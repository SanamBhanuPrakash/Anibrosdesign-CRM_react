import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { dayBounds } from '../modules/home/service';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/** Slice 3: Home ("what needs me today"), the lead next step, and global search. Restricted database role throughout. */
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
let auditor: AuthedUser;
let marketing: AuthedUser;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const inWs = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};
async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Kapoor', email: `b${uniq()}@x.test` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
async function newProperty(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 5_000_000, locality: 'Koramangala', city: 'Bangalore', ...extra });
  if (res.status !== 201) throw new Error(`property create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 'hsown', organisationName: 'Home Co' });
  other = await h.register({ emailPrefix: 'hsoth', organisationName: 'Other Home Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', agent2: 'sales_agent', auditor: 'auditor', marketing: 'marketing_manager' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `hs${k}` });
    await addMember(u, owner.tenantId, role);
    made[k] = inWs(u, owner.tenantId);
  }
  ({ manager, agent, agent2, auditor, marketing } = made as Record<keyof typeof roles, AuthedUser>);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('Home: my day', () => {
  it('shows only my own tasks, visits and leads, and every count equals the list it summarises', async () => {
    const mine = await newLead(agent);
    const theirs = await newLead(agent2);
    const unit = await newProperty(owner);
    // my tasks: one overdue, one later today (or tomorrow if it is late), one belonging to a colleague
    const overdue = await agent.post('/api/v1/tasks', { title: 'Call back Mr Kapoor', dueDate: inMin(-120), leadId: mine.id });
    expect(overdue.status).toBe(201);
    await agent.post('/api/v1/tasks', { title: 'Send brochure', dueDate: inMin(30), leadId: mine.id });
    await agent2.post('/api/v1/tasks', { title: 'Colleague task', dueDate: inMin(-60), leadId: theirs.id });
    // a visit today for me and a visit for the colleague
    const startsAt = new Date();
    startsAt.setUTCMinutes(startsAt.getUTCMinutes() + 20);
    const v = await agent.post('/api/v1/viewings', { leadId: mine.id, propertyId: unit.id, scheduledAt: startsAt.toISOString(), durationMinutes: 30 });
    expect(v.status).toBe(201);
    await agent2.post('/api/v1/viewings', { leadId: theirs.id, propertyId: (await newProperty(owner)).id, scheduledAt: startsAt.toISOString(), durationMinutes: 30 });

    const res = await agent.get('/api/v1/home');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.myDay.tasks.overdue.items.map((t: any) => t.title)).toEqual(['Call back Mr Kapoor']);
    expect(d.myDay.tasks.overdue.count).toBe(d.myDay.tasks.overdue.items.length);
    expect(JSON.stringify(d)).not.toContain('Colleague task');
    // "today" shows the brochure task unless midnight is inside the next 30 minutes in the workspace zone; the count always matches the list
    expect(d.myDay.tasks.today.count).toBe(d.myDay.tasks.today.items.length);
    expect(d.myDay.viewings.today.count).toBe(d.myDay.viewings.today.items.length);
    for (const item of d.myDay.viewings.today.items) expect(item.leadId).toBe(mine.id);
    expect(d.myDay.waitingForReply.items.every((r: any) => typeof r.overdue === 'boolean')).toBe(true);
    expect(d.team).toBeNull(); // not a manager
    expect(d.getStarted).toBeNull(); // not an owner or admin
    expect(d.attention).toBeNull();
    expect(d.timezone).toBeTruthy();
    expect(d.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the pipeline snapshot only counts leads the person may see, leaves test leads out and its numbers add up', async () => {
    const a = await newLead(agent, { estimatedValue: 1_000_000 });
    await newLead(agent2, { estimatedValue: 2_000_000 });
    await newLead(agent, { tags: ['test'], estimatedValue: 99 });
    const mineOpen = (await agent.get('/api/v1/leads?state=open&limit=100')).body.data.filter((l: any) => !l.tags.includes('test'));
    const p = (await agent.get('/api/v1/home')).body.data.pipeline;
    expect(p.openLeads).toBe(mineOpen.length);
    expect(p.openLeads).toBe(p.stages.reduce((s: number, x: any) => s + x.count, 0));
    expect(p.openValue).toBe(mineOpen.reduce((s: number, l: any) => s + (l.estimatedValue ?? 0), 0));
    expect(p.stages.every((s: any) => !['Won', 'Lost', 'Not a fit'].includes(s.name))).toBe(true);
    expect(p.weightedValue).toBeLessThanOrEqual(p.openValue);
    const all = (await manager.get('/api/v1/home')).body.data.pipeline;
    expect(all.openLeads).toBeGreaterThan(p.openLeads);
    expect(a.id).toBeTruthy();
  });

  it('a lead waiting for a first reply is listed with its deadline until the reply is logged', async () => {
    const lead = await newLead(agent);
    let list = (await agent.get('/api/v1/home')).body.data.myDay.waitingForReply;
    expect(list.items.map((r: any) => r.leadId)).toContain(lead.id);
    expect(list.count).toBeGreaterThanOrEqual(1);
    expect((await agent.post(`/api/v1/leads/${lead.id}/activities`, { type: 'call', description: 'Spoke to the buyer' })).status).toBe(201);
    list = (await agent.get('/api/v1/home')).body.data.myDay.waitingForReply;
    expect(list.items.map((r: any) => r.leadId)).not.toContain(lead.id);
  });
});

describe('Home: team, attention and setup', () => {
  it('a manager sees the team problems; unassigned leads are listed and counted the same', async () => {
    const lead = await newLead(manager, { ownerId: null });
    const d = (await manager.get('/api/v1/home')).body.data;
    expect(d.team.unassignedLeads.items.map((l: any) => l.leadId)).toContain(lead.id);
    expect(d.team.unassignedLeads.count).toBeGreaterThanOrEqual(d.team.unassignedLeads.items.length);
    expect(typeof d.team.lateFirstReplies).toBe('number');
    expect(typeof d.team.overdueTasks).toBe('number');
    expect(d.attention).toBeNull();
    expect(d.getStarted).toBeNull();
  });

  it('owners get the setup checklist that ticks itself off; operators see what needs attention', async () => {
    const ws = await h.register({ emailPrefix: 'hsfresh', organisationName: 'Fresh Co' });
    let d = (await ws.get('/api/v1/home')).body.data;
    expect(d.getStarted.complete).toBe(false);
    expect(Object.fromEntries(d.getStarted.items.map((i: any) => [i.key, i.done]))).toEqual({ add_lead: false, invite_team: false, add_property: false, connect_source: false, turn_on_automation: false, book_visit: false });
    expect(d.attention).toEqual({ deliveriesNeedingReview: 0, failedAutomationRuns: 0 });
    expect(d.pipeline.openLeads).toBe(0);
    await newLead(ws);
    await newProperty(ws);
    await ws.post('/api/v1/automations/new_lead_follow_up/enable');
    d = (await ws.get('/api/v1/home')).body.data;
    const done = Object.fromEntries(d.getStarted.items.map((i: any) => [i.key, i.done]));
    expect(done).toMatchObject({ add_lead: true, add_property: true, turn_on_automation: true, invite_team: false });
    expect(d.getStarted.items.every((i: any) => i.href.startsWith('/'))).toBe(true);
  });

  it('roles only get the parts they may read; another workspace sees nothing of this one', async () => {
    const a = (await auditor.get('/api/v1/home')).body.data;
    expect(a.myDay).toEqual({ tasks: null, viewings: null, waitingForReply: null });
    expect(a.pipeline).toBeNull();
    expect(a.team).toBeNull();
    expect(a.attention).not.toBeNull(); // auditors read operations
    const m = (await marketing.get('/api/v1/home')).body.data;
    expect(m.team).toBeNull();
    expect(m.attention).not.toBeNull();
    const o = (await other.get('/api/v1/home')).body.data;
    expect(o.pipeline.openLeads).toBe(0);
    expect(o.myDay.waitingForReply.count).toBe(0);
    expect((await request(h.app).get('/api/v1/home')).status).toBe(401);
  });
});

describe('the next step on a lead', () => {
  it('asks for the first reply, then follows the lead as things get planned', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(agent);
    let step = (await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep;
    expect(step).toMatchObject({ kind: 'reply', urgent: false });
    expect(step.dueAt).toBeTruthy();

    // reply logged: nothing planned yet
    await agent.post(`/api/v1/leads/${lead.id}/activities`, { type: 'call', description: 'Spoke' });
    step = (await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep;
    expect(step.kind).toBe('plan');

    // a task becomes the next step
    await agent.post('/api/v1/tasks', { title: 'Send floor plans', dueDate: inMin(-30), leadId: lead.id });
    step = (await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep;
    expect(step).toMatchObject({ kind: 'task', title: 'Send floor plans', urgent: true });

    // an upcoming visit takes over (its reminder task is not shown as a second step)
    const v = await agent.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: inMin(60 * 24 * 3), durationMinutes: 30 });
    await agent.post('/api/v1/tasks', { title: 'Send floor plans', dueDate: inMin(60 * 24 * 5), leadId: lead.id }); // a later task does not outrank the visit
    step = (await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep;
    expect(step).toMatchObject({ kind: 'visit', urgent: false, viewingId: v.body.data.id });
    expect(v.status).toBe(201);
  });

  it('a visit that has ended and is not recorded becomes the next step, and closed leads have none', async () => {
    const lead = await newLead(agent);
    await agent.post(`/api/v1/leads/${lead.id}/activities`, { type: 'call', description: 'Spoke' });
    const unit = await newProperty(owner);
    const v = await agent.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: inMin(-90), durationMinutes: 30 });
    const step = (await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep;
    expect(step).toMatchObject({ kind: 'record_visit', urgent: true, viewingId: v.body.data.id });
    const stages = Object.fromEntries((await owner.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
    expect((await agent.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.lost, reasonCode: 'timing' })).status).toBe(200);
    expect((await agent.get(`/api/v1/leads/${lead.id}`)).body.data.nextStep).toBeNull();
  });
});

describe('global search', () => {
  let who: string;
  beforeAll(async () => {
    who = `Zephyrine${uniq()}`;
    await newLead(agent, { contact: { firstName: who, lastName: 'Menon', email: `${who.toLowerCase()}@find.test`, phone: '+919800011122' } });
    await newLead(agent2, { contact: { firstName: who, lastName: 'Rao', email: `${who.toLowerCase()}2@find.test` } });
    await newProperty(owner, { title: `${who} Heights`, unitNumber: 'A-1204' });
    await agent.post('/api/v1/tasks', { title: `Call ${who} about the loan` });
    await agent2.post('/api/v1/tasks', { title: `Colleague ${who} task` });
  });

  it('finds each kind of record, at most five of each, and says where to open it', async () => {
    const r = await manager.get(`/api/v1/search?q=${encodeURIComponent(who)}`);
    expect(r.status).toBe(200);
    const res = r.body.data.results;
    expect(res.leads.length).toBe(2);
    expect(res.leads[0].href).toMatch(/^\/leads\/[0-9a-f-]{36}$/);
    expect(res.contacts.length).toBe(2);
    expect(res.contacts[0].href).toMatch(/^\/contacts\?c=/);
    expect(res.properties[0]).toMatchObject({ title: `${who} Heights` });
    expect(res.tasks.length).toBe(2);
    for (const k of Object.keys(res)) expect(res[k].length).toBeLessThanOrEqual(5);
  });

  it('matches phone digits and unit numbers, and treats % and _ literally', async () => {
    expect((await manager.get('/api/v1/search?q=98000')).body.data.results.leads.length).toBeGreaterThanOrEqual(1);
    expect((await manager.get('/api/v1/search?q=A-1204')).body.data.results.properties.length).toBe(1);
    const wild = (await manager.get('/api/v1/search?q=%25%25')).body.data.results;
    expect([...(wild.leads ?? []), ...(wild.contacts ?? []), ...(wild.properties ?? []), ...(wild.tasks ?? [])]).toHaveLength(0);
    expect(Object.values((await manager.get(`/api/v1/search?q=${encodeURIComponent("x'; DROP TABLE leads;--")}`)).body.data.results).flat()).toHaveLength(0);
  });

  it('a salesperson finds only their own leads and tasks', async () => {
    const res = (await agent.get(`/api/v1/search?q=${encodeURIComponent(who)}`)).body.data.results;
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].title).toContain('Menon');
    expect(res.tasks.map((t: any) => t.title)).toEqual([`Call ${who} about the loan`]);
    expect(JSON.stringify(res)).not.toContain('Colleague');
  });

  it('kinds a role may not read are absent, an auditor may not search, other workspaces find nothing', async () => {
    const mk = (await marketing.get(`/api/v1/search?q=${encodeURIComponent(who)}`)).body.data.results;
    expect(Object.keys(mk)).toEqual(expect.arrayContaining(['leads', 'contacts', 'properties']));
    expect((await auditor.get(`/api/v1/search?q=${encodeURIComponent(who)}`)).status).toBe(403);
    const o = (await other.get(`/api/v1/search?q=${encodeURIComponent(who)}`)).body.data.results;
    expect(Object.values(o).flat()).toHaveLength(0);
    expect((await request(h.app).get('/api/v1/search?q=abc')).status).toBe(401);
  });

  it('does not return archived records and asks for at least two characters', async () => {
    const gone = await newLead(manager, { contact: { firstName: `Archivable${uniq()}`, email: `arch${uniq()}@x.test` } });
    const name = gone.contactName.split(' ')[0];
    expect((await manager.get(`/api/v1/search?q=${name}`)).body.data.results.leads).toHaveLength(1);
    expect((await owner.delete(`/api/v1/leads/${gone.id}`)).status).toBe(204);
    expect((await manager.get(`/api/v1/search?q=${name}`)).body.data.results.leads).toHaveLength(0);
    expect((await manager.get('/api/v1/search?q=a')).status).toBe(400);
    expect((await manager.get('/api/v1/search')).status).toBe(400);
    expect((await manager.get(`/api/v1/search?q=${'x'.repeat(101)}`)).status).toBe(400);
  });
});

describe('a visit appears once on Home', () => {
  it('its reminder task is not listed as an overdue task, and a manager is told about visits nobody recorded', async () => {
    const ws = await h.register({ emailPrefix: 'hsdup', organisationName: 'Dup Co' });
    const lead = await newLead(ws);
    const unit = await newProperty(ws);
    const past = new Date(Date.now() - 90 * 60_000).toISOString();
    const v = await ws.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: past, durationMinutes: 30 });
    expect(v.status).toBe(201);
    const reminder = (await h.admin.query(`SELECT reminder_task_id FROM viewings WHERE id = $1`, [v.body.data.id])).rows[0].reminder_task_id;
    expect((await h.admin.query(`SELECT status, due_date < now() AS late FROM tasks WHERE id = $1`, [reminder])).rows[0]).toMatchObject({ status: 'pending', late: true });
    const d = (await ws.get('/api/v1/home')).body.data;
    expect(d.myDay.tasks.overdue.items.map((t: any) => t.id)).not.toContain(reminder);
    expect(d.myDay.tasks.overdue.count).toBe(0);
    expect(d.myDay.viewings.today.items.find((x: any) => x.id === v.body.data.id)?.needsOutcome).toBe(true);
    expect(d.team.unrecordedVisits).toBeGreaterThanOrEqual(1);
    expect(d.team.overdueTasks).toBe(0);
    // once recorded it leaves the manager's list
    expect((await ws.post(`/api/v1/viewings/${v.body.data.id}/complete`, { outcome: 'considering' })).status).toBe(200);
    expect((await ws.get('/api/v1/home')).body.data.team.unrecordedVisits).toBe(0);
  });
});

describe('tasks by due-date range (the calendar’s question)', () => {
  it('returns only tasks due inside the range, and validates the bounds', async () => {
    const ws = await h.register({ emailPrefix: 'hsrange', organisationName: 'Range Co' });
    const day = (n: number) => new Date(Date.UTC(2037, 4, n, 9, 0)).toISOString();
    for (const n of [1, 2, 3, 9]) expect((await ws.post('/api/v1/tasks', { title: `Task day ${n}`, dueDate: day(n) })).status).toBe(201);
    const r = await ws.get(`/api/v1/tasks?dueFrom=${encodeURIComponent(day(2))}&dueTo=${encodeURIComponent(day(4))}&limit=50`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((t: any) => t.title).sort()).toEqual(['Task day 2', 'Task day 3']);
    expect((await ws.get('/api/v1/tasks?dueFrom=tomorrow')).status).toBe(400);
  });
});

describe('"today" follows the workspace time zone, including daylight-saving days', () => {
  const hours = (b: { start_today: Date; start_tomorrow: Date }) => (b.start_tomorrow.getTime() - b.start_today.getTime()) / 3_600_000;
  const bounds = (tz: string, at: string) => dayBounds(h.admin as unknown as pg.PoolClient, tz, new Date(at));
  it('a day is 23 hours when clocks go forward, 25 when they go back, 24 elsewhere, and starts at local midnight', async () => {
    const fwd = await bounds('America/New_York', '2026-03-08T15:00:00Z');
    expect(fwd.local_date).toBe('2026-03-08');
    expect(hours(fwd)).toBe(23);
    expect(fwd.start_today.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // midnight EST
    expect(fwd.start_tomorrow.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // midnight EDT
    const back = await bounds('America/New_York', '2026-11-01T15:00:00Z');
    expect(hours(back)).toBe(25);
    expect(hours(await bounds('America/New_York', '2026-06-15T15:00:00Z'))).toBe(24);
    const kolkata = await bounds('Asia/Kolkata', '2026-03-08T20:00:00Z'); // 01:30 on the 9th in India
    expect(kolkata.local_date).toBe('2026-03-09');
    expect(kolkata.start_today.toISOString()).toBe('2026-03-08T18:30:00.000Z');
    expect(hours(kolkata)).toBe(24);
  });
  it('the same instant is a different day in different workspaces, and "8 days ahead" still lands on local midnight across a change', async () => {
    const at = '2026-03-08T03:30:00Z';
    expect((await bounds('America/New_York', at)).local_date).toBe('2026-03-07');
    expect((await bounds('Pacific/Auckland', at)).local_date).toBe('2026-03-08');
    const ahead = await bounds('America/New_York', '2026-03-05T15:00:00Z');
    expect(ahead.start_in_8.toISOString()).toBe('2026-03-13T04:00:00.000Z'); // midnight EDT on the 13th
  });
});
