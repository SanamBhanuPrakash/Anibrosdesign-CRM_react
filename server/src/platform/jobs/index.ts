import pg from 'pg';
import os from 'os';
import crypto from 'crypto';
import type { Database } from '../db';
import { Logger, logger as rootLogger } from '../../logger';
import { recordEvent } from '../observability/event-log';

/**
 * Durable job queue on PostgreSQL (SELECT … FOR UPDATE SKIP LOCKED) with leases.
 *
 *   enqueue()   runs INSIDE the caller's transaction (outbox semantics): job exists iff the business change committed.
 *   JobRunner   claims jobs with a lease, heartbeats while running, completes/fails with ownership checks,
 *               retries with exponential backoff + full jitter, dead-letters after max_attempts or on PermanentJobError,
 *               and a reaper returns jobs whose worker died (lease expired) to the queue.
 *
 * Semantics: at-least-once. Handlers MUST be idempotent (use dedupe keys / provider idempotency keys).
 * No database transaction is held open while a handler runs.
 */

type Queryable = Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>;

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  /** undefined → current transaction tenant; null → platform job (worker-only); string → explicit tenant. */
  tenantId?: string | null;
  delaySeconds?: number;
  priority?: number;
  maxAttempts?: number;
  /** (type, dedupeKey) is unique: re-enqueueing the same logical work is a no-op. Returns null when deduped. */
  dedupeKey?: string;
}

export async function enqueue(client: Queryable, job: EnqueueInput): Promise<string | null> {
  const { rows } = await (client as pg.Pool).query(
    `INSERT INTO jobs (tenant_id, type, payload, run_at, priority, max_attempts, dedupe_key)
     VALUES (
       COALESCE($1::uuid, CASE WHEN $2::boolean THEN NULL ELSE app.current_tenant_id() END),
       $3, $4::jsonb, now() + make_interval(secs => $5::int), $6, $7, $8
     )
     ON CONFLICT (type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      typeof job.tenantId === 'string' ? job.tenantId : null,
      job.tenantId === null,
      job.type,
      JSON.stringify(job.payload ?? {}),
      Math.max(0, Math.floor(job.delaySeconds ?? 0)),
      job.priority ?? 0,
      job.maxAttempts ?? 8,
      job.dedupeKey ?? null,
    ]
  );
  return rows[0]?.id ?? null;
}

export class PermanentJobError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
/** Throw to reschedule at a specific delay without counting it as a failure reason (e.g. provider Retry-After). */
export class RetryAfterError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message);
    this.name = 'RetryAfterError';
  }
}

export interface JobRecord {
  id: string;
  tenantId: string | null;
  type: string;
  payload: Record<string, any>;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
}

export interface JobContext {
  db: Database;
  log: Logger;
  signal: AbortSignal;
  /** Run `fn` in a transaction scoped to the job's tenant (RLS enforced). */
  withTenant<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
}

export type JobHandler = (job: JobRecord, ctx: JobContext) => Promise<unknown>;

export interface RunnerOptions {
  workerId?: string;
  concurrency?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  /** Connection string used for the dedicated LISTEN connection (instant wake-up on enqueue). Optional. */
  listenConnectionString?: string;
}

export function backoffSeconds(attempt: number): number {
  const cap = Math.min(3600, 5 * 2 ** Math.max(0, attempt));
  return Math.max(1, Math.round(Math.random() * cap));
}

export class JobRunner {
  readonly workerId: string;
  private concurrency: number;
  private leaseSeconds: number;
  private pollIntervalMs: number;
  private running = false;
  private inflight = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private reaperTimer?: NodeJS.Timeout;
  private listener?: pg.Client;
  private ticking = false;
  private wakeRequested = false;
  readonly counters = { claimed: 0, succeeded: 0, retried: 0, dead: 0, leaseLost: 0 };

  constructor(
    private db: Database,
    private handlers: Record<string, JobHandler>,
    private opts: RunnerOptions = {}
  ) {
    this.workerId = opts.workerId ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
    this.concurrency = opts.concurrency ?? 8;
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.startListener();
    this.reaperTimer = setInterval(() => void this.reap().catch((e) => rootLogger.error('Job reaper failed', { error: e.message })), 30_000);
    this.reaperTimer.unref?.();
    this.schedule(0);
    rootLogger.info('Job runner started', { workerId: this.workerId, concurrency: this.concurrency });
  }

  /** Stop claiming; wait up to `graceMs` for in-flight handlers. Leases of unfinished jobs expire and are reaped. */
  async stop(graceMs = 25_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    await this.listener?.end().catch(() => undefined);
    const deadline = new Promise<void>((r) => setTimeout(r, graceMs));
    await Promise.race([Promise.allSettled([...this.inflight]), deadline]);
    rootLogger.info('Job runner stopped', { workerId: this.workerId, stillRunning: this.inflight.size });
  }

  private async startListener() {
    if (!this.opts.listenConnectionString) return;
    try {
      this.listener = new pg.Client({ connectionString: this.opts.listenConnectionString });
      this.listener.on('error', (e) => rootLogger.warn('Job LISTEN connection error (falling back to polling)', { error: e.message }));
      await this.listener.connect();
      await this.listener.query('LISTEN crm_jobs');
      this.listener.on('notification', () => this.wake());
    } catch (e: any) {
      rootLogger.warn('Could not start job LISTEN (polling only)', { error: e.message });
      this.listener = undefined;
    }
  }

  wake() {
    this.wakeRequested = true;
    if (this.running && !this.ticking) this.schedule(0);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    this.wakeRequested = false;
    let claimedAny = false;
    try {
      const slots = this.concurrency - this.inflight.size;
      if (slots > 0) {
        const jobs = await this.claim(slots);
        claimedAny = jobs.length > 0;
        for (const job of jobs) {
          const p = this.execute(job).finally(() => {
            this.inflight.delete(p);
            this.wake(); // a slot freed up: look for more immediately
          });
          this.inflight.add(p);
        }
      }
    } catch (e: any) {
      rootLogger.error('Job claim failed', { error: e.message });
    } finally {
      this.ticking = false;
      this.schedule(claimedAny || this.wakeRequested ? 0 : this.pollIntervalMs);
    }
  }

  async claim(limit: number): Promise<JobRecord[]> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, attempts = attempts + 1,
              lease_until = now() + make_interval(secs => $2::int)
        WHERE id IN (
          SELECT id FROM jobs
           WHERE status = 'queued' AND run_at <= now()
           ORDER BY priority DESC, run_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id AS "tenantId", type, payload, attempts, max_attempts AS "maxAttempts", correlation_id AS "correlationId"`,
      [this.workerId, this.leaseSeconds, limit]
    );
    this.counters.claimed += rows.length;
    return rows as JobRecord[];
  }

  private async execute(job: JobRecord): Promise<void> {
    const log = new Logger(job.correlationId ?? undefined).child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const handler = this.handlers[job.type];
    if (!handler) {
      await this.finish(job, 'dead', `No handler registered for job type "${job.type}"`);
      this.counters.dead++;
      return;
    }

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          `UPDATE jobs SET lease_until = now() + make_interval(secs => $3::int)
            WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [job.id, this.workerId, this.leaseSeconds]
        )
        .then((r) => {
          if (r.rowCount === 0) abort.abort(); // someone else owns it now
        })
        .catch(() => undefined);
    }, Math.max(1000, (this.leaseSeconds * 1000) / 3));

    const ctx: JobContext = {
      db: this.db,
      log,
      signal: abort.signal,
      withTenant: (fn) => {
        if (!job.tenantId) throw new Error('Platform job has no tenant context');
        return this.db.withTenant({ tenantId: job.tenantId, requestId: job.correlationId ?? undefined }, fn);
      },
    };

    try {
      const result = await handler(job, ctx);
      const ok = await this.finish(job, 'done', undefined, result);
      if (ok) this.counters.succeeded++;
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 2000);
      if (err instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        log.error('Job failed permanently', { error: message });
        recordEvent({ tenantId: job.tenantId, component: 'worker', severity: 'error', message: `Background job "${job.type}" failed permanently`, context: { jobId: job.id, jobType: job.type, attempts: job.attempts, error: message }, correlationId: job.correlationId ?? undefined });
        await this.finish(job, 'dead', message);
        this.counters.dead++;
      } else {
        const delay = err instanceof RetryAfterError ? err.delaySeconds : backoffSeconds(job.attempts);
        log.warn('Job failed; will retry', { error: message, retryInSeconds: delay });
        await this.finish(job, 'queued', message, undefined, delay);
        this.counters.retried++;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finish(
    job: JobRecord,
    status: 'done' | 'dead' | 'queued',
    error?: string,
    result?: unknown,
    delaySeconds = 0
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE jobs
          SET status = $3::job_status, last_error = $4, result = $5::jsonb,
              run_at = CASE WHEN $3::job_status = 'queued' THEN now() + make_interval(secs => $6::int) ELSE run_at END,
              finished_at = CASE WHEN $3::job_status IN ('done','dead') THEN now() ELSE NULL END,
              lease_until = NULL, locked_by = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [job.id, this.workerId, status, error ?? null, result === undefined ? null : JSON.stringify(result), delaySeconds]
    );
    if (rowCount === 0) {
      this.counters.leaseLost++;
      rootLogger.warn('Job completion ignored: lease no longer owned', { jobId: job.id, workerId: this.workerId });
      return false;
    }
    return true;
  }

  /** Return jobs whose worker vanished (lease expired) to the queue, or dead-letter them if out of attempts. */
  async reap(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status ELSE 'queued'::job_status END,
              last_error = 'lease expired (worker lost)', run_at = now(), lease_until = NULL, locked_by = NULL,
              finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
        WHERE status = 'running' AND lease_until < now()`
    );
    if (rowCount) rootLogger.warn('Reaped expired job leases', { count: rowCount });
    return rowCount ?? 0;
  }

  /** Test/ops helper: process until nothing is runnable. */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const jobs = await this.claim(this.concurrency);
      if (jobs.length === 0 && this.inflight.size === 0) return;
      await Promise.all(jobs.map((j) => this.execute(j)));
      if (jobs.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('drain: exceeded max rounds (jobs keep re-queuing?)');
  }
}
