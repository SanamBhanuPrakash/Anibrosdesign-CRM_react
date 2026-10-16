import crypto from 'crypto';
import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { enqueue } from '../../platform/jobs';
import { encryptField, decryptField } from '../../platform/crypto/field-encryption';
import { config } from '../../platform/config';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { summarize, type EndpointConfig, type InboundProvider } from './providers';

export type InboundStatus = 'received' | 'created' | 'duplicate' | 'needs_review' | 'ignored' | 'failed';

export interface EndpointDto {
  id: string;
  provider: InboundProvider;
  name: string;
  status: 'active' | 'paused';
  /** Last four characters of the stored secret; the secret itself is shown once, at creation or rotation. */
  secretHint: string | null;
  hasAccessToken: boolean;
  verifyToken: string | null;
  /** Where the sender must POST. */
  url: string;
  config: EndpointConfig;
  lastReceivedAt: string | null;
  receivedCount: number;
  stats: Record<InboundStatus, number>;
  createdAt: string;
}

export interface EventDto {
  id: string;
  endpointId: string;
  endpointName: string;
  provider: InboundProvider;
  status: InboundStatus;
  isTest: boolean;
  leadId: string | null;
  who: string;
  reason: string | null;
  attempts: number;
  receivedAt: string;
  processedAt: string | null;
}

export interface CreateEndpointInput {
  provider: InboundProvider;
  name: string;
  /** Meta only: the app secret that signs deliveries. Other providers get a generated secret. */
  appSecret?: string;
  pageAccessToken?: string;
  config?: EndpointConfig;
}
export interface UpdateEndpointInput {
  name?: string;
  status?: 'active' | 'paused';
  config?: EndpointConfig;
  appSecret?: string;
  pageAccessToken?: string | null;
}

const aad = (endpointId: string) => `inbound:${endpointId}`;
const newSecret = () => `ansk_${crypto.randomBytes(32).toString('base64url')}`;
const EMPTY_STATS: Record<InboundStatus, number> = { received: 0, created: 0, duplicate: 0, needs_review: 0, ignored: 0, failed: 0 };

export const hookUrl = (id: string) => `${(config.publicApiUrl ?? config.publicAppUrl).replace(/\/$/, '')}/hooks/${id}`;

const COLUMNS = `e.id, e.provider, e.name, e.status, e.secret_hint AS "secretHint", (e.access_token_enc IS NOT NULL) AS "hasAccessToken", e.verify_token AS "verifyToken",
  e.config, e.last_received_at AS "lastReceivedAt", e.received_count::int AS "receivedCount", e.created_at AS "createdAt"`;

export class InboundService {
  constructor(private db: Database) {}

  // ── endpoints ────────────────────────────────────────────────────────────────

  async list(actor: Actor): Promise<EndpointDto[]> {
    assertCan(actor, 'integrations:read');
    return this.db.readTenant(actor, async (tx) => {
      const rows = (await tx.query(`SELECT ${COLUMNS} FROM inbound_endpoints e WHERE e.tenant_id = $1 AND e.deleted_at IS NULL ORDER BY e.created_at DESC`, [actor.tenantId])).rows;
      const stats = (await tx.query(`SELECT endpoint_id, status, count(*)::int AS n FROM inbound_events WHERE tenant_id = $1 AND received_at > now() - interval '7 days' GROUP BY 1, 2`, [actor.tenantId])).rows;
      return rows.map((r) => this.toDto(r, stats.filter((s) => s.endpoint_id === r.id)));
    });
  }

  async get(actor: Actor, id: string): Promise<EndpointDto> {
    assertCan(actor, 'integrations:read');
    return this.db.readTenant(actor, async (tx) => this.fetch(tx, actor.tenantId, id));
  }

  async create(actor: Actor, input: CreateEndpointInput): Promise<{ endpoint: EndpointDto; secret: string | null }> {
    assertCan(actor, 'integrations:manage');
    if (input.provider === 'meta' && !input.appSecret) throw Errors.validation([{ path: 'body.appSecret', message: 'Paste your Meta app secret (App settings → Basic). It is used to check that deliveries really come from Meta.' }]);
    const id = crypto.randomUUID();
    const generated = input.provider === 'google' || input.provider === 'generic' ? newSecret() : null;
    const secret = input.provider === 'meta' ? input.appSecret! : generated;
    return this.db.withTenant(actor, async (tx) => {
      await this.validateConfig(tx, actor.tenantId, input.config ?? {});
      await tx.query(
        `INSERT INTO inbound_endpoints (id, tenant_id, provider, name, secret_enc, secret_hint, verify_token, access_token_enc, config, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          id, actor.tenantId, input.provider, input.name.trim(), secret ? encryptField(secret, aad(id)) : null, secret ? secret.slice(-4) : null,
          input.provider === 'meta' ? crypto.randomBytes(18).toString('base64url') : null,
          input.pageAccessToken ? encryptField(input.pageAccessToken, aad(id)) : null, JSON.stringify(input.config ?? {}), actor.userId,
        ]
      );
      await audit(tx, { action: 'lead_source.create', entityType: 'lead_source', entityId: id, after: { provider: input.provider, name: input.name.trim() } });
      await emit(tx, { type: 'lead_source.updated', aggregateId: id, payload: { change: 'created' } });
      return { endpoint: await this.fetch(tx, actor.tenantId, id), secret: generated };
    });
  }

  async update(actor: Actor, id: string, patch: UpdateEndpointInput): Promise<EndpointDto> {
    assertCan(actor, 'integrations:manage');
    return this.db.withTenant(actor, async (tx) => {
      const cur = (await tx.query(`SELECT provider, status FROM inbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId])).rows[0];
      if (!cur) throw Errors.notFound('Lead source');
      if (patch.appSecret !== undefined && cur.provider !== 'meta') throw Errors.validation([{ path: 'body.appSecret', message: 'Only Meta sources take your own secret. Use “Rotate secret” for this source.' }]);
      if (patch.config) await this.validateConfig(tx, actor.tenantId, patch.config);
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.name !== undefined) set('name', patch.name.trim());
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.config !== undefined) set('config', JSON.stringify(patch.config), '::jsonb');
      if (patch.appSecret !== undefined) {
        set('secret_enc', encryptField(patch.appSecret, aad(id)));
        set('secret_hint', patch.appSecret.slice(-4));
      }
      if (patch.pageAccessToken !== undefined) set('access_token_enc', patch.pageAccessToken ? encryptField(patch.pageAccessToken, aad(id)) : null);
      if (!sets.length) return this.fetch(tx, actor.tenantId, id);
      await tx.query(`UPDATE inbound_endpoints SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      // Secrets never enter the audit trail; say which fields changed.
      await audit(tx, { action: 'lead_source.update', entityType: 'lead_source', entityId: id, after: { fields: Object.keys(patch) } });
      await emit(tx, { type: 'lead_source.updated', aggregateId: id, payload: { change: 'updated' } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  /** New signing secret for Google / generic sources. The old one stops working immediately. Shown once. */
  async rotateSecret(actor: Actor, id: string): Promise<{ endpoint: EndpointDto; secret: string }> {
    assertCan(actor, 'integrations:manage');
    return this.db.withTenant(actor, async (tx) => {
      const cur = (await tx.query(`SELECT provider FROM inbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId])).rows[0];
      if (!cur) throw Errors.notFound('Lead source');
      if (cur.provider !== 'google' && cur.provider !== 'generic') throw Errors.conflict('This source does not use a generated secret. For Meta, paste the new app secret instead.');
      const secret = newSecret();
      await tx.query(`UPDATE inbound_endpoints SET secret_enc = $3, secret_hint = $4 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, encryptField(secret, aad(id)), secret.slice(-4)]);
      await audit(tx, { action: 'lead_source.rotate_secret', entityType: 'lead_source', entityId: id });
      await emit(tx, { type: 'lead_source.updated', aggregateId: id, payload: { change: 'secret_rotated' } });
      return { endpoint: await this.fetch(tx, actor.tenantId, id), secret };
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'integrations:delete');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE inbound_endpoints SET deleted_at = now(), status = 'paused' WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Lead source');
      await audit(tx, { action: 'lead_source.delete', entityType: 'lead_source', entityId: id });
      await emit(tx, { type: 'lead_source.updated', aggregateId: id, payload: { change: 'deleted' } });
    });
  }

  // ── delivery log ─────────────────────────────────────────────────────────────

  async events(actor: Actor, q: { endpointId?: string; status?: InboundStatus; limit: number; cursor?: string }): Promise<{ items: EventDto[]; page: PageInfo }> {
    assertCan(actor, 'integrations:manage');
    const sig = 'inbound-events';
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['ev.tenant_id = $1'];
      if (q.endpointId) { params.push(q.endpointId); where.push(`ev.endpoint_id = $${params.length}`); }
      if (q.status) { params.push(q.status); where.push(`ev.status = $${params.length}`); }
      const pred = cursorPredicate(cursor, params, 'ev.received_at', 'ev.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `SELECT ev.id, ev.endpoint_id, ep.name AS endpoint_name, ev.provider, ev.status, ev.is_test, ev.lead_id, ev.reason, ev.attempts, ev.received_at, ev.received_at::text AS _k, ev.processed_at, ev.payload
           FROM inbound_events ev JOIN inbound_endpoints ep ON ep.id = ev.endpoint_id
          WHERE ${where.join(' AND ')} ORDER BY ev.received_at DESC, ev.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return {
        items: items.map((r) => ({
          id: r.id, endpointId: r.endpoint_id, endpointName: r.endpoint_name, provider: r.provider, status: r.status, isTest: r.is_test, leadId: r.lead_id,
          who: summarize(r.provider, r.payload) || (r.payload?.leadgen?.leadgen_id ? `Meta lead ${String(r.payload.leadgen.leadgen_id).slice(-6)}` : ''),
          reason: r.reason, attempts: r.attempts, receivedAt: r.received_at, processedAt: r.processed_at,
        })),
        page,
      };
    });
  }

  /** Put a stuck or rejected delivery back in the queue (after fixing the token, pipeline, …). */
  async retry(actor: Actor, eventId: string): Promise<void> {
    assertCan(actor, 'integrations:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE inbound_events SET status = 'received', reason = NULL, attempts = 0, processed_at = NULL WHERE id = $1 AND tenant_id = $2 AND status IN ('needs_review','failed') RETURNING id`, [eventId, actor.tenantId]);
      if (!r.rowCount) throw Errors.conflict('Only deliveries that need review or failed can be retried');
      await enqueue(tx, { type: 'inbound.process', payload: { eventId }, dedupeKey: `inbound:${eventId}:retry:${Date.now()}`, maxAttempts: 6, priority: 5 });
      await audit(tx, { action: 'inbound_event.retry', entityType: 'inbound_event', entityId: eventId });
      await emit(tx, { type: 'inbound.updated', aggregateId: eventId, payload: { status: 'received' } });
    });
  }

  async ignore(actor: Actor, eventId: string): Promise<void> {
    assertCan(actor, 'integrations:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE inbound_events SET status = 'ignored', processed_at = now() WHERE id = $1 AND tenant_id = $2 AND status IN ('needs_review','failed') RETURNING id`, [eventId, actor.tenantId]);
      if (!r.rowCount) throw Errors.conflict('Only deliveries that need review or failed can be ignored');
      await audit(tx, { action: 'inbound_event.ignore', entityType: 'inbound_event', entityId: eventId });
      await emit(tx, { type: 'inbound.updated', aggregateId: eventId, payload: { status: 'ignored' } });
    });
  }

  /** A synthetic, provider-shaped delivery that goes through the real pipeline (worker, dedupe, lead creation), tagged "test". */
  async sendTest(actor: Actor, id: string): Promise<{ eventId: string }> {
    assertCan(actor, 'integrations:manage');
    return this.db.withTenant(actor, async (tx) => {
      const ep = (await tx.query(`SELECT provider, status FROM inbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, actor.tenantId])).rows[0];
      if (!ep) throw Errors.notFound('Lead source');
      const rnd = crypto.randomBytes(4).toString('hex');
      const phone = `+9198${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
      const email = `lead.test.${rnd}@example.com`;
      const eventId = `test-${rnd}`;
      const payloads: Record<InboundProvider, Record<string, unknown>> = {
        meta: {
          leadgen: { leadgen_id: eventId, page_id: '0', form_id: '0', ad_id: '0', created_time: Math.floor(Date.now() / 1000) }, pageId: '0',
          lead: { campaign_name: 'Test campaign', adset_name: 'Test ad set', ad_name: 'Test ad', platform: 'fb', field_data: [
            { name: 'full_name', values: ['Test Lead'] }, { name: 'email', values: [email] }, { name: 'phone_number', values: [phone] },
            { name: 'budget', values: ['85 lakh'] }, { name: 'preferred_location', values: ['Whitefield'] }, { name: 'how_soon_are_you_looking_to_buy', values: ['Within 3 months'] },
          ] },
        },
        google: { lead_id: eventId, form_id: '0', campaign_id: '0', is_test: true, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Test Lead' }, { column_id: 'EMAIL', string_value: email }, { column_id: 'PHONE_NUMBER', string_value: phone }, { column_id: 'CITY', string_value: 'Bengaluru' }] },
        website: { name: 'Test Lead', email, phone, message: 'This is a test enquiry from the Send test lead button.', page_url: 'https://example.com/contact' },
        generic: { name: 'Test Lead', email, phone, message: 'This is a test delivery from the Send test lead button.' },
      };
      const ins = await tx.query(
        `INSERT INTO inbound_events (tenant_id, endpoint_id, provider, provider_event_id, payload, is_test) VALUES ($1,$2,$3,$4,$5::jsonb,true) RETURNING id`,
        [actor.tenantId, id, ep.provider, eventId, JSON.stringify(payloads[ep.provider as InboundProvider])]
      );
      const evId = ins.rows[0].id as string;
      await enqueue(tx, { type: 'inbound.process', payload: { eventId: evId }, dedupeKey: `inbound:${evId}`, maxAttempts: 6, priority: 5 });
      await audit(tx, { action: 'lead_source.test', entityType: 'lead_source', entityId: id, after: { eventId: evId } });
      await emit(tx, { type: 'inbound.updated', aggregateId: evId, payload: { status: 'received' } });
      return { eventId: evId };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private toDto(r: any, statRows: Array<{ status: InboundStatus; n: number }>): EndpointDto {
    const stats = { ...EMPTY_STATS };
    for (const s of statRows) stats[s.status] = s.n;
    return { ...r, url: hookUrl(r.id), stats };
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<EndpointDto> {
    const r = (await tx.query(`SELECT ${COLUMNS} FROM inbound_endpoints e WHERE e.id = $1 AND e.tenant_id = $2 AND e.deleted_at IS NULL`, [id, tenantId])).rows[0];
    if (!r) throw Errors.notFound('Lead source');
    const stats = (await tx.query(`SELECT status, count(*)::int AS n FROM inbound_events WHERE tenant_id = $1 AND endpoint_id = $2 AND received_at > now() - interval '7 days' GROUP BY 1`, [tenantId, id])).rows;
    return this.toDto(r, stats);
  }

  /** The pipeline, stage and owner a source sends leads to must exist in THIS workspace. */
  private async validateConfig(tx: pg.PoolClient, tenantId: string, cfg: EndpointConfig): Promise<void> {
    if (cfg.pipelineId) {
      const p = await tx.query(`SELECT 1 FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [cfg.pipelineId, tenantId]);
      if (!p.rowCount) throw Errors.validation([{ path: 'body.config.pipelineId', message: 'Pipeline not found' }]);
      if (cfg.stageId) {
        const s = await tx.query(`SELECT 1 FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2 AND tenant_id = $3 AND archived_at IS NULL`, [cfg.stageId, cfg.pipelineId, tenantId]);
        if (!s.rowCount) throw Errors.validation([{ path: 'body.config.stageId', message: 'Stage not found in that pipeline' }]);
      }
    } else if (cfg.stageId) throw Errors.validation([{ path: 'body.config.stageId', message: 'Choose the pipeline as well' }]);
    if (cfg.ownerId) {
      const m = await tx.query(`SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND tm.is_active AND u.is_active`, [tenantId, cfg.ownerId]);
      if (!m.rowCount) throw Errors.validation([{ path: 'body.config.ownerId', message: 'Owner must be an active member of this workspace' }]);
    }
  }
}

/** Used by the receiver and the processor: decrypt a stored secret bound to its endpoint. */
export const readSecret = (endpointId: string, enc: string | null): string | null => (enc ? decryptField(enc, aad(endpointId)) : null);
