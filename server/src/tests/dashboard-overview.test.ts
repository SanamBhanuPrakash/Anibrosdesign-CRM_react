import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * The executive overview: every figure must equal the number of rows in the list its click leads to, the caller only sees what they may see,
 * and the date range and test-lead switch behave as stated. Restricted database role throughout.
 */
let h: ApiHarness;
let ws: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let auditor: AuthedUser;
let marketing: AuthedUser;
let stages: Record<string, string> = {};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const inWs = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};
const lead = async (u: AuthedUser, extra: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Rao', email: `b${uniq()}@x.test` }, source: 'website', ...extra });
  if (r.status !== 201) throw new Error(`lead ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
const unit = async (u: AuthedUser, extra: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 6_000_000, ...extra });
  if (r.status !== 201) throw new Error(`property ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
/** Follow the cursor to the end and return every row. */
const all = async (u: AuthedUser, path: string): Promise<any[]> => {
  const rows: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await u.get(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    rows.push(...r.body.data);
    if (!r.body.page?.hasMore) break;
    cursor = r.body.page.next;
  }
  return rows;
};
const overview = async (u: AuthedUser, qs = '') => {
  const r = await u.get(`/api/v1/dashboard/overview${qs}`);
  if (r.status !== 200) throw new Error(`overview -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  ws = await h.register({ emailPrefix: 'dbown', organisationName: 'Overview Co' });
  other = await h.register({ emailPrefix: 'dboth', organisationName: 'Other Overview Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', auditor: 'auditor', marketing: 'marketing_manager' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `db${k}` });
    await addMember(u, ws.tenantId, role);
    made[k] = inWs(u, ws.tenantId);
  }
  ({ manager, agent, auditor, marketing } = made as Record<keyof typeof roles, AuthedUser>);
  stages = Object.fromEntries((await ws.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));

  // ── leads: open (agent, manager, unassigned), won with a recorded sale, lost, a test lead, an archived lead, and an old one outside the default range
  ids.agentOpen = (await lead(ws, { ownerId: agent.userId, source: 'meta_ads', estimatedValue: 4_000_000 })).id;
  ids.agentWon = (await lead(ws, { ownerId: agent.userId, source: 'google_ads', estimatedValue: 9_999_999 })).id;
  ids.managerLost = (await lead(ws, { ownerId: manager.userId, source: 'referral', estimatedValue: 2_000_000 })).id;
  ids.unassigned = (await lead(ws, { ownerId: null, source: 'website', estimatedValue: 1_000_000 })).id;
  ids.test = (await lead(ws, { ownerId: manager.userId, source: 'website', tags: ['test'], estimatedValue: 500_000 })).id;
  ids.archived = (await lead(ws, { ownerId: manager.userId, estimatedValue: 700_000 })).id;
  ids.old = (await lead(ws, { ownerId: manager.userId, source: 'portal', estimatedValue: 3_000_000 })).id;
  await ws.delete(`/api/v1/leads/${ids.archived}`);
  await h.admin.query(`UPDATE leads SET created_at = $2 WHERE id = $1`, [ids.old, ago(40)]);
  expect((await ws.post(`/api/v1/leads/${ids.managerLost}/stage`, { stageId: stages.lost, reasonCode: 'price_too_high' })).status).toBe(200);
  await ws.post(`/api/v1/leads/${ids.agentOpen}/stage`, { stageId: stages.qualified });

  // ── a sale: offer, reserve, complete (recorded deal value 6,000,000)
  ids.soldUnit = (await unit(ws)).id;
  const offer = (await ws.post('/api/v1/reservations', { leadId: ids.agentWon, propertyId: ids.soldUnit, offerPrice: 5_900_000 })).body.data.reservation;
  await ws.post(`/api/v1/reservations/${offer.id}/reserve`, { tokenAmount: 100_000, agreedPrice: 5_950_000 });
  expect((await ws.post(`/api/v1/reservations/${offer.id}/complete`, { dealValue: 6_000_000 })).status).toBe(200);
  // a booked unit (reserved) and two available ones
  const bookedUnit = (await unit(ws)).id;
  const o2 = (await ws.post('/api/v1/reservations', { leadId: ids.agentOpen, propertyId: bookedUnit })).body.data.reservation;
  await ws.post(`/api/v1/reservations/${o2.id}/reserve`, { tokenAmount: 50_000, agreedPrice: 6_000_000 });
  await unit(ws, { price: 8_000_000 });
  await unit(ws, { price: 4_000_000 });

  // ── tasks: one overdue for the agent, one overdue unassigned, one due today, one far in the future
  await ws.post('/api/v1/tasks', { title: 'Call back', assignedTo: agent.userId, dueDate: ago(2) });
  await ws.post('/api/v1/tasks', { title: 'Unowned overdue', dueDate: ago(1) });
  await ws.post('/api/v1/tasks', { title: 'Later today', assignedTo: agent.userId, dueDate: new Date(Date.now() + 60_000).toISOString() });
  await ws.post('/api/v1/tasks', { title: 'Next month', assignedTo: manager.userId, dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString() });

  // ── visits: one upcoming, one completed yesterday, one ended and never recorded
  const unitV = (await unit(ws)).id;
  const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
  expect((await ws.post('/api/v1/viewings', { leadId: ids.agentOpen, propertyId: unitV, scheduledAt: when, durationMinutes: 30 })).status).toBe(201);
  for (const [status, at] of [['completed', ago(1)], ['scheduled', ago(0.5)]] as const) {
    await h.admin.query(
      `INSERT INTO viewings (tenant_id, lead_id, property_id, scheduled_at, duration_minutes, status, agent_id) VALUES ($1,$2,$3,$4,30,$5::viewing_status,$6)`,
      [ws.tenantId, ids.agentOpen, unitV, at, status, agent.userId]
    );
  }
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('every number equals the rows behind it', () => {
  it('leads: total, open, created in the period, unassigned, late replies, overdue follow-ups, and the test-lead switch', async () => {
    const o = await overview(ws);
    const q = (s: string) => all(ws, `/api/v1/leads?${s}`);
    expect(o.includesTestLeads).toBe(false);
    expect((await q('test=exclude')).length).toBe(o.leads.total);
    expect((await q('state=open&test=exclude')).length).toBe(o.leads.open);
    expect((await q(`test=exclude&createdFrom=${o.range.from}&createdTo=${o.range.to}`)).length).toBe(o.leads.created);
    expect((await q(`test=exclude&status=won&createdFrom=${o.range.from}&createdTo=${o.range.to}`)).length).toBe(o.leads.wonOfCreated);
    expect((await q('state=open&test=exclude&ownerId=unassigned')).length).toBe(o.leads.unassigned);
    expect((await q('state=open&test=exclude&sla=breached')).length).toBe(o.leads.lateFirstReplies);
    expect((await q('state=open&test=exclude&followup=overdue')).length).toBe(o.leads.followupsOverdue);
    // the fixtures: 5 live leads (7 created, minus the test lead and the archived one)
    expect(o.leads.total).toBe(5);
    expect(o.leads.created).toBe(4); // the old lead is outside the 30-day range
    expect(o.leads.open).toBe(3); // agentOpen, unassigned and the old lead; one is won, one lost
    // switching test leads on adds exactly the test lead, and the lists agree
    const withTest = await overview(ws, '?includeTest=true');
    expect(withTest.leads.total).toBe(6);
    expect((await q('')).length).toBe(6);
    expect(withTest.includesTestLeads).toBe(true);
  });

  it('the conversion rate is leads created in the period that are now won, and “—” (null) when none were created', async () => {
    const o = await overview(ws);
    expect(o.leads.conversionRate).toBe(o.leads.wonOfCreated / o.leads.created);
    const empty = await overview(ws, '?from=2001-01-01&to=2001-01-31');
    expect(empty.leads.created).toBe(0);
    expect(empty.leads.conversionRate).toBeNull();
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
  });

  it('pipeline: stage counts and values equal the lists by stage; open value and weighted value add up', async () => {
    const o = await overview(ws);
    for (const s of o.pipeline.stages) {
      const rows = await all(ws, `/api/v1/leads?test=exclude&stage=${s.id}`.replace('stage=', 'stageId='));
      expect(rows.length, s.name).toBe(s.count);
      expect(rows.reduce((a: number, r: any) => a + (r.estimatedValue ?? 0), 0), s.name).toBe(s.value);
    }
    const open = o.pipeline.stages.filter((s: any) => !s.isClosed);
    expect(o.pipeline.openValue).toBe(open.reduce((a: number, s: any) => a + s.value, 0) + o.pipeline.otherPipelines.value);
    expect(o.pipeline.weightedValue).toBeLessThanOrEqual(o.pipeline.openValue);
    expect(o.pipeline.weightedValue).toBeGreaterThan(0);
  });

  it('sources: leads per source in the period equal the lists, and add up to the leads created', async () => {
    const o = await overview(ws);
    expect(o.sources.reduce((a: number, s: any) => a + s.leads, 0)).toBe(o.leads.created);
    for (const s of o.sources) {
      expect((await all(ws, `/api/v1/leads?test=exclude&source=${s.source}&createdFrom=${o.range.from}&createdTo=${o.range.to}`)).length, s.source).toBe(s.leads);
    }
  });

  it('sales: the recorded deal value equals the sum over the sold list for the same days; a booking is not a sale', async () => {
    const o = await overview(ws);
    const sold = await all(ws, `/api/v1/reservations?status=completed&completedFrom=${o.range.from}&completedTo=${o.range.to}&test=exclude`);
    expect(sold).toHaveLength(o.sales.count);
    expect(sold.reduce((a: number, d: any) => a + d.dealValue, 0)).toBe(o.sales.dealValue);
    expect(o.sales.count).toBe(1);
    expect(o.sales.dealValue).toBe(6_000_000); // not the 9,999,999 typed on the lead
    expect(o.sales.reserved).toBe((await all(ws, '/api/v1/reservations?status=reserved')).length);
    expect(o.sales.averageDealValue).toBe(6_000_000);
  });

  it('tasks: open, overdue and due today equal the task lists', async () => {
    const o = await overview(ws);
    expect(o.tasks.scope).toBe('all');
    expect((await all(ws, '/api/v1/tasks?status=open&assignee=any')).length).toBe(o.tasks.open);
    expect((await all(ws, '/api/v1/tasks?status=open&assignee=any&due=overdue')).length).toBe(o.tasks.overdue);
    expect((await all(ws, '/api/v1/tasks?status=open&assignee=any&due=today')).length).toBe(o.tasks.dueToday);
    expect((await all(ws, '/api/v1/tasks?status=open&assignee=unassigned')).length).toBe(o.tasks.unassigned);
    expect(o.tasks.overdue).toBeGreaterThanOrEqual(2);
  });

  it('inventory: counts by status equal the property lists and add up to the total', async () => {
    const o = await overview(ws);
    expect(Object.values(o.inventory.byStatus).reduce((a: number, b) => a + (b as number), 0)).toBe(o.inventory.total);
    for (const [status, count] of Object.entries(o.inventory.byStatus)) {
      expect((await all(ws, `/api/v1/properties?status=${status}`)).length, status).toBe(count);
    }
    expect((await all(ws, '/api/v1/properties')).length).toBe(o.inventory.total);
    const available = await all(ws, '/api/v1/properties?status=available');
    expect(available.reduce((a: number, p: any) => a + p.price, 0)).toBe(o.inventory.availableValue);
  });

  it('visits: counts come from the visit records', async () => {
    const o = await overview(ws);
    expect(o.viewings.upcoming).toBe(1);
    expect(o.viewings.next7Days).toBe(1);
    expect(o.viewings.completed).toBe(1);
    expect(o.viewings.unrecorded).toBe(1);
    const list = await all(ws, `/api/v1/viewings?status=completed`);
    expect(list.length).toBe(1);
  });

  it('team: one row per person; open leads plus unassigned open leads equal all open leads; deal value equals the sale', async () => {
    const o = await overview(ws);
    expect(o.team.reduce((a: number, t: any) => a + t.openLeads, 0) + o.leads.unassigned).toBe(o.leads.open);
    expect(o.team.reduce((a: number, t: any) => a + t.dealValue, 0)).toBe(o.sales.dealValue);
    const a = o.team.find((t: any) => t.userId === agent.userId);
    expect(a).toMatchObject({ sales: 1, dealValue: 6_000_000 });
    expect((await all(ws, `/api/v1/leads?state=open&test=exclude&ownerId=${agent.userId}`)).length).toBe(a.openLeads);
    expect(a.overdueTasks).toBe((await all(ws, `/api/v1/tasks?status=open&assignee=${agent.userId}&due=overdue`)).length);
  });

  it('the trend adds up: leads per bucket sum to the leads created, deal value per bucket to the sales, buckets cover the range once', async () => {
    const o = await overview(ws);
    expect(o.bucket).toBe('day');
    expect(o.trend.reduce((a: number, b: any) => a + b.leads, 0)).toBe(o.leads.created);
    expect(o.trend.reduce((a: number, b: any) => a + b.dealValue, 0)).toBe(o.sales.dealValue);
    expect(o.trend).toHaveLength(o.range.days);
    const wide = await overview(ws, `?from=${o.range.from.slice(0, 4)}-01-01&to=${o.range.to}`);
    expect(['week', 'month']).toContain(wide.bucket);
    expect(wide.trend.reduce((a: number, b: any) => a + b.leads, 0)).toBe(wide.leads.created);
    expect(wide.leads.created).toBe(5); // the old lead is inside a year-to-date range
    // a bucket's own dates reproduce its count
    const day = o.trend.find((b: any) => b.leads > 0);
    expect((await all(ws, `/api/v1/leads?test=exclude&createdFrom=${day.from}&createdTo=${day.to}`)).length).toBe(day.leads);
  });

  it('the previous period is the window of the same length just before, and its lead count is real', async () => {
    const o = await overview(ws);
    expect(o.previous.to < o.range.from).toBe(true);
    const prev = await all(ws, `/api/v1/leads?test=exclude&createdFrom=${o.previous.from}&createdTo=${o.previous.to}`);
    expect(prev.length).toBe(o.leads.previousCreated);
    expect(o.leads.previousCreated).toBe(1); // the old lead (40 days ago) falls in the previous 30 days
  });
});

describe('who sees what', () => {
  it('a salesperson sees only their own leads, tasks and visits, no team table, and the same inventory', async () => {
    const o = await overview(agent);
    expect(o.team).toBeNull();
    expect(o.tasks.scope).toBe('own');
    const mine = await all(agent, '/api/v1/leads?test=exclude');
    expect(mine.length).toBe(o.leads.total);
    expect(o.leads.total).toBe(2);
    expect(o.sales.dealValue).toBe(6_000_000);
    expect(o.tasks.overdue).toBe((await all(agent, '/api/v1/tasks?status=open&assignee=me&due=overdue')).length);
    expect(o.inventory.total).toBeGreaterThan(0);
  });

  it('a manager sees everything; marketing sees leads and the team table is theirs to see only if they may assign', async () => {
    const m = await overview(manager);
    expect(m.leads.total).toBe(5);
    expect(m.team).not.toBeNull();
    const mm = await overview(marketing);
    expect(mm.leads.total).toBe(5);
    expect(mm.tasks).not.toBeNull();
    expect(mm.team).toBeNull(); // marketing cannot assign leads
  });

  it('an auditor has no dashboard; another workspace sees none of this one', async () => {
    expect((await auditor.get('/api/v1/dashboard/overview')).status).toBe(403);
    const o = await overview(other);
    expect(o.leads.total).toBe(0);
    expect(o.sales.count).toBe(0);
    expect(o.inventory.total).toBe(0);
    expect(o.team).toEqual([]);
  });
});

describe('the date range', () => {
  it('is whole days in the workspace time zone, validated, and capped at a year', async () => {
    expect((await ws.get('/api/v1/dashboard/overview?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await ws.get('/api/v1/dashboard/overview?from=yesterday')).status).toBe(400);
    expect((await ws.get('/api/v1/dashboard/overview?from=2026-03-10&to=2026-03-01')).status).toBe(400);
    expect((await ws.get('/api/v1/dashboard/overview?from=2024-01-01&to=2026-03-01')).status).toBe(400);
    const one = await overview(ws, '?from=2026-03-08&to=2026-03-08');
    expect(one.range.days).toBe(1);
    expect(one.trend).toHaveLength(1);
  });

  it('a lead created at 23:30 workspace time on the last day is inside the range and one created just after midnight is not', async () => {
    const tz = (await h.admin.query(`SELECT timezone FROM tenants WHERE id = $1`, [ws.tenantId])).rows[0].timezone as string;
    const a = await lead(ws, { ownerId: null });
    const b = await lead(ws, { ownerId: null });
    const edge = (await h.admin.query(`SELECT to_char((timestamp '2031-06-15 23:30') AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS late, to_char((timestamp '2031-06-16 00:10') AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS early`, [tz])).rows[0];
    await h.admin.query(`UPDATE leads SET created_at = (timestamp '2031-06-15 23:30') AT TIME ZONE $2 WHERE id = $1`, [a.id, tz]);
    await h.admin.query(`UPDATE leads SET created_at = (timestamp '2031-06-16 00:10') AT TIME ZONE $2 WHERE id = $1`, [b.id, tz]);
    void edge;
    const day = await overview(ws, '?from=2031-06-15&to=2031-06-15');
    expect(day.leads.created).toBe(1);
    expect((await all(ws, '/api/v1/leads?test=exclude&createdFrom=2031-06-15&createdTo=2031-06-15')).map((l: any) => l.id)).toEqual([a.id]);
    expect((await all(ws, '/api/v1/leads?test=exclude&createdFrom=2031-06-16&createdTo=2031-06-16')).map((l: any) => l.id)).toEqual([b.id]);
  });
});
