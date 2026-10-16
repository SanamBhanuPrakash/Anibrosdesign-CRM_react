import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Wave 2: claiming leads from the pool, the cross-client task list, lifecycle of archived clients, and the invitation / client-creation
 * safety properties an outside audit asked about (token never returned, single-use under a race, creation is all-or-nothing).
 */
let h: ApiHarness;
let boss: AuthedUser;
let ann: AuthedUser; // caller
let bob: AuthedUser; // caller
let vic: AuthedUser; // view-only in the clinic
let clinic: any;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const api = () => request(h.app);
const H = (c: { id: string }) => ({ 'X-Tenant-Id': c.id });
const A = '/api/v1/agency';
const dbCount = async (sql: string, params: unknown[] = []) => Number((await h.admin.query(sql, params)).rows[0].n);

async function joinStaff(name: string): Promise<AuthedUser> {
  const email = `w2staff${uniq()}@anibros.test`;
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
/** A lead nobody owns (the pool). */
async function poolLead(c: { id: string }) {
  const r = await boss.post('/api/v1/leads', { contact: { firstName: `Pool${uniq()}`, email: `p${uniq()}@x.test` }, source: 'google_ads', ownerId: null }, H(c));
  if (r.status !== 201) throw new Error(`lead create failed ${r.status} ${JSON.stringify(r.body)}`);
  expect(r.body.data.ownerId).toBeNull();
  return r.body.data as any;
}

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  boss = await h.register({ emailPrefix: 'w2boss', name: 'Wave Boss', organisationName: 'Wave Two Agency' });
  clinic = await mkClient({ name: 'Pool Clinic', industry: 'healthcare' });
  ann = await joinStaff('Ann Caller');
  bob = await joinStaff('Bob Caller');
  vic = await joinStaff('Vic Viewer');
  for (const [u, role] of [[ann, 'sales_agent'], [bob, 'sales_agent'], [vic, 'executive_readonly']] as const) {
    expect((await boss.put(`${A}/clients/${clinic.id}/team/${u.userId}`, { role })).status).toBe(200);
  }
}, 180_000);
afterAll(async () => h?.close());

describe('the pool: callers take leads nobody owns yet', () => {
  it('callers see only their own leads, plus the unowned ones through the pool filter', async () => {
    const a = await poolLead(clinic);
    const b = await poolLead(clinic);
    const owned = await poolLead(clinic);
    expect((await boss.post(`/api/v1/leads/${owned.id}/assign`, { ownerId: bob.userId }, H(clinic))).status).toBe(200);

    const plain = (await ann.get('/api/v1/leads?limit=100', H(clinic))).body.data.map((l: any) => l.id);
    expect(plain).not.toContain(a.id); // not hers
    const pool = await ann.get('/api/v1/leads?pool=true&limit=100', H(clinic));
    expect(pool.status).toBe(200);
    const ids = pool.body.data.map((l: any) => l.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(owned.id); // somebody else's lead never leaks through the pool
    expect(pool.body.data.every((l: any) => l.ownerId === null && l.closedAt === null)).toBe(true);
    // and the pool does not open the lead itself
    expect((await ann.get(`/api/v1/leads/${a.id}`, H(clinic))).status).toBe(404);
  });

  it('claiming makes the lead yours, is recorded, and works once', async () => {
    const lead = await poolLead(clinic);
    const r = await ann.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic));
    expect(r.status).toBe(200);
    expect(r.body.data.ownerId).toBe(ann.userId);
    expect((await ann.get(`/api/v1/leads/${lead.id}`, H(clinic))).status).toBe(200); // now she can open it
    const tl = (await ann.get(`/api/v1/leads/${lead.id}/activities`, H(clinic))).body.data.map((x: any) => x.description);
    expect(tl).toContain('Lead claimed');
    expect(await dbCount(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.claim' AND entity_id = $2`, [clinic.id, lead.id])).toBe(1);
    expect((await ann.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic))).status).toBe(200); // her own: harmless
    expect((await bob.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic))).status).toBe(409); // already taken
    expect((await ann.get(`/api/v1/leads?pool=true&limit=100`, H(clinic))).body.data.map((l: any) => l.id)).not.toContain(lead.id);
  });

  it('two people clicking at the same moment: exactly one gets it', async () => {
    const lead = await poolLead(clinic);
    const rs = await Promise.all([ann.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic)), bob.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic))]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const owner = (await h.admin.query(`SELECT owner_id FROM leads WHERE id = $1`, [lead.id])).rows[0].owner_id;
    expect([ann.userId, bob.userId]).toContain(owner);
    expect(await dbCount(`SELECT count(*) AS n FROM activities WHERE lead_id = $1 AND description = 'Lead claimed'`, [lead.id])).toBe(1);
  });

  it('a closed lead cannot be claimed; view-only people cannot claim; outsiders cannot reach another client', async () => {
    const lead = await poolLead(clinic);
    await h.admin.query(`UPDATE leads SET closed_at = now() WHERE id = $1`, [lead.id]);
    expect((await ann.post(`/api/v1/leads/${lead.id}/claim`, undefined, H(clinic))).status).toBe(409);
    const open = await poolLead(clinic);
    expect((await vic.post(`/api/v1/leads/${open.id}/claim`, undefined, H(clinic))).status).toBe(403);
    const other = await mkClient({ name: `Elsewhere ${uniq()}`, industry: 'retail' });
    const theirs = await poolLead(other);
    expect((await ann.post(`/api/v1/leads/${theirs.id}/claim`, undefined, H(other))).status).toBe(403); // not assigned there
    expect(await dbCount(`SELECT count(*) AS n FROM leads WHERE id = $1 AND owner_id IS NULL`, [theirs.id])).toBe(1);
  });

  it('the agency-wide list offers the same pool across clients', async () => {
    const other = await mkClient({ name: `Second ${uniq()}`, industry: 'restaurant' });
    expect((await boss.put(`${A}/clients/${other.id}/team/${ann.userId}`, { role: 'sales_agent' })).status).toBe(200);
    const a = await poolLead(clinic);
    const b = await poolLead(other);
    const r = await ann.get(`${A}/leads?pool=true&pageSize=100`);
    expect(r.status).toBe(200);
    const items = r.body.data.items as any[];
    expect(items.find((i) => i.id === a.id)?.client.id).toBe(clinic.id);
    expect(items.find((i) => i.id === b.id)?.client.id).toBe(other.id);
    expect(items.every((i) => i.ownerId === null)).toBe(true);
    expect((await ann.get(`${A}/leads?pageSize=100`)).body.data.items.map((i: any) => i.id)).not.toContain(a.id); // without the pool: only hers
  });
});

describe('my tasks across clients', () => {
  it('lists only my own overdue and due-today tasks, each with its client', async () => {
    const other = await mkClient({ name: `Tasks ${uniq()}`, industry: 'retail' });
    expect((await boss.put(`${A}/clients/${other.id}/team/${ann.userId}`, { role: 'sales_agent' })).status).toBe(200);
    const lead = await poolLead(clinic);
    expect((await boss.post(`/api/v1/leads/${lead.id}/assign`, { ownerId: ann.userId }, H(clinic))).status).toBe(200);
    const day = 86_400_000;
    const mk = (c: any, title: string, assignedTo: string, due: number, extra: Record<string, unknown> = {}) =>
      boss.post('/api/v1/tasks', { title, assignedTo, dueDate: new Date(Date.now() + due).toISOString(), ...extra }, H(c));
    expect((await mk(clinic, 'Call the overdue one', ann.userId, -2 * day, { leadId: lead.id })).status).toBe(201);
    expect((await mk(other, 'Overdue elsewhere', ann.userId, -3 * day)).status).toBe(201);
    expect((await mk(clinic, 'Next week', ann.userId, 7 * day)).status).toBe(201);
    expect((await mk(clinic, 'Bob’s task', bob.userId, -day)).status).toBe(201);

    const r = await ann.get(`${A}/tasks`);
    expect(r.status).toBe(200);
    const titles = r.body.data.map((t: any) => t.title);
    expect(titles).toEqual(expect.arrayContaining(['Call the overdue one', 'Overdue elsewhere']));
    expect(titles).not.toContain('Next week');
    expect(titles).not.toContain('Bob’s task');
    const one = r.body.data.find((t: any) => t.title === 'Call the overdue one');
    expect(one).toMatchObject({ overdue: true, client: { id: clinic.id, name: 'Pool Clinic' }, leadId: lead.id });
    expect(r.body.data.find((t: any) => t.title === 'Overdue elsewhere').client.id).toBe(other.id);
    // soonest first
    expect(r.body.data.map((t: any) => t.dueDate)).toEqual([...r.body.data.map((t: any) => t.dueDate)].sort());
    // nobody sees someone else's list
    expect((await bob.get(`${A}/tasks`)).body.data.map((t: any) => t.title)).not.toContain('Call the overdue one');
  });
});

describe('notifications across clients', () => {
  it('a lead nobody owns tells the callers; each client tab can show its own unread count', async () => {
    const c = await mkClient({ name: `Notif ${uniq()}`, industry: 'retail' });
    for (const u of [ann, bob]) expect((await boss.put(`${A}/clients/${c.id}/team/${u.userId}`, { role: 'sales_agent' })).status).toBe(200);
    await poolLead(c);
    const mine = (await ann.get(`${A}/unread`)).body.data as Array<{ clientId: string; unread: number }>;
    expect(mine.find((x) => x.clientId === c.id)?.unread).toBe(1);
    const titles = (await ann.get('/api/v1/notifications?limit=20', H(c))).body.data.map((n: any) => n.title);
    expect(titles).toContain('New lead waiting for an owner');
    expect((await boss.get(`${A}/unread`)).body.data.find((x: any) => x.clientId === c.id)).toBeUndefined(); // not told about what they added themselves
    expect(mine.every((x) => x.unread > 0)).toBe(true);
    expect((await ann.post('/api/v1/notifications/read', { all: true }, H(c))).status).toBe(200);
    expect((await ann.get(`${A}/unread`)).body.data.find((x: any) => x.clientId === c.id)).toBeUndefined();
    expect((await bob.get(`${A}/unread`)).body.data.find((x: any) => x.clientId === c.id)?.unread).toBe(1); // still unread for the other caller
  });
});

describe('archived clients accept no changes', () => {
  it('settings, members, invitations, leads, team and profile edits are all refused until restored', async () => {
    const c = await mkClient({ name: `Frozen ${uniq()}`, industry: 'retail', staff: [{ userId: ann.userId, role: 'sales_agent' }] });
    expect((await ann.post('/api/v1/leads', { contact: { firstName: 'Before', email: `b${uniq()}@x.test` }, source: 'direct' }, H(c))).status).toBe(201);
    expect((await boss.post(`${A}/clients/${c.id}/archive`)).status).toBe(200);

    expect((await boss.post('/api/v1/leads', { contact: { firstName: 'After', email: `a${uniq()}@x.test` }, source: 'direct' }, H(c))).status).toBe(403);
    expect((await ann.post('/api/v1/leads', { contact: { firstName: 'After', email: `a${uniq()}@x.test` }, source: 'direct' }, H(c))).status).toBe(403);
    expect((await boss.patch('/api/v1/workspace', { name: 'Renamed while frozen' }, H(c))).status).toBe(403);
    expect((await boss.post('/api/v1/members/invitations', { email: `x${uniq()}@x.test`, role: 'sales_agent' }, H(c))).status).toBe(403);
    expect((await boss.get('/api/v1/members', H(c))).status).toBe(403);
    expect((await boss.patch(`${A}/clients/${c.id}`, { notes: 'edit while frozen' })).status).toBe(409);
    expect((await boss.delete(`${A}/clients/${c.id}/team/${ann.userId}`)).status).toBe(409);
    expect((await boss.put(`${A}/clients/${c.id}/team/${bob.userId}`, { role: 'sales_agent' })).status).toBe(409);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [c.id, ann.userId])).toBe(1);
    expect(await dbCount(`SELECT count(*) AS n FROM tenants WHERE id = $1 AND name LIKE 'Renamed%'`, [c.id])).toBe(0);

    expect((await boss.post(`${A}/clients/${c.id}/restore`)).status).toBe(200);
    expect((await boss.patch(`${A}/clients/${c.id}`, { notes: 'back' })).status).toBe(200);
    expect((await ann.post('/api/v1/leads', { contact: { firstName: 'Again', email: `g${uniq()}@x.test` }, source: 'direct' }, H(c))).status).toBe(201);
  });
});

describe('invitations and client creation are safe', () => {
  it('the invitation response never carries the token; it only travels by e-mail', async () => {
    const email = `tok${uniq()}@anibros.test`;
    const r = await boss.post(`${A}/staff/invitations`, { email });
    expect(r.status).toBe(201);
    await h.runJobs();
    const token = h.mail.tokenFor(email, 'invited')!;
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(Object.keys(r.body.data).sort()).not.toContain('token');
    const list = await boss.get(`${A}/staff`);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_invitations WHERE email = $1 AND token_hash = $2`, [email, token])).toBe(0); // only a hash is stored
  });

  it('an invitation link works once even when it is opened twice at the same moment', async () => {
    const email = `race${uniq()}@anibros.test`;
    expect((await boss.post(`${A}/staff/invitations`, { email })).status).toBe(201);
    await h.runJobs();
    const token = h.mail.tokenFor(email, 'invited')!;
    const accept = () => api().post('/api/v1/invitations/accept').send({ token, name: 'Racer', password: 'Violet-Lantern-Orbit-77' });
    const rs = await Promise.all([accept(), accept(), accept()]);
    expect(rs.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).every((r) => [404, 409].includes(r.status))).toBe(true);
    expect(await dbCount(`SELECT count(*) AS n FROM users WHERE email = $1`, [email])).toBe(1);
    expect(await dbCount(`SELECT count(*) AS n FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [email])).toBe(1);
    expect((await accept()).status).toBe(404); // and the link is dead afterwards
  });

  it('creating a client is all or nothing', async () => {
    const name = `Atomic ${uniq()}`;
    const before = await dbCount(`SELECT count(*) AS n FROM tenants`);
    const r = await boss.post(`${A}/clients`, { name, industry: 'retail', staff: [{ userId: randomUUID(), role: 'sales_agent' }] });
    expect(r.status).toBe(400); // that person is not an employee
    expect(await dbCount(`SELECT count(*) AS n FROM tenants WHERE name = $1`, [name])).toBe(0);
    expect(await dbCount(`SELECT count(*) AS n FROM tenants`)).toBe(before);
    expect(await dbCount(`SELECT count(*) AS n FROM pipelines p JOIN tenants t ON t.id = p.tenant_id WHERE t.name = $1`, [name])).toBe(0);
    expect((await boss.post(`${A}/clients`, { name, industry: 'retail' })).status).toBe(201); // the name is still free
  });
});
