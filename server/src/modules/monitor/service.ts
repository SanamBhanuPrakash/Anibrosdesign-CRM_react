import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { redactSensitiveData } from '../../logger';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { escapeLike } from '../contacts/normalize';
import { toCsv } from '../leads/csv';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  id: 'database' | 'worker' | 'queue' | 'intake' | 'errors';
  label: string;
  status: CheckStatus;
  detail: string;
}
export interface Overview {
  generatedAt: string;
  status: 'healthy' | 'attention' | 'problem';
  summary: string;
  checks: Check[];
  queue: { queued: number; running: number; deadLast7d: number; oldestWaitingSeconds: number };
  intake: { activeSources: number; pausedSources: number; deliveries24h: Record<string, number>; quietSources: Array<{ id: string; name: string; lastReceivedAt: string }> };
  /** Aggregates only; absent for roles that cannot see leads (e.g. auditors). */
  leads: { created24h: number; created7d: number; bySource7d: Array<{ source: string; n: number }>; firstReplyOverdue: number; tasksOverdue: number } | null;
  events: { errors24h: number; security24h: number; warnings24h: number };
  audit: { actions24h: number };
  recent: Array<{ id: string; at: string; severity: string; component: string; message: string }>;
}
export interface EventRow {
  id: string;
  at: string;
  severity: 'info' | 'warn' | 'error' | 'fatal';
  component: string;
  message: string;
  requestId: string | null;
  userName: string | null;
  context: Record<string, unknown>;
}
export interface AuditRow {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actorName: string | null;
  ip: string | null;
  requestId: string | null;
}
export interface AuditFilters {
  action?: string;
  entityType?: string;
  actorId?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

const HEARTBEAT_WARN_S = 45;
const HEARTBEAT_FAIL_S = 120;

export class MonitorService {
  constructor(private db: Database) {}

  async overview(actor: Actor): Promise<Overview> {
    assertCan(actor, 'operations:read');
    const t = actor.tenantId;
    const canSeeLeads = scopeIfAllowed(actor, 'leads:read') === 'all';
    const started = Date.now();
    return this.db.readTenant(actor, async (tx) => {
      const ping = await tx.query('SELECT 1');
      const dbMs = Date.now() - started;
      void ping;
      const [jobs, oldest, dead, health, srcs, deliveries, quiet, ev24, recent, audits] = await Promise.all([
        tx.query(`SELECT status::text AS status, count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND status IN ('queued','running') GROUP BY 1`, [t]),
        tx.query(`SELECT COALESCE(extract(epoch FROM now() - min(run_at)), 0)::int AS s FROM jobs WHERE tenant_id = $1 AND status = 'queued' AND run_at <= now()`, [t]),
        tx.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND status = 'dead' AND finished_at > now() - interval '7 days'`, [t]),
        tx.query(`SELECT component, status, extract(epoch FROM now() - last_checked_at)::int AS age FROM app.platform_health()`),
        tx.query(`SELECT status, count(*)::int AS n FROM inbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY 1`, [t]),
        tx.query(`SELECT status, count(*)::int AS n FROM inbound_events WHERE tenant_id = $1 AND received_at > now() - interval '24 hours' GROUP BY 1`, [t]),
        tx.query(`SELECT id, name, last_received_at FROM inbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active' AND last_received_at IS NOT NULL AND last_received_at < now() - interval '24 hours' ORDER BY last_received_at LIMIT 5`, [t]),
        tx.query(`SELECT severity, component, count(*)::int AS n FROM operational_logs WHERE tenant_id = $1 AND created_at > now() - interval '24 hours' AND severity IN ('warn','error','fatal') GROUP BY 1, 2`, [t]),
        tx.query(`SELECT id, created_at, severity, component, message FROM operational_logs WHERE tenant_id = $1 AND severity IN ('warn','error','fatal') ORDER BY created_at DESC, id DESC LIMIT 8`, [t]),
        tx.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND created_at > now() - interval '24 hours'`, [t]),
      ]);

      const jobN = (s: string) => jobs.rows.find((r) => r.status === s)?.n ?? 0;
      const queue = { queued: jobN('queued'), running: jobN('running'), deadLast7d: dead.rows[0].n as number, oldestWaitingSeconds: oldest.rows[0].s as number };
      const workerRow = health.rows.find((r) => r.component === 'worker');
      const srcN = (s: string) => srcs.rows.find((r) => r.status === s)?.n ?? 0;
      const deliveries24h: Record<string, number> = { received: 0, created: 0, duplicate: 0, needs_review: 0, ignored: 0, failed: 0 };
      for (const r of deliveries.rows) deliveries24h[r.status] = r.n;
      const errors24h = ev24.rows.filter((r) => r.severity === 'error' || r.severity === 'fatal').reduce((a, r) => a + r.n, 0);
      const security24h = ev24.rows.filter((r) => r.component === 'security').reduce((a, r) => a + r.n, 0);
      const warnings24h = ev24.rows.filter((r) => r.severity === 'warn').reduce((a, r) => a + r.n, 0);

      let leads: Overview['leads'] = null;
      if (canSeeLeads) {
        const [l, bySource, sla, tasks] = await Promise.all([
          tx.query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS d1, count(*)::int AS d7 FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND created_at > now() - interval '7 days'`, [t]),
          tx.query(`SELECT source::text AS source, count(*)::int AS n FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`, [t]),
          tx.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND closed_at IS NULL AND first_response_at IS NULL AND first_response_due_at < now()`, [t]),
          tx.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND deleted_at IS NULL AND status IN ('pending','in_progress') AND due_date < now()`, [t]),
        ]);
        leads = { created24h: l.rows[0].d1, created7d: l.rows[0].d7, bySource7d: bySource.rows as Array<{ source: string; n: number }>, firstReplyOverdue: sla.rows[0].n, tasksOverdue: tasks.rows[0].n };
      }

      const checks: Check[] = [];
      checks.push({ id: 'database', label: 'Database', status: dbMs > 1500 ? 'warn' : 'ok', detail: dbMs > 1500 ? `Slow to answer (${dbMs} ms)` : `Responding in ${dbMs} ms` });
      checks.push(
        !workerRow
          ? { id: 'worker', label: 'Background worker', status: 'fail', detail: 'No heartbeat yet. Emails, reminders and lead intake are not being processed.' }
          : workerRow.age > HEARTBEAT_FAIL_S
            ? { id: 'worker', label: 'Background worker', status: 'fail', detail: `Silent for ${fmtAge(workerRow.age)}. Emails, reminders and lead intake are not being processed.` }
            : workerRow.age > HEARTBEAT_WARN_S
              ? { id: 'worker', label: 'Background worker', status: 'warn', detail: `Last heartbeat ${fmtAge(workerRow.age)} ago` }
              : { id: 'worker', label: 'Background worker', status: 'ok', detail: `Running (heartbeat ${fmtAge(workerRow.age)} ago)` }
      );
      checks.push(
        queue.deadLast7d > 0
          ? { id: 'queue', label: 'Job queue', status: 'warn', detail: `${queue.deadLast7d} background ${queue.deadLast7d === 1 ? 'job' : 'jobs'} failed for good in the last 7 days` }
          : queue.oldestWaitingSeconds > 300
            ? { id: 'queue', label: 'Job queue', status: 'warn', detail: `Oldest waiting job has been queued for ${fmtAge(queue.oldestWaitingSeconds)}` }
            : { id: 'queue', label: 'Job queue', status: 'ok', detail: queue.queued || queue.running ? `${queue.queued} waiting, ${queue.running} running` : 'Nothing waiting' }
      );
      const needs = deliveries24h.needs_review + deliveries24h.failed;
      checks.push(
        needs > 0
          ? { id: 'intake', label: 'Lead intake', status: deliveries24h.failed > 0 ? 'fail' : 'warn', detail: `${needs} ${needs === 1 ? 'delivery needs' : 'deliveries need'} attention. A lead may be waiting.` }
          : quiet.rows.length
            ? { id: 'intake', label: 'Lead intake', status: 'warn', detail: `No leads from ${quiet.rows.map((r) => r.name).join(', ')} in over 24 hours` }
            : srcN('active') + srcN('paused') === 0
              ? { id: 'intake', label: 'Lead intake', status: 'ok', detail: 'No lead sources connected yet' }
              : { id: 'intake', label: 'Lead intake', status: 'ok', detail: `${srcN('active')} active ${srcN('active') === 1 ? 'source' : 'sources'}, ${deliveries24h.created + deliveries24h.duplicate} ${deliveries24h.created + deliveries24h.duplicate === 1 ? 'lead' : 'leads'} in 24 h` }
      );
      checks.push(
        errors24h > 0
          ? { id: 'errors', label: 'Errors', status: errors24h >= 10 ? 'fail' : 'warn', detail: `${errors24h} ${errors24h === 1 ? 'error' : 'errors'} in the last 24 hours` }
          : { id: 'errors', label: 'Errors', status: 'ok', detail: warnings24h ? `None in 24 h (${warnings24h} warning${warnings24h === 1 ? '' : 's'})` : 'None in the last 24 hours' }
      );

      const worst = checks.some((c) => c.status === 'fail') ? 'problem' : checks.some((c) => c.status === 'warn') ? 'attention' : 'healthy';
      return {
        generatedAt: new Date().toISOString(),
        status: worst,
        summary: worst === 'healthy' ? 'Everything is running normally.' : worst === 'attention' ? 'Something needs a look, but nothing is down.' : 'Something is wrong and may be costing you leads.',
        checks,
        queue,
        intake: { activeSources: srcN('active'), pausedSources: srcN('paused'), deliveries24h, quietSources: quiet.rows.map((r) => ({ id: r.id, name: r.name, lastReceivedAt: r.last_received_at })) },
        leads,
        events: { errors24h, security24h, warnings24h },
        audit: { actions24h: audits.rows[0].n },
        recent: recent.rows.map((r) => ({ id: r.id, at: r.created_at, severity: r.severity, component: r.component, message: r.message })),
      } satisfies Overview;
    });
  }

  // ── activity log ─────────────────────────────────────────────────────────────

  async events(actor: Actor, q: { severity?: 'info' | 'warn' | 'error'; component?: string; q?: string; from?: string; to?: string; limit: number; cursor?: string }): Promise<{ items: EventRow[]; page: PageInfo }> {
    assertCan(actor, 'operations:read');
    const sig = `monitor-events:${q.severity ?? ''}:${q.component ?? ''}`;
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['l.tenant_id = $1'];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
      if (q.severity === 'error') where.push(`l.severity IN ('error','fatal')`);
      else if (q.severity === 'warn') where.push(`l.severity IN ('warn','error','fatal')`);
      if (q.component) add('l.component = ?', q.component);
      if (q.q) add(`l.message ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.q)}%`);
      if (q.from) add('l.created_at >= ?::timestamptz', q.from);
      if (q.to) add('l.created_at < ?::timestamptz', q.to);
      const pred = cursorPredicate(cursor, params, 'l.created_at', 'l.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `SELECT l.id, l.created_at, l.created_at::text AS _k, l.severity, l.component, l.message, l.correlation_id, l.context, u.name AS user_name
           FROM operational_logs l LEFT JOIN users u ON u.id = l.user_id
          WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return { items: items.map((r) => ({ id: r.id, at: r.created_at, severity: r.severity, component: r.component, message: r.message, requestId: r.correlation_id, userName: r.user_name, context: redactSensitiveData(r.context) })), page };
    });
  }

  // ── audit trail ──────────────────────────────────────────────────────────────

  private auditWhere(actor: Actor, f: AuditFilters, params: unknown[]): string[] {
    const where = ['a.tenant_id = $1'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.action) {
      // "lead" matches lead.create, lead.update …; "lead.create" matches itself. starts_with, not LIKE: action names contain "_".
      params.push(f.action);
      where.push(`(a.action = $${params.length} OR starts_with(a.action, $${params.length} || '.'))`);
    }
    if (f.entityType) add('a.entity_type = ?', f.entityType);
    if (f.actorId) add('a.actor_id = ?::uuid', f.actorId);
    if (f.entityId) add('a.entity_id = ?::uuid', f.entityId);
    if (f.from) add('a.created_at >= ?::timestamptz', f.from);
    if (f.to) add('a.created_at < ?::timestamptz', f.to);
    void actor;
    return where;
  }

  async audit(actor: Actor, q: AuditFilters & { limit: number; cursor?: string }): Promise<{ items: AuditRow[]; page: PageInfo }> {
    assertCan(actor, 'audit:read');
    const sig = `audit:${q.action ?? ''}:${q.entityType ?? ''}:${q.actorId ?? ''}`;
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = this.auditWhere(actor, q, params);
      const pred = cursorPredicate(cursor, params, 'a.created_at', 'a.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `SELECT a.id, a.created_at, a.created_at::text AS _k, a.action, a.entity_type, a.entity_id, a.actor_id, u.name AS actor_name, a.ip_address, a.correlation_id
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
          WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return { items: items.map(toAuditRow), page };
    });
  }

  async auditDetail(actor: Actor, id: string): Promise<AuditRow & { before: unknown; after: unknown }> {
    assertCan(actor, 'audit:read');
    return this.db.readTenant(actor, async (tx) => {
      const r = (await tx.query(
        `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.actor_id, u.name AS actor_name, a.ip_address, a.correlation_id, a.before_state, a.after_state
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.id = $1 AND a.tenant_id = $2`,
        [id, actor.tenantId]
      )).rows[0];
      if (!r) throw Errors.notFound('Audit entry');
      return { ...toAuditRow(r), before: redactSensitiveData(r.before_state) ?? null, after: redactSensitiveData(r.after_state) ?? null };
    });
  }

  /** Filter choices for the explorer (what actually occurs in this workspace, last 90 days). */
  async auditFacets(actor: Actor): Promise<{ actions: string[]; entityTypes: string[]; people: Array<{ id: string; name: string }> }> {
    assertCan(actor, 'audit:read');
    return this.db.readTenant(actor, async (tx) => {
      const [a, e, p] = await Promise.all([
        tx.query(`SELECT DISTINCT action FROM audit_logs WHERE tenant_id = $1 AND created_at > now() - interval '90 days' ORDER BY 1 LIMIT 300`, [actor.tenantId]),
        tx.query(`SELECT DISTINCT entity_type FROM audit_logs WHERE tenant_id = $1 AND created_at > now() - interval '90 days' ORDER BY 1 LIMIT 100`, [actor.tenantId]),
        tx.query(`SELECT DISTINCT u.id, u.name FROM audit_logs a JOIN users u ON u.id = a.actor_id WHERE a.tenant_id = $1 AND a.created_at > now() - interval '90 days' ORDER BY u.name LIMIT 200`, [actor.tenantId]),
      ]);
      return { actions: a.rows.map((r) => r.action), entityTypes: e.rows.map((r) => r.entity_type), people: p.rows };
    });
  }

  /** CSV of the filtered trail (max 10,000 rows). Exporting is itself recorded in the trail. */
  async auditCsv(actor: Actor, f: AuditFilters): Promise<{ csv: string; rows: number }> {
    assertCan(actor, 'audit:read');
    return this.db.withTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = this.auditWhere(actor, f, params);
      const { rows } = await tx.query(
        `SELECT a.created_at, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.ip_address, a.correlation_id
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
          WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT 10000`,
        params
      );
      await audit(tx, { action: 'audit.export', entityType: 'audit_log', entityId: actor.tenantId, after: { rows: rows.length, filters: f } });
      return { csv: toCsv(['When', 'Who', 'Action', 'Record type', 'Record id', 'IP address', 'Request id'], rows.map((r) => [r.created_at, r.actor_name ?? 'System', r.action, r.entity_type, r.entity_id, r.ip_address, r.correlation_id])), rows: rows.length };
    });
  }
}

const fmtAge = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const toAuditRow = (r: any): AuditRow => ({ id: r.id, at: r.created_at, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actorId: r.actor_id, actorName: r.actor_name, ip: r.ip_address, requestId: r.correlation_id });
