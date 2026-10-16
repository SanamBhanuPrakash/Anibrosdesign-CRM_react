import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Wave 4: outgoing webhooks, ready-made API key templates, e-mail and WhatsApp sending from a lead, and the shared rate limiter.
 * Two local servers stand in for the outside world: a webhook receiver and WhatsApp's Graph API.
 */
const PORT = vi.hoisted(() => {
  process.env.OUTBOUND_ALLOW_PRIVATE = 'true';
  const p = 41000 + Math.floor(Math.random() * 8000);
  process.env.WHATSAPP_GRAPH_URL = `http://127.0.0.1:${p + 1}/v21.0`;
  return p;
});

let h: ApiHarness;
let owner: AuthedUser;
let stranger: AuthedUser; // a different workspace entirely
let dispatcher: any;
let workerDb: any;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const phone = () => `+9190${String(10_000_000 + (n++ * 7919) % 89_999_999).padStart(8, '0')}`;
const GOOD_TOKEN = 'EAAGgoodtoken0123456789abcdefXYZ';

// ── the outside world ───────────────────────────────────────────────────────────────────────────────────
const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const receiverMode = { status: 200 };
const waCalls: Array<{ method: string; url: string; auth: string | undefined; body: any }> = [];
const waMode: { error: { code: number; status: number } | null } = { error: null };
let receiver: http.Server;
let graph: http.Server;

function listen(server: http.Server, port: number) {
  return new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
async function pump() {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 20; j++) {
      const r = await dispatcher.runOnce();
      if (!Object.values(r).some((c) => (c as number) > 0)) break;
    }
    await h.runJobs();
  }
}
/** Failed sends are rescheduled with back-off; make them runnable now. */
const hurry = () => h.admin.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND type IN ('webhook.deliver', 'message.send')`);
const newLead = async (u: AuthedUser, extra: Record<string, unknown> = {}, contact: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/leads', { contact: { firstName: `Pat${uniq()}`, lastName: 'Lee', email: `p${uniq()}@x.test`, ...contact }, source: 'website', ...extra });
  if (r.status !== 201) throw new Error(`lead create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
const addHook = async (u: AuthedUser, events: string[] = ['lead.created'], path = '/hook') => {
  const r = await u.post('/api/v1/webhooks', { name: `Hook ${uniq()}`, url: `http://127.0.0.1:${PORT}${path}`, events });
  if (r.status !== 201) throw new Error(`webhook create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { webhook: any; secret: string };
};
const verify = (secret: string, header: string, body: string) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]!)) && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
};
const hits = (path = '/hook') => received.filter((r) => r.path === path);
const addMember = (u: AuthedUser, tenantId: string, role: string, channels: string[] | null = null) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, work_channels) VALUES ($1,$2,$3::tenant_role,'active',true,$4::text[])`, [tenantId, u.userId, role, channels]);
const asIn = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(receiverMode.status, { 'content-type': 'text/plain' }).end(receiverMode.status >= 400 ? 'nope' : 'ok');
    });
  });
  graph = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      waCalls.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) return res.writeHead(401).end(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }));
      if (req.method === 'GET') return res.writeHead(200).end(JSON.stringify({ display_phone_number: '+1 555 0100', verified_name: 'Clinic' }));
      if (waMode.error) return res.writeHead(waMode.error.status).end(JSON.stringify({ error: { code: waMode.error.code, message: 'rejected' } }));
      return res.writeHead(200).end(JSON.stringify({ messages: [{ id: `wamid.${uniq()}` }] }));
    });
  });
  await listen(receiver, PORT);
  await listen(graph, PORT + 1);

  h = await bootApi({ restricted: true });
  const platform = await import('../platform/db');
  const worker = await import('../worker');
  const events = await import('../platform/events');
  workerDb = platform.createWorkerDb();
  dispatcher = new events.EventDispatcher(workerDb, worker.eventConsumers);
  owner = await h.register({ emailPrefix: 'w4own', organisationName: 'Wave Four Co' });
  stranger = await h.register({ emailPrefix: 'w4str', organisationName: 'Someone Else Ltd' });
  await pump(); // drain the setup events
}, 240_000);

afterAll(async () => {
  await new Promise((r) => receiver?.close(r));
  await new Promise((r) => graph?.close(r));
  await workerDb?.end();
  await h?.close();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('ready-made API key templates', () => {
  it('lists the two templates, and each key can do exactly its job', async () => {
    const t = await owner.get('/api/v1/api-keys/templates');
    expect(t.status).toBe(200);
    const list = t.body.data as Array<{ id: string; direction: string; role: string; scopes: string[] }>;
    expect(list.map((x) => x.id).sort()).toEqual(['read-data-out', 'send-leads-in']);

    const make = async (id: string) => {
      const tpl = list.find((x) => x.id === id)!;
      const r = await owner.post('/api/v1/api-keys', { name: `From ${id}`, role: tpl.role, scopes: tpl.scopes, expiresInDays: 365 });
      expect(r.status).toBe(201);
      return r.body.data.key as string;
    };
    const intake = await make('send-leads-in');
    const reader = await make('read-data-out');
    const call = (key: string) => ({
      get: (p: string) => import('supertest').then(({ default: rq }) => rq(h.app).get(p).set('Authorization', `Bearer ${key}`)),
      post: (p: string, b: object) => import('supertest').then(({ default: rq }) => rq(h.app).post(p).send(b).set('Authorization', `Bearer ${key}`)),
    });
    // "in": can create a lead, cannot read the list
    const created = await call(intake).post('/api/v1/leads', { contact: { firstName: 'FromForm', email: `f${uniq()}@x.test` }, source: 'website' });
    expect(created.status).toBe(201);
    expect((await call(intake).get('/api/v1/leads')).status).toBe(403);
    // "out": can read, cannot create
    expect((await call(reader).get('/api/v1/leads')).status).toBe(200);
    expect((await call(reader).post('/api/v1/leads', { contact: { firstName: 'Nope', email: `n${uniq()}@x.test` }, source: 'website' })).status).toBe(403);
  });

  it('a person who may not manage keys gets no templates', async () => {
    const agent = await h.register({ emailPrefix: 'w4agent', organisationName: 'Agent Home' });
    await addMember(agent, owner.tenantId, 'sales_agent');
    expect((await asIn(agent, owner.tenantId).get('/api/v1/api-keys/templates')).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('outgoing webhooks', () => {
  it('sends a signed message once, with the lead’s details, and never twice even when events are replayed', async () => {
    const { webhook, secret } = await addHook(owner, ['lead.created']);
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(webhook)).not.toContain(secret);
    expect(webhook.secretHint).toBe(secret.slice(-4));
    const before = hits().length;
    const lead = await newLead(owner, { campaign: 'Diwali offer' }, { firstName: 'Meera', lastName: 'Iyer', phone: phone() });
    await pump();
    const got = hits().slice(before);
    expect(got.length).toBe(1);
    const msg = got[0]!;
    expect(msg.headers['x-anibros-event']).toBe('lead.created');
    expect(verify(secret, String(msg.headers['x-anibros-signature']), msg.body)).toBe(true);
    expect(verify('whsec_wrong', String(msg.headers['x-anibros-signature']), msg.body)).toBe(false);
    const body = JSON.parse(msg.body);
    expect(body.id).toBe(msg.headers['x-anibros-delivery']);
    expect(body.event).toBe('lead.created');
    expect(body.workspace.id).toBe(owner.tenantId);
    expect(body.data.lead).toMatchObject({ id: lead.id, name: expect.stringContaining('Meera'), campaign: 'Diwali offer', stage: expect.any(String) });
    // replaying every event from the start must not send anything again
    await h.admin.query(`UPDATE event_consumers SET last_tx_id = '0'::xid8, last_event_id = 0 WHERE name = 'outbound'`);
    await pump();
    expect(hits().slice(before).length).toBe(1);
    const rows = (await h.admin.query(`SELECT status, attempts, response_status FROM outbound_deliveries WHERE endpoint_id = $1`, [webhook.id])).rows;
    expect(rows.filter((r: any) => r.status === 'delivered').length).toBe(rows.length);
  });

  it('only the events a webhook listens to, only while it is on, and only for its own workspace', async () => {
    const { webhook } = await addHook(owner, ['lead.stage_changed'], '/stage-only');
    const lead = await newLead(owner);
    await pump();
    expect(hits('/stage-only').length).toBe(0); // created is not subscribed
    const stages = (await owner.get('/api/v1/pipelines')).body.data[0].stages;
    const next = stages.find((s: any) => s.id !== lead.stageId && !s.isClosed);
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: next.id })).status).toBe(200);
    await pump();
    expect(hits('/stage-only').length).toBe(1);
    expect(JSON.parse(hits('/stage-only')[0]!.body).data.lead.stage).toBe(next.name);

    // paused: nothing is sent
    expect((await owner.patch(`/api/v1/webhooks/${webhook.id}`, { status: 'paused' })).status).toBe(200);
    const stage2 = stages.find((s: any) => s.id !== next.id && !s.isClosed);
    await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stage2.id });
    await pump();
    expect(hits('/stage-only').length).toBe(1);

    // another workspace's events never reach this workspace's webhook
    await addHook(owner, ['lead.created'], '/mine-only');
    await newLead(stranger);
    await pump();
    expect(hits('/mine-only').length).toBe(0);
    await newLead(owner);
    await pump();
    expect(hits('/mine-only').length).toBe(1);
  });

  it('a receiver that errors is retried with the same delivery id; once it recovers the message arrives', async () => {
    const { webhook } = await addHook(owner, ['lead.created'], '/flaky');
    receiverMode.status = 500;
    await newLead(owner);
    await pump();
    const first = hits('/flaky');
    expect(first.length).toBe(1);
    let d = (await h.admin.query(`SELECT status, attempts, error, response_status FROM outbound_deliveries WHERE endpoint_id = $1`, [webhook.id])).rows[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 1, response_status: 500 });
    expect(d.error).toMatch(/500/);
    receiverMode.status = 200;
    await hurry();
    await pump();
    const all = hits('/flaky');
    expect(all.length).toBe(2);
    expect(all[1]!.headers['x-anibros-delivery']).toBe(all[0]!.headers['x-anibros-delivery']); // the receiver's idempotency key
    d = (await h.admin.query(`SELECT status, attempts FROM outbound_deliveries WHERE endpoint_id = $1`, [webhook.id])).rows[0];
    expect(d).toMatchObject({ status: 'delivered', attempts: 2 });
    const ep = (await owner.get(`/api/v1/webhooks/${webhook.id}`)).body.data;
    expect(ep).toMatchObject({ status: 'active', lastStatus: 200, lastError: null });
  });

  it('an address that keeps failing is switched off, and switching it back on starts fresh', async () => {
    const { webhook } = await addHook(owner, ['lead.created'], '/dead');
    receiverMode.status = 500;
    await h.admin.query(`UPDATE outbound_endpoints SET consecutive_failures = 29 WHERE id = $1`, [webhook.id]);
    await newLead(owner);
    await pump();
    const ep = (await owner.get(`/api/v1/webhooks/${webhook.id}`)).body.data;
    expect(ep.status).toBe('disabled');
    expect(ep.disabledReason).toMatch(/failed attempts/);
    receiverMode.status = 200;
    const calls = hits('/dead').length;
    await newLead(owner);
    await pump();
    expect(hits('/dead').length).toBe(calls); // switched off: nothing more is sent
    const on = await owner.patch(`/api/v1/webhooks/${webhook.id}`, { status: 'active' });
    expect(on.body.data).toMatchObject({ status: 'active', disabledReason: null });
    const row = (await h.admin.query(`SELECT consecutive_failures FROM outbound_endpoints WHERE id = $1`, [webhook.id])).rows[0];
    expect(row.consecutive_failures).toBe(0);
  });

  it('the test button pings the address right now and reports the answer; a failed message can be sent again by hand', async () => {
    const { webhook, secret } = await addHook(owner, ['lead.created'], '/pingme');
    const t = await owner.post(`/api/v1/webhooks/${webhook.id}/test`);
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ ok: true, status: 200 });
    const ping = hits('/pingme')[0]!;
    expect(ping.headers['x-anibros-event']).toBe('ping');
    expect(verify(secret, String(ping.headers['x-anibros-signature']), ping.body)).toBe(true);
    const log = (await owner.get(`/api/v1/webhooks/deliveries?endpointId=${webhook.id}`)).body.data;
    expect(log[0]).toMatchObject({ event: 'ping', isTest: true, status: 'delivered' });

    receiverMode.status = 503;
    const bad = await owner.post(`/api/v1/webhooks/${webhook.id}/test`);
    expect(bad.body.data).toMatchObject({ ok: false, status: 503 });
    expect(bad.body.data.error).toMatch(/503/);
    receiverMode.status = 200;

    // rotate: the old secret stops verifying
    const rot = await owner.post(`/api/v1/webhooks/${webhook.id}/rotate-secret`);
    expect(rot.body.data.secret).not.toBe(secret);
    await owner.post(`/api/v1/webhooks/${webhook.id}/test`);
    const last = hits('/pingme').at(-1)!;
    expect(verify(rot.body.data.secret, String(last.headers['x-anibros-signature']), last.body)).toBe(true);
    expect(verify(secret, String(last.headers['x-anibros-signature']), last.body)).toBe(false);
  });

  it('is workspace-private and permission-checked, never leaks the secret, and refuses unsafe addresses', async () => {
    const { webhook, secret } = await addHook(owner, ['lead.created'], '/private');
    // another workspace cannot see, change or delete it
    expect((await stranger.get(`/api/v1/webhooks/${webhook.id}`)).status).toBe(404);
    expect((await stranger.patch(`/api/v1/webhooks/${webhook.id}`, { status: 'paused' })).status).toBe(404);
    expect((await stranger.delete(`/api/v1/webhooks/${webhook.id}`)).status).toBe(404);
    expect((await stranger.get('/api/v1/webhooks')).body.data.map((w: any) => w.id)).not.toContain(webhook.id);
    // a salesperson cannot manage them
    const agent = await h.register({ emailPrefix: 'w4wh', organisationName: 'Wh Agent Home' });
    await addMember(agent, owner.tenantId, 'sales_agent');
    const a = asIn(agent, owner.tenantId);
    expect((await a.post('/api/v1/webhooks', { name: 'x', url: `http://127.0.0.1:${PORT}/x`, events: ['lead.created'] })).status).toBe(403);
    expect((await a.get('/api/v1/webhooks/deliveries')).status).toBe(403);
    // the secret is never in a read or in the audit trail
    const read = JSON.stringify((await owner.get(`/api/v1/webhooks/${webhook.id}`)).body);
    expect(read).not.toContain(secret);
    const audit = JSON.stringify((await h.admin.query(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'webhook.%'`, [owner.tenantId])).rows);
    expect(audit).not.toContain(secret);
    const stored = (await h.admin.query(`SELECT secret_enc FROM outbound_endpoints WHERE id = $1`, [webhook.id])).rows[0].secret_enc as string;
    expect(stored).not.toContain(secret);
    // bad input
    expect((await owner.post('/api/v1/webhooks', { name: 'x', url: 'not a url', events: ['lead.created'] })).status).toBe(400);
    expect((await owner.post('/api/v1/webhooks', { name: 'x', url: `http://user:pw@127.0.0.1:${PORT}/x`, events: ['lead.created'] })).status).toBe(400);
    expect((await owner.post('/api/v1/webhooks', { name: 'x', url: `http://127.0.0.1:${PORT}/x`, events: ['lead.exploded'] })).status).toBe(400);
    expect((await owner.post('/api/v1/webhooks', { name: 'x', url: `http://127.0.0.1:${PORT}/x`, events: [] })).status).toBe(400);
  });

  it('soft-deleting a webhook stops its messages', async () => {
    const { webhook } = await addHook(owner, ['lead.created'], '/gone');
    expect((await owner.delete(`/api/v1/webhooks/${webhook.id}`)).status).toBe(204);
    await newLead(owner);
    await pump();
    expect(hits('/gone').length).toBe(0);
    expect((await owner.get(`/api/v1/webhooks/${webhook.id}`)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('e-mail from a lead', () => {
  it('goes out under the client’s name with the sender as reply-to, is logged on the timeline and stops the first-reply clock', async () => {
    const lead = await newLead(owner, {}, { email: `mailme${uniq()}@x.test` });
    const before = h.mail.sent.length;
    const r = await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', subject: 'Your appointment', body: 'Hello,\nSee you Tuesday at 4pm.' });
    expect(r.status).toBe(202);
    expect(r.body.data.delivery).toBe('queued');
    await pump();
    const mail = h.mail.sent.slice(before).find((m) => m.subject === 'Your appointment')!;
    expect(mail).toBeTruthy();
    expect(mail.to).toBe(lead.contactEmail);
    expect(mail.fromName).toBe('Wave Four Co');
    expect(mail.replyTo).toBe(owner.email.toLowerCase());
    expect(mail.text).toContain('See you Tuesday');
    const act = (await h.admin.query(`SELECT type, direction, metadata FROM activities WHERE id = $1`, [r.body.data.activityId])).rows[0];
    expect(act).toMatchObject({ type: 'email', direction: 'outbound' });
    expect(act.metadata.delivery).toBe('sent');
    const after = (await h.admin.query(`SELECT first_response_at FROM leads WHERE id = $1`, [lead.id])).rows[0];
    expect(after.first_response_at).not.toBeNull();
  });

  it('refuses a lead with no address, an empty subject, and never takes an address from the request', async () => {
    const noMail = await newLead(owner, {}, { email: undefined, phone: phone() });
    expect((await owner.post('/api/v1/messaging/send', { leadId: noMail.id, channel: 'email', subject: 'Hi', body: 'x' })).status).toBe(400);
    expect(Number((await h.admin.query(`SELECT count(*) AS n FROM activities WHERE lead_id = $1 AND type = 'email'`, [noMail.id])).rows[0].n)).toBe(0); // nothing was logged
    const lead = await newLead(owner);
    expect((await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', body: 'no subject' })).status).toBe(400);
    const before = h.mail.sent.length;
    await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', subject: 'S', body: 'b', to: 'attacker@evil.test' });
    await pump();
    expect(h.mail.sent.slice(before).map((m) => m.to)).toEqual([lead.contactEmail]);
  });

  it('follows who may log that kind of work, and who can see the lead', async () => {
    const lead = await newLead(owner, {}, { email: `spec${uniq()}@x.test` });
    const wa = await h.register({ emailPrefix: 'w4wa', organisationName: 'Wa Home' });
    await addMember(wa, owner.tenantId, 'sales_agent', ['whatsapp']);
    await h.admin.query(`UPDATE leads SET owner_id = $2 WHERE id = $1`, [lead.id, wa.userId]);
    expect((await asIn(wa, owner.tenantId).post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', subject: 'x', body: 'y' })).status).toBe(403);
    // a lead in another workspace cannot be reached at all
    expect((await stranger.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', subject: 'x', body: 'y' })).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('WhatsApp from a lead', () => {
  it('is refused until a number is connected; the token is checked, stored encrypted and never returned', async () => {
    const lead = await newLead(owner, {}, { phone: phone() });
    const refused = await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'whatsapp', body: 'Hello' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/not connected/i);
    expect(Number((await h.admin.query(`SELECT count(*) AS n FROM activities WHERE lead_id = $1 AND type = 'whatsapp'`, [lead.id])).rows[0].n)).toBe(0);

    const bad = await owner.put('/api/v1/messaging/whatsapp', { phoneNumberId: '1234567890', accessToken: 'EAAGbadtoken0123456789abcdef' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/token/i);
    const ok = await owner.put('/api/v1/messaging/whatsapp', { phoneNumberId: '1234567890', accessToken: GOOD_TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ connected: true, phoneNumberId: '1234567890', displayPhone: '+1 555 0100', tokenHint: GOOD_TOKEN.slice(-4) });
    expect(JSON.stringify(ok.body)).not.toContain(GOOD_TOKEN);
    expect(JSON.stringify((await owner.get('/api/v1/messaging/whatsapp')).body)).not.toContain(GOOD_TOKEN);
    const stored = (await h.admin.query(`SELECT token_enc FROM messaging_accounts WHERE tenant_id = $1`, [owner.tenantId])).rows[0].token_enc as string;
    expect(stored).not.toContain(GOOD_TOKEN);
    expect((await stranger.get('/api/v1/messaging/whatsapp')).body.data.connected).toBe(false); // not shared with other workspaces
  });

  it('sends free text to the lead’s own number, and a template when asked', async () => {
    const ph = phone();
    const lead = await newLead(owner, {}, { phone: ph });
    waCalls.length = 0;
    const r = await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'whatsapp', body: 'Your visit is confirmed.' });
    expect(r.status).toBe(202);
    await pump();
    const post = waCalls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v21.0/1234567890/messages');
    expect(post.auth).toBe(`Bearer ${GOOD_TOKEN}`);
    expect(post.body).toMatchObject({ messaging_product: 'whatsapp', to: ph.replace(/\D/g, ''), type: 'text', text: { body: 'Your visit is confirmed.' } });
    const act = (await h.admin.query(`SELECT metadata FROM activities WHERE id = $1`, [r.body.data.activityId])).rows[0];
    expect(act.metadata.delivery).toBe('sent');
    expect(act.metadata.providerId).toMatch(/^wamid\./);

    waCalls.length = 0;
    const t = await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'whatsapp', template: { name: 'appointment_reminder', language: 'en', params: ['Tuesday'] } });
    expect(t.status).toBe(202);
    await pump();
    expect(waCalls.find((c) => c.method === 'POST')!.body).toMatchObject({ type: 'template', template: { name: 'appointment_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Tuesday' }] }] } });
  });

  it('explains a refusal in plain words, marks the message failed and tells the sender', async () => {
    const lead = await newLead(owner, {}, { phone: phone() });
    waMode.error = { code: 131047, status: 400 };
    const r = await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'whatsapp', body: 'Hi again' });
    await pump();
    waMode.error = null;
    const act = (await h.admin.query(`SELECT metadata FROM activities WHERE id = $1`, [r.body.data.activityId])).rows[0];
    expect(act.metadata.delivery).toBe('failed');
    expect(act.metadata.error).toMatch(/24 hours/);
    const note = (await h.admin.query(`SELECT title, message FROM notifications WHERE entity_id = $1 AND user_id = $2 AND type = 'lead_activity'`, [lead.id, owner.userId])).rows;
    expect(note.some((x: any) => /not delivered/.test(x.title))).toBe(true);
  });

  it('disconnecting removes the number; sending is refused again', async () => {
    expect((await owner.delete('/api/v1/messaging/whatsapp')).status).toBe(204);
    expect((await owner.get('/api/v1/messaging/whatsapp')).body.data.connected).toBe(false);
    const lead = await newLead(owner, {}, { phone: phone() });
    expect((await owner.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'whatsapp', body: 'x' })).status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('shared rate limiter', () => {
  it('two processes sharing one table enforce one allowance, refill over time, and keep keys apart', async () => {
    const { PgRateLimiter } = await import('../platform/http/rate-limit');
    const opts = { name: 't', capacity: 3, refillPerSecond: 1 };
    const db = { query: (sql: string, params?: unknown[]) => h.admin.query(sql, params as any[]) as any };
    const procA = new PgRateLimiter(opts, db);
    const procB = new PgRateLimiter(opts, db); // a second API process
    const key = `k:${uniq()}`;
    const results = [await procA.takeAsync(key), await procB.takeAsync(key), await procA.takeAsync(key)];
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    const denied = await procB.takeAsync(key);
    expect(denied).toMatchObject({ allowed: false, remaining: 0, limit: 3 });
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((await procA.takeAsync(`other:${uniq()}`)).allowed).toBe(true); // another key has its own bucket
    await new Promise((r) => setTimeout(r, 1200));
    expect((await procA.takeAsync(key)).allowed).toBe(true); // refilled by one token
    expect((await procB.takeAsync(key)).allowed).toBe(false);
  });

  it('fails open (never blocks the service) when the counters cannot be reached', async () => {
    const { PgRateLimiter } = await import('../platform/http/rate-limit');
    const broken = new PgRateLimiter({ name: 'x', capacity: 5, refillPerSecond: 1 }, { query: async () => { throw new Error('db down'); } });
    expect(await broken.takeAsync('a')).toMatchObject({ allowed: true });
  });

  it('is reachable only through the function: the API role has no direct access to the table', async () => {
    const api = new (await import('pg')).default.Client({ connectionString: h.tdb.apiUrl });
    await api.connect();
    try {
      await expect(api.query(`SELECT * FROM rate_buckets`)).rejects.toThrow(/permission denied/);
      await expect(api.query(`DELETE FROM rate_buckets`)).rejects.toThrow(/permission denied/);
      expect((await api.query(`SELECT * FROM app.rate_take('probe', 2, 1, 1)`)).rows[0].allowed).toBe(true);
      await expect(api.query(`SELECT * FROM app.rate_take('probe', 0, 1, 1)`)).rejects.toThrow(/invalid rate limit/);
    } finally {
      await api.end();
    }
  });
});

describe('address safety', () => {
  it('private, loopback, link-local and metadata addresses are all blocked, IPv4-in-IPv6 included', async () => {
    const { isBlockedAddress } = await import('../modules/outbound/safe-http');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});
