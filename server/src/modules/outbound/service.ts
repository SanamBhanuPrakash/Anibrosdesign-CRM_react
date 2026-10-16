import crypto from 'crypto';
import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { enqueue } from '../../platform/jobs';
import { encryptField } from '../../platform/crypto/field-encryption';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { BlockedTargetError, assertPublicUrl } from './safe-http';
import { deliverNow } from './delivery';
import { OUTBOUND_EVENTS, OUTBOUND_EVENT_KEYS, secretAad, type OutboundEvent } from './catalog';

/**
 * Outgoing webhooks: a client gives a web address and picks the events it wants; the CRM sends each one as a signed JSON message.
 * Everything here is scoped to one workspace (row-level security) and needs the same permissions as lead sources.
 */
const MAX_ENDPOINTS = 10;
export { OUTBOUND_EVENTS, OUTBOUND_EVENT_KEYS, type OutboundEvent };

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: OutboundEvent[];
  status: 'active' | 'paused' | 'disabled';
  disabledReason: string | null;
  secretHint: string | null;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  stats: { delivered: number; failed: number; pending: number };
  createdAt: string;
}
export interface DeliveryDto {
  id: string;
  endpointId: string;
  endpointName: string;
  event: string;
  isTest: boolean;
  status: 'pending' | 'delivered' | 'failed' | 'dead' | 'skipped';
  attempts: number;
  responseStatus: number | null;
  responseMs: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

const COLUMNS = `e.id, e.name, e.url, e.events, e.status, e.disabled_reason AS "disabledReason", e.secret_hint AS "secretHint", e.last_delivery_at AS "lastDeliveryAt", e.last_status AS "lastStatus", e.last_error AS "lastError", e.created_at AS "createdAt"`;

export class OutboundService {
  constructor(private db: Database) {}

  private async validateUrl(url: string) {
    try {
      await assertPublicUrl(url);
    } catch (e) {
      if (e instanceof BlockedTargetError) throw Errors.validation([{ path: 'body.url', message: e.message }]);
      throw e;
    }
  }

  private dto(r: Record<string, any>, stats?: Array<{ status: string; n: number }>): WebhookDto {
    const n = (s: string[]) => (stats ?? []).filter((x) => s.includes(x.status)).reduce((a, b) => a + b.n, 0);
    return { ...(r as Omit<WebhookDto, 'stats'>), stats: { delivered: n(['delivered']), failed: n(['failed', 'dead']), pending: n(['pending']) } };
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<WebhookDto> {
    const r = (await tx.query(`SELECT ${COLUMNS} FROM outbound_endpoints e WHERE e.id = $1 AND e.tenant_id = $2 AND e.deleted_at IS NULL`, [id, tenantId])).rows[0];
    if (!r) throw Errors.notFound('Webhook');
    const stats = (await tx.query(`SELECT status, count(*)::int AS n FROM outbound_deliveries WHERE endpoint_id = $1 AND tenant_id = $2 AND created_at > now() - interval '7 days' GROUP BY 1`, [id, tenantId])).rows;
    return this.dto(r, stats);
  }

  async list(actor: Actor): Promise<WebhookDto[]> {
    assertCan(actor, 'integrations:read');
    return this.db.readTenant(actor, async (tx) => {
      const rows = (await tx.query(`SELECT ${COLUMNS} FROM outbound_endpoints e WHERE e.tenant_id = $1 AND e.deleted_at IS NULL ORDER BY e.created_at DESC`, [actor.tenantId])).rows;
      const stats = (await tx.query(`SELECT endpoint_id, status, count(*)::int AS n FROM outbound_deliveries WHERE tenant_id = $1 AND created_at > now() - interval '7 days' GROUP BY 1, 2`, [actor.tenantId])).rows;
      return rows.map((r) => this.dto(r, stats.filter((s) => s.endpoint_id === r.id)));
    });
  }

  async get(actor: Actor, id: string): Promise<WebhookDto> {
    assertCan(actor, 'integrations:read');
    return this.db.readTenant(actor, (tx) => this.fetch(tx, actor.tenantId, id));
  }

  async create(actor: Actor, input: { name: string; url: string; events: OutboundEvent[] }): Promise<{ webhook: WebhookDto; secret: string }> {
    assertCan(actor, 'integrations:manage');
    await this.validateUrl(input.url);
    const id = crypto.randomUUID();
    const secret = newSecret();
    return this.db.withTenant(actor, async (tx) => {
      const n = (await tx.query(`SELECT count(*)::int AS n FROM outbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL`, [actor.tenantId])).rows[0].n as number;
      if (n >= MAX_ENDPOINTS) throw Errors.conflict(`A workspace can have at most ${MAX_ENDPOINTS} webhooks`);
      await tx.query(
        `INSERT INTO outbound_endpoints (id, tenant_id, name, url, secret_enc, secret_hint, events, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8)`,
        [id, actor.tenantId, input.name.trim(), input.url.trim(), encryptField(secret, secretAad(id)), secret.slice(-4), [...new Set(input.events)], actor.userId]
      );
      await audit(tx, { action: 'webhook.create', entityType: 'webhook', entityId: id, after: { name: input.name.trim(), url: new URL(input.url).origin, events: input.events } });
      await emit(tx, { type: 'integration.updated', aggregateId: id, payload: { change: 'webhook_created' } });
      return { webhook: await this.fetch(tx, actor.tenantId, id), secret };
    });
  }

  async update(actor: Actor, id: string, patch: { name?: string; url?: string; events?: OutboundEvent[]; status?: 'active' | 'paused' }): Promise<WebhookDto> {
    assertCan(actor, 'integrations:manage');
    if (patch.url !== undefined) await this.validateUrl(patch.url);
    return this.db.withTenant(actor, async (tx) => {
      const cur = (await tx.query(`SELECT status FROM outbound_endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId])).rows[0];
      if (!cur) throw Errors.notFound('Webhook');
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.name !== undefined) set('name', patch.name.trim());
      if (patch.url !== undefined) set('url', patch.url.trim());
      if (patch.events !== undefined) set('events', [...new Set(patch.events)], '::text[]');
      if (patch.status !== undefined) {
        set('status', patch.status);
        // Switching it back on is a fresh start: forget the failures that disabled it.
        if (patch.status === 'active') sets.push(`consecutive_failures = 0`, `disabled_reason = NULL`);
      }
      if (sets.length) await tx.query(`UPDATE outbound_endpoints SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      await audit(tx, { action: 'webhook.update', entityType: 'webhook', entityId: id, after: { changed: Object.keys(patch) } });
      await emit(tx, { type: 'integration.updated', aggregateId: id, payload: { change: 'webhook_updated' } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  async rotateSecret(actor: Actor, id: string): Promise<{ webhook: WebhookDto; secret: string }> {
    assertCan(actor, 'integrations:manage');
    const secret = newSecret();
    return this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE outbound_endpoints SET secret_enc = $3, secret_hint = $4 WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`, [id, actor.tenantId, encryptField(secret, secretAad(id)), secret.slice(-4)]);
      if (!r.rowCount) throw Errors.notFound('Webhook');
      await audit(tx, { action: 'webhook.rotate_secret', entityType: 'webhook', entityId: id });
      return { webhook: await this.fetch(tx, actor.tenantId, id), secret };
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'integrations:delete');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE outbound_endpoints SET deleted_at = now(), status = 'paused' WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING name`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Webhook');
      await audit(tx, { action: 'webhook.delete', entityType: 'webhook', entityId: id, before: { name: r.rows[0].name } });
    });
  }

  async deliveries(actor: Actor, q: { endpointId?: string; status?: string; limit: number; cursor?: string }): Promise<{ items: DeliveryDto[]; page: PageInfo }> {
    assertCan(actor, 'integrations:manage');
    const sig = 'outbound-deliveries';
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['d.tenant_id = $1'];
      if (q.endpointId) { params.push(q.endpointId); where.push(`d.endpoint_id = $${params.length}`); }
      if (q.status) { params.push(q.status); where.push(`d.status = $${params.length}`); }
      const pred = cursorPredicate(cursor, params, 'd.created_at', 'd.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `SELECT d.id, d.endpoint_id, e.name AS endpoint_name, d.event_type, d.is_test, d.status, d.attempts, d.response_status, d.response_ms, d.error, d.created_at, d.created_at::text AS _k, d.delivered_at
           FROM outbound_deliveries d JOIN outbound_endpoints e ON e.id = d.endpoint_id AND e.tenant_id = d.tenant_id
          WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return {
        items: items.map((r) => ({
          id: r.id, endpointId: r.endpoint_id, endpointName: r.endpoint_name, event: r.event_type, isTest: r.is_test, status: r.status, attempts: r.attempts,
          responseStatus: r.response_status, responseMs: r.response_ms, error: r.error, createdAt: r.created_at, deliveredAt: r.delivered_at,
        })),
        page,
      };
    });
  }

  /** Put a failed message back in the queue. Only failed ones: a delivered message is never sent twice. */
  async retry(actor: Actor, deliveryId: string): Promise<void> {
    assertCan(actor, 'integrations:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE outbound_deliveries SET status = 'pending', error = NULL WHERE id = $1 AND tenant_id = $2 AND status IN ('failed', 'dead') AND NOT is_test RETURNING id`, [deliveryId, actor.tenantId]);
      if (!r.rowCount) throw Errors.conflict('Only a failed message can be sent again');
      await enqueue(tx, { type: 'webhook.deliver', payload: { deliveryId }, dedupeKey: `wh-retry:${deliveryId}:${Date.now()}`, maxAttempts: 6 });
    });
  }

  /** Sends a "ping" right now and shows what the receiver answered, so the address and the signature check can be verified in one click. */
  async sendTest(actor: Actor, id: string): Promise<{ ok: boolean; status: number | null; ms: number | null; error: string | null }> {
    assertCan(actor, 'integrations:manage');
    return deliverNow(this.db, actor, id);
  }
}

