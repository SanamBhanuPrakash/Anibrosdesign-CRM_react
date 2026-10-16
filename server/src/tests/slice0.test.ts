import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Slice 0 acceptance (docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md §2). Runs as the RESTRICTED database role, so row-level security is real.
 *  - legacy endpoints that bypassed the permission matrix are gone
 *  - dashboard / attribution numbers reconcile with the lists and ignore archived and test leads
 *  - workspace settings merge instead of overwrite
 *  - viewings: role rules, availability rules, no double booking, no cross-workspace access
 *  - property matching ignores archived and unavailable units
 */
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
let manager: AuthedUser;
let auditor: AuthedUser;
let marketing: AuthedUser;
let stages: Record<string, string> = {};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);

async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Lead${uniq()}`, email: `l${uniq()}@x.test` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
async function newProperty(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 5_000_000, locality: 'Whitefield', city: 'Bangalore', bedrooms: 3, bathrooms: 2, areaSqft: 1500, ...extra });
  if (res.status !== 201) throw new Error(`property create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
const move = async (u: AuthedUser, leadId: string, key: string) => {
  // winning needs a recorded deal value tied to a unit in the recommended pipeline (Slice 4, D3)
  const deal = key === 'won' ? { propertyId: (await newProperty(u)).id, dealValue: 2_000_000 } : undefined;
  const r = await u.post(`/api/v1/leads/${leadId}/stage`, { stageId: stages[key], reasonCode: key === 'lost' ? 'bought_elsewhere' : undefined, deal });
  if (r.status !== 200) throw new Error(`move failed ${r.status} ${JSON.stringify(r.body)}`);
};
/** A time slot far enough away to be unique per call. */
let slot = 0;
const when = () => new Date(Date.UTC(2031, 0, 1, 9, 0) + slot++ * 3 * 3600_000).toISOString();

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 's0own', organisationName: 'Slice Zero Co' });
  other = await h.register({ emailPrefix: 's0oth', organisationName: 'Other Slice Co' });
  const roles = { agent: 'sales_agent', agent2: 'sales_agent', manager: 'sales_manager', auditor: 'auditor', marketing: 'marketing_manager' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `s0${k}` });
    await addMember(u, owner.tenantId, role);
    made[k] = u;
  }
  const inOwnerWs = (u: AuthedUser): AuthedUser => {
    const hdr = { 'X-Tenant-Id': owner.tenantId };
    return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
  };
  ({ agent, agent2, manager, auditor, marketing } = Object.fromEntries(Object.entries(made).map(([k, u]) => [k, inOwnerWs(u)])) as Record<keyof typeof roles, AuthedUser>);
  // free movement between stages: this suite is about the numbers, not the seeded transition rules
  const pl = (await owner.get('/api/v1/pipelines')).body.data[0];
  expect((await owner.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] })).status).toBe(200);
  stages = Object.fromEntries((await owner.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
}, 240_000);

afterAll(async () => {
  await h?.close();
});


describe('removed legacy endpoints', () => {
  const gone: Array<[string, string]> = [
    ['get', '/api/viewings'],
    ['post', '/api/viewings'],
    ['get', '/api/dashboard/metrics'],
    ['get', '/api/dashboard/attribution'],
    ['post', '/api/properties/match'],
    ['get', '/api/tenant/config'],
    ['patch', '/api/tenant/config'],
    ['get', '/api/tenant/members'],
    ['post', '/api/tenant/members/invite'],
    ['delete', '/api/tenant/members/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/tenant/audit-logs'],
    ['get', '/api/integrations'],
    ['post', '/api/integrations'],
    ['get', '/api/automation'],
    ['post', '/api/automation'],
    ['get', '/api/custom-fields'],
    ['post', '/api/custom-fields'],
    ['get', '/api/reports/pipeline-velocity'],
  ];
  it.each(gone)('%s %s no longer exists (the owner gets 404, not data)', async (method, path) => {
    const call = (owner as any)[method] as (p: string, b?: object) => request.Test;
    const res = await call.call(owner, path, method === 'get' || method === 'delete' ? undefined : {});
    expect(res.status).toBe(404);
  });

  it('health probes still work', async () => {
    expect((await request(h.app).get('/api/health/live')).body.status).toBe('ok');
    const ready = await request(h.app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.database).toBe('connected');
  });

  it('a user of another workspace cannot borrow this workspace through the X-Tenant-Id header', async () => {
    const res = await other.get('/api/v1/leads', { 'X-Tenant-Id': owner.tenantId });
    expect(res.status).toBe(403);
  });
});

describe('dashboard numbers reconcile with the lists', () => {
  let ws: AuthedUser;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    ws = await h.register({ emailPrefix: 's0dash', organisationName: 'Dash Co' });
    const pl = (await ws.get('/api/v1/pipelines')).body.data[0];
    await ws.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] });
    const st = Object.fromEntries((await ws.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
    const stage = async (id: string, key: string) => {
      const deal = key === 'won' ? { propertyId: (await newProperty(ws)).id, dealValue: 1_800_000 } : undefined;
      const r = await ws.post(`/api/v1/leads/${id}/stage`, { stageId: st[key], reasonCode: key === 'lost' ? 'price_too_high' : undefined, deal });
      if (r.status !== 200) throw new Error(`stage ${key} -> ${r.status} ${JSON.stringify(r.body)}`);
    };
    ids.fresh = (await newLead(ws, { estimatedValue: 1_000_000, source: 'meta_ads', campaign: 'Diwali Launch' })).id;
    ids.won = (await newLead(ws, { estimatedValue: 2_000_000, source: 'google_ads', campaign: 'Diwali Launch' })).id;
    ids.lost = (await newLead(ws, { estimatedValue: 500_000, source: 'google_ads' })).id;
    ids.archived = (await newLead(ws, { estimatedValue: 9_000_000, source: 'meta_ads' })).id;
    ids.test = (await newLead(ws, { estimatedValue: 700_000, source: 'website', tags: ['test'] })).id;
    await stage(ids.won, 'won');
    await stage(ids.lost, 'lost');
    expect((await ws.delete(`/api/v1/leads/${ids.archived}`)).status).toBe(204);
  });

  it('counts only live leads, leaves test leads out by default, and the status buckets add up to the total', async () => {
    const res = await ws.get('/api/v1/dashboard/metrics');
    expect(res.status).toBe(200);
    const l = res.body.data.leads;
    expect(l.total).toBe(3); // fresh + won + lost (archived and test excluded)
    expect(l.new + l.contacted + l.qualified + l.viewingScheduled + l.negotiation + l.converted + l.lost + l.disqualified).toBe(l.total);
    expect(l.converted).toBe(1);
    expect(l.lost).toBe(1);
    expect(l.totalPipelineValue).toBe(1_000_000); // open leads only
    expect(l.wonValue).toBe(2_000_000); // the estimate typed on the lead
    expect(l.wonDealValue).toBe(1_800_000); // the recorded sale (Slice 4): the figure to report
    expect(res.body.data.includesTestLeads).toBe(false);
    // the lead list agrees
    const list = await ws.get('/api/v1/leads?limit=100');
    expect(list.body.data.filter((x: any) => !x.tags.includes('test')).length).toBe(l.total);
  });

  it('includeTest=true adds the test lead, and nothing else changes', async () => {
    const l = (await ws.get('/api/v1/dashboard/metrics?includeTest=true')).body.data;
    expect(l.leads.total).toBe(4);
    expect(l.includesTestLeads).toBe(true);
    expect(l.leads.new + l.leads.converted + l.leads.lost).toBe(4);
  });

  it('stage counts follow the live leads too', async () => {
    const { stages: sg } = (await ws.get('/api/v1/dashboard/metrics')).body.data;
    expect(sg.reduce((a: number, s: any) => a + s.leadCount, 0)).toBe(3);
  });

  it('rejects an invalid includeTest value', async () => {
    expect((await ws.get('/api/v1/dashboard/metrics?includeTest=maybe')).status).toBe(400);
  });

  it('attribution reports untracked leads separately and invents no campaigns', async () => {
    const a = (await ws.get('/api/v1/dashboard/attribution')).body.data;
    expect(a.total_leads).toBe(3);
    expect(a.total_attributed + a.untracked_leads).toBe(a.total_leads);
    const bySource = Object.fromEntries(a.source_breakdown.map((r: any) => [r.source, r]));
    expect(bySource.meta_ads.lead_count).toBe(1);
    expect(bySource.google_ads.lead_count).toBe(2);
    expect(bySource.google_ads.won_count).toBe(1);
    // campaigns come only from names that were recorded on leads
    expect(a.campaign_performance.map((c: any) => c.campaign_name).sort()).toEqual(['Diwali Launch', 'Diwali Launch']);
    expect(a.channel_metrics).toBeUndefined();
    expect((await ws.get('/api/v1/dashboard/attribution?includeTest=true')).body.data.total_leads).toBe(4);
  });

  it('a lead with no recorded source is reported as untracked, never as a channel', async () => {
    const lead = await newLead(ws, { source: 'other' });
    const a = (await ws.get('/api/v1/dashboard/attribution')).body.data;
    expect(a.untracked_leads).toBe(1);
    expect(a.total_attributed).toBe(3);
    await ws.delete(`/api/v1/leads/${lead.id}`);
  });
});

describe('dashboard permissions and scope', () => {
  it('a salesperson sees only their own leads; a manager sees all', async () => {
    const mine = await newLead(agent);
    await newLead(agent2);
    const a = (await agent.get('/api/v1/dashboard/metrics')).body.data.leads.total;
    const own = (await agent.get('/api/v1/leads?limit=100')).body.data.length;
    expect(a).toBe(own);
    expect(a).toBeGreaterThanOrEqual(1);
    const m = (await manager.get('/api/v1/dashboard/metrics')).body.data.leads.total;
    expect(m).toBeGreaterThan(a);
    expect(mine.id).toBeTruthy();
  });

  it('auditor has no dashboard; salesperson has no attribution; marketing sees attribution', async () => {
    expect((await auditor.get('/api/v1/dashboard/metrics')).status).toBe(403);
    expect((await agent.get('/api/v1/dashboard/attribution')).status).toBe(403);
    expect((await marketing.get('/api/v1/dashboard/attribution')).status).toBe(200);
  });

  it('another workspace sees none of this workspace’s numbers', async () => {
    const o = (await other.get('/api/v1/dashboard/metrics')).body.data;
    expect(o.leads.total).toBe(0);
    expect(o.properties.total).toBe(0);
  });

  it('requires a session', async () => {
    expect((await request(h.app).get('/api/v1/dashboard/metrics')).status).toBe(401);
  });
});

describe('property matching', () => {
  it('ranks available units with reasons, and ignores archived, sold and inactive ones', async () => {
    const fit = await newProperty(owner, { title: 'Perfect fit', price: 5_000_000, bedrooms: 3, propertyType: 'apartment' });
    const sold = await newProperty(owner, { title: 'Sold one', price: 5_000_000, bedrooms: 3 });
    const gone = await newProperty(owner, { title: 'Archived one', price: 5_000_000, bedrooms: 3 });
    expect((await owner.post(`/api/v1/properties/${sold.id}/status`, { status: 'sold' })).status).toBe(200);
    expect((await owner.delete(`/api/v1/properties/${gone.id}`)).status).toBe(204);
    const res = await owner.post('/api/v1/matching/properties', { budgetMin: 4_000_000, budgetMax: 6_000_000, location: 'Whitefield', bedrooms: 3, propertyType: 'apartment' });
    expect(res.status).toBe(200);
    const titles = res.body.data.matches.map((m: any) => m.property.title);
    expect(titles).toContain('Perfect fit');
    expect(titles).not.toContain('Sold one');
    expect(titles).not.toContain('Archived one');
    const top = res.body.data.matches.find((m: any) => m.property.id === fit.id);
    expect(top.score).toBe(100);
    expect(top.matchReasons.length).toBeGreaterThanOrEqual(4);
  });

  it('never returns another workspace’s inventory, and validates its input', async () => {
    await newProperty(other, { title: 'Foreign unit' });
    const res = await owner.post('/api/v1/matching/properties', {});
    expect(res.body.data.matches.map((m: any) => m.property.title)).not.toContain('Foreign unit');
    expect((await owner.post('/api/v1/matching/properties', { bedrooms: -1 })).status).toBe(400);
    expect((await owner.post('/api/v1/matching/properties', { propertyType: 'castle' })).status).toBe(400);
  });

  it('auditors may not use matching', async () => {
    expect((await auditor.post('/api/v1/matching/properties', {})).status).toBe(403);
  });
});

describe('workspace settings', () => {
  it('reads typed settings and exposes a version', async () => {
    const res = await owner.get('/api/v1/workspace');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Slice Zero Co', leadAssignment: expect.any(String), firstResponseMinutes: expect.any(Number) });
    expect(res.headers.etag).toBeTruthy();
  });

  it('saving the name keeps every other stored setting (the old page wiped them)', async () => {
    await h.admin.query(
      `UPDATE tenants SET settings = settings || '{"leadAssignment":"balanced","sla":{"firstResponseMinutes":45},"defaultCountry":"IN","scoring":{"weights":{"budget":3}},"custom":{"keep":"me"}}'::jsonb WHERE id = $1`,
      [owner.tenantId]
    );
    const res = await owner.patch('/api/v1/workspace', { name: 'Slice Zero Realty' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Slice Zero Realty');
    expect(res.body.data.leadAssignment).toBe('balanced');
    expect(res.body.data.firstResponseMinutes).toBe(45);
    const raw = (await h.admin.query(`SELECT settings FROM tenants WHERE id = $1`, [owner.tenantId])).rows[0].settings;
    expect(raw.scoring).toEqual({ weights: { budget: 3 } });
    expect(raw.custom).toEqual({ keep: 'me' });
    expect(raw.defaultCountry).toBe('IN');
  });

  it('the time zone is validated and stored where reminders read it', async () => {
    expect((await owner.patch('/api/v1/workspace', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await owner.patch('/api/v1/workspace', { timezone: 'not a zone' })).status).toBe(400);
    const ok = await owner.patch('/api/v1/workspace', { timezone: 'Asia/Dubai' });
    expect(ok.status).toBe(200);
    const row = (await h.admin.query(`SELECT timezone, settings FROM tenants WHERE id = $1`, [owner.tenantId])).rows[0];
    expect(row.timezone).toBe('Asia/Dubai');
    expect(row.settings.timezone).toBeUndefined();
  });

  it('rejects unknown keys, bad values and empty names instead of storing them', async () => {
    for (const body of [{ evil: 1 }, { settings: { x: 1 } }, { name: '   ' }, { currency: 'RUPEES' }, { firstResponseMinutes: -5 }, { leadAssignment: 'random' }, { primaryColor: 'red' }]) {
      const r = await owner.patch('/api/v1/workspace', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses to overwrite a newer change (If-Match → 412)', async () => {
    const cur = await owner.get('/api/v1/workspace');
    const tag = cur.headers.etag;
    expect((await owner.patch('/api/v1/workspace', { currency: 'USD' }, { 'If-Match': tag })).status).toBe(200);
    const stale = await owner.patch('/api/v1/workspace', { currency: 'EUR' }, { 'If-Match': tag });
    expect(stale.status).toBe(412);
    expect((await owner.get('/api/v1/workspace')).body.data.currency.toUpperCase()).toBe('USD');
  });

  it('only admins may change it; others may read it; other workspaces are untouched', async () => {
    expect((await agent.patch('/api/v1/workspace', { name: 'Hacked' })).status).toBe(403);
    expect((await manager.patch('/api/v1/workspace', { name: 'Hacked' })).status).toBe(403);
    expect((await auditor.get('/api/v1/workspace')).status).toBe(200);
    expect((await other.get('/api/v1/workspace')).body.data.name).toBe('Other Slice Co');
    expect((await request(h.app).patch('/api/v1/workspace').send({ name: 'x' })).status).toBeGreaterThanOrEqual(401);
  });

  it('records who changed which fields, without values that could be secret', async () => {
    await owner.patch('/api/v1/workspace', { firstResponseMinutes: 15 });
    const rows = (await h.admin.query(`SELECT action, after_state AS details FROM audit_logs WHERE tenant_id = $1 AND action = 'workspace.update' ORDER BY created_at DESC LIMIT 1`, [owner.tenantId])).rows;
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0].details)).toContain('firstResponseMinutes');
  });
});

describe('viewings', () => {
  let lead: any;
  let unit: any;
  beforeAll(async () => {
    lead = await newLead(owner, { source: 'website', ownerId: owner.userId }); // explicit owner: the workspace assignment mode must not hand it to someone else
    unit = await newProperty(owner, { title: 'Viewing unit' });
  });

  it('books a viewing and does not rewrite the lead status', async () => {
    const before = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data;
    const at = when();
    const res = await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: at, durationMinutes: 30, notes: 'Bring brochure' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ leadId: lead.id, propertyId: unit.id, status: 'scheduled' });
    expect(res.body.data.property.title).toBe('Viewing unit');
    const after = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data;
    expect(after.status).toBe(before.status);
    expect(after.stageId).toBe(before.stageId);
  });

  it('rejects overlapping bookings of the same unit, allows adjacent ones', async () => {
    const t0 = Date.UTC(2032, 5, 1, 10, 0);
    const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
    expect((await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: iso(0), durationMinutes: 30 })).status).toBe(201);
    const clash = await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: iso(15), durationMinutes: 30 });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
    expect((await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: iso(30), durationMinutes: 30 })).status).toBe(201);
  });

  it('six simultaneous requests for one slot: exactly one wins', async () => {
    const at = new Date(Date.UTC(2033, 2, 3, 12, 0)).toISOString();
    const attempts = await Promise.all(Array.from({ length: 6 }, () => owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: at, durationMinutes: 30 })));
    const codes = attempts.map((a) => a.status).sort();
    expect(codes.filter((c) => c === 201).length).toBe(1);
    expect(codes.filter((c) => c === 409).length).toBe(5);
  });

  it('allows available and under-offer units; refuses reserved, sold, rented, inactive and archived ones', async () => {
    const book = (p: any) => owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: p.id, scheduledAt: when(), durationMinutes: 30 });
    const p = await newProperty(owner, { title: 'Status unit' });
    expect((await owner.post(`/api/v1/properties/${p.id}/status`, { status: 'under_offer' })).status).toBe(200);
    expect((await book(p)).status).toBe(201);
    for (const s of ['reserved', 'sold', 'rented', 'inactive'] as const) {
      const q = await newProperty(owner, { title: `Unit ${s}`, listingType: s === 'rented' ? 'rent' : 'sale' });
      const moved = await owner.post(`/api/v1/properties/${q.id}/status`, { status: s });
      expect(moved.status, s).toBe(200);
      const res = await book(q);
      expect(res.status, s).toBe(422);
      expect(res.body.detail, s).toContain(s.replace('_', ' '));
    }
    const arch = await newProperty(owner, { title: 'Archived unit' });
    await owner.delete(`/api/v1/properties/${arch.id}`);
    expect((await book(arch)).status).toBe(404);
  });

  it('refuses archived leads and leads or properties from another workspace', async () => {
    const gone = await newLead(owner, { ownerId: owner.userId });
    await owner.delete(`/api/v1/leads/${gone.id}`);
    expect((await owner.post('/api/v1/viewings', { leadId: gone.id, propertyId: unit.id, scheduledAt: when() })).status).toBe(404);
    const foreignLead = await newLead(other);
    const foreignUnit = await newProperty(other, { title: 'Foreign' });
    expect((await owner.post('/api/v1/viewings', { leadId: foreignLead.id, propertyId: unit.id, scheduledAt: when() })).status).toBe(404);
    expect((await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: foreignUnit.id, scheduledAt: when() })).status).toBeGreaterThanOrEqual(400);
  });

  it('validates the input', async () => {
    const bad = [{ durationMinutes: 1 }, { durationMinutes: 9999 }, { scheduledAt: 'tomorrow' }, { leadId: 'nope' }];
    for (const b of bad) {
      const r = await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: when(), ...b });
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
  });

  it('role rules: auditors cannot book; a salesperson books only their own leads and only for themselves', async () => {
    expect((await auditor.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: when() })).status).toBe(403);
    // lead belongs to the owner, so a salesperson may not book it
    expect((await agent.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: when() })).status).toBe(404);
    const mine = await newLead(agent);
    const ok = await agent.post('/api/v1/viewings', { leadId: mine.id, propertyId: unit.id, scheduledAt: when() });
    expect(ok.status).toBe(201);
    expect(ok.body.data.agent.id).toBe(agent.userId);
    const other2 = await agent.post('/api/v1/viewings', { leadId: mine.id, propertyId: unit.id, scheduledAt: when(), agentId: agent2.userId });
    expect(other2.status).toBe(403);
    const byManager = await manager.post('/api/v1/viewings', { leadId: mine.id, propertyId: unit.id, scheduledAt: when(), agentId: agent2.userId });
    expect(byManager.status).toBe(201);
    expect(byManager.body.data.agent.id).toBe(agent2.userId);
  });

  it('the agent must be an active member of this workspace', async () => {
    const outsider = other.userId;
    const r = await owner.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: when(), agentId: outsider });
    expect(r.status).toBe(400);
  });

  it('listing: a salesperson sees their own, managers see all, auditors are refused, other workspaces see none; no agent e-mail leaks', async () => {
    const asAgent = await agent.get('/api/v1/viewings?limit=200');
    expect(asAgent.status).toBe(200);
    const mineIds = new Set(asAgent.body.data.map((v: any) => v.id));
    const all = await manager.get('/api/v1/viewings?limit=200');
    expect(all.body.data.length).toBeGreaterThan(asAgent.body.data.length);
    for (const v of asAgent.body.data) expect(all.body.data.some((x: any) => x.id === v.id)).toBe(true);
    expect(mineIds.size).toBe(asAgent.body.data.length);
    expect((await auditor.get('/api/v1/viewings?limit=200')).status).toBe(403); // buyers’ contact details are not part of an audit view
    expect((await other.get('/api/v1/viewings?limit=200')).body.data).toEqual([]);
    expect(JSON.stringify(all.body)).not.toMatch(/@anibros\.test/);
    // time ordering and paging
    const page1 = await owner.get('/api/v1/viewings?limit=2');
    expect(page1.body.page.hasMore).toBe(true);
    const page2 = await owner.get(`/api/v1/viewings?limit=2&cursor=${encodeURIComponent(page1.body.page.next)}`);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    const times = all.body.data.map((v: any) => v.scheduledAt);
    expect([...times].sort()).toEqual(times);
  });

  it('booking is recorded in the audit trail', async () => {
    const rows = (await h.admin.query(`SELECT count(*)::int AS c FROM audit_logs WHERE tenant_id = $1 AND action = 'viewing.schedule'`, [owner.tenantId])).rows[0];
    expect(rows.c).toBeGreaterThan(0);
  });
});

describe('lead status cannot disagree with its stage', () => {
  it('the database refuses a status change that contradicts the stage', async () => {
    const l = await newLead(owner);
    await expect(h.admin.query(`UPDATE leads SET status = 'won' WHERE id = $1`, [l.id])).rejects.toThrow(/INVALID_ARGUMENT/);
    await move(owner, l.id, 'won');
    expect((await owner.get(`/api/v1/leads/${l.id}`)).body.data.status).toBe('won');
  });
});

describe('custom field values cannot point at another workspace’s definition', () => {
  it('the database refuses it', async () => {
    const mk = async (tenantId: string) => {
      const r = await h.admin.query(
        `INSERT INTO custom_field_definitions (tenant_id, entity_type, name, label, field_key, field_type) VALUES ($1,'lead',$2,$2,$2,'text') RETURNING id`,
        [tenantId, `k${uniq()}`]
      );
      return r.rows[0].id as string;
    };
    const foreignDef = await mk(other.tenantId);
    const l = await newLead(owner);
    await expect(
      h.admin.query(`INSERT INTO custom_field_values (tenant_id, field_id, entity_type, entity_id, value) VALUES ($1,$2,'lead',$3,'x')`, [owner.tenantId, foreignDef, l.id])
    ).rejects.toThrow();
  });
});
