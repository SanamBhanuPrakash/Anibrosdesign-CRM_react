import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Wave 3: specialist employees (only calls, only WhatsApp…), people who work on a lead without owning it, routing leads by source,
 * and the side-by-side report of the clients a person belongs to.
 */
let h: ApiHarness;
let boss: AuthedUser;
let wa: AuthedUser; // only WhatsApp
let caller: AuthedUser; // only calls
let allrounder: AuthedUser; // everything
let manager: AuthedUser; // team lead in the clinic, and a plain caller (own leads only) in the diner
let clinic: any;
let diner: any;
let shop: any;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const api = () => request(h.app);
const H = (c: { id: string }) => ({ 'X-Tenant-Id': c.id });
const A = '/api/v1/agency';
const dbCount = async (sql: string, params: unknown[] = []) => Number((await h.admin.query(sql, params)).rows[0].n);

async function joinStaff(name: string): Promise<AuthedUser> {
  const email = `w3staff${uniq()}@anibros.test`;
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
async function mkClient(body: Record<string, unknown>) {
  const r = await boss.post(`${A}/clients`, body);
  if (r.status !== 201) throw new Error(`client create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}
const assign = (c: { id: string }, u: AuthedUser, role: string, channels?: string[] | null) =>
  boss.put(`${A}/clients/${c.id}/team/${u.userId}`, channels === undefined ? { role } : { role, channels });
async function mkLead(c: { id: string }, extra: Record<string, unknown> = {}) {
  const r = await boss.post('/api/v1/leads', { contact: { firstName: `Lead${uniq()}`, email: `l${uniq()}@x.test` }, source: 'direct', ...extra }, H(c));
  if (r.status !== 201) throw new Error(`lead create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}
const log = (u: AuthedUser, c: { id: string }, leadId: string, body: Record<string, unknown>) => u.post(`/api/v1/leads/${leadId}/activities`, { description: 'x', ...body }, H(c));

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  boss = await h.register({ emailPrefix: 'w3boss', name: 'Wave Three Boss', organisationName: 'Wave Three Agency' });
  clinic = await mkClient({ name: 'Spec Clinic', industry: 'healthcare' });
  diner = await mkClient({ name: 'Report Diner', industry: 'restaurant' });
  shop = await mkClient({ name: 'Empty Shop', industry: 'retail' });
  wa = await joinStaff('Wanda WhatsApp');
  caller = await joinStaff('Carl Caller');
  allrounder = await joinStaff('Alex Allround');
  manager = await joinStaff('Maya Manager');
  expect((await assign(clinic, wa, 'sales_agent', ['whatsapp'])).status).toBe(200);
  expect((await assign(clinic, caller, 'sales_agent', ['call'])).status).toBe(200);
  expect((await assign(clinic, allrounder, 'sales_agent')).status).toBe(200);
  expect((await assign(clinic, manager, 'sales_manager')).status).toBe(200);
}, 240_000);
afterAll(async () => h?.close());

describe('specialists: each person logs only the work they handle', () => {
  it('a WhatsApp-only person can log WhatsApp and notes, not calls; a calls-only person the reverse', async () => {
    const l1 = await mkLead(clinic, { ownerId: wa.userId });
    const l2 = await mkLead(clinic, { ownerId: caller.userId });
    expect((await log(wa, clinic, l1.id, { type: 'whatsapp', outcome: 'sent' })).status).toBe(201);
    expect((await log(wa, clinic, l1.id, { type: 'note' })).status).toBe(201);
    const refused = await log(wa, clinic, l1.id, { type: 'call' });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toMatch(/WhatsApp/);
    expect((await log(wa, clinic, l1.id, { type: 'instagram' })).status).toBe(403);
    expect((await log(caller, clinic, l2.id, { type: 'call', outcome: 'connected' })).status).toBe(201);
    expect((await log(caller, clinic, l2.id, { type: 'whatsapp' })).status).toBe(403);
    expect(await dbCount(`SELECT count(*) AS n FROM activities WHERE lead_id = $1 AND type = 'call'`, [l1.id])).toBe(0); // the refused call left nothing behind
  });

  it('everyone else, and admins, still log everything, including Instagram messages', async () => {
    const l = await mkLead(clinic, { ownerId: allrounder.userId });
    for (const type of ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting', 'note']) expect((await log(allrounder, clinic, l.id, { type })).status).toBe(201);
    const ig = await log(boss, clinic, l.id, { type: 'instagram', outcome: 'replied', direction: 'inbound' });
    expect(ig.status).toBe(201);
    const tl = (await boss.get(`/api/v1/leads/${l.id}/activities`, H(clinic))).body.data;
    expect(tl.find((a: any) => a.type === 'instagram' && a.direction === 'inbound')).toMatchObject({ outcome: 'replied' });
  });

  it('the setting is per client, shown in who-am-I, changeable, and validated', async () => {
    const mine = (await wa.get('/api/v1/me')).body.data.tenants.find((t: any) => t.id === clinic.id);
    expect(mine.workChannels).toEqual(['whatsapp']);
    expect((await boss.get('/api/v1/me')).body.data.tenants.find((t: any) => t.id === clinic.id).workChannels).toBeNull();
    const team = (await boss.get(`${A}/clients/${clinic.id}/team`)).body.data;
    expect(team.find((m: any) => m.userId === caller.userId).workChannels).toEqual(['call']);
    expect((await assign(clinic, wa, 'sales_agent', ['whatsapp', 'instagram'])).status).toBe(200);
    const l = await mkLead(clinic, { ownerId: wa.userId });
    expect((await log(wa, clinic, l.id, { type: 'instagram' })).status).toBe(201);
    expect((await assign(clinic, wa, 'sales_agent', ['fax'] as any)).status).toBe(400);
    expect((await assign(clinic, wa, 'sales_agent')).status).toBe(200); // leaving it out keeps what they have
    expect((await wa.get('/api/v1/me')).body.data.tenants.find((t: any) => t.id === clinic.id).workChannels).toEqual(['whatsapp', 'instagram']);
    expect((await assign(clinic, wa, 'sales_agent', [])).status).toBe(200); // empty = everything
    expect((await wa.get('/api/v1/me')).body.data.tenants.find((t: any) => t.id === clinic.id).workChannels).toBeNull();
    expect((await assign(clinic, wa, 'sales_agent', ['whatsapp'])).status).toBe(200);
    expect((await wa.put(`${A}/clients/${clinic.id}/team/${wa.userId}`, { role: 'sales_agent', channels: null })).status).toBe(403); // not their call
  });
});

describe('handlers: working on a lead without owning it', () => {
  it('a handler sees the lead and logs their kind of work, but cannot edit, move or reassign it', async () => {
    const lead = await mkLead(clinic, { ownerId: allrounder.userId });
    expect((await wa.get(`/api/v1/leads/${lead.id}`, H(clinic))).status).toBe(404); // not theirs yet
    const added = await boss.put(`/api/v1/leads/${lead.id}/handlers/${wa.userId}`, undefined, H(clinic));
    expect(added.status).toBe(200);
    expect(added.body.data).toEqual([expect.objectContaining({ userId: wa.userId, name: 'Wanda WhatsApp', workChannels: ['whatsapp'] })]);

    expect((await wa.get(`/api/v1/leads/${lead.id}`, H(clinic))).body.data.handlers).toHaveLength(1);
    expect((await wa.get('/api/v1/leads?limit=100', H(clinic))).body.data.map((x: any) => x.id)).toContain(lead.id);
    expect((await wa.get(`${A}/leads?pageSize=100`)).body.data.items.map((x: any) => x.id)).toContain(lead.id);
    expect((await log(wa, clinic, lead.id, { type: 'whatsapp', outcome: 'sent' })).status).toBe(201);
    expect((await log(wa, clinic, lead.id, { type: 'call' })).status).toBe(403); // still only WhatsApp
    const tl = (await wa.get(`/api/v1/leads/${lead.id}/activities`, H(clinic))).body.data;
    expect(tl.find((a: any) => a.type === 'whatsapp')).toMatchObject({ userName: 'Wanda WhatsApp' });
    expect(tl.map((a: any) => a.description)).toContain('Wanda WhatsApp was added to work on this lead');

    expect((await wa.patch(`/api/v1/leads/${lead.id}`, { campaign: 'hijack' }, { ...H(clinic), 'If-Match': `"${lead.version}"` })).status).toBeGreaterThanOrEqual(403);
    expect((await wa.post(`/api/v1/leads/${lead.id}/assign`, { ownerId: wa.userId }, H(clinic))).status).toBe(403);
    expect((await wa.put(`/api/v1/leads/${lead.id}/handlers/${caller.userId}`, undefined, H(clinic))).status).toBe(403);
    expect((await caller.get(`/api/v1/leads/${lead.id}`, H(clinic))).status).toBe(404); // other callers still cannot see it
    expect(await dbCount(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND entity_id = $2 AND title = 'You were added to a lead'`, [wa.userId, lead.id])).toBe(1);

    expect((await boss.delete(`/api/v1/leads/${lead.id}/handlers/${wa.userId}`, H(clinic))).body.data).toEqual([]);
    expect((await wa.get(`/api/v1/leads/${lead.id}`, H(clinic))).status).toBe(404);
    expect((await log(wa, clinic, lead.id, { type: 'whatsapp' })).status).toBe(404);
  });

  it('adding rules: not the owner, not a viewer, once only; and taking someone off a client removes them from its leads', async () => {
    const lead = await mkLead(clinic, { ownerId: allrounder.userId });
    expect((await boss.put(`/api/v1/leads/${lead.id}/handlers/${allrounder.userId}`, undefined, H(clinic))).status).toBe(409); // already the owner
    const viewer = await joinStaff('Vera Viewer');
    expect((await assign(clinic, viewer, 'executive_readonly')).status).toBe(200);
    expect((await boss.put(`/api/v1/leads/${lead.id}/handlers/${viewer.userId}`, undefined, H(clinic))).status).toBe(400);
    expect((await manager.put(`/api/v1/leads/${lead.id}/handlers/${caller.userId}`, undefined, H(clinic))).status).toBe(200); // a team lead may
    expect((await manager.put(`/api/v1/leads/${lead.id}/handlers/${caller.userId}`, undefined, H(clinic))).body.data).toHaveLength(1); // adding twice adds once
    expect(await dbCount(`SELECT count(*) AS n FROM lead_handlers WHERE lead_id = $1`, [lead.id])).toBe(1);
    expect((await boss.delete(`${A}/clients/${clinic.id}/team/${caller.userId}`)).status).toBe(200);
    expect(await dbCount(`SELECT count(*) AS n FROM lead_handlers WHERE lead_id = $1`, [lead.id])).toBe(0);
    expect((await assign(clinic, caller, 'sales_agent', ['call'])).status).toBe(200);
  });

  it('a lead counts once in a handler’s own numbers, however it reached them', async () => {
    const lead = await mkLead(clinic, { ownerId: allrounder.userId });
    await boss.put(`/api/v1/leads/${lead.id}/handlers/${wa.userId}`, undefined, H(clinic));
    const own = (await wa.get('/api/v1/leads?limit=200', H(clinic))).body.data.filter((x: any) => x.id === lead.id);
    expect(own).toHaveLength(1);
    const ids = (await wa.get(`${A}/leads?pageSize=100`)).body.data.items.filter((x: any) => x.id === lead.id);
    expect(ids).toHaveLength(1);
  });
});

describe('routing: leads from a source go to chosen people', () => {
  it('validates the rules against this client, and stores them', async () => {
    const ws = (u: AuthedUser, routing: unknown) => u.patch('/api/v1/workspace', { routing }, H(clinic));
    expect((await ws(boss, [{ source: 'meta_ads', userIds: ['00000000-0000-4000-8000-000000000000'] }])).status).toBe(400); // not a member
    expect((await ws(boss, [{ source: 'meta_ads', userIds: [wa.userId] }, { source: 'meta_ads', userIds: [caller.userId] }])).status).toBe(400); // one rule per source
    expect((await ws(boss, [{ source: 'telepathy', userIds: [wa.userId] }])).status).toBe(400);
    expect((await ws(wa, [{ source: 'meta_ads', userIds: [wa.userId] }])).status).toBe(403);
    const ok = await ws(boss, [{ source: 'meta_ads', userIds: [wa.userId, caller.userId] }]);
    expect(ok.status).toBe(200);
    expect(ok.body.data.routing).toEqual([{ source: 'meta_ads', userIds: [wa.userId, caller.userId] }]);
    expect((await boss.get('/api/v1/workspace', H(clinic))).body.data.routing).toHaveLength(1);
  });

  it('Meta leads are shared between the chosen people, least busy first; other sources follow the normal rule; an explicit owner wins', async () => {
    const owners = [] as string[];
    for (let i = 0; i < 4; i++) owners.push((await mkLead(clinic, { source: 'meta_ads' })).ownerId);
    expect(owners.every((o) => [wa.userId, caller.userId].includes(o))).toBe(true);
    const wa4 = owners.filter((o) => o === wa.userId).length;
    expect(Math.abs(wa4 - (4 - wa4))).toBeLessThanOrEqual(2); // shared, not piled on one person
    const other = await mkLead(clinic, { source: 'google_ads' });
    expect(other.ownerId).toBeTruthy(); // the client's normal rule (least busy salesperson)
    const explicit = await mkLead(clinic, { source: 'meta_ads', ownerId: allrounder.userId });
    expect(explicit.ownerId).toBe(allrounder.userId);
  });

  it('a rule beats “leave leads unassigned”, and clearing the rules goes back to the normal behaviour', async () => {
    expect((await boss.patch('/api/v1/workspace', { leadAssignment: 'unassigned' }, H(clinic))).status).toBe(200);
    expect((await mkLead(clinic, { source: 'meta_ads' })).ownerId).toBeTruthy();
    expect((await mkLead(clinic, { source: 'website' })).ownerId).toBeNull();
    expect((await boss.patch('/api/v1/workspace', { routing: [] }, H(clinic))).body.data.routing).toEqual([]);
    expect((await mkLead(clinic, { source: 'meta_ads' })).ownerId).toBeNull();
    expect((await boss.patch('/api/v1/workspace', { leadAssignment: 'balanced' }, H(clinic))).status).toBe(200);
  });
});

describe('the API cannot be hammered or guessed at', () => {
  it('a key that floods the API is slowed down with Retry-After; people and other keys are unaffected', async () => {
    const created = await boss.post('/api/v1/api-keys', { name: 'Flooder', role: 'sales_agent', scopes: ['members:directory'] }, H(clinic));
    expect(created.status).toBe(201);
    const key = created.body.data.key as string;
    const hit = () => api().get('/api/v1/members/directory').set('Authorization', `Bearer ${key}`).set('X-Tenant-Id', clinic.id);
    expect((await hit()).status).toBe(200);
    const statuses: number[] = [];
    let limited: request.Response | undefined;
    for (let i = 0; i < 12 && !limited; i++) {
      const batch = await Promise.all(Array.from({ length: 50 }, hit));
      for (const r of batch) {
        statuses.push(r.status);
        if (r.status === 429) limited ??= r;
      }
    }
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(100); // a real integration is not bothered
    expect(limited).toBeDefined();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited!.body.code ?? limited!.body.error?.code ?? JSON.stringify(limited!.body)).toMatch(/RATE_LIMITED/);
    expect((await boss.get('/api/v1/me')).status).toBe(200); // another caller is not affected
  }, 60_000);

  it('wrong keys are turned away, and after a handful from one address the answer becomes “slow down”; valid keys still work', async () => {
    const created = await boss.post('/api/v1/api-keys', { name: 'Steady', role: 'sales_agent', scopes: ['members:directory'] }, H(clinic));
    const good = created.body.data.key as string;
    const bad = `crm_live_aaaaaaaaaa_${'B'.repeat(43)}`;
    const answers: number[] = [];
    for (let i = 0; i < 30; i++) answers.push((await api().get('/api/v1/members/directory').set('Authorization', `Bearer ${bad}`)).status);
    expect(answers.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(answers.at(-1)).toBe(429);
    expect((await api().get('/api/v1/members/directory').set('Authorization', `Bearer ${good}`).set('X-Tenant-Id', clinic.id)).status).toBe(200);
  }, 60_000);
});

describe('compare clients: one period, authorised clients only, same definitions', () => {
  const FROM = '2026-03-10';
  const TO = '2026-03-11';
  const windowCount = (id: string, from: string, to: string, extra = `AND NOT ('test' = ANY(l.tags))`) =>
    dbCount(
      `SELECT count(*) AS n FROM leads l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.deleted_at IS NULL ${extra}
          AND l.created_at >= ($2::date)::timestamp AT TIME ZONE t.timezone AND l.created_at < (($3::date + 1)::timestamp AT TIME ZONE t.timezone)`,
      [id, from, to]
    );
  const setCreated = (id: string, iso: string) => h.admin.query(`UPDATE leads SET created_at = $2::timestamptz WHERE id = $1`, [id, iso]);
  const get = (u: AuthedUser, qs = '') => u.get(`${A}/report?from=${FROM}&to=${TO}${qs}`);
  let mine: any[] = [];

  beforeAll(async () => {
    await h.admin.query(`UPDATE tenants SET timezone = 'Asia/Kolkata' WHERE id = $1`, [clinic.id]);
    await h.admin.query(`UPDATE tenants SET timezone = 'America/New_York' WHERE id = $1`, [diner.id]);
    await h.admin.query(`UPDATE tenants SET timezone = 'Asia/Kolkata' WHERE id = $1`, [shop.id]);
    await h.admin.query(`UPDATE tenants SET settings = settings || '{"currency":"USD"}'::jsonb WHERE id = $1`, [diner.id]); // before any spend is entered
    expect((await assign(diner, manager, 'sales_agent')).status).toBe(200); // the same person: team lead in the clinic, plain caller in the diner
    expect((await assign(shop, manager, 'marketing_analyst')).status).toBe(200);
    // Kolkata clinic: the evening of the 10th, just after midnight on the 11th, and exactly midnight between them
    const a = await mkLead(clinic, { ownerId: manager.userId });
    const b = await mkLead(clinic, { ownerId: allrounder.userId });
    const c = await mkLead(clinic, { ownerId: allrounder.userId });
    const d = await mkLead(clinic, { ownerId: manager.userId });
    const e = await mkLead(clinic, { ownerId: allrounder.userId, tags: ['test'] });
    const old = await mkLead(clinic, { ownerId: allrounder.userId });
    await setCreated(a.id, '2026-03-10T23:30:00+05:30');
    await setCreated(b.id, '2026-03-11T00:10:00+05:30');
    await setCreated(c.id, '2026-03-11T00:00:00+05:30'); // belongs to the 11th, not the 10th
    await setCreated(d.id, '2026-03-12T00:00:00+05:30'); // the day after the period: out
    await setCreated(e.id, '2026-03-10T12:00:00+05:30'); // a test lead: out unless asked for
    await setCreated(old.id, '2026-03-09T23:59:59+05:30'); // the day before: out
    mine = [a, b, c, d, e, old];
    // New York diner: 23:30 on the 10th local = 04:30 on the 11th in Kolkata. Same two calendar dates, read in its own zone.
    const f = await mkLead(diner, { ownerId: manager.userId });
    const g = await mkLead(diner, { ownerId: boss.userId });
    const hh = await mkLead(diner, { ownerId: boss.userId });
    await setCreated(f.id, '2026-03-10T23:30:00-04:00');
    await setCreated(g.id, '2026-03-11T23:59:00-04:00');
    await setCreated(hh.id, '2026-03-12T00:01:00-04:00'); // the 12th in New York: out
    // won: the lead sits in the pipeline's Won stage (a lead's status follows its stage, so both change together)
    const wonStage = (await h.admin.query(`SELECT id FROM pipeline_stages WHERE tenant_id = $1 AND maps_to_status = 'won' AND archived_at IS NULL LIMIT 1`, [diner.id])).rows[0].id as string;
    await h.admin.query(`UPDATE leads SET stage_id = $2, status = 'won', closed_at = now() WHERE id = $1`, [g.id, wonStage]);
    expect((await boss.post('/api/v1/spend', { source: 'meta_ads', periodStart: FROM, periodEnd: TO, amount: 2000 }, H(diner))).status).toBe(201);
  }, 120_000);

  it('every figure equals the underlying records, per client and in total; days are read in each client’s own time zone', async () => {
    const r = await get(boss);
    expect(r.status).toBe(200);
    const row = (c: any) => r.body.data.rows.find((x: any) => x.client.id === c.id);
    expect(row(clinic).leads.created).toBe(await windowCount(clinic.id, FROM, TO));
    expect(row(clinic).leads.created).toBe(3); // 23:30 on the 10th, 00:00 and 00:10 on the 11th
    expect(row(diner).leads.created).toBe(await windowCount(diner.id, FROM, TO));
    expect(row(diner).leads.created).toBe(2);
    expect(row(shop).leads.created).toBe(0);
    expect(r.body.data.totals.leads.created).toBe(r.body.data.rows.reduce((s: number, x: any) => s + x.leads.created, 0));
    expect(r.body.data.totals.leads.created).toBe(5);
    expect(row(diner).leads.won).toBe(1);
    expect(r.body.data.totals.leads.won).toBe(1);
    expect(r.body.data.range).toEqual({ from: FROM, to: TO });
    expect(row(clinic).timezone).toBe('Asia/Kolkata');
    expect(row(diner).timezone).toBe('America/New_York');
    // the open / unassigned snapshot figures match the records too
    expect(row(clinic).leads.open).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND closed_at IS NULL AND NOT ('test' = ANY(tags))`, [clinic.id]));
  });

  it('is the same number each client’s own Reports page shows (nothing is recalculated)', async () => {
    const r = await get(boss);
    for (const c of [clinic, diner, shop]) {
      const own = (await boss.get(`/api/v1/dashboard/overview?from=${FROM}&to=${TO}&includeTest=false`, H(c))).body.data;
      const row = r.body.data.rows.find((x: any) => x.client.id === c.id);
      expect(row.leads).toMatchObject({ created: own.leads.created, previousCreated: own.leads.previousCreated, open: own.leads.open, unassigned: own.leads.unassigned, won: own.leads.wonOfCreated });
    }
  });

  it('test leads are left out unless asked for, in the same way for every client', async () => {
    const without = (await get(boss)).body.data.totals.leads.created;
    const withTest = await get(boss, '&includeTest=true');
    expect(withTest.body.data.totals.leads.created).toBe(without + 1);
    expect(withTest.body.data.includesTestLeads).toBe(true);
    expect(withTest.body.data.rows.find((x: any) => x.client.id === clinic.id).leads.created).toBe(await windowCount(clinic.id, FROM, TO, ''));
  });

  it('a client with no data is a row of zeros, not a hole or an error', async () => {
    const r = await get(boss);
    const empty = r.body.data.rows.find((x: any) => x.client.id === shop.id);
    expect(empty.leads).toMatchObject({ created: 0, previousCreated: 0, open: 0, unassigned: 0, waitingForReply: 0, won: 0, winRate: null });
    expect(empty.trend.every((p: any) => p.leads === 0)).toBe(true);
    const only = await get(boss, `&clientId=${shop.id}`);
    expect(only.body.data.rows).toHaveLength(1);
    expect(only.body.data.totals.leads.created).toBe(0);
    expect(only.body.data.totals.leads.winRate).toBeNull();
  });

  it('mixed permissions: the same person gets everything in one client and only their own leads in another, flagged as partial', async () => {
    const r = await get(manager);
    expect(r.status).toBe(200);
    const row = (c: any) => r.body.data.rows.find((x: any) => x.client.id === c.id);
    expect(row(clinic).scope).toBe('all'); // team lead there
    expect(row(clinic).leads.created).toBe(3);
    expect(row(diner).scope).toBe('own'); // a plain caller there: only their own leads
    expect(row(diner).leads.created).toBe(1); // the one lead owned by them, not both of the diner's leads in the period
    expect(row(shop).scope).toBe('all'); // analyst
    expect(r.body.data.partial).toBe(true);
    expect(r.body.data.totals.leads.created).toBe(4);
    // an admin sees all of it, and is not partial
    const boss2 = await get(boss);
    expect(boss2.body.data.partial).toBe(false);
    expect(boss2.body.data.totals.leads.created).toBe(5);
    // and a caller sees no more than their own work in the clinic
    const own = await get(allrounder);
    expect(own.body.data.rows).toHaveLength(1); // only assigned to the clinic
    expect(own.body.data.rows[0]).toMatchObject({ scope: 'own' });
    expect(own.body.data.rows[0].leads.created).toBe(2); // their own two leads in the period (b, c)
    expect(own.body.data.rows[0].money).toBeNull(); // no access to spend
  });

  it('only clients you belong to can be named; nothing about other clients leaks', async () => {
    const stranger = await h.register({ emailPrefix: 'w3stranger', name: 'Stranger', organisationName: 'Someone Else' });
    const elsewhere = (await stranger.post(`${A}/clients`, { name: 'Their Client', industry: 'retail' })).body.data;
    expect((await get(allrounder, `&clientId=${diner.id}`)).status).toBe(404); // a client they are not in
    expect((await get(boss, `&clientId=${elsewhere.id}`)).status).toBe(404); // another agency's client
    const theirs = await get(stranger);
    expect(theirs.body.data.rows.map((x: any) => x.client.name)).toEqual(['Their Client']);
    expect(JSON.stringify((await get(boss)).body)).not.toContain('Their Client');
  });

  it('money is never added across currencies, spend is counted once, and per-lead cost is spend over that client’s leads', async () => {
    const r = await get(boss);
    const dinerRow = r.body.data.rows.find((x: any) => x.client.id === diner.id);
    expect(dinerRow.currency).toBe('USD');
    expect(dinerRow.money.spend).toBeCloseTo(2000, 1); // the one entry covers exactly the period
    expect(dinerRow.money.costPerLead).toBeCloseTo(2000 / dinerRow.leads.created, 1);
    const usd = r.body.data.totals.byCurrency.find((c: any) => c.currency === 'USD');
    expect(usd.spend).toBeCloseTo(dinerRow.money.spend, 2);
    expect(usd.clientsWithSpend).toBe(1);
    for (const c of r.body.data.totals.byCurrency.filter((x: any) => x.currency !== 'USD')) expect(c.spend).toBe(0); // the other clients spent nothing: the diner's money is not mixed into theirs
    const inDb = Number((await h.admin.query(`SELECT COALESCE(sum(amount), 0) AS n FROM marketing_spend WHERE tenant_id = $1`, [diner.id])).rows[0].n);
    expect(inDb).toBe(2000); // one entry, counted once in the report's period
  });

  it('rejects bad dates, and the trend adds up to the total', async () => {
    expect((await boss.get(`${A}/report?from=yesterday`)).status).toBe(400);
    expect((await boss.get(`${A}/report?from=2026-03-12&to=2026-03-01`)).status).toBe(400);
    const r = await get(boss);
    expect(r.body.data.trend.reduce((s: number, p: any) => s + p.leads, 0)).toBe(r.body.data.totals.leads.created);
  });
});
