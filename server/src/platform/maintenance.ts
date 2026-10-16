import type { Database } from './db';
import { logger } from '../logger';
import { jobsOldestAge, jobsQueueDepth, eventConsumerLag } from './observability/metrics';

/**
 * Scheduled housekeeping, run by the worker (the only role with DELETE on these tables; the identity tables are purged through app.purge_identity).
 * Retention is a data-protection control as much as a cost control: tokens, attempts, logs and keys do not live forever.
 */
const RETENTION_SQL: Array<{ name: string; sql: string }> = [
  { name: 'login_attempts', sql: `SELECT app.purge_identity('login_attempts') AS n` },
  { name: 'idempotency_keys', sql: `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'` },
  { name: 'jobs_done', sql: `DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '7 days'` },
  { name: 'jobs_dead', sql: `DELETE FROM jobs WHERE status = 'dead' AND finished_at < now() - interval '30 days'` },
  { name: 'domain_events', sql: `DELETE FROM domain_events WHERE occurred_at < now() - interval '14 days' AND tx_id < pg_snapshot_xmin(pg_current_snapshot())` },
  // Raw deliveries hold personal data (names, phones). Keep a month for support and replay, then remove.
  { name: 'inbound_events', sql: `DELETE FROM inbound_events WHERE received_at < now() - interval '30 days' AND status <> 'received'` },
  { name: 'rate_buckets', sql: `SELECT app.rate_purge()` },
  { name: 'outbound_deliveries', sql: `DELETE FROM outbound_deliveries WHERE created_at < now() - interval '30 days' AND status <> 'pending'` },
  { name: 'operational_logs', sql: `DELETE FROM operational_logs WHERE created_at < now() - interval '30 days'` },
  { name: 'verification_tokens', sql: `SELECT app.purge_identity('verification_tokens') AS n` },
  { name: 'reset_tokens', sql: `SELECT app.purge_identity('reset_tokens') AS n` },
  { name: 'sessions', sql: `SELECT app.purge_identity('sessions') AS n` },
];

export async function runMaintenance(db: Database): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of RETENTION_SQL) {
    try {
      const r = await db.query(t.sql);
      out[t.name] = typeof r.rows[0]?.n === 'number' ? r.rows[0].n : (r.rowCount ?? 0); // the identity tables are purged through one function: the worker cannot read them
    } catch (e: any) {
      logger.error('Retention task failed', { task: t.name, error: e.message });
      out[t.name] = -1;
    }
  }
  return out;
}

export async function refreshQueueGauges(db: Database): Promise<void> {
  const [byStatus, oldest, lag] = await Promise.all([
    db.query<{ status: string; n: string }>(`SELECT status::text, count(*)::text AS n FROM jobs GROUP BY status`),
    db.query<{ age: string | null }>(`SELECT extract(epoch FROM now() - min(run_at))::text AS age FROM jobs WHERE status = 'queued' AND run_at <= now()`),
    db.query<{ name: string; lag: string }>(
      `SELECT c.name, (SELECT count(*) FROM domain_events e WHERE (e.tx_id, e.id) > (c.last_tx_id, c.last_event_id))::text AS lag FROM event_consumers c`
    ),
  ]);
  jobsQueueDepth.reset();
  for (const s of ['queued', 'running', 'done', 'dead']) jobsQueueDepth.set({ status: s }, 0);
  for (const r of byStatus.rows) jobsQueueDepth.set({ status: r.status }, Number(r.n));
  jobsOldestAge.set(Number(oldest.rows[0]?.age ?? 0));
  eventConsumerLag.reset();
  for (const r of lag.rows) eventConsumerLag.set({ consumer: r.name }, Number(r.lag));
}
