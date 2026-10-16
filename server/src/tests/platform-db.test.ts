import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { seedTenant, seedLead, type SeededTenant } from './support/fixtures';

/**
 * Wave-1 exit criteria, proven against a real PostgreSQL as the RESTRICTED runtime roles:
 *  (a) no tenant context ⇒ zero rows            (b) cross-tenant read/write denied even without WHERE tenant_id
 *  (c) events are transactional, ordered and at-least-once   (d) jobs are exactly-once under concurrency, leases recover
 */
type DbModule = typeof import('../platform/db');
type EventsModule = typeof import('../platform/events');
type JobsModule = typeof import('../platform/jobs');

let dbmod: DbModule;
let events: EventsModule;
let jobs: JobsModule;

describe('platform: database access layer, RLS, events, jobs', () => {
  let tdb: TestDatabase;
  let admin: pg.Client;
  let api: InstanceType<DbModule['Database']>;
  let worker: InstanceType<DbModule['Database']>;
  let A: SeededTenant;
  let B: SeededTenant;
  let leadA: string;
  let leadB: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Client({ connectionString: tdb.adminUrl });
    await admin.connect();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = tdb.apiUrl;
    process.env.WORKER_DATABASE_URL = tdb.workerUrl;
    dbmod = await import('../platform/db');
    events = await import('../platform/events');
    jobs = await import('../platform/jobs');
    api = new dbmod.Database(dbmod.createPool(tdb.apiUrl, 'test-api', 5));
    worker = new dbmod.Database(dbmod.createPool(tdb.workerUrl, 'test-worker', 5));

    A = await seedTenant(admin, 'alpha');
    B = await seedTenant(admin, 'bravo');
    leadA = (await seedLead(admin, A, 'Alice')).leadId;
    leadB = (await seedLead(admin, B, 'Bob')).leadId;
  }, 60_000);

  afterAll(async () => {
    await api?.end();
    await worker?.end();
    await admin?.end();
    await tdb?.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe('runtime role is genuinely restricted', () => {
    it('API and worker roles are neither superuser nor BYPASSRLS', async () => {
      for (const d of [api, worker]) {
        const info = await d.assertRuntimeRoleSafe('test');
        expect(info.superuser).toBe(false);
        expect(info.bypassRls).toBe(false);
        expect(info.ownsTables).toBe(false); // owners skip RLS unless FORCE is set
      }
    });

    it("the startup guard reports a table owner (the migrator connection) as unsafe, so production refuses it", async () => {
      const owner = new dbmod.Database(dbmod.createPool(tdb.adminUrl, "test-owner", 2));
      try {
        const info = await owner.assertRuntimeRoleSafe("test");
        expect(info.ownsTables).toBe(true);
      } finally {
        await owner.end();
      }
    });
    it('cannot create objects, touch migration history or open TEMP tables', async () => {
      await expect(api.query('CREATE TABLE evil (id int)')).rejects.toMatchObject({ code: '42501' });
      await expect(api.query('SELECT * FROM schema_migrations')).rejects.toMatchObject({ code: '42501' });
      await expect(api.query('CREATE TEMP TABLE leads (id int)')).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('tenant isolation (RLS) without relying on WHERE tenant_id', () => {
    it('(a) a query with no tenant context returns zero rows', async () => {
      expect((await api.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(0);
      expect((await api.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(0);
    });

    it('(b) tenant A sees only A; B sees only B — with deliberately NO tenant predicate', async () => {
      const a = await api.withTenant({ tenantId: A.tenantId, userId: A.userId }, (c) => c.query('SELECT id, tenant_id FROM leads'));
      expect(a.rows.map((r) => r.id)).toEqual([leadA]);
      const b = await api.withTenant({ tenantId: B.tenantId, userId: B.userId }, (c) => c.query('SELECT id, tenant_id FROM leads'));
      expect(b.rows.map((r) => r.id)).toEqual([leadB]);
    });

    it('A cannot UPDATE or DELETE B’s rows by id (silently 0 rows, not an error leak)', async () => {
      await api.withTenant({ tenantId: A.tenantId, userId: A.userId }, async (c) => {
        const up = await c.query(`UPDATE leads SET estimated_value = 1 WHERE id = $1`, [leadB]);
        const del = await c.query(`DELETE FROM leads WHERE id = $1`, [leadB]);
        expect(up.rowCount).toBe(0);
        expect(del.rowCount).toBe(0);
      });
      const still = await admin.query('SELECT estimated_value FROM leads WHERE id = $1', [leadB]);
      expect(Number(still.rows[0].estimated_value)).toBe(0);
    });

    it('A cannot INSERT a row into B (RLS WITH CHECK ⇒ 42501)', async () => {
      await expect(
        api.withTenant({ tenantId: A.tenantId, userId: A.userId }, (c) =>
          c.query(`INSERT INTO contacts (tenant_id, first_name) VALUES ($1, 'Intruder')`, [B.tenantId])
        )
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('context never leaks to the next use of a pooled connection', async () => {
      const single = new dbmod.Database(dbmod.createPool(tdb.apiUrl, 'test-single', 1));
      try {
        await single.withTenant({ tenantId: A.tenantId, userId: A.userId }, (c) => c.query('SELECT 1'));
        const after = await single.query(`SELECT current_setting('app.current_tenant_id', true) AS t`);
        expect(after.rows[0].t === '' || after.rows[0].t === null).toBe(true);
        expect((await single.query('SELECT count(*)::int n FROM leads')).rows[0].n).toBe(0);
      } finally {
        await single.end();
      }
    });

    it('readTenant is read-only', async () => {
      await expect(
        api.readTenant({ tenantId: A.tenantId }, (c) => c.query(`UPDATE leads SET estimated_value = 5`))
      ).rejects.toMatchObject({ code: '25006' });
    });

    it('rejects malformed tenant ids before touching the database (injection guard)', async () => {
      await expect(api.withTenant({ tenantId: "x'; DROP TABLE leads;--" }, async () => 1)).rejects.toThrow(/invalid tenantId/);
      await expect(api.withTenant({ tenantId: A.tenantId, userId: 'not-a-uuid' }, async () => 1)).rejects.toThrow(/invalid userId/);
    });

    it('request id from a client header cannot inject SQL (sanitised/regenerated)', async () => {
      const r = await api.withTenant({ tenantId: A.tenantId, requestId: "abc'); DROP TABLE leads;--" }, (c) =>
        c.query(`SELECT app.current_request_id() AS rid`)
      );
      expect(r.rows[0].rid).not.toContain('DROP');
      expect((await admin.query('SELECT count(*)::int n FROM leads')).rows[0].n).toBe(2);
    });

    it('queue tables: API sees only own tenant; worker role sees all', async () => {
      await admin.query(
        `INSERT INTO webhook_inbox (tenant_id, provider, event_type, provider_event_id, payload) VALUES ($1,'meta','leadgen','e1','{}'), ($2,'meta','leadgen','e2','{}'), (NULL,'meta','leadgen','e3','{}')`,
        [A.tenantId, B.tenantId]
      );
      const apiSees = await api.withTenant({ tenantId: A.tenantId }, (c) => c.query('SELECT provider_event_id FROM webhook_inbox'));
      expect(apiSees.rows.map((r) => r.provider_event_id)).toEqual(['e1']); // not e2 (other tenant), not e3 (unrouted)
      const workerSees = await worker.query('SELECT provider_event_id FROM webhook_inbox ORDER BY provider_event_id');
      expect(workerSees.rows.map((r) => r.provider_event_id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('platform-level operational logs and health are invisible to tenants (defect C7)', async () => {
      await admin.query(`INSERT INTO operational_logs (tenant_id, component, severity, message) VALUES (NULL,'worker','info','platform-secret-infra-detail'), ($1,'api','info','tenant-visible')`, [A.tenantId]);
      const seen = await api.withTenant({ tenantId: A.tenantId }, (c) => c.query('SELECT message FROM operational_logs'));
      expect(seen.rows.map((r) => r.message)).toEqual(['tenant-visible']);
    });

    it('API role cannot mutate or create platform jobs; cannot touch consumer cursors', async () => {
      await expect(api.withTenant({ tenantId: A.tenantId }, (c) => jobs.enqueue(c, { type: 'x', tenantId: null }))).rejects.toMatchObject({ code: '42501' });
      await expect(api.query(`UPDATE jobs SET status='done'`)).rejects.toMatchObject({ code: '42501' });
      await expect(api.query(`SELECT * FROM event_consumers`)).rejects.toMatchObject({ code: '42501' });
    });

    it('audit log is append-only for the API role', async () => {
      await api.withTenant({ tenantId: A.tenantId, userId: A.userId, requestId: 'req-audit-1', ip: '203.0.113.9' }, async (c) => {
        const { audit } = await import('../platform/audit');
        await audit(c, { action: 'lead.update', entityType: 'lead', entityId: leadA, before: { password: 'x', a: 1 }, after: { a: 2 } });
      });
      const row = (await admin.query(`SELECT actor_id, correlation_id, ip_address, before_state FROM audit_logs ORDER BY created_at DESC LIMIT 1`)).rows[0];
      expect(row.actor_id).toBe(A.userId);
      expect(row.correlation_id).toBe('req-audit-1');
      expect(row.ip_address).toBe('203.0.113.9');
      expect(row.before_state.password).toBe('[REDACTED]');
      await expect(api.query(`DELETE FROM audit_logs`)).rejects.toMatchObject({ code: '42501' });
      await expect(api.withTenant({ tenantId: A.tenantId }, (c) => c.query(`UPDATE audit_logs SET action='x'`))).rejects.toMatchObject({ code: '42501' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe('domain events (transactional outbox + cursor dispatcher)', () => {
    const ctxA = () => ({ tenantId: A.tenantId, userId: A.userId, requestId: 'req-evt' });

    it('(c) emit commits with the business change and carries actor/correlation from context', async () => {
      await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.created', aggregateId: leadA, payload: { source: 'website' } }));
      const row = (await admin.query(`SELECT * FROM domain_events WHERE aggregate_id = $1 ORDER BY id DESC LIMIT 1`, [leadA])).rows[0];
      expect(row.tenant_id).toBe(A.tenantId);
      expect(row.actor_user_id).toBe(A.userId);
      expect(row.correlation_id).toBe('req-evt');
      expect(row.aggregate_type).toBe('lead');
    });

    it('a rolled-back transaction produces NO event and NO notification', async () => {
      const listener = new pg.Client({ connectionString: tdb.adminUrl });
      await listener.connect();
      await listener.query('LISTEN crm_events');
      const received: any[] = [];
      listener.on('notification', (m) => received.push(JSON.parse(m.payload!)));
      const before = (await admin.query('SELECT count(*)::int n FROM domain_events')).rows[0].n;

      await expect(
        api.withTenant(ctxA(), async (c) => {
          await events.emit(c, { type: 'lead.updated', aggregateId: leadA });
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { ok: true } }));
      await new Promise((r) => setTimeout(r, 150));
      await listener.end();

      expect((await admin.query('SELECT count(*)::int n FROM domain_events')).rows[0].n).toBe(before + 1);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ t: A.tenantId, ty: 'lead.updated', a: 'lead', i: leadA });
      expect(JSON.stringify(received[0])).not.toMatch(/email|phone|name/i); // ids/types only
    });

    it('API cannot rewrite or delete events; cross-tenant event insert is blocked', async () => {
      await expect(api.withTenant(ctxA(), (c) => c.query(`UPDATE domain_events SET type='lead.deleted'`))).rejects.toMatchObject({ code: '42501' });
      await expect(api.withTenant(ctxA(), (c) => c.query(`DELETE FROM domain_events`))).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.withTenant(ctxA(), (c) => c.query(`INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id) VALUES ($1,'lead.created','lead',$2)`, [B.tenantId, leadB]))
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('rejects malformed event types and oversized payloads at the database', async () => {
      await expect(api.withTenant(ctxA(), (c) => c.query(`INSERT INTO domain_events (type, aggregate_type, aggregate_id) VALUES ('NOT VALID','x',$1)`, [leadA]))).rejects.toMatchObject({ code: '23514' });
      await expect(
        api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { blob: 'x'.repeat(5000) } }))
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('dispatcher: delivers in order, advances the cursor, is idempotent across runs', async () => {
      await admin.query('TRUNCATE domain_events, event_consumers');
      for (let i = 1; i <= 5; i++) await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { i } }));
      const seen: number[] = [];
      const dispatcher = new events.EventDispatcher(worker, [{ name: 'test', handle: async (evs) => void evs.forEach((e) => seen.push(Number(e.payload.i))) }], { batchSize: 3 });
      expect((await dispatcher.runOnce()).test).toBe(3);
      expect((await dispatcher.runOnce()).test).toBe(2);
      expect((await dispatcher.runOnce()).test).toBe(0);
      expect(seen).toEqual([1, 2, 3, 4, 5]);
    });

    it('dispatcher never skips an event that commits late (xmin horizon)', async () => {
      await admin.query('TRUNCATE domain_events, event_consumers');
      const order: string[] = [];
      const dispatcher = new events.EventDispatcher(worker, [{ name: 'gap', handle: async (evs) => void evs.forEach((e) => order.push(String(e.payload.tag))) }]);

      const slow = await api.pool.connect(); // transaction A: inserts first, commits LAST
      await slow.query(`BEGIN; SELECT set_config('app.current_tenant_id','${A.tenantId}',true)`);
      await events.emit(slow, { type: 'lead.updated', aggregateId: leadA, payload: { tag: 'A-slow' } });

      await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { tag: 'B-fast' } }));

      // B has a higher id but A is still in flight: delivering B now would let the cursor jump past A forever.
      expect((await dispatcher.runOnce()).gap).toBe(0);
      expect(order).toEqual([]);

      await slow.query('COMMIT');
      slow.release();
      expect((await dispatcher.runOnce()).gap).toBe(2);
      expect(order).toEqual(['A-slow', 'B-fast']);
    });

    it('a failing consumer does not advance its cursor (event is retried, not lost)', async () => {
      await admin.query('TRUNCATE domain_events, event_consumers');
      await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { tag: 'x' } }));
      let attempts = 0;
      const d = new events.EventDispatcher(worker, [{ name: 'flaky', handle: async () => { if (++attempts === 1) throw new Error('transient'); } }]);
      expect((await d.runOnce()).flaky).toBe(0);
      expect((await d.runOnce()).flaky).toBe(1);
      expect(attempts).toBe(2);
    });

    it('two dispatcher replicas never process the same consumer batch twice', async () => {
      await admin.query('TRUNCATE domain_events, event_consumers');
      for (let i = 0; i < 20; i++) await api.withTenant(ctxA(), (c) => events.emit(c, { type: 'lead.updated', aggregateId: leadA, payload: { i } }));
      const seen: number[] = [];
      const consumer = { name: 'dup', handle: async (evs: any[]) => { await new Promise((r) => setTimeout(r, 30)); evs.forEach((e) => seen.push(Number(e.payload.i))); } };
      const d1 = new events.EventDispatcher(worker, [consumer], { batchSize: 7 });
      const d2 = new events.EventDispatcher(worker, [consumer], { batchSize: 7 });
      for (let i = 0; i < 6; i++) await Promise.all([d1.runOnce(), d2.runOnce()]);
      expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe('job queue (leases, retries, dead-letter)', () => {
    const newRunner = (handlers: Record<string, any>, extra = {}) => new jobs.JobRunner(worker, handlers, { concurrency: 8, leaseSeconds: 30, ...extra });
    const enqueueA = (j: Parameters<JobsModule['enqueue']>[1]) => api.withTenant({ tenantId: A.tenantId, userId: A.userId }, (c) => jobs.enqueue(c, j));
    const status = async (id: string) => (await admin.query('SELECT status, attempts, last_error FROM jobs WHERE id = $1', [id])).rows[0];

    it('enqueue is transactional (rolled back with the business change) and deduplicates', async () => {
      await admin.query('TRUNCATE jobs');
      await expect(api.withTenant({ tenantId: A.tenantId }, async (c) => { await jobs.enqueue(c, { type: 't' }); throw new Error('x'); })).rejects.toThrow('x');
      expect((await admin.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(0);

      const first = await enqueueA({ type: 'dedupe', dedupeKey: 'evt:1' });
      const second = await enqueueA({ type: 'dedupe', dedupeKey: 'evt:1' });
      expect(first).toBeTruthy();
      expect(second).toBeNull();
      expect((await admin.query(`SELECT count(*)::int n FROM jobs WHERE type='dedupe'`)).rows[0].n).toBe(1);
    });

    it('runs a job to completion with tenant-scoped (RLS) access inside the handler', async () => {
      await admin.query('TRUNCATE jobs');
      const id = (await enqueueA({ type: 'count_leads' }))!;
      const runner = newRunner({ count_leads: async (_j: any, ctx: any) => ctx.withTenant(async (tx: pg.PoolClient) => (await tx.query('SELECT count(*)::int n FROM leads')).rows[0]) });
      await runner.drain();
      const row = (await admin.query('SELECT status, result FROM jobs WHERE id = $1', [id])).rows[0];
      expect(row.status).toBe('done');
      expect(row.result).toEqual({ n: 1 }); // only tenant A's lead, though the handler ran on the cross-tenant worker role
    });

    it('retries transient failures, then succeeds', async () => {
      await admin.query('TRUNCATE jobs');
      const id = (await enqueueA({ type: 'flaky' }))!;
      let calls = 0;
      const runner = newRunner({ flaky: async () => { if (++calls < 3) throw new jobs.RetryAfterError('provider 503', 0); return { calls }; } });
      await runner.drain();
      expect(await status(id)).toMatchObject({ status: 'done', attempts: 3 });
    });

    it('dead-letters permanent errors immediately and exhausted retries after max_attempts', async () => {
      await admin.query('TRUNCATE jobs');
      const perm = (await enqueueA({ type: 'perm' }))!;
      const exhaust = (await enqueueA({ type: 'exhaust', maxAttempts: 2 }))!;
      const unknown = (await enqueueA({ type: 'nobody-handles-this' }))!;
      const runner = newRunner({
        perm: async () => { throw new jobs.PermanentJobError('invalid payload'); },
        exhaust: async () => { throw new jobs.RetryAfterError('still failing', 0); },
      });
      await runner.drain();
      expect(await status(perm)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'invalid payload' });
      expect(await status(exhaust)).toMatchObject({ status: 'dead', attempts: 2 });
      expect(await status(unknown)).toMatchObject({ status: 'dead' });
    });

    it('(d) exactly-once execution with two concurrent runners over 60 jobs', async () => {
      await admin.query('TRUNCATE jobs');
      for (let i = 0; i < 60; i++) await enqueueA({ type: 'once', payload: { i } });
      const handled: number[] = [];
      const handler = async (j: any) => { await new Promise((r) => setTimeout(r, 5)); handled.push(j.payload.i); };
      await Promise.all([newRunner({ once: handler }).drain(), newRunner({ once: handler }).drain()]);
      expect(handled).toHaveLength(60);
      expect(new Set(handled).size).toBe(60);
      expect((await admin.query(`SELECT count(*)::int n FROM jobs WHERE status='done'`)).rows[0].n).toBe(60);
    });

    it('a crashed worker’s job is recovered by the reaper; the stale worker cannot overwrite the new owner', async () => {
      await admin.query('TRUNCATE jobs');
      const id = (await enqueueA({ type: 'recover' }))!;
      const crashed = newRunner({ recover: async () => 'x' }, { workerId: 'worker-crashed' });
      const [job] = await crashed.claim(1); // claimed, then the process "dies"
      expect(job.id).toBe(id);
      await admin.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);

      const survivor = newRunner({ recover: async () => 'ok' }, { workerId: 'worker-survivor' });
      expect(await survivor.reap()).toBe(1);
      const [again] = await survivor.claim(1);
      expect(again.id).toBe(id);

      // the zombie wakes up and tries to report success — must be ignored
      const accepted = await (crashed as any).finish(job, 'done');
      expect(accepted).toBe(false);
      expect((await status(id)).status).toBe('running');
      await (survivor as any).finish(again, 'done');
      expect((await status(id)).status).toBe('done');
    });

    it('a worker that keeps dying eventually dead-letters the job (no infinite poison loop)', async () => {
      await admin.query('TRUNCATE jobs');
      const id = (await enqueueA({ type: 'poison', maxAttempts: 2 }))!;
      const r = newRunner({}, { workerId: 'w' });
      for (let i = 0; i < 2; i++) {
        await r.claim(1);
        await admin.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
        await r.reap();
      }
      expect((await status(id)).status).toBe('dead');
    });

    it('delayed jobs are not claimed before run_at', async () => {
      await admin.query('TRUNCATE jobs');
      await enqueueA({ type: 'later', delaySeconds: 3600 });
      expect(await newRunner({ later: async () => 1 }).claim(5)).toHaveLength(0);
    });
  });
});
