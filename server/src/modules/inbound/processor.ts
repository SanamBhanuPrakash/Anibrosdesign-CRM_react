import type pg from 'pg';
import type { Actor } from '../../platform/authz/actor';
import { AppError } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { notify } from '../../platform/notifications';
import { PermanentJobError, type JobHandler } from '../../platform/jobs';
import { recordEvent } from '../../platform/observability/event-log';
import { ContactsService } from '../contacts/service';
import { LeadsService } from '../leads/service';
import { recordLaterTouch, touchFrom } from '../analytics/touches';
import { BadPayload, normalizeLead, type EndpointConfig, type InboundProvider, type NormalizedLead } from './providers';
import { PermanentGraphError, TransientGraphError, getMetaGraph } from './graph';
import { readSecret } from './service';

/**
 * Worker side of lead intake (`inbound.process`).
 *
 *   1. load the stored delivery (tenant comes from the stored row, never from the payload)
 *   2. Meta: fetch the answers by lead id (outside any transaction)
 *   3. normalise → one transaction: create the lead (or add the enquiry to the person's open lead), write the timeline note,
 *      notify the owner, mark the delivery
 *
 * Outcomes are explicit and visible in the delivery log:
 *   created       a new lead exists
 *   duplicate     the person already had an open lead; the new enquiry was added to its timeline (nothing lost, nothing doubled)
 *   needs_review  we understood the sender but cannot continue without a human (no phone/email, missing token, no pipeline …)
 *   failed        technical failure after all retries
 * The handler is idempotent: a delivery that is no longer `received` is skipped.
 */

const PROVIDER_LABEL: Record<InboundProvider, string> = { meta: 'Meta Lead Ads', google: 'Google Ads lead form', website: 'your website form', generic: 'an integration' };

type Row = { id: string; endpoint_id: string; provider: InboundProvider; status: string; payload: Record<string, any>; is_test: boolean; attempts: number; config: EndpointConfig; secret_enc: string | null; access_token_enc: string | null };

export const inboundProcessHandler: JobHandler = async (job, ctx) => {
  const tenantId = job.tenantId;
  const eventId = String(job.payload.eventId ?? '');
  if (!tenantId || !eventId) throw new PermanentJobError('Malformed inbound job');
  try {
    return await processEvent(tenantId, eventId, ctx);
  } catch (e: any) {
    // Out of retries: say so on the delivery instead of leaving it "received" forever.
    if (e instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
      await ctx.db
        .withTenant({ tenantId }, (tx) => finish(tx, tenantId, eventId, 'failed', 'We could not process this delivery after several attempts. Use Retry once the cause is fixed.', null))
        .catch(() => undefined);
      recordEvent({ tenantId, component: 'inbound', severity: 'error', message: 'A lead delivery could not be processed', context: { eventId, error: String(e?.message ?? e).slice(0, 300) }, correlationId: job.correlationId ?? undefined });
    }
    throw e;
  }
};

async function processEvent(tenantId: string, eventId: string, ctx: Parameters<JobHandler>[1]) {
  const row = await ctx.db.withTenant({ tenantId }, async (tx) => {
    const r = await tx.query(
      `SELECT ev.id, ev.endpoint_id, ev.provider, ev.status, ev.payload, ev.is_test, ev.attempts, ep.config, ep.secret_enc, ep.access_token_enc
         FROM inbound_events ev JOIN inbound_endpoints ep ON ep.id = ev.endpoint_id WHERE ev.id = $1 AND ev.tenant_id = $2`,
      [eventId, tenantId]
    );
    if (r.rows[0]?.status === 'received') await tx.query(`UPDATE inbound_events SET attempts = attempts + 1 WHERE id = $1`, [eventId]);
    return r.rows[0] as Row | undefined;
  });
  if (!row) throw new PermanentJobError('Delivery not found');
  if (row.status !== 'received') return { skipped: row.status };

  let payload = row.payload;

  // Meta only sends ids; fetch what the person typed. Done outside any transaction (network call).
  if (row.provider === 'meta' && !payload.lead) {
    const token = readSecret(row.endpoint_id, row.access_token_enc);
    const appSecret = readSecret(row.endpoint_id, row.secret_enc);
    if (!token || !appSecret) {
      return needsReview(ctx, tenantId, eventId, 'Add this Meta source’s page access token so we can fetch the lead’s answers, then press Retry.');
    }
    try {
      const lead = await getMetaGraph().fetchLead(String(payload.leadgen?.leadgen_id ?? ''), token, appSecret);
      payload = { ...payload, lead };
      await ctx.db.withTenant({ tenantId }, (tx) => tx.query(`UPDATE inbound_events SET payload = $2::jsonb WHERE id = $1`, [eventId, JSON.stringify(payload)]));
    } catch (e) {
      if (e instanceof PermanentGraphError) return needsReview(ctx, tenantId, eventId, `Meta refused the request: ${e.message}. Check the page access token and its lead-retrieval permission, then press Retry.`);
      if (e instanceof TransientGraphError) throw e; // retry with backoff
      throw e;
    }
  }

  let lead: NormalizedLead;
  try {
    lead = normalizeLead(row.provider, payload, row.config ?? {}, row.is_test, row.endpoint_id);
  } catch (e) {
    if (e instanceof BadPayload) return needsReview(ctx, tenantId, eventId, `${e.message}.`);
    throw e;
  }
  if (!lead.email && !lead.phone) return needsReview(ctx, tenantId, eventId, 'The submission had no usable phone number or email address, so there is nobody to contact.');

  const actor: Actor = { tenantId, userId: null, role: 'tenant_owner', kind: 'system' };
  const leads = new LeadsService(ctx.db, new ContactsService(ctx.db));
  return ctx.db.withTenant({ tenantId }, async (tx) => {
    const cur = (await tx.query(`SELECT status FROM inbound_events WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [eventId, tenantId])).rows[0];
    if (!cur || cur.status !== 'received') return { skipped: cur?.status ?? 'missing' };
    const cfg = row.config ?? {};
    await tx.query('SAVEPOINT create_lead');
    try {
      const created = await leads.createInTx(tx, actor, {
        contact: { firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone },
        source: lead.source,
        campaign: lead.campaign,
        tags: lead.tags,
        budgetMax: lead.budgetMax,
        bedroomsMin: lead.bedroomsMin,
        locations: lead.locations,
        pipelineId: cfg.pipelineId,
        stageId: cfg.stageId,
        ownerId: cfg.ownerId ?? undefined,
        sourceDetails: lead.details,
      });
      await tx.query('RELEASE SAVEPOINT create_lead');
      await timeline(tx, tenantId, created.id, `Captured from ${PROVIDER_LABEL[row.provider]}${lead.campaign ? ` · ${lead.campaign}` : ''}`, row, lead, 'created');
      await theirWords(tx, tenantId, created.id, row, lead);
      await finish(tx, tenantId, eventId, 'created', null, created.id);
      if (created.ownerId) {
        await notify(tx, { userId: created.ownerId, title: `New lead from ${PROVIDER_LABEL[row.provider]}`, message: [created.contactName, lead.campaign].filter(Boolean).join(' · '), type: 'lead_assigned', link: `/leads/${created.id}`, entityType: 'lead', entityId: created.id, dedupeKey: `inbound-lead:${eventId}` });
      }
      return { status: 'created', leadId: created.id };
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT create_lead');
      if (e instanceof AppError && e.extensions?.reason === 'duplicate_lead') {
        const leadId = String(e.extensions.leadId);
        // the buyer came back through another door: that is a later touch on the same lead (first touch stays as it was)
        await recordLaterTouch(tx, tenantId, leadId, touchFrom({ source: lead.source, campaign: lead.campaign, sourceDetails: lead.details }));
        await timeline(tx, tenantId, leadId, `Enquired again via ${PROVIDER_LABEL[row.provider]}${lead.campaign ? ` · ${lead.campaign}` : ''}`, row, lead, 'duplicate');
        await theirWords(tx, tenantId, leadId, row, lead);
        await finish(tx, tenantId, eventId, 'duplicate', 'This person already has an open lead, so the new enquiry was added to that lead’s timeline.', leadId);
        const owner = (await tx.query(`SELECT owner_id FROM leads WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId])).rows[0]?.owner_id as string | undefined;
        if (owner) await notify(tx, { userId: owner, title: 'An existing lead enquired again', message: `Via ${PROVIDER_LABEL[row.provider]}`, type: 'lead_activity', link: `/leads/${leadId}`, entityType: 'lead', entityId: leadId, dedupeKey: `inbound-dup:${eventId}` });
        return { status: 'duplicate', leadId };
      }
      if (e instanceof AppError && e.status >= 400 && e.status < 500) {
        const detail = e.errors?.[0]?.message ?? e.detail ?? e.message;
        await finish(tx, tenantId, eventId, 'needs_review', `${detail}. Fix the cause and press Retry.`, null);
        return { status: 'needs_review' };
      }
      throw e; // unexpected → retry with backoff
    }
  });
}

async function needsReview(ctx: Parameters<JobHandler>[1], tenantId: string, eventId: string, reason: string) {
  await ctx.db.withTenant({ tenantId }, (tx) => finish(tx, tenantId, eventId, 'needs_review', reason, null));
  return { status: 'needs_review', reason };
}

async function finish(tx: pg.PoolClient, tenantId: string, eventId: string, status: 'created' | 'duplicate' | 'needs_review' | 'failed', reason: string | null, leadId: string | null) {
  const r = await tx.query(`UPDATE inbound_events SET status = $3, reason = $4, lead_id = COALESCE($5::uuid, lead_id), processed_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'received' RETURNING id`, [eventId, tenantId, status, reason?.slice(0, 500) ?? null, leadId]);
  if (!r.rowCount) return;
  await audit(tx, { action: `inbound_event.${status}`, entityType: 'inbound_event', entityId: eventId, after: { leadId } });
  await emit(tx, { type: 'inbound.updated', aggregateId: eventId, payload: { status } });
}

async function timeline(tx: pg.PoolClient, tenantId: string, leadId: string, description: string, row: Row, lead: NormalizedLead, outcome: 'created' | 'duplicate') {
  await tx.query(
    `INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,NULL,'note',$3,$4::jsonb,clock_timestamp())`,
    [tenantId, leadId, description.slice(0, 500), JSON.stringify({ event: 'inbound', outcome, provider: row.provider, endpointId: row.endpoint_id, isTest: row.is_test, answers: lead.answers })]
  );
  await emit(tx, { type: 'activity.created', aggregateId: leadId, payload: { kind: 'inbound' } });
}

/** What the person actually wrote (form message box, or the chatbot conversation), as its own note so the team reads it first. */
async function theirWords(tx: pg.PoolClient, tenantId: string, leadId: string, row: Row, lead: NormalizedLead) {
  const talked = lead.conversation.length > 0;
  if (!lead.message && !talked) return;
  const description = talked
    ? ['Chat with the visitor:', ...lead.conversation.slice(0, 60).map((t) => `${t.who === 'visitor' ? 'Visitor' : 'Bot'}: ${t.text}`)].join('\n').slice(0, 6000)
    : `Their message: “${lead.message}”`.slice(0, 2200);
  await tx.query(
    `INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,NULL,'note',$3,$4::jsonb,clock_timestamp())`,
    [tenantId, leadId, description, JSON.stringify({ event: 'inbound_message', provider: row.provider, endpointId: row.endpoint_id, isTest: row.is_test, ...(talked ? { turns: lead.conversation.length } : {}) })]
  );
  await emit(tx, { type: 'activity.created', aggregateId: leadId, payload: { kind: 'inbound_message' } });
}
