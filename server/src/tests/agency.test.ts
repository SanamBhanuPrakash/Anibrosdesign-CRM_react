import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';
import { unzip } from '../modules/agency/xlsx';

/**
 * The agency model end to end, against the restricted database role (row-level security enforced):
 * adding a client builds an isolated workspace; employees are shared and see only what they are assigned;
 * the admin sees everything; calls/messages are logged with structure; leads download as Excel/CSV.
 */
let h: ApiHarness;
let boss: AuthedUser; // agency owner
let asha: AuthedUser; // employee: agent in Clinic, manager in Diner
let ravi: AuthedUser; // employee: agent in Diner
let meera: AuthedUser; // employee: manager in Diner (can export)
let clinic: any;
let diner: any;
let realco: any;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const api = () => request(h.app);
const H = (c: { id: string }) => ({ 'X-Tenant-Id': c.id });
const A = '/api/v1/agency';

const binary = (t: request.Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function joinStaff(name: string): Promise<AuthedUser> {
  const email = `staff${uniq()}@anibros.test`;
  const inv = await boss.post(`${A}/staff/invitations`, { email });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  await h.runJobs();
  const token = h.mail.tokenFor(email, 'invited')!;
  const password = 'Violet-Lantern-Orbit-77';
  const acc = await api().post('/api/v1/invitations/accept').send({ token, name, password });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
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

async function mkLead(u: AuthedUser, c: { id: string }, extra: Record<string, unknown> = {}) {
  const r = await u.post('/api/v1/leads', { contact: { firstName: `Lead${uniq()}`, email: `l${uniq()}@x.test` }, source: 'meta_ads', campaign: 'Diwali offer', ...extra }, H(c));
  if (r.status !== 201) throw new Error(`lead create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}

const dbCount = async (sql: string, params: unknown[] = []) => Number((await h.admin.query(sql, params)).rows[0].n);

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  boss = await h.register({ emailPrefix: 'boss', name: 'Bhanu Boss', organisationName: 'Anibros Design' });
  clinic = await mkClient({ name: 'Smile Dental Clinic', industry: 'healthcare', contactName: 'Dr Rao', contactEmail: 'rao@smile.test' });
  diner = await mkClient({ name: 'Spice Garden Restaurant', industry: 'restaurant' });
  realco = await mkClient({ name: 'Skyline Realty', industry: 'real_estate' });
  asha = await joinStaff('Asha Caller');
  ravi = await joinStaff('Ravi Caller');
  meera = await joinStaff('Meera Lead');
}, 180_000);
afterAll(async () => h?.close());

describe('adding a client creates a separate, ready workspace', () => {
  it('has its own tenant, owner membership for the admin, audit trail, pipeline words and settings', async () => {
    const c = (await boss.get(`${A}/clients/${clinic.id}`)).body.data;
    expect(c).toMatchObject({ name: 'Smile Dental Clinic', industry: 'healthcare', status: 'active', contactName: 'Dr Rao', myRole: 'tenant_owner', assignedStaff: 0 });
    expect(c.stats).toMatchObject({ totalLeads: 0, openLeads: 0, unassigned: 0 });

    const stages = (await h.admin.query(`SELECT name FROM pipeline_stages WHERE tenant_id = $1 ORDER BY order_index`, [clinic.id])).rows.map((r) => r.name);
    expect(stages).toContain('Appointment booked');
    expect(stages).toContain('Appointment done');
    expect(stages).toContain('New enquiry');
    expect(stages).not.toContain('Site visit booked');
    const dinerStages = (await h.admin.query(`SELECT name FROM pipeline_stages WHERE tenant_id = $1`, [diner.id])).rows.map((r) => r.name);
    expect(dinerStages).toContain('Table booking booked');
    const realStages = (await h.admin.query(`SELECT name FROM pipeline_stages WHERE tenant_id = $1`, [realco.id])).rows.map((r) => r.name);
    expect(realStages).toContain('Site visit booked'); // real estate keeps the recommended wording

    const needs = async (id: string) => (await h.admin.query(`SELECT deal_value_required AS d FROM pipelines WHERE tenant_id = $1 AND archived_at IS NULL`, [id])).rows[0].d;
    expect(await needs(clinic.id)).toBe(false); // "won needs a property deal value" is a real-estate rule
    expect(await needs(realco.id)).toBe(true);

    expect((await boss.get('/api/v1/workspace', H(clinic))).body.data.leadAssignment).toBe('balanced');
    expect(await dbCount(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'client.create'`, [clinic.id])).toBe(1);
    expect(await dbCount(`SELECT count(*) AS n FROM lead_scoring_config WHERE tenant_id = $1`, [clinic.id])).toBe(1);
  });

  it('the HQ is not a client; the session knows which workspace is which', async () => {
    const list = (await boss.get(`${A}/clients`)).body.data;
    expect(list.map((c: any) => c.name).sort()).toEqual(['Skyline Realty', 'Smile Dental Clinic', 'Spice Garden Restaurant']);
    const me = (await boss.get('/api/v1/me')).body.data;
    expect(me.tenants.filter((t: any) => t.kind === 'agency_hq')).toHaveLength(1);
    expect(me.tenants.filter((t: any) => t.kind === 'client')).toHaveLength(3);
    expect(me.tenants.find((t: any) => t.id === clinic.id)).toMatchObject({ industry: 'healthcare', role: 'tenant_owner' });
  });

  it('rejects duplicate names (any case), bad input, and a double-click race creates exactly one', async () => {
    expect((await boss.post(`${A}/clients`, { name: 'smile dental clinic' })).status).toBe(409);
    expect((await boss.post(`${A}/clients`, { name: '   ' })).status).toBe(400);
    expect((await boss.post(`${A}/clients`, { name: 'X1', industry: 'space_travel' })).status).toBe(400);
    expect((await boss.post(`${A}/clients`, { name: 'X2', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await boss.post(`${A}/clients`, { name: 'X3', staff: [{ userId: boss.userId, role: 'sales_agent' }] })).status).toBe(409); // admins are in every client already
    const name = `Race ${uniq()}`;
    const rs = await Promise.all([boss.post(`${A}/clients`, { name }), boss.post(`${A}/clients`, { name })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await dbCount(`SELECT count(*) AS n FROM tenants WHERE lower(name) = lower($1)`, [name])).toBe(1);
  });

  it('can assign staff at creation time', async () => {
    const c = await mkClient({ name: `With team ${uniq()}`, industry: 'retail', staff: [{ userId: ravi.userId, role: 'sales_agent' }] });
    expect(c.assignedStaff).toBe(1);
    expect((await ravi.get('/api/v1/leads', H(c))).status).toBe(200);
    await boss.post(`${A}/clients/${c.id}/archive`);
  });

  it('only agency admins manage clients', async () => {
    expect((await asha.post(`${A}/clients`, { name: 'Sneaky' })).status).toBe(403);
    expect((await asha.patch(`${A}/clients/${clinic.id}`, { name: 'Renamed' })).status).toBe(403); // admin-only, whether or not the client exists
    expect((await asha.get(`${A}/staff`)).status).toBe(403);
    expect((await asha.post(`${A}/staff/invitations`, { email: 'x@y.test' })).status).toBe(403);
    expect((await asha.get(`${A}/clients`)).body.data).toEqual([]); // assigned to nothing yet
  });

  it('admins can edit a client; unknown fields are refused', async () => {
    const r = await boss.patch(`${A}/clients/${clinic.id}`, { website: 'https://smile.test', notes: 'Pays on the 5th', contactPhone: '+91 90000 11111' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ website: 'https://smile.test', notes: 'Pays on the 5th' });
    expect((await boss.patch(`${A}/clients/${clinic.id}`, { isActive: false })).status).toBe(400);
    expect((await boss.patch(`${A}/clients/${clinic.id}`, { name: 'Spice Garden Restaurant' })).status).toBe(409);
  });
});

describe('employees are shared across clients but each client stays isolated', () => {
  const clinicLeads: any[] = [];
  const dinerLeads: any[] = [];
  const realLeads: any[] = [];

  beforeAll(async () => {
    // Before anyone is assigned: balanced assignment falls back to the agency owner.
    for (let i = 0; i < 3; i++) clinicLeads.push(await mkLead(boss, clinic, { contact: { firstName: `Alpha${i}`, email: `a${i}${uniq()}@x.test` } }));
    for (let i = 0; i < 2; i++) dinerLeads.push(await mkLead(boss, diner, { contact: { firstName: `Beta${i}`, email: `b${i}${uniq()}@x.test` } }));
    realLeads.push(await mkLead(boss, realco, { contact: { firstName: 'Gamma', email: `g${uniq()}@x.test` } }));
    clinicLeads.push(await mkLead(boss, clinic, { ownerId: null, contact: { firstName: 'Alpha-orphan', email: `ao${uniq()}@x.test` } }));
  });

  it('assignment is admin-only, needs agency employees, and takes effect per client', async () => {
    expect((await boss.put(`${A}/clients/${clinic.id}/team/${asha.userId}`, { role: 'sales_agent' })).status).toBe(200);
    expect((await boss.put(`${A}/clients/${diner.id}/team/${asha.userId}`, { role: 'sales_manager' })).status).toBe(200);
    expect((await boss.put(`${A}/clients/${diner.id}/team/${ravi.userId}`, { role: 'sales_agent' })).status).toBe(200);
    expect((await boss.put(`${A}/clients/${diner.id}/team/${meera.userId}`, { role: 'sales_manager' })).status).toBe(200);

    expect((await boss.put(`${A}/clients/${clinic.id}/team/${boss.userId}`, { role: 'sales_agent' })).status).toBe(409); // admin already everywhere
    expect((await boss.put(`${A}/clients/${clinic.id}/team/${asha.userId}`, { role: 'tenant_owner' })).status).toBe(400); // not an assignable role
    expect((await boss.put(`${A}/clients/${clinic.id}/team/${randomUUID()}`, { role: 'sales_agent' })).status).toBe(400); // not agency staff
    expect((await asha.put(`${A}/clients/${clinic.id}/team/${ravi.userId}`, { role: 'sales_manager' })).status).toBe(403); // employees cannot grant access

    const team = (await boss.get(`${A}/clients/${diner.id}/team`)).body.data;
    expect(team.map((t: any) => [t.name, t.clientRole, t.isAgencyAdmin])).toEqual(
      expect.arrayContaining([['Bhanu Boss', 'tenant_owner', true], ['Asha Caller', 'sales_manager', false], ['Ravi Caller', 'sales_agent', false], ['Meera Lead', 'sales_manager', false]])
    );
  });

  it('an employee sees only the clients they are assigned to — others look like they do not exist', async () => {
    const mine = (await asha.get(`${A}/clients`)).body.data;
    expect(mine.map((c: any) => c.name).sort()).toEqual(['Smile Dental Clinic', 'Spice Garden Restaurant']);
    expect(mine.find((c: any) => c.id === clinic.id).myRole).toBe('sales_agent');
    expect((await ravi.get(`${A}/clients`)).body.data.map((c: any) => c.name)).toEqual(['Spice Garden Restaurant']);

    expect((await asha.get(`${A}/clients/${realco.id}`)).status).toBe(404);
    expect((await asha.get('/api/v1/leads', H(realco))).status).toBe(403);
    expect((await ravi.get('/api/v1/leads', H(clinic))).status).toBe(403);
    expect((await ravi.get('/api/v1/contacts', H(clinic))).status).toBe(403);
    expect((await ravi.get(`/api/v1/leads/${clinicLeads[0].id}`, H(diner))).status).toBe(404); // a lead id from another client does not resolve here
    expect((await ravi.get(`${A}/leads?clientId=${clinic.id}`)).status).toBe(404);
    expect((await asha.get(`${A}/leads?clientId=${realco.id}`)).status).toBe(404);
  });

  it('new leads go to the least-busy assigned employee automatically', async () => {
    const l = await mkLead(boss, clinic);
    expect(l.ownerId).toBe(asha.userId); // the only sales_agent in the clinic
    const d = await mkLead(boss, diner);
    expect(d.ownerId).toBe(ravi.userId); // agents are preferred over managers
    clinicLeads.push(l);
    dinerLeads.push(d);
  });

  it('the admin sees all leads across clients, paged without gaps or repeats, filterable by client', async () => {
    const all = await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = ANY($1::uuid[])`, [[clinic.id, diner.id, realco.id]]);
    const dbIds = new Set((await h.admin.query(`SELECT id FROM leads WHERE tenant_id = ANY($1::uuid[])`, [[clinic.id, diner.id, realco.id]])).rows.map((r) => r.id));

    const first = (await boss.get(`${A}/leads?pageSize=3`)).body.data;
    expect(first.page).toMatchObject({ page: 1, pageSize: 3, total: all });
    expect(first.byClient.map((b: any) => b.clientName)).toEqual(expect.arrayContaining(['Skyline Realty', 'Smile Dental Clinic', 'Spice Garden Restaurant']));
    expect(first.byClient.reduce((s: number, b: any) => s + b.total, 0)).toBe(all);

    const seen: any[] = [];
    for (let p = 1; p <= first.page.totalPages; p++) seen.push(...(await boss.get(`${A}/leads?pageSize=3&page=${p}`)).body.data.items);
    expect(seen).toHaveLength(all);
    expect(new Set(seen.map((s) => s.id))).toEqual(dbIds);
    const times = seen.map((s) => new Date(s.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first across clients
    expect(seen[0].client).toMatchObject({ id: expect.any(String), name: expect.any(String) });

    const onlyDiner = (await boss.get(`${A}/leads?clientId=${diner.id}&pageSize=100`)).body.data;
    expect(onlyDiner.items.every((i: any) => i.client.id === diner.id)).toBe(true);
    expect(onlyDiner.page.total).toBe(dinerLeads.length);
    expect(onlyDiner.byClient).toHaveLength(1);
  });

  it('filters and sorting apply across clients', async () => {
    const q = (await boss.get(`${A}/leads?q=Alpha-orphan`)).body.data;
    expect(q.items.map((i: any) => i.contactName)).toEqual(['Alpha-orphan']);
    const un = (await boss.get(`${A}/leads?ownerId=unassigned&pageSize=100`)).body.data;
    expect(un.items.length).toBeGreaterThanOrEqual(1);
    expect(un.items.every((i: any) => i.ownerId === null)).toBe(true);
    const mine = (await boss.get(`${A}/leads?ownerId=me&pageSize=100`)).body.data;
    expect(mine.items.every((i: any) => i.ownerId === boss.userId)).toBe(true);
    const byScore = (await boss.get(`${A}/leads?sort=score&order=asc&pageSize=100`)).body.data.items.map((i: any) => i.leadScore);
    expect([...byScore].sort((a, b) => a - b)).toEqual(byScore);
    expect((await boss.get(`${A}/leads?source=meta_ads&state=open&createdFrom=2020-01-01`)).body.data.page.total).toBeGreaterThan(0);
    expect((await boss.get(`${A}/leads?source=google_ads`)).body.data.page.total).toBe(0);
    expect((await boss.get(`${A}/leads?status=bogus`)).status).toBe(400);
    expect((await boss.get(`${A}/leads?pageSize=101`)).status).toBe(400);
    expect((await boss.get(`${A}/leads?page=60&pageSize=100`)).status).toBe(422); // window beyond 5,000 rows
    expect((await boss.get(`${A}/leads?clientId=${randomUUID()}`)).status).toBe(404);
  });

  it('a shared employee gets exactly what her role allows in each client', async () => {
    const mine = (await asha.get(`${A}/leads?pageSize=100`)).body.data;
    const inClinic = mine.items.filter((i: any) => i.client.id === clinic.id);
    const inDiner = mine.items.filter((i: any) => i.client.id === diner.id);
    // clinic: sales_agent sees only leads assigned to her; diner: sales_manager sees all of the diner's leads
    expect(inClinic.length).toBeGreaterThan(0);
    expect(inClinic.every((i: any) => i.ownerId === asha.userId)).toBe(true);
    expect(inClinic.length).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1 AND owner_id = $2`, [clinic.id, asha.userId]));
    expect(inDiner.length).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1`, [diner.id]));
    expect(mine.items.some((i: any) => i.client.id === realco.id)).toBe(false);

    const ravis = (await ravi.get(`${A}/leads?pageSize=100`)).body.data.items;
    expect(ravis.every((i: any) => i.client.id === diner.id && i.ownerId === ravi.userId)).toBe(true);
    expect((await asha.get(`${A}/leads?ownerId=me&pageSize=100`)).body.data.items.every((i: any) => i.ownerId === asha.userId)).toBe(true);
  });

  it('the overview counts what the caller may see', async () => {
    const o = (await boss.get(`${A}/overview`)).body.data;
    expect(o.agency).toMatchObject({ name: 'Anibros Design', isAdmin: true, isOwner: true });
    expect(o.clients.active).toBeGreaterThanOrEqual(3);
    expect(o.totals.totalLeads).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id IN (SELECT id FROM tenants WHERE kind = 'client' AND archived_at IS NULL) AND NOT ('test' = ANY(tags))`));
    expect(o.staff).toBeGreaterThanOrEqual(4);
    const em = (await asha.get(`${A}/overview`)).body.data;
    expect(em.agency.isAdmin).toBe(false);
    expect(em.staff).toBeNull();
    expect(em.clients.active).toBe(2);
    const clinicStats = (await asha.get(`${A}/clients/${clinic.id}`)).body.data.stats;
    expect(clinicStats.totalLeads).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1 AND owner_id = $2`, [clinic.id, asha.userId])); // own-scope count
    expect(clinicStats.spendThisMonth).toBeNull(); // a caller who may not see spend never gets a number
    expect(clinicStats.leadSources).toBeNull(); // nor integration or API-key details
    expect(clinicStats.apiKeys).toBeNull();
    const adminStats = (await boss.get(`${A}/clients/${clinic.id}`)).body.data.stats;
    expect(adminStats.leadSources).toEqual({ active: 0, lastReceivedAt: null }); // admin sees that lead capture is not wired up yet
    expect(adminStats.apiKeys).toBe(0);
    expect(adminStats.spendThisMonth).toBe(0);
  });
});

describe('employees log calls and messages', () => {
  let lead: any;
  beforeAll(async () => {
    lead = await mkLead(boss, clinic, { contact: { firstName: 'Caller-target', phone: '+919876500011' } });
    expect(lead.ownerId).toBe(asha.userId);
  });
  const log = (u: AuthedUser, id: string, body: Record<string, unknown>, c = clinic) => u.post(`/api/v1/leads/${id}/activities`, body, H(c));

  it('publishes the vocabulary', async () => {
    const v = (await asha.get('/api/v1/leads/activity-options', H(clinic))).body.data;
    expect(v.types).toEqual(expect.arrayContaining(['call', 'whatsapp', 'sms', 'email', 'meeting', 'note']));
    expect(v.directions).toEqual(['outbound', 'inbound']);
    expect(v.outcomes.find((o: any) => o.code === 'connected')).toMatchObject({ label: 'Spoke to them', forTypes: ['call', 'meeting'] });
  });

  it('a message the lead sends does not answer them; our outbound call does', async () => {
    const before = (await asha.get(`/api/v1/leads/${lead.id}`, H(clinic))).body.data;
    expect(before.sla.state).not.toBe('met');
    expect((await log(asha, lead.id, { type: 'whatsapp', direction: 'inbound', outcome: 'replied', description: 'Hi, what is the price for implants?' })).status).toBe(201);
    expect((await asha.get(`/api/v1/leads/${lead.id}`, H(clinic))).body.data.sla.state).not.toBe('met');

    const followUp = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const call = await log(asha, lead.id, { type: 'call', outcome: 'connected', durationMinutes: 4, description: 'Explained pricing, wants Saturday', nextFollowupAt: followUp });
    expect(call.status).toBe(201);
    expect(call.body.data).toMatchObject({ type: 'call', direction: 'outbound', outcome: 'connected', durationMinutes: 4 });
    const after = (await asha.get(`/api/v1/leads/${lead.id}`, H(clinic))).body.data;
    expect(after.sla.state).toBe('met');
    expect(new Date(after.nextFollowupAt).getTime()).toBe(new Date(followUp).getTime());
  });

  it('logs WhatsApp, SMS, e-mail and meetings with direction, outcome and notes; the timeline shows who did what', async () => {
    for (const body of [
      { type: 'whatsapp', outcome: 'sent', description: 'Sent price list' },
      { type: 'sms', outcome: 'sent', description: 'Reminder for Saturday' },
      { type: 'email', description: 'Sent brochure' },
      { type: 'meeting', outcome: 'appointment_booked', durationMinutes: 30, description: 'Booked scaling visit' },
      { type: 'note', description: 'Prefers morning slots' },
    ]) {
      const r = await log(asha, lead.id, body);
      expect(r.status).toBe(201);
    }
    const tl = (await asha.get(`/api/v1/leads/${lead.id}/activities?limit=50`, H(clinic))).body.data;
    expect(tl.find((a: any) => a.type === 'call')).toMatchObject({ outcome: 'connected', direction: 'outbound', durationMinutes: 4, userName: 'Asha Caller' });
    expect(tl.find((a: any) => a.type === 'whatsapp' && a.direction === 'inbound')).toMatchObject({ outcome: 'replied' });
    expect(tl.find((a: any) => a.type === 'meeting').direction).toBeNull();
    expect(tl.find((a: any) => a.type === 'note' && a.description === 'Prefers morning slots').outcome).toBeNull();
  });

  it('rejects combinations that make no sense', async () => {
    expect((await log(asha, lead.id, { type: 'call', outcome: 'sent', description: 'x' })).status).toBe(400); // "sent" is not a call outcome
    expect((await log(asha, lead.id, { type: 'call', outcome: 'made_up', description: 'x' })).status).toBe(400);
    expect((await log(asha, lead.id, { type: 'note', direction: 'inbound', description: 'x' })).status).toBe(400);
    expect((await log(asha, lead.id, { type: 'sms', durationMinutes: 3, description: 'x' })).status).toBe(400);
    expect((await log(asha, lead.id, { type: 'call', description: 'x', occurredAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
    expect((await log(asha, lead.id, { type: 'fax', description: 'x' })).status).toBe(400);
  });

  it('employees can only log on leads they may work, in clients they belong to', async () => {
    expect((await log(ravi, lead.id, { type: 'call', description: 'not my client' })).status).toBe(403);
    const orphan = await mkLead(boss, clinic, { ownerId: null });
    expect((await log(asha, orphan.id, { type: 'call', description: 'not assigned to me' })).status).toBe(404); // an agent works only her own leads
    expect((await boss.post(`/api/v1/leads/${orphan.id}/assign`, { ownerId: asha.userId }, H(clinic))).status).toBe(200);
    expect((await log(asha, orphan.id, { type: 'call', outcome: 'no_answer', description: 'Rang twice' })).status).toBe(201);
  });

  it('shows what each employee did today, per client; employees see only their own numbers', async () => {
    const mine = (await asha.get(`${A}/activity?clientId=${clinic.id}`)).body.data;
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ userName: 'Asha Caller', clientName: 'Smile Dental Clinic', calls: 2, connected: 1, whatsapp: 2, sms: 1, emails: 1, meetings: 1, leadsTouched: 2 });
    expect(mine.totals).toMatchObject({ calls: 2, connected: 1 });

    const all = (await boss.get(`${A}/activity`)).body.data;
    expect(all.rows.find((r: any) => r.userName === 'Asha Caller' && r.clientName === 'Smile Dental Clinic')).toMatchObject({ calls: 2 });
    expect((await ravi.get(`${A}/activity`)).body.data.rows).toEqual([]); // Ravi logged nothing
    // a team lead (Asha is a manager in the diner) sees the whole diner team, an agent only herself
    expect((await asha.get(`${A}/activity?clientId=${diner.id}`)).status).toBe(200);
    expect((await boss.get(`${A}/activity?from=2020-01-01&to=2020-01-31`)).body.data.rows).toEqual([]);
    expect((await boss.get(`${A}/activity?from=2026-02-01&to=2026-01-01`)).status).toBe(400);
    expect((await boss.get(`${A}/activity?from=2020-01-01&to=2026-01-01`)).status).toBe(400); // over a year
    expect((await asha.get(`${A}/activity?clientId=${realco.id}`)).status).toBe(404);
  });
});

describe('downloads', () => {
  const day = new Date().toISOString().slice(0, 10);

  it('Excel: one workbook with leads, the activity log, team activity and a client summary', async () => {
    const res = await binary(boss.get(`${A}/leads/export`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="leads-all-clients-${day}.xlsx"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const parts = unzip(res.body as Buffer);
    const wb = parts.find((p) => p.name === 'xl/workbook.xml')!.data.toString('utf8');
    for (const s of ['Leads', 'Activity log', 'Team activity', 'Clients']) expect(wb).toContain(`name="${s}"`);

    const total = await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = ANY($1::uuid[]) AND deleted_at IS NULL`, [[clinic.id, diner.id, realco.id]]);
    expect(Number(res.headers['x-row-count'])).toBe(total);
    const sheet = (i: number) => parts.find((p) => p.name === `xl/worksheets/sheet${i}.xml`)!.data.toString('utf8');
    expect((sheet(1).match(/<row /g) ?? []).length).toBe(total + 1); // + header
    expect(sheet(1)).toContain('Caller-target');
    expect(sheet(1)).toContain('Smile Dental Clinic');
    expect(sheet(1)).toContain('Assigned employee');
    expect(sheet(2)).toContain('Explained pricing, wants Saturday');
    expect(sheet(2)).toContain('Asha Caller');
    expect(sheet(3)).toContain('Asha Caller');
    expect(sheet(4)).toContain('Skyline Realty');
    expect(sheet(1)).not.toContain('<f>');
  });

  it('every number in the lead row is right: touches, calls, connected, WhatsApp, SMS, last touch', async () => {
    const csv = (await binary(boss.get(`${A}/leads/export?format=csv&clientId=${clinic.id}&q=Caller-target`))).body.toString('utf8');
    const lines = (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    const head = lines[0].split(',');
    const row = lines[1];
    const col = (name: string) => head.indexOf(name);
    for (const [name, want] of [['Total touches', '6'], ['Calls', '1'], ['Calls connected', '1'], ['WhatsApp', '2'], ['SMS', '1'], ['E-mails', '1'], ['Meetings', '1'], ['Notes', '1']] as const) {
      expect(col(name), `column ${name}`).toBeGreaterThan(-1);
      expect(row.split(',')[col(name)], name).toBe(want);
    }
  });

  it('CSV: leads and activity log, UTF-8 with BOM, formula-looking text neutralised, narrowed by client', async () => {
    await mkLead(boss, diner, { contact: { firstName: '=HYPERLINK("http://evil.test")', email: `evil${uniq()}@x.test` } });
    const leads = await binary(boss.get(`${A}/leads/export?format=csv&clientId=${diner.id}`));
    expect(leads.status).toBe(200);
    expect(leads.headers['content-type']).toContain('text/csv');
    expect(leads.headers['content-disposition']).toBe(`attachment; filename="leads-spice-garden-restaurant-${day}.csv"`);
    const text = (leads.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'=HYPERLINK"); // never starts a cell with =
    expect(text).not.toContain('Smile Dental Clinic'); // other clients' leads are not in a one-client download
    expect(text.trim().split('\r\n').length - 1).toBe(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1`, [diner.id]));

    const acts = (await binary(boss.get(`${A}/leads/export?format=csv&dataset=activities`))).body.toString('utf8');
    expect(acts).toContain('Client,Lead ID,Contact');
    expect(acts).toContain('whatsapp,inbound,replied');
    expect(acts).toContain('call,outbound,connected,4');
  });

  it('an employee’s download contains only what they may see; those who may not export are refused', async () => {
    expect((await binary(ravi.get(`${A}/leads/export`))).status).toBe(403); // sales_agent has no export right in his only client
    expect((await binary(ravi.get(`${A}/leads/export?clientId=${diner.id}`))).status).toBe(403);
    // Asha is an agent in the clinic (no export right) but a manager in the diner (export right): her download is the diner only.
    const ashaX = await binary(asha.get(`${A}/leads/export?format=csv`));
    expect(ashaX.status).toBe(200);
    expect((ashaX.body as Buffer).toString('utf8')).toContain('Spice Garden Restaurant');
    expect((ashaX.body as Buffer).toString('utf8')).not.toContain('Smile Dental Clinic');
    expect((await binary(asha.get(`${A}/leads/export?clientId=${clinic.id}`))).status).toBe(403);
    const r = await binary(meera.get(`${A}/leads/export?format=csv`)); // manager in Diner only
    expect(r.status).toBe(200);
    const text = (r.body as Buffer).toString('utf8');
    expect(text).toContain('Spice Garden Restaurant');
    expect(text).not.toContain('Smile Dental Clinic');
    expect(text).not.toContain('Skyline Realty');
    expect((await binary(meera.get(`${A}/leads/export?clientId=${clinic.id}`))).status).toBe(404);
  });

  it('each client’s part of a download is written to that client’s own audit trail', async () => {
    expect(await dbCount(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.export'`, [clinic.id])).toBeGreaterThanOrEqual(2);
    expect(await dbCount(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.export' AND actor_id = $2`, [diner.id, meera.userId])).toBe(1);
  });

  it('refuses unknown formats', async () => {
    expect((await boss.get(`${A}/leads/export?format=pdf`)).status).toBe(400);
  });
});

describe('taking people off a client, archiving, and managing employees', () => {
  it('unassigning ends access at once and leaves no lead stranded', async () => {
    const open = await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1 AND owner_id = $2 AND closed_at IS NULL`, [diner.id, ravi.userId]);
    expect(open).toBeGreaterThan(0);
    expect((await ravi.get('/api/v1/leads', H(diner))).status).toBe(200);
    const r = await boss.delete(`${A}/clients/${diner.id}/team/${ravi.userId}`);
    expect(r.status).toBe(200);
    expect(r.body.data.leadsUnassigned).toBe(open);
    expect((await ravi.get('/api/v1/leads', H(diner))).status).toBe(403);
    expect(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1 AND owner_id = $2`, [diner.id, ravi.userId])).toBe(0);
    expect((await boss.delete(`${A}/clients/${diner.id}/team/${ravi.userId}`)).status).toBe(404); // already gone
    expect((await boss.delete(`${A}/clients/${diner.id}/team/${boss.userId}`)).status).toBe(409); // admins cannot be taken off a client
    expect(await dbCount(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'client.member_unassign'`, [diner.id])).toBe(1);
  });

  it('archiving locks everyone out and hides the client from all leads; restoring brings it back', async () => {
    const r = await boss.post(`${A}/clients/${diner.id}/archive`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'archived', stats: null });
    expect((await boss.get('/api/v1/leads', H(diner))).status).toBe(403); // not even the admin works inside an archived client
    expect((await meera.get('/api/v1/leads', H(diner))).status).toBe(403);
    expect((await boss.get(`${A}/leads?pageSize=100`)).body.data.items.some((i: any) => i.client.id === diner.id)).toBe(false);
    expect((await boss.get(`${A}/clients`)).body.data.some((c: any) => c.id === diner.id)).toBe(false);
    expect((await boss.get(`${A}/clients?status=archived`)).body.data.map((c: any) => c.id)).toContain(diner.id);
    expect((await boss.put(`${A}/clients/${diner.id}/team/${ravi.userId}`, { role: 'sales_agent' })).status).toBe(409);
    expect(await dbCount(`SELECT count(*) AS n FROM leads WHERE tenant_id = $1`, [diner.id])).toBeGreaterThan(0); // nothing deleted

    expect((await boss.post(`${A}/clients/${diner.id}/restore`)).body.data.status).toBe('active');
    expect((await boss.get('/api/v1/leads', H(diner))).status).toBe(200);
    expect((await meera.get('/api/v1/leads', H(diner))).status).toBe(200);
  });

  it('lists employees with the clients each works on, including pending invitations', async () => {
    await boss.post(`${A}/staff/invitations`, { email: `pending${uniq()}@anibros.test` });
    const s = (await boss.get(`${A}/staff`)).body.data;
    const a = s.staff.find((x: any) => x.name === 'Asha Caller');
    expect(a.agencyRole).toBe('staff');
    expect(a.clients.map((c: any) => [c.clientName, c.role]).sort()).toEqual([['Smile Dental Clinic', 'sales_agent'], ['Spice Garden Restaurant', 'sales_manager']]);
    expect(s.staff.find((x: any) => x.name === 'Bhanu Boss').agencyRole).toBe('owner');
    expect(s.invitations.length).toBeGreaterThanOrEqual(1);
    expect(s.staff.every((x: any) => x.email && !('passwordHash' in x))).toBe(true);
  });

  it('only the owner promotes admins; an admin is in every client; demotion takes that away', async () => {
    expect((await meera.patch(`${A}/staff/${ravi.userId}`, { agencyRole: 'admin' })).status).toBe(403);
    expect((await boss.patch(`${A}/staff/${boss.userId}`, { agencyRole: 'staff' })).status).toBe(409); // the owner is not changed here

    expect((await boss.patch(`${A}/staff/${asha.userId}`, { agencyRole: 'admin' })).status).toBe(200);
    const clients = await dbCount(`SELECT count(*) AS n FROM tenants WHERE kind = 'client'`);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.kind = 'client' AND m.role = 'tenant_admin' AND m.status = 'active'`, [asha.userId])).toBe(clients);
    expect((await asha.get(`${A}/overview`)).body.data.agency.isAdmin).toBe(true);
    expect((await asha.get('/api/v1/leads', H(realco))).status).toBe(200); // now in every client
    const ashaMadeClient = await asha.post(`${A}/clients`, { name: `By Asha ${uniq()}` });
    expect(ashaMadeClient.status).toBe(201);
    expect((await asha.patch(`${A}/staff/${ravi.userId}`, { agencyRole: 'admin' })).status).toBe(403); // admins cannot mint admins
    expect((await asha.delete(`${A}/staff/${boss.userId}`)).status).toBe(409); // nobody removes the owner

    expect((await boss.patch(`${A}/staff/${asha.userId}`, { agencyRole: 'staff' })).status).toBe(200);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.kind = 'client' AND m.role = 'tenant_admin' AND m.status = 'active'`, [asha.userId])).toBe(0);
    expect((await asha.get('/api/v1/leads', H(realco))).status).toBe(403);
    expect((await asha.post(`${A}/clients`, { name: 'Again' })).status).toBe(403);
  });

  it('access follows the HQ role even if it is changed through the generic Team screen', async () => {
    const hq = boss.tenantId;
    const adminCount = (userId: string) => dbCount(`SELECT count(*) AS n FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.kind = 'client' AND m.role = 'tenant_admin' AND m.status = 'active' AND m.is_active`, [userId]);
    expect(await adminCount(ravi.userId)).toBe(0);
    // promoted behind the agency layer's back
    await h.admin.query(`UPDATE tenant_memberships SET role = 'tenant_admin' WHERE tenant_id = $1 AND user_id = $2`, [hq, ravi.userId]);
    expect((await ravi.get(`${A}/overview`)).body.data.agency.isAdmin).toBe(true);
    expect(await adminCount(ravi.userId)).toBe(await dbCount(`SELECT count(*) AS n FROM tenants WHERE kind = 'client'`)); // healed: in every client
    // demoted behind its back: the stale admin rights are withdrawn on his next agency request
    await h.admin.query(`UPDATE tenant_memberships SET role = 'sales_agent' WHERE tenant_id = $1 AND user_id = $2`, [hq, ravi.userId]);
    expect((await ravi.get(`${A}/overview`)).body.data.agency.isAdmin).toBe(false);
    expect(await adminCount(ravi.userId)).toBe(0);
    expect((await ravi.get('/api/v1/leads', H(realco))).status).toBe(403);
  });

  it('removing an employee ends all access, unassigns their open leads, and keeps what they logged', async () => {
    // Asha (staff again) still has no client assignments after demotion; give her one with an open lead to strand.
    await boss.put(`${A}/clients/${clinic.id}/team/${asha.userId}`, { role: 'sales_agent' });
    const mine = await mkLead(boss, clinic, { ownerId: asha.userId });
    expect(mine.ownerId).toBe(asha.userId);
    const logged = await dbCount(`SELECT count(*) AS n FROM activities WHERE user_id = $1`, [asha.userId]);
    expect(logged).toBeGreaterThan(0);

    expect((await boss.delete(`${A}/staff/${boss.userId}`)).status).toBe(409); // not yourself
    const r = await boss.delete(`${A}/staff/${asha.userId}`);
    expect(r.status).toBe(200);
    expect(r.body.data.leadsUnassigned).toBeGreaterThanOrEqual(1);
    expect(await dbCount(`SELECT count(*) AS n FROM leads WHERE owner_id = $1 AND closed_at IS NULL`, [asha.userId])).toBe(0);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_memberships WHERE user_id = $1 AND status = 'active'`, [asha.userId])).toBe(0);
    expect((await asha.get('/api/v1/me')).status).toBe(401); // no workspace left: the session is useless
    expect((await asha.get('/api/v1/leads', H(clinic))).status).toBe(401);
    expect(await dbCount(`SELECT count(*) AS n FROM activities WHERE user_id = $1`, [asha.userId])).toBeGreaterThanOrEqual(logged); // history stays
    expect((await boss.delete(`${A}/staff/${asha.userId}`)).status).toBe(404);
  });
});
