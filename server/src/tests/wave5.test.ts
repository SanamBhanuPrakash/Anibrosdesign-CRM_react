import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Wave 5: any website form and any chatbot into the CRM (with the visitor's message), "send everything to one person", the agency's own
 * workspace opening like any client, opted-out people not being messaged, and the identity-table row-level policies as the app sees them.
 */
const require = createRequire(import.meta.url);

let h: ApiHarness;
let boss: AuthedUser;
let stranger: AuthedUser;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const phone = () => `+9187${String(10_000_000 + ((n++ * 7919) % 89_999_999)).padStart(8, '0')}`;
const A = '/api/v1/agency';
const H = (c: { id: string }) => ({ 'X-Tenant-Id': c.id });
const api = () => request(h.app);

async function joinStaff(name: string): Promise<AuthedUser> {
  const email = `w5staff${uniq()}@anibros.test`;
  const inv = await boss.post(`${A}/staff/invitations`, { email });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status}`);
  await h.runJobs();
  const token = h.mail.tokenFor(email, 'invited')!;
  const password = 'Violet-Lantern-Orbit-77';
  const acc = await api().post('/api/v1/invitations/accept').send({ token, name, password });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status}`);
  const { cookies, csrf } = cookiesFrom(acc);
  const probe = h.as({ cookies, csrf });
  const me = await probe.get('/api/v1/me');
  return { email, password, name, userId: me.body.data.user.id, tenantId: me.body.data.activeTenantId, cookies, csrf, ...probe };
}
async function mkClient(name: string) {
  const r = await boss.post(`${A}/clients`, { name, industry: 'retail' });
  if (r.status !== 201) throw new Error(`client create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}
const mkLead = async (c: { id: string }, as: AuthedUser, extra: Record<string, unknown> = {}) => {
  const r = await as.post('/api/v1/leads', { contact: { firstName: `Lead${uniq()}`, email: `l${uniq()}@x.test` }, source: 'direct', ...extra }, H(c));
  if (r.status !== 201) throw new Error(`lead create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
async function source(body: Record<string, unknown>) {
  const r = await boss.post('/api/v1/lead-sources', body);
  if (r.status !== 201) throw new Error(`create source failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { endpoint: any; secret: string | null };
}
/** The lead a delivery produced, once the worker has run. */
async function leadOf(endpointId: string) {
  await h.runJobs();
  const ev = (await h.admin.query(`SELECT status, lead_id FROM inbound_events WHERE endpoint_id = $1 ORDER BY received_at DESC LIMIT 1`, [endpointId])).rows[0];
  expect(ev?.status, 'delivery status').toBe('created');
  const lead = (await h.admin.query(`SELECT l.id, l.source, c.first_name, c.last_name, c.email::text AS email, c.phone FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1`, [ev.lead_id])).rows[0];
  const notes = (await h.admin.query(`SELECT description, metadata FROM activities WHERE lead_id = $1 ORDER BY created_at, id`, [lead.id])).rows as Array<{ description: string; metadata: any }>;
  return { lead, notes, said: notes.find((x) => x.metadata?.event === 'inbound_message') };
}
const post = (id: string, body: unknown, type = 'text/plain') => api().post(`/hooks/${id}`).set('Content-Type', type).send(typeof body === 'string' ? body : JSON.stringify(body));

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  boss = await h.register({ emailPrefix: 'w5boss', name: 'Wave Five Boss', organisationName: 'Wave Five Agency' });
  stranger = await h.register({ emailPrefix: 'w5str', name: 'Someone Else', organisationName: 'Another Agency' });
}, 240_000);
afterAll(async () => h?.close());

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the agency’s own company opens like any client', () => {
  it('its overview loads for the owner and for staff, and not for another agency', async () => {
    const mine = await boss.get(`${A}/clients/${boss.tenantId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id: boss.tenantId, name: 'Wave Five Agency' });
    expect(mine.body.data.stats).toBeTruthy();
    const staff = await joinStaff('Own Company Staff');
    expect((await staff.get(`${A}/clients/${boss.tenantId}`)).status).toBe(200);
    expect((await stranger.get(`${A}/clients/${boss.tenantId}`)).status).toBe(404);
  });

  it('it is still not offered as a client to manage: no rename, archive or team edits through the client routes', async () => {
    expect((await boss.patch(`${A}/clients/${boss.tenantId}`, { name: 'Renamed' })).status).toBe(404);
    expect((await boss.post(`${A}/clients/${boss.tenantId}/archive`)).status).toBe(404);
    expect((await boss.get(`${A}/clients`)).body.data.map((c: any) => c.id)).not.toContain(boss.tenantId);
  });

  it('its team activity opens too', async () => {
    expect((await boss.get(`${A}/activity?clientId=${boss.tenantId}`)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('send every lead to one person', () => {
  let shop: any;
  let one: AuthedUser;
  let two: AuthedUser;
  let agent: AuthedUser;
  beforeAll(async () => {
    shop = await mkClient('Everything Shop');
    one = await joinStaff('Olive One');
    two = await joinStaff('Tom Two');
    agent = await joinStaff('Agent Alex');
    for (const [u, role] of [[one, 'sales_agent'], [two, 'sales_agent'], [agent, 'sales_agent']] as const) expect((await boss.put(`${A}/clients/${shop.id}/team/${u.userId}`, { role })).status).toBe(200);
  });

  it('a rule for “all” is accepted, validated against this client and stored first', async () => {
    const ws = (routing: unknown) => boss.patch('/api/v1/workspace', { routing }, H(shop));
    expect((await ws([{ source: 'all', userIds: ['00000000-0000-4000-8000-000000000000'] }])).status).toBe(400);
    expect((await ws([{ source: 'all', userIds: [one.userId] }, { source: 'all', userIds: [two.userId] }])).status).toBe(400);
    expect((await agent.patch('/api/v1/workspace', { routing: [{ source: 'all', userIds: [agent.userId] }] }, H(shop))).status).toBe(403);
    const ok = await ws([{ source: 'all', userIds: [one.userId] }]);
    expect(ok.status).toBe(200);
    expect(ok.body.data.routing).toEqual([{ source: 'all', userIds: [one.userId] }]);
  });

  it('every source goes to that person, including leads a team member adds by hand', async () => {
    for (const source of ['website', 'meta_ads', 'google_ads', 'walk_in', 'other']) expect((await mkLead(shop, boss, { source })).ownerId, source).toBe(one.userId);
    expect((await mkLead(shop, agent, { source: 'direct' })).ownerId).toBe(one.userId); // added by hand in "whoever adds it" mode
  });

  it('a rule for one source still wins, an explicit owner is respected, and clearing the rule restores the normal behaviour', async () => {
    const both = await boss.patch('/api/v1/workspace', { routing: [{ source: 'all', userIds: [one.userId] }, { source: 'google_ads', userIds: [two.userId] }] }, H(shop));
    expect(both.status).toBe(200);
    expect((await mkLead(shop, boss, { source: 'google_ads' })).ownerId).toBe(two.userId);
    expect((await mkLead(shop, boss, { source: 'website' })).ownerId).toBe(one.userId);
    expect((await mkLead(shop, boss, { source: 'website', ownerId: agent.userId })).ownerId).toBe(agent.userId);
    expect((await boss.patch('/api/v1/workspace', { routing: [], leadAssignment: 'creator' }, H(shop))).status).toBe(200);
    expect((await mkLead(shop, agent, { source: 'direct' })).ownerId).toBe(agent.userId); // back to "whoever adds it"
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('any website form, whatever its fields are called', () => {
  it('reads WordPress-style names and keeps what the visitor wrote as a note', async () => {
    const { endpoint } = await source({ provider: 'website', name: `WP ${uniq()}` });
    const p = phone();
    const res = await post(endpoint.id, {
      'your-name': 'Kavita Rao', 'your-email': `kavita${uniq()}@example.com`, 'tel-512': p, 'your-message': 'I would like a quote for a 5-page website and a logo.',
      'your-subject': 'Website quote', page_url: 'https://www.example-agency.com/contact', page_title: 'Contact us', form_name: 'contact', utm_source: 'google',
    });
    expect(res.status).toBe(200);
    const { lead, said } = await leadOf(endpoint.id);
    expect(lead).toMatchObject({ first_name: 'Kavita', last_name: 'Rao', phone: p, source: 'website' });
    expect(said?.description).toBe('Their message: “I would like a quote for a 5-page website and a logo.”');
    const row = (await h.admin.query(`SELECT source_details FROM leads WHERE id = $1`, [lead.id])).rows[0].source_details;
    expect(row.context).toMatchObject({ page_url: 'https://www.example-agency.com/contact', form_name: 'contact' });
    expect(row.tracking).toEqual({ utm_source: 'google' });
  });

  it('finds the phone and e-mail by what they look like when the labels are strange', async () => {
    const { endpoint } = await source({ provider: 'website', name: `Odd ${uniq()}` });
    const p = phone();
    await post(endpoint.id, { Who: 'x', 'Reach me on': p, 'Mail me': `odd${uniq()}@example.com`, 'Full Name': 'Dev Patel', 'Tell us more': 'We need help with our brand.', Budget: '2500000' });
    const { lead, said } = await leadOf(endpoint.id);
    expect(lead).toMatchObject({ first_name: 'Dev', last_name: 'Patel', phone: p });
    expect(lead.email).toMatch(/^odd/);
    expect(said?.description).toContain('We need help with our brand.');
  });

  it('a budget of digits is not mistaken for a phone number', async () => {
    const { endpoint } = await source({ provider: 'website', name: `Budget ${uniq()}` });
    await post(endpoint.id, { name: 'Sam Roy', email: `sam${uniq()}@example.com`, budget_amount: '12345678', details: 'Hello' });
    const { lead } = await leadOf(endpoint.id);
    expect(lead.phone).toBeNull();
  });

  it('accepts form-encoded posts from no-code form tools as well as JSON', async () => {
    const { endpoint } = await source({ provider: 'website', name: `Encoded ${uniq()}` });
    const body = new URLSearchParams({ name: 'Isha Mehta', email: `isha${uniq()}@example.com`, comments: 'Please call me' }).toString();
    expect((await post(endpoint.id, body, 'application/x-www-form-urlencoded')).status).toBe(200);
    const { said } = await leadOf(endpoint.id);
    expect(said?.description).toContain('Please call me');
  });
});

describe('the one-line website script', () => {
  const { JSDOM } = require('jsdom');
  let id: string;
  beforeAll(async () => {
    id = (await source({ provider: 'website', name: `Script ${uniq()}` })).endpoint.id;
  });

  it('is served for a website source only, with the address filled in safely', async () => {
    const r = await api().get(`/hooks/${id}/capture.js`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.text).toContain(`/hooks/${id}`);
    expect(r.text).not.toContain('__ENDPOINT__');
    const generic = (await source({ provider: 'generic', name: `NoScript ${uniq()}` })).endpoint;
    expect((await api().get(`/hooks/${generic.id}/capture.js`)).status).toBe(404);
    expect((await api().get(`/hooks/${'0'.repeat(8)}-0000-4000-8000-000000000000/capture.js`)).status).toBe(404);
    expect((await api().get(`/hooks/not-an-id/capture.js`)).status).toBe(404);
  });

  /** Load the real script into a page with the given body, collect what it would send. */
  async function page(body: string) {
    const script = (await api().get(`/hooks/${id}/capture.js`)).text;
    const dom = new JSDOM(`<!doctype html><title>Contact</title><body>${body}</body>`, { url: 'https://shop.example/contact?utm_source=fb&utm_campaign=autumn', runScripts: 'outside-only', referrer: 'https://google.com/' });
    const w = dom.window;
    // jsdom has no layout: say which elements a visitor could see
    Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.hasAttribute('data-hidden') ? 0 : 100; } });
    w.HTMLElement.prototype.getClientRects = function () { return this.hasAttribute('data-hidden') ? [] : [1]; };
    const sent: Array<{ url: string; body: any }> = [];
    w.fetch = (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true }); };
    w.eval(script);
    const submit = (sel: string) => w.document.querySelector(sel).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    return { w, sent, submit };
  }

  it('sends a WordPress contact form (Contact Form 7 names) and the server turns it into a lead with the message', async () => {
    const { sent, submit, w } = await page(`<form id="cf7" aria-label="Contact form 1">
      <input name="your-name" value="Neha Kapoor"><input name="your-email" type="email" value="neha${uniq()}@example.com">
      <input name="tel-512" type="tel" value="${phone()}"><input name="_wpcf7" type="hidden" value="123">
      <textarea name="your-message">Need a rebrand before Diwali.</textarea><input type="submit"></form>`);
    submit('#cf7');
    expect(sent).toHaveLength(1);
    const b = sent[0]!.body;
    expect(b).toMatchObject({ 'your-name': 'Neha Kapoor', 'your-message': 'Need a rebrand before Diwali.', page_url: 'https://shop.example/contact', utm_source: 'fb', utm_campaign: 'autumn', form_name: 'Contact form 1' });
    expect(b.referrer).toBe('https://google.com/');
    expect(Object.keys(b)).not.toContain('_wpcf7'); // hidden plumbing fields are not sent
    expect(w.AnibrosCRM.loaded).toBe(true);
    expect((await post(id, b)).status).toBe(200);
    const { lead, said } = await leadOf(id);
    expect(lead).toMatchObject({ first_name: 'Neha', last_name: 'Kapoor' });
    expect(said?.description).toContain('Need a rebrand before Diwali.');
  });

  it('names an Elementor-style field by its label when the name is a meaningless id', async () => {
    const { sent, submit } = await page(`<form id="el"><label for="f1">Your name</label><input id="f1" name="form_fields[name]" value="Rahul Jain">
      <label for="f2">Phone number</label><input id="f2" name="form_fields[field_9c2e1a]" value="${phone()}">
      <label for="f3">Message</label><textarea id="f3" name="form_fields[message]">Hello there</textarea></form>`);
    submit('#el');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body)).toEqual(expect.arrayContaining(['name', 'Phone number', 'message']));
    expect((await post(id, sent[0]!.body)).status).toBe(200);
    const { lead } = await leadOf(id);
    expect(lead.first_name).toBe('Rahul');
    expect(lead.phone).toMatch(/^\+9187/);
  });

  it('does not send login, search, payment, contact-less or bot-filled forms, nor read private fields', async () => {
    const { sent, submit } = await page(`
      <form id="login"><input name="email" value="a@b.co"><input type="password" name="pw" value="secret"></form>
      <form id="search" role="search"><input name="q" value="shoes 5551234567"></form>
      <form id="news"><input name="name" value="Just A Name"></form>
      <form id="bot"><input name="name" value="Bot"><input name="email" value="bot@x.co"><input name="website_url" value="http://spam" data-hidden></form>
      <form id="skip" data-anibros="ignore"><input name="email" value="skip@x.co"></form>
      <form id="pay"><input name="email" value="pay@x.co"><input name="card_number" value="4242424242424242"><input name="phone" value="+919800000001"></form>`);
    for (const f of ['#login', '#search', '#news', '#bot', '#skip']) submit(f);
    expect(sent).toHaveLength(0);
    submit('#pay');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).not.toContain('4242');
  });

  it('sends the same submission only once, and lets a chatbot hand over the conversation', async () => {
    const { sent, submit, w } = await page(`<form id="f"><input name="email" value="once@x.co"></form>`);
    submit('#f');
    submit('#f');
    expect(sent).toHaveLength(1);
    w.AnibrosCRM.say('visitor', 'I want a logo');
    w.AnibrosCRM.say('bot', 'Great, what is your name and number?');
    w.AnibrosCRM.lead({ name: 'Chat Person', phone: phone() });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.conversation).toEqual([{ from: 'visitor', text: 'I want a logo' }, { from: 'bot', text: 'Great, what is your name and number?' }]);
    expect((await post(id, sent[1]!.body)).status).toBe(200);
    const { lead, said } = await leadOf(id);
    expect(lead.first_name).toBe('Chat');
    expect(said?.description).toBe('Chat with the visitor:\nVisitor: I want a logo\nBot: Great, what is your name and number?');
    expect(said?.metadata.turns).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('chatbots and no-code tools', () => {
  let ep: any;
  let key: string;
  beforeAll(async () => {
    const s = await source({ provider: 'generic', name: `Chatbot ${uniq()}`, config: { source: 'website' } });
    ep = s.endpoint;
    key = s.secret!;
  });
  const chat = () => ({
    visitor: { name: 'Anil Kumar', email: `anil${uniq()}@example.com`, phone: phone() },
    message: 'Looking for a marketing agency for my restaurant',
    conversation: [{ from: 'visitor', text: 'Hi, can you do Instagram ads?' }, { role: 'assistant', content: 'Yes! Tell me about your business.' }, 'We run a restaurant'],
  });

  it('accepts the key in the address, as a bearer token, or in a header, and nothing else', async () => {
    expect((await post(ep.id, chat())).status).toBe(401);
    expect((await api().post(`/hooks/${ep.id}?key=wrong-key-wrong-key`).send(chat())).status).toBe(401);
    expect((await api().post(`/hooks/${ep.id}?key=short`).send(chat())).status).toBe(401);
    expect((await api().post(`/hooks/${ep.id}?key=${key}`).send(chat())).status).toBe(200);
    expect((await api().post(`/hooks/${ep.id}`).set('Authorization', `Bearer ${key}`).send(chat())).status).toBe(200);
    expect((await api().post(`/hooks/${ep.id}`).set('X-Anibros-Key', key).send(chat())).status).toBe(200);
    expect((await api().post(`/hooks/${ep.id}`).set('Authorization', `Bearer ${key}x`).send(chat())).status).toBe(401);
  });

  it('reads a nested visitor and a transcript in several shapes, and keeps both as notes', async () => {
    const r = await api().post(`/hooks/${ep.id}`).set('X-Anibros-Key', key).send({ ...chat(), eventId: `chat-${uniq()}` });
    expect(r.status).toBe(200);
    const { lead, notes } = await leadOf(ep.id);
    expect(lead).toMatchObject({ first_name: 'Anil', last_name: 'Kumar', source: 'website' });
    expect(lead.email).toMatch(/^anil/);
    expect(notes.find((x) => x.metadata?.event === 'inbound_message')?.description).toBe('Chat with the visitor:\nVisitor: Hi, can you do Instagram ads?\nBot: Yes! Tell me about your business.\nVisitor: We run a restaurant');
  });

  it('a signed request still works for developers', async () => {
    const crypto = await import('node:crypto');
    const raw = JSON.stringify({ name: 'Signed Sam', email: `sam${uniq()}@example.com`, message: 'signed' });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', key).update(`${t}.${raw}`).digest('hex');
    const r = await api().post(`/hooks/${ep.id}`).set('Content-Type', 'application/json').set('X-Anibros-Signature', `t=${t},v1=${sig}`).send(raw);
    expect(r.status).toBe(200);
  });

  it('a Meta, Google or website source cannot be opened with a bare key', async () => {
    const g = await source({ provider: 'google', name: `G ${uniq()}` });
    expect((await api().post(`/hooks/${g.endpoint.id}?key=${g.secret}`).send({ lead_id: 'x', user_column_data: [] })).status).toBe(401); // Google's key must be in the body
    expect((await api().post(`/hooks/${g.endpoint.id}`).set('Authorization', `Bearer ${g.secret}`).send({ lead_id: 'y' })).status).toBe(401); // a bearer token never stands in for it
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('people who opted out are not messaged from the CRM', () => {
  it('blocks a channel they withdrew, allows it again once they agree, and never blocks someone nobody asked', async () => {
    const lead = await mkLead({ id: boss.tenantId }, boss, { source: 'website' });
    const send = () => boss.post('/api/v1/messaging/send', { leadId: lead.id, channel: 'email', subject: 'Hello', body: 'Following up' });
    expect((await send()).status).toBe(202); // no record either way: replying to an enquiry is fine
    expect((await boss.post(`/api/v1/contacts/${lead.contactId}/consents`, { channel: 'email', action: 'grant', source: 'form' })).status).toBe(200);
    expect((await send()).status).toBe(202); // agreed: fine
    expect((await boss.post(`/api/v1/contacts/${lead.contactId}/consents`, { channel: 'email', action: 'revoke', reason: 'Asked us to stop' })).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('opted out');
    expect(Number((await h.admin.query(`SELECT count(*) AS n FROM activities WHERE lead_id = $1 AND type = 'email'`, [lead.id])).rows[0].n)).toBe(2); // the blocked one left nothing behind
    expect((await boss.post(`/api/v1/contacts/${lead.contactId}/consents`, { channel: 'email', action: 'grant', source: 'manual' })).status).toBe(200);
    expect((await send()).status).toBe(202);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the app still works for everyone with row-level policies on the identity tables', () => {
  it('another agency cannot see this agency’s staff, clients or team through any route', async () => {
    const mine = await boss.get(`${A}/staff`);
    expect(mine.status).toBe(200);
    expect(JSON.stringify((await stranger.get(`${A}/staff`)).body)).not.toContain('Wave Five');
    const clients = (await boss.get(`${A}/clients`)).body.data as Array<{ id: string }>;
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) {
      expect((await stranger.get(`${A}/clients/${c.id}`)).status).toBe(404);
      expect([403, 404]).toContain((await stranger.get('/api/v1/members', H(c))).status);
    }
  });

  it('the members screen shows MFA and last-seen for the workspace’s own people', async () => {
    const r = await boss.get('/api/v1/members');
    expect(r.status).toBe(200);
    const me = (r.body.data.members as any[]).find((m) => m.userId === boss.userId);
    expect(me).toMatchObject({ mfaEnabled: false });
    expect(me.lastSeenAt === null || typeof me.lastSeenAt === 'string').toBe(true);
  });
});
