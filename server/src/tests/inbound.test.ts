import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

// Modules that read configuration at import time are loaded after the harness has set the environment.
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let mkt: AuthedUser;
let exec: AuthedUser;
let graph: typeof import('../modules/inbound/graph');
let providers: typeof import('../modules/inbound/providers');
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const phone = () => `+9198${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
const metaSig = (raw: string, secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

const inOwnerWorkspace = () => ({ 'X-Tenant-Id': owner.tenantId });
async function source(u: AuthedUser, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await u.post('/api/v1/lead-sources', body, headers);
  if (r.status !== 201) throw new Error(`create source failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { endpoint: any; secret: string | null };
}
const hook = (id: string) => request(h.app).post(`/hooks/${id}`);
const eventOf = async (endpointId: string, eventId: string) => (await h.admin.query(`SELECT * FROM inbound_events WHERE endpoint_id = $1 AND provider_event_id = $2`, [endpointId, eventId])).rows[0];
const leadsWithPhone = async (p: string) => (await h.admin.query('SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.phone = $1', [p])).rows;

const googleBody = (key: string, over: Record<string, unknown> = {}) => ({
  lead_id: `G-${uniq()}`, form_id: 'F1', campaign_id: '42', gcl_id: 'gclid-abc', google_key: key,
  user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Ravi Kumar' }, { column_id: 'EMAIL', string_value: `ravi${uniq()}@example.com` }, { column_id: 'PHONE_NUMBER', string_value: phone() }],
  ...over,
});
const metaBody = (leadgenIds: string[]) => JSON.stringify({ object: 'page', entry: [{ id: '123', time: 1, changes: leadgenIds.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: '123', form_id: '999', ad_id: '55', created_time: 1 } })) }] });

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  graph = await import('../modules/inbound/graph');
  providers = await import('../modules/inbound/providers');
  owner = await h.register({ emailPrefix: 'iown', organisationName: 'Inbound Co' });
  other = await h.register({ emailPrefix: 'ioth', organisationName: 'Other Inbound Co' });
  agent = await h.register({ emailPrefix: 'iagt' });
  mkt = await h.register({ emailPrefix: 'imkt' });
  exec = await h.register({ emailPrefix: 'iexe' });
  await addMember(agent, owner.tenantId, 'sales_agent');
  await addMember(mkt, owner.tenantId, 'marketing_manager');
  await addMember(exec, owner.tenantId, 'executive_readonly');
  // the seeded pipeline has a transition matrix that is not relevant here
  await owner.put(`/api/v1/pipelines/${(await owner.get('/api/v1/pipelines')).body.data[0].id}/transitions`, { restricted: false, transitions: [] });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('managing lead sources', () => {
  it('creates a Google source: a private address, a generated secret shown once, stored encrypted', async () => {
    const { endpoint, secret } = await source(owner, { provider: 'google', name: 'Google brand campaign' });
    expect(secret).toMatch(/^ansk_/);
    expect(endpoint).toMatchObject({ provider: 'google', status: 'active', secretHint: secret!.slice(-4), verifyToken: null, hasAccessToken: false });
    expect(endpoint.url).toMatch(new RegExp(`/hooks/${endpoint.id}$`));
    expect(JSON.stringify(endpoint)).not.toContain(secret!);
    const row = (await h.admin.query(`SELECT secret_enc FROM inbound_endpoints WHERE id = $1`, [endpoint.id])).rows[0];
    expect(row.secret_enc).toMatch(/^v1\./);
    expect(row.secret_enc).not.toContain(secret!);
    const again = await owner.get(`/api/v1/lead-sources/${endpoint.id}`);
    expect(JSON.stringify(again.body)).not.toContain(secret!);
    // audit has the action but never the secret
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'lead_source.create' AND entity_id = $1`, [endpoint.id])).rowCount).toBe(1);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE after_state::text LIKE $1`, [`%${secret}%`])).rows[0].n).toBe(0);
  });

  it('Meta needs the app secret; it is never returned; a verify token is generated', async () => {
    const bad = await owner.post('/api/v1/lead-sources', { provider: 'meta', name: 'Meta' });
    expect(bad.status).toBe(400);
    const { endpoint, secret } = await source(owner, { provider: 'meta', name: 'Meta Whitefield', appSecret: 'my-meta-app-secret', pageAccessToken: 'EAAB' + 'x'.repeat(40) });
    expect(secret).toBeNull();
    expect(endpoint.verifyToken).toMatch(/^[\w-]{20,}$/);
    expect(endpoint).toMatchObject({ hasAccessToken: true, secretHint: 'cret' });
    expect(JSON.stringify(endpoint)).not.toContain('my-meta-app-secret');
  });

  it('role matrix: marketing manager manages, executive only reads the list, agent has no access, other workspace sees nothing', async () => {
    const W = inOwnerWorkspace();
    const { endpoint } = await source(mkt, { provider: 'generic', name: 'Portal feed' }, W);
    expect((await exec.get('/api/v1/lead-sources', W)).status).toBe(200);
    expect((await exec.get('/api/v1/lead-sources/events', W)).status).toBe(403);
    expect((await exec.post('/api/v1/lead-sources', { provider: 'generic', name: 'x' }, W)).status).toBe(403);
    expect((await agent.get('/api/v1/lead-sources', W)).status).toBe(403);
    expect((await agent.post(`/api/v1/lead-sources/${endpoint.id}/test`, {}, W)).status).toBe(403);
    expect((await mkt.delete(`/api/v1/lead-sources/${endpoint.id}`, W)).status).toBe(403); // delete is admin-only
    expect((await mkt.get('/api/v1/lead-sources/events', W)).status).toBe(200);
    const theirs = await other.get('/api/v1/lead-sources');
    expect(theirs.body.data).toEqual([]);
    expect((await other.get(`/api/v1/lead-sources/${endpoint.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/lead-sources/${endpoint.id}`, { name: 'hijack' })).status).toBe(404);
    expect((await other.post(`/api/v1/lead-sources/${endpoint.id}/test`)).status).toBe(404);
  });

  it('validates routing config against THIS workspace', async () => {
    const foreignPipeline = (await other.get('/api/v1/pipelines')).body.data[0].id;
    const r = await owner.post('/api/v1/lead-sources', { provider: 'website', name: 'Site', config: { pipelineId: foreignPipeline } });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toBe('body.config.pipelineId');
    expect((await owner.post('/api/v1/lead-sources', { provider: 'website', name: 'Site', config: { ownerId: other.userId } })).status).toBe(400);
    expect((await owner.post('/api/v1/lead-sources', { provider: 'website', name: 'Site', config: { evil: true } })).status).toBe(400); // strict config
    expect((await owner.post('/api/v1/lead-sources', { provider: 'website', name: 'Site', config: { allowedOrigins: ['javascript:alert(1)'] } })).status).toBe(400);
  });
});

describe('Google Ads lead forms', () => {
  let ep: any;
  let key: string;
  beforeAll(async () => {
    const s = await source(owner, { provider: 'google', name: 'Google leads', config: { tags: ['google-form'] } });
    ep = s.endpoint;
    key = s.secret!;
  });

  it('accepts a correctly keyed delivery, stores it durably, and the worker turns it into a lead with provenance', async () => {
    const body = googleBody(key);
    const ph = body.user_column_data[2].string_value;
    const res = await hook(ep.id).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received', accepted: 1 });
    // durable before processing: stored and a job exists; the shared key is not stored
    const stored = await eventOf(ep.id, body.lead_id);
    expect(stored).toMatchObject({ status: 'received', provider: 'google', is_test: false });
    expect(JSON.stringify(stored.payload)).not.toContain(key);
    expect((await h.admin.query(`SELECT 1 FROM jobs WHERE type = 'inbound.process' AND payload->>'eventId' = $1`, [stored.id])).rowCount).toBe(1);

    await h.runJobs();
    const done = await eventOf(ep.id, body.lead_id);
    expect(done).toMatchObject({ status: 'created', reason: null });
    const lead = (await h.admin.query(`SELECT l.*, c.first_name, c.last_name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1`, [done.lead_id])).rows[0];
    expect(lead).toMatchObject({ source: 'google_ads', campaign: 'Google campaign 42', first_name: 'Ravi', last_name: 'Kumar' });
    expect(lead.tags).toContain('google-form');
    expect(lead.source_details).toMatchObject({ provider: 'google', endpointId: ep.id, gclid: 'gclid-abc', formId: 'F1' });
    expect(lead.tenant_id).toBe(owner.tenantId);
    const note = (await h.admin.query(`SELECT description, metadata FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [lead.id])).rows[0];
    expect(note.description).toMatch(/Captured from Google Ads lead form/);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'inbound_event.created' AND entity_id = $1`, [done.id])).rowCount).toBe(1);
    expect(ph).toBeTruthy();
  });

  it('a wrong or missing key is refused (401), nothing is stored', async () => {
    const before = (await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1`, [ep.id])).rows[0].n;
    expect((await hook(ep.id).send(googleBody('ansk_wrong'))).status).toBe(401);
    const noKey = googleBody(key);
    delete (noKey as any).google_key;
    expect((await hook(ep.id).send(noKey)).status).toBe(401);
    expect((await hook(ep.id).set('Content-Type', 'application/json').send('not json')).status).toBe(401);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1`, [ep.id])).rows[0].n).toBe(before);
  });

  it('a redelivery of the same lead id is acknowledged but processed once', async () => {
    const body = googleBody(key);
    expect((await hook(ep.id).send(body)).status).toBe(200);
    expect((await hook(ep.id).send(body)).status).toBe(200);
    expect((await hook(ep.id).send(body)).status).toBe(200);
    await h.runJobs();
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1 AND provider_event_id = $2`, [ep.id, body.lead_id])).rows[0].n).toBe(1);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM leads WHERE id IN (SELECT lead_id FROM inbound_events WHERE provider_event_id = $1)`, [body.lead_id])).rows[0].n).toBe(1);
  });

  it('the same person enquiring again adds to their open lead instead of creating a second one', async () => {
    const first = googleBody(key);
    await hook(ep.id).send(first);
    await h.runJobs();
    const firstEv = await eventOf(ep.id, first.lead_id);
    expect(firstEv.status).toBe('created');
    const again = googleBody(key, { user_column_data: first.user_column_data });
    await hook(ep.id).send(again);
    await h.runJobs();
    const dup = await eventOf(ep.id, again.lead_id);
    expect(dup).toMatchObject({ status: 'duplicate', lead_id: firstEv.lead_id });
    expect(dup.reason).toMatch(/already has an open lead/);
    const notes = (await h.admin.query(`SELECT description FROM activities WHERE lead_id = $1`, [firstEv.lead_id])).rows.map((r) => r.description);
    expect(notes.some((d) => /Enquired again via Google Ads/.test(d))).toBe(true);
    // attribution: the first enquiry is the lead's first touch; coming back through another door adds a later touch and leaves the first alone
    const touches = (await h.admin.query(`SELECT touch_type, source, click_id FROM marketing_attribution WHERE lead_id = $1`, [firstEv.lead_id])).rows;
    expect(touches.map((t) => t.touch_type).sort()).toEqual(['first_touch', 'later_touch']);
    expect(touches.every((t) => t.source === 'google_ads' && t.click_id === 'gclid-abc')).toBe(true);
    const ph = first.user_column_data[2].string_value;
    expect((await leadsWithPhone(ph)).length).toBe(1);
  });

  it('test deliveries are tagged', async () => {
    const body = googleBody(key, { is_test: true });
    await hook(ep.id).send(body);
    await h.runJobs();
    const ev = await eventOf(ep.id, body.lead_id);
    expect(ev.is_test).toBe(true);
    expect((await h.admin.query(`SELECT tags FROM leads WHERE id = $1`, [ev.lead_id])).rows[0].tags).toContain('test');
  });

  it('a submission with nobody to contact goes to review with a reason; it can be ignored, not retried into nothing', async () => {
    const body = googleBody(key, { user_column_data: [{ column_id: 'FULL_NAME', string_value: 'No Contact' }] });
    await hook(ep.id).send(body);
    await h.runJobs();
    const ev = await eventOf(ep.id, body.lead_id);
    expect(ev.status).toBe('needs_review');
    expect(ev.reason).toMatch(/nobody to contact/);
    expect((await owner.post(`/api/v1/lead-sources/events/${ev.id}/ignore`)).status).toBe(204);
    expect((await eventOf(ep.id, body.lead_id)).status).toBe('ignored');
    expect((await owner.post(`/api/v1/lead-sources/events/${ev.id}/retry`)).status).toBe(409); // not retryable once ignored
  });

  it('rotating the secret cuts the old one off at once', async () => {
    const s = await source(owner, { provider: 'google', name: 'Rotating' });
    expect((await hook(s.endpoint.id).send(googleBody(s.secret!))).status).toBe(200);
    const rot = await owner.post(`/api/v1/lead-sources/${s.endpoint.id}/rotate-secret`);
    expect(rot.status).toBe(200);
    expect(rot.body.data.secret).toMatch(/^ansk_/);
    expect(rot.body.data.secret).not.toBe(s.secret);
    expect((await hook(s.endpoint.id).send(googleBody(s.secret!))).status).toBe(401);
    expect((await hook(s.endpoint.id).send(googleBody(rot.body.data.secret))).status).toBe(200);
  });
});

describe('Meta Lead Ads', () => {
  const APP_SECRET = 'meta-app-secret-for-tests';
  let ep: any;
  const fetched: string[] = [];
  const leadFor = (id: string, extra: Record<string, unknown> = {}) => ({
    id, created_time: '2026-10-14T08:00:00+0000', campaign_id: 'C9', campaign_name: 'Diwali Launch', adset_name: 'Whitefield 30-45', ad_id: '55', ad_name: 'Carousel A', form_id: '999', platform: 'fb',
    field_data: [{ name: 'full_name', values: ['Asha Verma'] }, { name: 'email', values: [`asha${uniq()}@example.com`] }, { name: 'phone_number', values: [phone()] }, { name: 'budget', values: ['1.2 cr'] }, { name: 'preferred_location', values: ['Whitefield'] }],
    ...extra,
  });
  beforeAll(async () => {
    ep = (await source(owner, { provider: 'meta', name: 'Meta main', appSecret: APP_SECRET, pageAccessToken: 'EAAB' + 'y'.repeat(40) })).endpoint;
    graph.setMetaGraph({
      async fetchLead(id, token, secret) {
        fetched.push(id);
        expect(token).toMatch(/^EAAB/);
        expect(secret).toBe(APP_SECRET);
        if (id === '900000000000403') throw new graph.PermanentGraphError('Invalid OAuth access token.');
        if (id === '900000000000503') throw new graph.TransientGraphError('Meta is busy');
        return leadFor(id);
      },
    });
  });

  it('answers Meta’s subscription handshake only with the right verify token', async () => {
    const ok = await request(h.app).get(`/hooks/${ep.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': ep.verifyToken, 'hub.challenge': '1158201444' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect((await request(h.app).get(`/hooks/${ep.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status).toBe(403);
    expect((await request(h.app).get(`/hooks/${ep.id}`).query({ 'hub.mode': 'subscribe', 'hub.challenge': '1' })).status).toBe(403);
    expect((await request(h.app).get(`/hooks/${ep.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': ep.verifyToken, 'hub.challenge': '<script>' })).status).toBe(403);
  });

  it('verifies X-Hub-Signature-256 over the raw bytes, fetches the answers, creates the lead with campaign and ad ids', async () => {
    const raw = metaBody(['900000000000001']);
    const res = await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw);
    expect(res.status).toBe(200);
    await h.runJobs();
    const ev = await eventOf(ep.id, '900000000000001');
    expect(ev.status).toBe('created');
    const lead = (await h.admin.query(`SELECT * FROM leads WHERE id = $1`, [ev.lead_id])).rows[0];
    expect(lead).toMatchObject({ source: 'meta_ads', campaign: 'Diwali Launch' });
    expect(Number(lead.budget_max)).toBe(12_000_000);
    expect(lead.locations).toEqual(['Whitefield']);
    expect(lead.source_details).toMatchObject({ provider: 'meta', leadgenId: '900000000000001', pageId: '123', formId: '999', campaignId: 'C9', adsetName: 'Whitefield 30-45', adId: '55', platform: 'fb' });
    // the fetched answers are kept on the delivery so a retry never calls Meta again
    expect(ev.payload.lead.id).toBe('900000000000001');
  });

  it('refuses a bad, missing or body-tampered signature (401) and stores nothing', async () => {
    const raw = metaBody(['900000000000002']);
    expect((await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, 'wrong')).send(raw)).status).toBe(401);
    expect((await hook(ep.id).set('Content-Type', 'application/json').send(raw)).status).toBe(401);
    expect((await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw.replace('900000000000002', '900000000000009'))).status).toBe(401);
    expect(await eventOf(ep.id, '900000000000002')).toBeUndefined();
    expect(await eventOf(ep.id, '900000000000009')).toBeUndefined();
  });

  it('one delivery with several leads becomes several events', async () => {
    const raw = metaBody(['900000000000011', '900000000000012', '900000000000013']);
    const res = await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw);
    expect(res.body).toEqual({ status: 'received', accepted: 3 });
    await h.runJobs();
    for (const id of ['900000000000011', '900000000000012', '900000000000013']) expect((await eventOf(ep.id, id)).status).toBe('created');
  });

  it('a Meta rejection (bad token) needs review with a plain reason; after fixing the token, Retry creates the lead', async () => {
    const raw = metaBody(['900000000000403']);
    await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw);
    await h.runJobs();
    const ev = await eventOf(ep.id, '900000000000403');
    expect(ev.status).toBe('needs_review');
    expect(ev.reason).toMatch(/Meta refused the request: Invalid OAuth access token/);
    // fix: the "token" now works because the fake only fails this id; swap the fake to succeed
    graph.setMetaGraph({ async fetchLead(id) { return leadFor(id); } });
    expect((await owner.post(`/api/v1/lead-sources/events/${ev.id}/retry`)).status).toBe(204);
    await h.runJobs();
    expect((await eventOf(ep.id, '900000000000403')).status).toBe('created');
  });

  it('a temporary Meta outage is retried, not turned into a failure', async () => {
    graph.setMetaGraph({ async fetchLead() { throw new graph.TransientGraphError('Meta is busy'); } });
    const raw = metaBody(['900000000000503']);
    await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw);
    await h.runJobs();
    const ev = await eventOf(ep.id, '900000000000503');
    expect(ev.status).toBe('received'); // still waiting for its retry
    const job = (await h.admin.query(`SELECT status, attempts, last_error FROM jobs WHERE type = 'inbound.process' AND payload->>'eventId' = $1`, [ev.id])).rows[0];
    expect(job.status).toBe('queued');
    expect(job.attempts).toBeGreaterThanOrEqual(1);
    expect(job.last_error).toMatch(/Meta is busy/);
    graph.setMetaGraph({ async fetchLead(id) { return leadFor(id); } });
    await h.admin.query(`UPDATE jobs SET run_at = now() WHERE type = 'inbound.process' AND payload->>'eventId' = $1`, [ev.id]);
    await h.runJobs();
    expect((await eventOf(ep.id, '900000000000503')).status).toBe('created');
  });

  it('without a page access token the delivery waits for a human instead of being lost', async () => {
    const s = await source(owner, { provider: 'meta', name: 'Meta no token', appSecret: APP_SECRET });
    const raw = metaBody(['900000000000601']);
    expect((await hook(s.endpoint.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw)).status).toBe(200);
    await h.runJobs();
    const ev = await eventOf(s.endpoint.id, '900000000000601');
    expect(ev.status).toBe('needs_review');
    expect(ev.reason).toMatch(/page access token/);
    const p = await owner.patch(`/api/v1/lead-sources/${s.endpoint.id}`, { pageAccessToken: 'EAAB' + 'z'.repeat(40) });
    expect(p.status).toBe(200);
    expect(p.body.data.hasAccessToken).toBe(true);
    graph.setMetaGraph({ async fetchLead(id) { return leadFor(id); } });
    await owner.post(`/api/v1/lead-sources/events/${ev.id}/retry`);
    await h.runJobs();
    expect((await eventOf(s.endpoint.id, '900000000000601')).status).toBe('created');
  });

  it('non-lead Meta notifications are acknowledged and ignored', async () => {
    const raw = JSON.stringify({ object: 'page', entry: [{ id: '123', time: 1, changes: [{ field: 'feed', value: { x: 1 } }] }] });
    const res = await hook(ep.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, APP_SECRET)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(0);
  });

  it('cannot rotate a Meta secret (it is yours); can replace it', async () => {
    expect((await owner.post(`/api/v1/lead-sources/${ep.id}/rotate-secret`)).status).toBe(409);
    const s = await source(owner, { provider: 'meta', name: 'Replace secret', appSecret: 'old-secret-123' });
    await owner.patch(`/api/v1/lead-sources/${s.endpoint.id}`, { appSecret: 'new-secret-456' });
    const raw = metaBody([]);
    expect((await hook(s.endpoint.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, 'old-secret-123')).send(raw)).status).toBe(401);
    expect((await hook(s.endpoint.id).set('Content-Type', 'application/json').set('X-Hub-Signature-256', metaSig(raw, 'new-secret-456')).send(raw)).status).toBe(200);
  });
});

describe('generic signed JSON', () => {
  let ep: any;
  let secret: string;
  const send = (e: any, obj: object, opts: { t?: number; secret?: string; tamper?: boolean; eventId?: string } = {}) => {
    const raw = JSON.stringify(obj);
    const sig = providers.signGeneric(raw, opts.secret ?? secret, opts.t ?? Math.floor(Date.now() / 1000));
    const r = hook(e.id).set('Content-Type', 'application/json').set('X-Anibros-Signature', sig);
    if (opts.eventId) r.set('X-Event-Id', opts.eventId);
    return r.send(opts.tamper ? raw.replace('Kiran', 'Evil') : raw);
  };
  beforeAll(async () => {
    const s = await source(owner, { provider: 'generic', name: 'Portal feed', config: { source: 'portal', campaign: 'Portal listing', fieldMap: { mobile_no: 'phone', person: 'name' } } });
    ep = s.endpoint;
    secret = s.secret!;
  });

  it('accepts a signed delivery, maps fields and uses the configured source and campaign', async () => {
    const ph = phone();
    expect((await send(ep, { id: 'p-1', person: 'Kiran Rao', mobile_no: ph, message: 'Interested in 3BHK' })).status).toBe(200);
    await h.runJobs();
    const ev = await eventOf(ep.id, 'p-1');
    expect(ev.status).toBe('created');
    const lead = (await h.admin.query(`SELECT source, campaign FROM leads WHERE id = $1`, [ev.lead_id])).rows[0];
    expect(lead).toEqual({ source: 'portal', campaign: 'Portal listing' });
  });

  it('rejects tampering, the wrong secret and stale timestamps (replay protection)', async () => {
    expect((await send(ep, { id: 'p-2', person: 'Kiran Rao', mobile_no: phone() }, { tamper: true })).status).toBe(401);
    expect((await send(ep, { id: 'p-3', person: 'Kiran Rao', mobile_no: phone() }, { secret: 'ansk_nope' })).status).toBe(401);
    expect((await send(ep, { id: 'p-4', person: 'Kiran Rao', mobile_no: phone() }, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    for (const id of ['p-2', 'p-3', 'p-4']) expect(await eventOf(ep.id, id)).toBeUndefined();
  });

  it('an exact replay of a signed request is deduplicated', async () => {
    const t = Math.floor(Date.now() / 1000);
    const obj = { person: 'Dev Patel', mobile_no: phone() };
    expect((await send(ep, obj, { t })).status).toBe(200);
    expect((await send(ep, obj, { t })).status).toBe(200);
    const raw = JSON.stringify(obj);
    const id = crypto.createHash('sha256').update(raw).digest('hex');
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1 AND provider_event_id = $2`, [ep.id, id])).rows[0].n).toBe(1);
  });

  it('oversized bodies are refused before any database work', async () => {
    const res = await hook(ep.id).set('Content-Type', 'application/json').send(JSON.stringify({ blob: 'x'.repeat(300_000) }));
    expect(res.status).toBe(413);
  });
});

describe('website form', () => {
  let ep: any;
  beforeAll(async () => {
    ep = (await source(owner, { provider: 'website', name: 'Landing page', config: { allowedOrigins: ['https://www.example-realty.com'], tags: ['landing'] } })).endpoint;
  });

  it('answers the browser preflight only for allowed websites', async () => {
    const ok = await request(h.app).options(`/hooks/${ep.id}`).set('Origin', 'https://www.example-realty.com').set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://www.example-realty.com');
    const bad = await request(h.app).options(`/hooks/${ep.id}`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts a form post from an allowed site and creates a tagged website lead', async () => {
    const ph = phone();
    const res = await hook(ep.id).set('Origin', 'https://www.example-realty.com').send({ name: 'Meera Nair', email: `meera${uniq()}@example.com`, phone: ph, message: 'Call after 6pm', utm_campaign: 'brand' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://www.example-realty.com');
    await h.runJobs();
    const ev = (await h.admin.query(`SELECT * FROM inbound_events WHERE endpoint_id = $1 ORDER BY received_at DESC LIMIT 1`, [ep.id])).rows[0];
    expect(ev.status).toBe('created');
    const lead = (await h.admin.query(`SELECT source, campaign, tags, source_details FROM leads WHERE id = $1`, [ev.lead_id])).rows[0];
    expect(lead).toMatchObject({ source: 'website', campaign: 'brand' });
    expect(lead.tags).toContain('landing');
    expect(lead.source_details.tracking).toEqual({ utm_campaign: 'brand' });
  });

  it('refuses other websites (403) and silently drops bot submissions (honeypot)', async () => {
    const before = (await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1`, [ep.id])).rows[0].n;
    expect((await hook(ep.id).set('Origin', 'https://evil.example').send({ name: 'Bot', email: 'bot@example.com' })).status).toBe(403);
    const bot = await hook(ep.id).set('Origin', 'https://www.example-realty.com').send({ name: 'Bot', email: 'bot@example.com', _hp: 'http://spam.example' });
    expect(bot.status).toBe(200); // looks fine to the bot
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM inbound_events WHERE endpoint_id = $1`, [ep.id])).rows[0].n).toBe(before);
  });

  it('is rate limited per visitor', async () => {
    const e2 = (await source(owner, { provider: 'website', name: 'Busy page' })).endpoint;
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await hook(e2.id).send({ name: `Visitor ${i}`, email: `v${i}${uniq()}@example.com` })).status;
    expect(last).toBe(429);
  });
});

describe('pausing, deleting, test button, isolation and database guarantees', () => {
  it('a paused source answers 503 + Retry-After so providers retry later; resuming accepts again', async () => {
    const s = await source(owner, { provider: 'google', name: 'Pausable' });
    await owner.patch(`/api/v1/lead-sources/${s.endpoint.id}`, { status: 'paused' });
    const res = await hook(s.endpoint.id).send(googleBody(s.secret!));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    await owner.patch(`/api/v1/lead-sources/${s.endpoint.id}`, { status: 'active' });
    expect((await hook(s.endpoint.id).send(googleBody(s.secret!))).status).toBe(200);
  });

  it('a deleted source and unknown or malformed ids all look the same: 404', async () => {
    const s = await source(owner, { provider: 'google', name: 'Deletable' });
    expect((await owner.delete(`/api/v1/lead-sources/${s.endpoint.id}`)).status).toBe(204);
    expect((await hook(s.endpoint.id).send(googleBody(s.secret!))).status).toBe(404);
    expect((await hook(crypto.randomUUID()).send({})).status).toBe(404);
    expect((await hook('not-a-uuid').send({})).status).toBe(404);
    expect((await owner.get(`/api/v1/lead-sources/${s.endpoint.id}`)).status).toBe(404);
  });

  it('Send test lead runs the real pipeline for every provider and tags the lead', async () => {
    for (const provider of ['google', 'website', 'generic'] as const) {
      const s = await source(owner, { provider, name: `Test ${provider}` });
      const r = await owner.post(`/api/v1/lead-sources/${s.endpoint.id}/test`);
      expect(r.status).toBe(202);
      await h.runJobs();
      const ev = (await h.admin.query(`SELECT status, is_test, lead_id FROM inbound_events WHERE id = $1`, [r.body.data.eventId])).rows[0];
      expect(ev).toMatchObject({ status: 'created', is_test: true });
      expect((await h.admin.query(`SELECT tags FROM leads WHERE id = $1`, [ev.lead_id])).rows[0].tags).toContain('test');
    }
    const meta = await source(owner, { provider: 'meta', name: 'Test meta', appSecret: 'abcdefgh1234' }); // inline answers: no Graph call, no token needed
    const t = await owner.post(`/api/v1/lead-sources/${meta.endpoint.id}/test`);
    await h.runJobs();
    expect((await h.admin.query(`SELECT status FROM inbound_events WHERE id = $1`, [t.body.data.eventId])).rows[0].status).toBe('created');
  });

  it('the delivery log is paginated, filterable, per-tenant, and shows names but not payloads', async () => {
    const all = await owner.get('/api/v1/lead-sources/events?limit=5');
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBe(5);
    expect(all.body.page.hasMore).toBe(true);
    const next = await owner.get(`/api/v1/lead-sources/events?limit=5&cursor=${all.body.page.next}`);
    expect(next.body.data.some((e: any) => all.body.data.find((a: any) => a.id === e.id))).toBe(false);
    const review = await owner.get('/api/v1/lead-sources/events?status=needs_review');
    expect(review.body.data.every((e: any) => e.status === 'needs_review')).toBe(true);
    expect(JSON.stringify(all.body)).not.toMatch(/@example\.com/);
    expect(JSON.stringify(all.body)).not.toMatch(/"payload"/);
    expect((await other.get('/api/v1/lead-sources/events')).body.data).toEqual([]);
  });

  it('retry/ignore on another workspace’s delivery is a 404-equivalent (nothing changes)', async () => {
    const ev = (await h.admin.query(`SELECT id FROM inbound_events WHERE tenant_id = $1 AND status = 'ignored' LIMIT 1`, [owner.tenantId])).rows[0];
    expect((await other.post(`/api/v1/lead-sources/events/${ev.id}/retry`)).status).toBe(409);
    expect((await h.admin.query(`SELECT status FROM inbound_events WHERE id = $1`, [ev.id])).rows[0].status).toBe('ignored');
  });

  it('database: the API role cannot read endpoints or events without a tenant context; the pre-tenant functions return only the one endpoint asked for', async () => {
    const c = new pg.Client({ connectionString: h.tdb.apiUrl });
    await c.connect();
    try {
      expect((await c.query('SELECT count(*)::int AS n FROM inbound_endpoints')).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM inbound_events')).rows[0].n).toBe(0);
      const id = (await h.admin.query(`SELECT id FROM inbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, [owner.tenantId])).rows[0].id;
      expect((await c.query('SELECT * FROM app.inbound_endpoint_lookup($1)', [id])).rowCount).toBe(1);
      expect((await c.query('SELECT * FROM app.inbound_endpoint_lookup($1)', [crypto.randomUUID()])).rowCount).toBe(0);
      await expect(c.query(`SELECT app.inbound_receive($1, '[{"eventId":"x","payload":{}}]'::jsonb)`, [crypto.randomUUID()])).rejects.toThrow(/NOT_FOUND/);
      await expect(c.query(`DELETE FROM inbound_events`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
    // the worker may purge old deliveries (retention) but still cannot touch endpoints
    const w = new pg.Client({ connectionString: h.tdb.workerUrl });
    await w.connect();
    try {
      await expect(w.query('DELETE FROM inbound_endpoints')).rejects.toThrow(/permission denied/);
    } finally {
      await w.end();
    }
  });

  it('suspended workspaces stop receiving (the lookup hides their endpoints)', async () => {
    const s = await source(other, { provider: 'google', name: 'Suspended soon' });
    await h.admin.query(`UPDATE tenants SET is_active = false WHERE id = $1`, [other.tenantId]);
    try {
      expect((await hook(s.endpoint.id).send(googleBody(s.secret!))).status).toBe(404);
    } finally {
      await h.admin.query(`UPDATE tenants SET is_active = true WHERE id = $1`, [other.tenantId]);
    }
  });

  it('no secret ever appears in the logs table, the audit trail or the API output', async () => {
    const s = await source(owner, { provider: 'generic', name: 'Leak check' });
    const text = JSON.stringify((await h.admin.query(`SELECT after_state FROM audit_logs`)).rows) + JSON.stringify((await owner.get('/api/v1/lead-sources')).body);
    expect(text).not.toContain(s.secret!);
  });
});
