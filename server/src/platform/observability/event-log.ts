import { redactSensitiveData, logger } from '../../logger';
import type { Database } from '../db';

/**
 * Persistent, workspace-visible activity log (table `operational_logs`).
 *
 * stdout JSON logs remain the complete record (shipped to the log pipeline). This is the curated subset a workspace admin sees in the
 * Monitor panel: server errors, security denials, slow requests, failed jobs, rejected lead deliveries.
 *
 * Design rules:
 *   - never on the request path: entries are buffered in memory and written in batches (one INSERT per tenant per flush)
 *   - bounded: at most MAX_BUFFER entries wait; beyond that the oldest are dropped and counted (a log write must never take the API down)
 *   - redacted: context goes through the same redaction as stdout logs, and message/context are size-capped
 *   - tenant rows are written inside a tenant transaction so RLS applies; platform rows (no tenant) are only visible to operators
 */
export type Severity = 'info' | 'warn' | 'error' | 'fatal';
export interface EventInput {
  tenantId?: string | null;
  userId?: string | null;
  component: 'api' | 'security' | 'worker' | 'inbound' | 'system' | (string & {});
  severity: Severity;
  message: string;
  context?: Record<string, unknown>;
  correlationId?: string;
  /** At most one entry per key per minute; the next one written reports how many were suppressed. Stops a scanner or a hot loop from flooding the log. */
  throttleKey?: string;
  /** When it happened (defaults to now). Entries flushed together must still sort in the order they occurred. */
  at?: Date;
}

const MAX_BUFFER = 1000;
const FLUSH_MS = 2000;
const BATCH = 50;
let buffer: EventInput[] = [];
let dropped = 0;
let timer: NodeJS.Timeout | undefined;
let target: (() => Database) | undefined;
let flushing: Promise<void> | undefined;
const THROTTLE_MS = 60_000;
const throttle = new Map<string, { at: number; suppressed: number }>();

/** Which database the entries are written with (API: default pool; worker: its own). */
export function bindEventLog(getDb: () => Database): void {
  target = getDb;
}
export const eventLogStats = () => ({ buffered: buffer.length, dropped });

export function recordEvent(e: EventInput): void {
  if (process.env.EVENT_LOG === 'off') return;
  if (e.throttleKey) {
    const key = `${e.tenantId ?? '-'}:${e.throttleKey}`;
    const now = Date.now();
    const t = throttle.get(key);
    if (t && now - t.at < THROTTLE_MS) {
      t.suppressed++;
      return;
    }
    if (throttle.size > 5000) throttle.clear();
    throttle.set(key, { at: now, suppressed: 0 });
    if (t?.suppressed) e = { ...e, context: { ...e.context, suppressedSincePrevious: t.suppressed } };
  }
  e = { ...e, at: e.at ?? new Date() };
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped++;
  }
  buffer.push(e);
  if (!timer) {
    timer = setTimeout(() => void flushEvents(), FLUSH_MS);
    timer.unref?.();
  }
  if (buffer.length >= BATCH) void flushEvents();
}

const text = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

export function flushEvents(): Promise<void> {
  if (flushing) return flushing;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const batch = buffer;
  buffer = [];
  if (!batch.length || !target) return Promise.resolve();
  const db = target();
  flushing = (async () => {
    // group by tenant: RLS needs a tenant context to accept the row
    const byTenant = new Map<string | null, EventInput[]>();
    for (const e of batch) byTenant.set(e.tenantId ?? null, [...(byTenant.get(e.tenantId ?? null) ?? []), e]);
    for (const [tenantId, rows] of byTenant) {
      try {
        const values: unknown[] = [];
        const tuples = rows.map((r, i) => {
          const o = i * 8;
          values.push(tenantId, r.component.slice(0, 40), r.severity, text(r.message, 500), JSON.stringify(redactSensitiveData(r.context ?? {})), r.correlationId ?? null, r.userId ?? null, r.at ?? new Date());
          return `($${o + 1}::uuid,$${o + 2},$${o + 3},$${o + 4},$${o + 5}::jsonb,$${o + 6},$${o + 7}::uuid,$${o + 8}::timestamptz)`;
        });
        const sql = `INSERT INTO operational_logs (tenant_id, component, severity, message, context, correlation_id, user_id, created_at) VALUES ${tuples.join(',')}`;
        if (tenantId) await db.withTenant({ tenantId }, (tx) => tx.query(sql, values), { retries: 0 });
        else await db.query(sql, values);
      } catch (err: any) {
        // Observability must never become an outage: say so once on stdout and move on.
        logger.warn('Activity log write failed', { error: err?.message, entries: rows.length });
      }
    }
  })().finally(() => {
    flushing = undefined;
    if (buffer.length) timer ??= setTimeout(() => void flushEvents(), FLUSH_MS);
  });
  return flushing;
}
