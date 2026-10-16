import crypto from 'crypto';
import type pg from 'pg';
import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import type { DomainEventRow, EventConsumer } from '../../platform/events';
import { enqueue, PermanentJobError, type JobHandler } from '../../platform/jobs';
import { decryptField } from '../../platform/crypto/field-encryption';
import { Errors } from '../../platform/errors';
import { recordEvent } from '../../platform/observability/event-log';
import { DISABLE_AFTER_FAILURES, MAX_DELIVERY_ATTEMPTS, isOutboundEvent, secretAad } from './catalog';
import { BlockedTargetError, postJson } from './safe-http';

/**
 * Sending the messages.
 *
 *   domain event ──► consumer "outbound" (worker, cursor-based): one tiny job per event, but only for workspaces that have an active webhook
 *                     └─ job webhook.fanout (workspace context): one delivery row per subscribed endpoint (UNIQUE endpoint+event = no double send),
 *                        and one webhook.deliver job per row
 *                        └─ job webhook.deliver: build the message, sign it, POST it (outside any transaction), record the outcome.
 *                           A failure is retried with back-off (the job runner), up to MAX_DELIVERY_ATTEMPTS, then the message is marked dead.
 *
 * Each message is signed with the endpoint's secret:  X-Anibros-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * so the receiver can prove it came from here, and (with t) refuse a replayed copy. X-Anibros-Delivery is the same on every retry of the
 * same message: it is the receiver's idempotency key.
 */

export const outboundConsumer: EventConsumer = {
  name: 'outbound',
  async handle(events, tx) {
    const relevant = events.filter((e) => isOutboundEvent(e.type));
    if (relevant.length === 0) return;
    const verdict = new Map<string, boolean>();
    for (const e of relevant) {
      if (!verdict.has(e.tenantId)) verdict.set(e.tenantId, Boolean((await tx.query(`SELECT app.tenant_has_outbound($1::uuid) AS has`, [e.tenantId])).rows[0]?.has));
      if (!verdict.get(e.tenantId)) continue;
      await enqueue(tx, { type: 'webhook.fanout', tenantId: e.tenantId, payload: { eventId: e.id }, dedupeKey: `wh-fan:${e.id}`, maxAttempts: 6 });
    }
  },
};

type EventLike = Pick<DomainEventRow, 'id' | 'aggregateId' | 'aggregateType' | 'payload' | 'occurredAt'> & { type: string };

async function loadEvent(tx: pg.PoolClient, tenantId: string, eventId: string): Promise<EventLike | undefined> {
  const r = await tx.query(
    `SELECT id::text, type, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", payload, occurred_at AS "occurredAt" FROM domain_events WHERE id = $1::bigint AND tenant_id = $2`,
    [eventId, tenantId]
  );
  return r.rows[0] as EventLike | undefined;
}

/** Fan-out: which endpoints want this event? One delivery row (and one send job) each. */
export const webhookFanoutHandler: JobHandler = async (job, ctx) => {
  const tenantId = job.tenantId;
  const eventId = String(job.payload.eventId ?? '');
  if (!tenantId || !/^\d+$/.test(eventId)) throw new PermanentJobError('Malformed webhook fan-out job');
  return ctx.withTenant(async (tx) => {
    const ev = await loadEvent(tx, tenantId, eventId);
    if (!ev || !isOutboundEvent(ev.type)) return { ignored: true };
    const eps = (await tx.query(`SELECT id FROM outbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active' AND $2 = ANY(events) AND created_at <= $3::timestamptz`, [tenantId, ev.type, ev.occurredAt])).rows as Array<{ id: string }>;
    let queued = 0;
    for (const ep of eps) {
      const ins = await tx.query(
        `INSERT INTO outbound_deliveries (tenant_id, endpoint_id, event_id, event_type) VALUES ($1, $2, $3::bigint, $4) ON CONFLICT (endpoint_id, event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING id`,
        [tenantId, ep.id, eventId, ev.type]
      );
      if (!ins.rows[0]) continue; // already created by an earlier run of this job
      await enqueue(tx, { type: 'webhook.deliver', tenantId, payload: { deliveryId: ins.rows[0].id }, dedupeKey: `wh-del:${ins.rows[0].id}`, maxAttempts: MAX_DELIVERY_ATTEMPTS });
      queued++;
    }
    return { endpoints: eps.length, queued };
  });
};

// ── the message ──────────────────────────────────────────────────────────────────────────────────────────────

/** A short, stable description of the record the event is about. Only fields the workspace itself entered or owns. */
async function describe(tx: pg.PoolClient, tenantId: string, ev: EventLike): Promise<Record<string, unknown>> {
  if (ev.aggregateType === 'lead') {
    const r = (
      await tx.query(
        `SELECT l.id, c.display_name AS name, c.email::text AS email, c.phone, l.source::text AS source, l.campaign, l.status::text AS status, s.name AS stage,
                u.name AS "ownerName", l.tags, l.estimated_value::float8 AS "estimatedValue", l.currency, l.custom_fields AS "customFields", l.created_at AS "createdAt"
           FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
           JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id LEFT JOIN users u ON u.id = l.owner_id
          WHERE l.id = $1 AND l.tenant_id = $2`,
        [ev.aggregateId, tenantId]
      )
    ).rows[0];
    return r ? { lead: r } : { lead: { id: ev.aggregateId, deleted: true } };
  }
  if (ev.aggregateType === 'activity') {
    const r = (await tx.query(`SELECT id, lead_id AS "leadId", type::text AS type, direction, outcome, duration_minutes AS "durationMinutes", left(description, 500) AS note, created_at AS "createdAt" FROM activities WHERE id = $1 AND tenant_id = $2`, [ev.aggregateId, tenantId])).rows[0];
    return r ? { activity: r } : { activity: { id: ev.aggregateId } };
  }
  if (ev.aggregateType === 'task') {
    const r = (await tx.query(`SELECT id, lead_id AS "leadId", title, status::text AS status, priority::text AS priority, due_date AS "dueDate", completed_at AS "completedAt" FROM tasks WHERE id = $1 AND tenant_id = $2`, [ev.aggregateId, tenantId])).rows[0];
    return r ? { task: r } : { task: { id: ev.aggregateId } };
  }
  if (ev.aggregateType === 'contact') {
    const r = (await tx.query(`SELECT id, display_name AS name, email::text AS email, phone FROM contacts WHERE id = $1 AND tenant_id = $2`, [ev.aggregateId, tenantId])).rows[0];
    return r ? { contact: r } : { contact: { id: ev.aggregateId } };
  }
  return {};
}

export function signBody(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function headersFor(secret: string, body: string, deliveryId: string, event: string): Record<string, string> {
  return {
    'user-agent': 'Anibros-CRM-Webhooks/1',
    'x-anibros-event': event,
    'x-anibros-delivery': deliveryId,
    'x-anibros-signature': signBody(secret, body),
  };
}

type Target = { id: string; url: string; secret_enc: string; status: string; name: string };

/** Sends one prepared body. Returns what happened, never throws for a normal "the other side said no". */
async function send(ep: Target, tenantId: string, deliveryId: string, event: string, body: string): Promise<{ ok: boolean; status: number | null; ms: number | null; error: string | null; gone: boolean }> {
  const secret = decryptField(ep.secret_enc, secretAad(ep.id));
  try {
    const res = await postJson(ep.url, body, headersFor(secret, body, deliveryId, event));
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, ms: res.ms, gone: res.status === 410, error: ok ? null : res.status >= 300 && res.status < 400 ? `The address answered with a redirect (${res.status}); redirects are not followed. Use the final address.` : `The other side answered ${res.status}${res.body ? `: ${res.body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}` };
  } catch (e) {
    const msg = e instanceof BlockedTargetError ? e.message : String((e as Error)?.message ?? e);
    return { ok: false, status: null, ms: null, gone: false, error: msg.slice(0, 300) };
  }
}

/** Records the outcome on the endpoint, and switches the endpoint off when it has failed too many times in a row. */
async function recordOutcome(tx: pg.PoolClient, tenantId: string, endpointId: string, r: { ok: boolean; status: number | null; error: string | null; gone: boolean }, countFailure: boolean) {
  if (r.ok) {
    await tx.query(`UPDATE outbound_endpoints SET consecutive_failures = 0, last_delivery_at = now(), last_status = $3, last_error = NULL WHERE id = $1 AND tenant_id = $2`, [endpointId, tenantId, r.status]);
    return;
  }
  const upd = (
    await tx.query(
      `UPDATE outbound_endpoints SET consecutive_failures = consecutive_failures + $3, last_delivery_at = now(), last_status = $4, last_error = $5,
              status = CASE WHEN status = 'active' AND ($6 OR consecutive_failures + $3 >= $7) THEN 'disabled' ELSE status END,
              disabled_reason = CASE WHEN status = 'active' AND ($6 OR consecutive_failures + $3 >= $7) THEN $8 ELSE disabled_reason END
        WHERE id = $1 AND tenant_id = $2 RETURNING status, name`,
      [endpointId, tenantId, countFailure ? 1 : 0, r.status, r.error, r.gone, DISABLE_AFTER_FAILURES, r.gone ? 'The receiver said this address is gone (410).' : `Switched off after ${DISABLE_AFTER_FAILURES} failed attempts in a row. Fix the address, then turn it back on.`]
    )
  ).rows[0];
  if (upd?.status === 'disabled') recordEvent({ tenantId, component: 'webhooks', severity: 'warn', message: `Webhook “${upd.name}” was switched off after repeated failures`, context: { endpointId, lastError: r.error } });
}

export const webhookDeliverHandler: JobHandler = async (job, ctx) => {
  const tenantId = job.tenantId;
  const deliveryId = String(job.payload.deliveryId ?? '');
  if (!tenantId || !deliveryId) throw new PermanentJobError('Malformed webhook delivery job');

  const prepared = await ctx.withTenant(async (tx) => {
    const d = (await tx.query(`SELECT id, endpoint_id, event_id::text AS event_id, event_type, status, is_test FROM outbound_deliveries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [deliveryId, tenantId])).rows[0];
    if (!d) throw new PermanentJobError('Delivery not found');
    if (d.status === 'delivered' || d.status === 'skipped') return { skip: d.status as string };
    const ep = (await tx.query(`SELECT id, name, url, secret_enc, status FROM outbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [d.endpoint_id, tenantId])).rows[0] as Target | undefined;
    if (!ep || ep.status !== 'active') {
      await tx.query(`UPDATE outbound_deliveries SET status = 'skipped', error = $2 WHERE id = $1`, [deliveryId, ep ? 'The webhook was paused or switched off before this message was sent.' : 'The webhook was deleted before this message was sent.']);
      return { skip: 'endpoint inactive' };
    }
    const ev = d.event_id ? await loadEvent(tx, tenantId, d.event_id) : undefined;
    if (!ev) {
      await tx.query(`UPDATE outbound_deliveries SET status = 'skipped', error = 'The event is no longer available.' WHERE id = $1`, [deliveryId]);
      return { skip: 'event gone' };
    }
    const tenant = (await tx.query(`SELECT id, name FROM tenants WHERE id = $1`, [tenantId])).rows[0];
    const data = await describe(tx, tenantId, ev);
    const body = JSON.stringify({ id: deliveryId, event: ev.type, occurredAt: ev.occurredAt, workspace: { id: tenant.id, name: tenant.name }, change: ev.payload ?? {}, data });
    await tx.query(`UPDATE outbound_deliveries SET attempts = attempts + 1 WHERE id = $1`, [deliveryId]);
    return { ep, body, event: ev.type as string };
  });
  if ('skip' in prepared) return { skipped: prepared.skip };

  const r = await send(prepared.ep, tenantId, deliveryId, prepared.event, prepared.body);
  const lastTry = r.gone || job.attempts >= job.maxAttempts;
  await ctx.withTenant(async (tx) => {
    await tx.query(
      `UPDATE outbound_deliveries SET status = $2, response_status = $3, response_ms = $4, error = $5, delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END WHERE id = $1`,
      [deliveryId, r.ok ? 'delivered' : lastTry ? 'dead' : 'failed', r.status, r.ms, r.error]
    );
    await recordOutcome(tx, tenantId, prepared.ep.id, r, true);
  });
  if (r.ok) return { delivered: true, status: r.status };
  if (lastTry) return { dead: true, error: r.error }; // do not throw: the job is finished, the log says why
  throw new Error(r.error ?? 'Delivery failed'); // the job runner retries with back-off
};

/** A synchronous "ping" for the Test button: nothing is queued, the answer comes straight back, and it is logged like any delivery. */
export async function deliverNow(db: Database, actor: Actor, endpointId: string): Promise<{ ok: boolean; status: number | null; ms: number | null; error: string | null }> {
  const ep = await db.readTenant(actor, async (tx) => (await tx.query(`SELECT id, name, url, secret_enc, status FROM outbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [endpointId, actor.tenantId])).rows[0] as Target | undefined);
  if (!ep) throw Errors.notFound('Webhook');
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, event: 'ping', occurredAt: new Date().toISOString(), workspace: { id: actor.tenantId }, change: {}, data: { message: 'This is a test message from Anibros CRM. If you can read it and the signature checks out, you are all set.' } });
  const r = await send(ep, actor.tenantId, id, 'ping', body);
  await db.withTenant(actor, async (tx) => {
    await tx.query(
      `INSERT INTO outbound_deliveries (id, tenant_id, endpoint_id, event_type, is_test, status, attempts, response_status, response_ms, error, delivered_at) VALUES ($1,$2,$3,'ping',true,$4,1,$5,$6,$7,$8)`,
      [id, actor.tenantId, endpointId, r.ok ? 'delivered' : 'failed', r.status, r.ms, r.error, r.ok ? new Date() : null]
    );
    // A test never switches an endpoint off, and a good one clears earlier failures.
    if (r.ok) await recordOutcome(tx, actor.tenantId, endpointId, r, false);
  });
  return { ok: r.ok, status: r.status, ms: r.ms, error: r.error };
}

export const outboundJobHandlers: Record<string, JobHandler> = {
  'webhook.fanout': webhookFanoutHandler,
  'webhook.deliver': webhookDeliverHandler,
};
