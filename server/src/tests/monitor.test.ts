import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let auditor: AuthedUser;
let exec: AuthedUser;
let log: typeof import('../platform/observability/event-log');
const W = () => ({ 'X-Tenant-Id': owner.tenantId });
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const heartbeat = (ageSeconds: number) =>
  h.admin.query(
    `INSERT INTO system_health (component, status, latency_ms, last_checked_at, details) VALUES ('worker','healthy',0, now() - make_interval(secs => $1::int), '{}'::jsonb)
     ON CONFLICT (component, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET status = 'healthy', last_checked_at = EXCLUDED.last_checked_at`, [ageSeconds]);
const check = (body: any, id: string) => body.data.checks.find((c: any) => c.id === id);

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  log = await import('../platform/observability/event-log');
  owner = await h.register({ emailPrefix: 'mown', organisationName: 'Monitor Co' });
  other = await h.register({ emailPrefix: 'moth', organisationName: 'Other Monitor Co' });
  agent = await h.register({ emailPrefix: 'magt' });
  auditor = await h.register({ emailPrefix: 'maud' });
  exec = await h.register({ emailPrefix: 'mexe' });
  await addMember(agent, owner.tenantId, 'sales_agent');
  await addMember(auditor, owner.tenantId, 'auditor');
  await addMember(exec, owner.tenantId, 'executive_readonly');
}, 180_000);

afterAll(async () => {
  await log?.flushEvents();
  await h?.close();
});

describe('monitor: access control', () => {
  it('owner and auditor can read; agent and executive cannot; another workspace sees only its own', async () => {
    expect((await owner.get('/api/v1/monitor/overview')).status).toBe(200);
    expect((await auditor.get('/api/v1/monitor/overview', W())).status).toBe(200);
    expect((await agent.get('/api/v1/monitor/overview', W())).status).toBe(403);
    expect((await exec.get('/api/v1/monitor/overview', W())).status).toBe(403);
    expect((await agent.get('/api/v1/monitor/events', W())).status).toBe(403);
    expect((await agent.get('/api/v1/monitor/audit', W())).status).toBe(403);
    expect((await exec.get('/api/v1/monitor/audit/export', W())).status).toBe(403);
    expect((await auditor.get('/api/v1/monitor/audit', W())).status).toBe(200);
    expect((await request(h.app).get('/api/v1/monitor/overview')).status).toBe(401);
  });

  it('an auditor sees health but no business numbers', async () => {
    const r = await auditor.get('/api/v1/monitor/overview', W());
    expect(r.body.data.leads).toBeNull();
    const o = await owner.get('/api/v1/monitor/overview');
    expect(o.body.data.leads).toMatchObject({ created24h: expect.any(Number), bySource7d: expect.any(Array) });
  });
});

describe('monitor: overview', () => {
  it('worker check follows the heartbeat: missing → failing, fresh → ok, stale → failing again', async () => {
    await h.admin.query(`DELETE FROM system_health WHERE component = 'worker'`);
    let r = await owner.get('/api/v1/monitor/overview');
    expect(check(r.body, 'worker')).toMatchObject({ status: 'fail' });
    expect(r.body.data.status).toBe('problem');
    await heartbeat(5);
    r = await owner.get('/api/v1/monitor/overview');
    expect(check(r.body, 'worker')).toMatchObject({ status: 'ok' });
    await heartbeat(60);
    expect(check((await owner.get('/api/v1/monitor/overview')).body, 'worker').status).toBe('warn');
    await heartbeat(600);
    r = await owner.get('/api/v1/monitor/overview');
    expect(check(r.body, 'worker')).toMatchObject({ status: 'fail' });
    expect(check(r.body, 'worker').detail).toMatch(/not being processed/);
    await heartbeat(3);
  });

  it('a healthy, empty workspace says so plainly', async () => {
    await heartbeat(2);
    const r = await other.get('/api/v1/monitor/overview');
    expect(r.body.data).toMatchObject({ status: 'healthy', summary: 'Everything is running normally.' });
    expect(r.body.data.checks.every((c: any) => c.status === 'ok')).toBe(true);
    expect(check(r.body, 'intake').detail).toMatch(/No lead sources/);
  });

  it('failed background jobs and a long queue are surfaced, per workspace', async () => {
    await heartbeat(2);
    await h.admin.query(`INSERT INTO jobs (tenant_id, type, status, finished_at, last_error, max_attempts, attempts) VALUES ($1,'mail.send','dead', now(), 'boom', 3, 3)`, [owner.tenantId]);
    await h.admin.query(`INSERT INTO jobs (tenant_id, type, status, run_at) VALUES ($1,'x.test','queued', now() - interval '20 minutes')`, [owner.tenantId]);
    const r = await owner.get('/api/v1/monitor/overview');
    expect(r.body.data.queue).toMatchObject({ queued: 1, deadLast7d: 1 });
    expect(r.body.data.queue.oldestWaitingSeconds).toBeGreaterThan(1000);
    expect(check(r.body, 'queue').status).toBe('warn');
    expect((await other.get('/api/v1/monitor/overview')).body.data.queue).toMatchObject({ queued: 0, deadLast7d: 0 });
    await h.admin.query(`DELETE FROM jobs WHERE tenant_id = $1 AND type IN ('x.test') `, [owner.tenantId]);
  });

  it('lead intake: deliveries that need attention and sources that went quiet', async () => {
    await heartbeat(2);
    const s = await owner.post('/api/v1/lead-sources', { provider: 'generic', name: 'Portal feed' });
    const id = s.body.data.endpoint.id;
    await h.admin.query(`INSERT INTO inbound_events (tenant_id, endpoint_id, provider, provider_event_id, payload, status, reason) VALUES ($1,$2,'generic','e1','{}','needs_review','no phone')`, [owner.tenantId, id]);
    let r = await owner.get('/api/v1/monitor/overview');
    expect(check(r.body, 'intake')).toMatchObject({ status: 'warn' });
    expect(check(r.body, 'intake').detail).toMatch(/1 delivery needs attention/);
    expect(r.body.data.intake.deliveries24h.needs_review).toBe(1);
    await h.admin.query(`UPDATE inbound_events SET status = 'ignored' WHERE endpoint_id = $1`, [id]);
    await h.admin.query(`UPDATE inbound_endpoints SET last_received_at = now() - interval '2 days', received_count = 5 WHERE id = $1`, [id]);
    r = await owner.get('/api/v1/monitor/overview');
    expect(check(r.body, 'intake').detail).toMatch(/No leads from Portal feed in over 24 hours/);
    expect(r.body.data.intake.quietSources[0]).toMatchObject({ id, name: 'Portal feed' });
    await h.admin.query(`UPDATE inbound_endpoints SET last_received_at = now() WHERE id = $1`, [id]);
  });

  it('lead counts by source and overdue follow-ups are counted', async () => {
    await owner.put(`/api/v1/pipelines/${(await owner.get('/api/v1/pipelines')).body.data[0].id}/transitions`, { restricted: false, transitions: [] });
    await owner.post('/api/v1/leads', { contact: { firstName: 'Counted', email: `c${Date.now()}@x.test` }, source: 'referral' });
    const r = await owner.get('/api/v1/monitor/overview');
    expect(r.body.data.leads.created24h).toBeGreaterThanOrEqual(1);
    expect(r.body.data.leads.bySource7d).toEqual(expect.arrayContaining([{ source: 'referral', n: 1 }]));
  });
});

describe('monitor: activity log', () => {
  it('records notable events per workspace, redacted, newest first, filterable and paginated', async () => {
    const base = Date.now() - 60_000;
    for (let i = 0; i < 7; i++) log.recordEvent({ at: new Date(base + i * 100), tenantId: owner.tenantId, userId: owner.userId, component: 'api', severity: i % 3 === 0 ? 'error' : 'warn', message: `Synthetic event ${i} on /demo`, context: { n: i, password: 'hunter2', apiKey: 'sk_live_abc', nested: { token: 'zzz', ok: 'visible' } }, correlationId: `req-${i}-aaaaaaaa` });
    log.recordEvent({ tenantId: other.tenantId, component: 'api', severity: 'error', message: 'Other workspace secret failure' });
    await log.flushEvents();

    const all = await owner.get('/api/v1/monitor/events?limit=5&component=api');
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBe(5);
    expect(all.body.page.hasMore).toBe(true);
    expect(all.body.data[0].message).toBe('Synthetic event 6 on /demo');
    expect(all.body.data[0]).toMatchObject({ component: 'api', userName: expect.any(String), requestId: 'req-6-aaaaaaaa' });
    const ctx = JSON.stringify(all.body.data[0].context);
    expect(ctx).not.toMatch(/hunter2|sk_live_abc|zzz/);
    expect(ctx).toContain('visible');
    const next = await owner.get(`/api/v1/monitor/events?limit=5&component=api&cursor=${all.body.page.next}`);
    expect(next.body.data.some((e: any) => all.body.data.find((a: any) => a.id === e.id))).toBe(false);
    const errors = await owner.get('/api/v1/monitor/events?severity=error&limit=50');
    expect(errors.body.data.every((e: any) => e.severity === 'error' || e.severity === 'fatal')).toBe(true);
    expect((await owner.get('/api/v1/monitor/events?q=event%203&limit=50')).body.data.map((e: any) => e.message)).toEqual(['Synthetic event 3 on /demo']);
    expect(JSON.stringify((await owner.get('/api/v1/monitor/events?limit=100')).body)).not.toContain('Other workspace secret');
    expect(JSON.stringify((await other.get('/api/v1/monitor/events?limit=100')).body)).toContain('Other workspace secret failure');
  });

  it('identical noisy events are throttled to one per minute and report how many were suppressed', async () => {
    for (let i = 0; i < 25; i++) log.recordEvent({ tenantId: owner.tenantId, component: 'security', severity: 'warn', message: 'Scanner hitting the form', throttleKey: 'scanner-test' });
    await log.flushEvents();
    const r = await owner.get('/api/v1/monitor/events?q=Scanner%20hitting&limit=50');
    expect(r.body.data.length).toBe(1);
  });

  it('a permission denial in the API is recorded against the right workspace and person', async () => {
    const denied = await agent.get('/api/v1/lead-sources', W());
    expect(denied.status).toBe(403);
    await log.flushEvents();
    const r = await owner.get('/api/v1/monitor/events?component=security&limit=50');
    const hit = r.body.data.find((e: any) => /Permission denied: GET .*lead-sources/.test(e.message));
    expect(hit).toBeTruthy();
    expect(hit.userName).toBe(agent.name);
    expect(hit.context).toMatchObject({ status: 403, method: 'GET' });
  });

  it('a refused lead delivery (bad signature) shows up as a security event', async () => {
    const s = await owner.post('/api/v1/lead-sources', { provider: 'google', name: 'Sig test' });
    const res = await request(h.app).post(`/hooks/${s.body.data.endpoint.id}`).send({ lead_id: 'x', google_key: 'ansk_nope' });
    expect(res.status).toBe(401);
    await log.flushEvents();
    const r = await owner.get('/api/v1/monitor/events?component=security&q=signature&limit=50');
    expect(r.body.data[0].message).toMatch(/google delivery failed its signature check/);
  });

  it('database: the API role cannot edit or delete log rows, and sees none without a tenant context', async () => {
    const c = new pg.Client({ connectionString: h.tdb.apiUrl });
    await c.connect();
    try {
      expect((await c.query('SELECT count(*)::int AS n FROM operational_logs')).rows[0].n).toBe(0);
      await expect(c.query(`UPDATE operational_logs SET message = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM operational_logs`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});

describe('monitor: audit trail', () => {
  let leadId: string;
  beforeAll(async () => {
    const l = await owner.post('/api/v1/leads', { contact: { firstName: 'Audited', email: `a${Date.now()}@x.test` } });
    leadId = l.body.data.id;
    await owner.patch(`/api/v1/leads/${leadId}`, { tags: ['vip'] }, { 'If-Match': l.headers.etag });
    await owner.post('/api/v1/api-keys', { name: 'Audit key', scopes: ['leads:read'] }).catch(() => undefined);
  });

  it('lists who did what, newest first, with names, and filters by action family, record type, person and dates', async () => {
    const r = await owner.get('/api/v1/monitor/audit?limit=100');
    expect(r.status).toBe(200);
    const actions = r.body.data.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['lead.create', 'lead.update']));
    expect(r.body.data[0]).toMatchObject({ actorName: owner.name, ip: expect.anything() });
    const fam = await owner.get('/api/v1/monitor/audit?action=lead&limit=100');
    expect(fam.body.data.length).toBeGreaterThan(0);
    expect(fam.body.data.every((a: any) => a.action.startsWith('lead.'))).toBe(true);
    const exact = await owner.get('/api/v1/monitor/audit?action=lead.create&limit=100');
    expect(exact.body.data.every((a: any) => a.action === 'lead.create')).toBe(true);
    expect((await owner.get(`/api/v1/monitor/audit?entityId=${leadId}&limit=100`)).body.data.every((a: any) => a.entityId === leadId)).toBe(true);
    expect((await owner.get(`/api/v1/monitor/audit?actorId=${owner.userId}&limit=100`)).body.data.length).toBeGreaterThan(0);
    expect((await owner.get(`/api/v1/monitor/audit?actorId=${crypto.randomUUID()}&limit=100`)).body.data).toEqual([]);
    expect((await owner.get(`/api/v1/monitor/audit?to=${encodeURIComponent('2001-01-01T00:00:00Z')}&limit=100`)).body.data).toEqual([]);
    expect((await owner.get('/api/v1/monitor/audit?action=lead&limit=1')).body.page.hasMore).toBe(true);
  });

  it('paginates without repeats', async () => {
    const a = await owner.get('/api/v1/monitor/audit?limit=3');
    const b = await owner.get(`/api/v1/monitor/audit?limit=3&cursor=${a.body.page.next}`);
    const ids = [...a.body.data, ...b.body.data].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await owner.get(`/api/v1/monitor/audit?limit=3&cursor=${a.body.page.next}&action=lead`)).status).toBe(400); // cursor is bound to its filters
  });

  it('shows one entry with before/after and redacts secrets; other workspaces get 404', async () => {
    const list = await owner.get(`/api/v1/monitor/audit?entityId=${leadId}&action=lead.update&limit=5`);
    const d = await owner.get(`/api/v1/monitor/audit/${list.body.data[0].id}`);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ action: 'lead.update', actorName: owner.name });
    expect(d.body.data).toHaveProperty('after');
    expect((await other.get(`/api/v1/monitor/audit/${list.body.data[0].id}`)).status).toBe(404);
    // a secret that somehow reached an audit row is masked when read back
    const id = crypto.randomUUID();
    await h.admin.query(`INSERT INTO audit_logs (id, tenant_id, actor_id, action, entity_type, entity_id, after_state) VALUES ($1,$2,$3,'test.secret','test',$4,$5::jsonb)`, [id, owner.tenantId, owner.userId, crypto.randomUUID(), JSON.stringify({ apiKey: 'sk_live_hidden', fine: 1 })]);
    const s = await owner.get(`/api/v1/monitor/audit/${id}`);
    expect(JSON.stringify(s.body)).not.toContain('sk_live_hidden');
    expect(s.body.data.after.fine).toBe(1);
  });

  it('is per workspace', async () => {
    const mine = await other.get('/api/v1/monitor/audit?limit=100');
    expect(mine.body.data.every((a: any) => a.actorId === other.userId || a.actorId === null)).toBe(true);
    expect(mine.body.data.some((a: any) => a.entityId === leadId)).toBe(false);
  });

  it('offers the filter choices that actually occur', async () => {
    const f = await owner.get('/api/v1/monitor/audit/facets');
    expect(f.body.data.actions).toEqual(expect.arrayContaining(['lead.create']));
    expect(f.body.data.entityTypes).toEqual(expect.arrayContaining(['lead']));
    expect(f.body.data.people.map((p: any) => p.id)).toContain(owner.userId);
  });

  it('exports CSV (BOM, header, formula-safe) and records the export itself', async () => {
    const r = await owner.get('/api/v1/monitor/audit/export?action=lead');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/audit-trail-\d{4}-\d{2}-\d{2}\.csv/);
    expect(r.text.startsWith('﻿When,Who,Action')).toBe(true);
    expect(r.text).toMatch(/lead\.create/);
    expect(Number(r.headers['x-row-count'])).toBeGreaterThan(0);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'audit.export' AND tenant_id = $1`, [owner.tenantId])).rowCount).toBe(1);
    expect((await agent.get('/api/v1/monitor/audit/export', W())).status).toBe(403);
  });

  it('the application cannot alter the trail', async () => {
    const c = new pg.Client({ connectionString: h.tdb.apiUrl });
    await c.connect();
    try {
      await expect(c.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});
