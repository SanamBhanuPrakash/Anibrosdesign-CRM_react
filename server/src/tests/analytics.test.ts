import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Attribution, spend and reports. The rules under test: every figure equals the rows behind it; funnel steps are nested; first touch can
 * never change; revenue is recorded sales only; rates are null (never NaN) when there is nothing to divide by; spend is pro-rated and never
 * double-counted; roles and workspaces are isolated. Restricted database role throughout.
 */
let h: ApiHarness;
let ws: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let marketing: AuthedUser;
let auditor: AuthedUser;
let stages: Record<string, string> = {};
const ids: Record<string, string> = {};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const inWs = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};
const lead = async (u: AuthedUser, extra: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Iyer', email: `b${uniq()}@x.test` }, ownerId: null, ...extra });
  if (r.status !== 201) throw new Error(`lead ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
const unit = async (u: AuthedUser) => (await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 6_000_000 })).body.data as any;
const report = async (u: AuthedUser, qs = '') => {
  const r = await u.get(`/api/v1/attribution${qs}`);
  if (r.status !== 200) throw new Error(`attribution -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const all = async (u: AuthedUser, path: string) => {
  const rows: any[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let i = 0; i < 30; i++) {
    const r = await u.get(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    rows.push(...r.body.data);
    total = Number(r.headers['x-total-count']);
    if (!r.body.page?.hasMore) break;
    cursor = r.body.page.next;
  }
  return { rows, total };
};
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const row = (rows: any[], source: string) => rows.find((r: any) => r.source === source);

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  ws = await h.register({ emailPrefix: 'anown', organisationName: 'Analytics Co' });
  other = await h.register({ emailPrefix: 'anoth', organisationName: 'Other Analytics Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', marketing: 'marketing_manager', auditor: 'auditor' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `an${k}` });
    await addMember(u, ws.tenantId, role);
    made[k] = inWs(u, ws.tenantId);
  }
  ({ manager, agent, marketing, auditor } = made as Record<keyof typeof roles, AuthedUser>);
  stages = Object.fromEntries((await ws.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));

  ids.m1 = (await lead(ws, { source: 'meta_ads', campaign: 'Diwali Launch', ownerId: manager.userId, estimatedValue: 9_999_999 })).id;
  ids.m2 = (await lead(ws, { source: 'meta_ads', campaign: 'Diwali Launch', ownerId: agent.userId })).id;
  ids.m3 = (await lead(ws, { source: 'meta_ads', campaign: 'Brand', ownerId: agent.userId })).id;
  ids.g1 = (await lead(ws, { source: 'google_ads', campaign: 'Search A', ownerId: manager.userId })).id;
  ids.w1 = (await lead(ws, { source: 'website' })).id;
  ids.r1 = (await lead(ws, { source: 'referral', ownerId: manager.userId })).id;
  ids.test = (await lead(ws, { source: 'website', tags: ['test'] })).id;
  ids.archived = (await lead(ws, { source: 'portal' })).id;
  ids.old = (await lead(ws, { source: 'meta_ads', campaign: 'Diwali Launch' })).id;
  await ws.delete(`/api/v1/leads/${ids.archived}`);
  await h.admin.query(`UPDATE leads SET created_at = $2 WHERE id = $1`, [ids.old, ago(40)]);
  await ws.post(`/api/v1/leads/${ids.m2}/stage`, { stageId: stages.qualified });
  // g1: a completed visit
  const vUnit = await unit(ws);
  await h.admin.query(`INSERT INTO viewings (tenant_id, lead_id, property_id, scheduled_at, duration_minutes, status) VALUES ($1,$2,$3,$4,30,'completed')`, [ws.tenantId, ids.g1, vUnit.id, ago(2)]);
  // r1: booked (reserved) but not sold
  const o1 = (await ws.post('/api/v1/reservations', { leadId: ids.r1, propertyId: (await unit(ws)).id })).body.data.reservation;
  await ws.post(`/api/v1/reservations/${o1.id}/reserve`, { tokenAmount: 1, agreedPrice: 6_000_000 });
  // m1: a recorded sale of 5,000,000
  const o2 = (await ws.post('/api/v1/reservations', { leadId: ids.m1, propertyId: (await unit(ws)).id })).body.data.reservation;
  await ws.post(`/api/v1/reservations/${o2.id}/reserve`, { tokenAmount: 1, agreedPrice: 5_000_000 });
  expect((await ws.post(`/api/v1/reservations/${o2.id}/complete`, { dealValue: 5_000_000 })).status).toBe(200);
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('attribution: every number equals the rows behind it', () => {
  it('sources add up to the total, each source equals its drill-down list, and archived, test and out-of-range leads are left out', async () => {
    const o = await report(ws);
    expect(o.totals.leads).toBe(6);
    expect(o.sources.reduce((a: number, s: any) => a + s.leads, 0)).toBe(o.totals.leads);
    expect(row(o.sources, 'meta_ads')).toMatchObject({ leads: 3, qualified: 2, visits: 1, booked: 1, won: 1, revenue: 5_000_000, label: 'Meta ads' });
    expect(row(o.sources, 'google_ads')).toMatchObject({ leads: 1, qualified: 1, visits: 1, booked: 0, won: 0 });
    expect(row(o.sources, 'website')).toMatchObject({ leads: 1, qualified: 0, visits: 0, booked: 0, won: 0 });
    expect(row(o.sources, 'referral')).toMatchObject({ leads: 1, qualified: 1, visits: 1, booked: 1, won: 0 });
    expect(row(o.sources, 'portal')).toBeUndefined(); // the archived lead
    for (const s of o.sources) {
      for (const metric of ['leads', 'qualified', 'visits', 'booked', 'won'] as const) {
        const d = await all(ws, `/api/v1/attribution/leads?metric=${metric}&source=${s.source}`);
        expect(d.total, `${s.source} ${metric}`).toBe(s[metric === 'leads' ? 'leads' : metric]);
        expect(d.rows.length).toBe(d.total);
      }
    }
    const withTest = await report(ws, '?includeTest=true');
    expect(withTest.totals.leads).toBe(7);
    expect(row(withTest.sources, 'website').leads).toBe(2);
  });

  it('funnel steps are nested: won ⊆ booked ⊆ visit ⊆ qualified ⊆ leads, in total and per source', async () => {
    const o = await report(ws);
    const nested = (r: any) => r.won <= r.booked && r.booked <= r.visits && r.visits <= r.qualified && r.qualified <= r.leads;
    expect(nested(o.totals)).toBe(true);
    for (const s of o.sources) expect(nested(s), s.source).toBe(true);
    expect(o.totals).toMatchObject({ leads: 6, qualified: 4, visits: 3, booked: 2, won: 1, revenue: 5_000_000 });
  });

  it('campaigns are only the ones that were recorded, with their own counts', async () => {
    const o = await report(ws);
    expect(o.campaigns.map((c: any) => `${c.campaign}|${c.source}|${c.leads}`).sort()).toEqual(['Brand|meta_ads|1', 'Diwali Launch|meta_ads|2', 'Search A|google_ads|1']);
    const d = await all(ws, '/api/v1/attribution/leads?metric=leads&source=meta_ads&campaign=diwali%20launch');
    expect(d.total).toBe(2); // names compare without regard to case
    const none = await all(ws, '/api/v1/attribution/leads?metric=leads&noCampaign=true');
    expect(none.total).toBe(2); // the website and referral leads carry no campaign
  });

  it('revenue is the recorded sale, never the estimate typed on the lead', async () => {
    const o = await report(ws);
    expect(o.totals.revenue).toBe(5_000_000);
    expect(o.totals.revenue).not.toBe(9_999_999);
    expect(o.totals.wonWithoutDealValue).toBe(0);
  });

  it('tracking health says how many leads carry a recorded source', async () => {
    const o = await report(ws);
    expect(o.tracking).toMatchObject({ untracked: 0, withCampaign: 4 });
    expect(o.tracking.sharePercent).toBe(1);
    const un = await lead(ws, { source: 'other' });
    const o2 = await report(ws);
    expect(o2.tracking.untracked).toBe(1);
    expect(o2.tracking.sharePercent).toBeCloseTo(6 / 7, 3);
    expect(row(o2.sources, 'other').label).toBe('Not recorded');
    await ws.delete(`/api/v1/leads/${un.id}`);
  });
});

describe('first touch is a fact about the past', () => {
  it('editing the lead later does not change who is credited, and a later touch only matters for the last-touch view', async () => {
    const l = await lead(ws, { source: 'meta_ads', campaign: 'Summer Sale' });
    expect((await ws.patch(`/api/v1/leads/${l.id}`, { source: 'website', campaign: 'Rewritten' }, { 'If-Match': `"${l.version}"` })).status).toBe(200);
    const first = await report(ws);
    expect(first.campaigns.find((c: any) => c.campaign === 'Summer Sale')).toMatchObject({ source: 'meta_ads', leads: 1 });
    expect(first.campaigns.find((c: any) => c.campaign === 'Rewritten')).toBeUndefined();
    // the buyer comes back through Google: a later touch on the same lead
    await h.admin.query(`INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, source, campaign) VALUES ($1,$2,'later_touch','google_ads','Retarget')`, [ws.tenantId, l.id]);
    const lastTouch = await report(ws, '?model=last');
    expect(lastTouch.campaigns.find((c: any) => c.campaign === 'Retarget')).toMatchObject({ source: 'google_ads', leads: 1 });
    expect(lastTouch.totals.leads).toBe(first.totals.leads); // the same leads, credited differently
    const still = await report(ws);
    expect(still.campaigns.find((c: any) => c.campaign === 'Summer Sale')?.leads).toBe(1);
    await ws.delete(`/api/v1/leads/${l.id}`);
  });

  it('the database refuses to edit a first touch, and the application role can neither edit nor delete any touch', async () => {
    const r = (await h.admin.query(`SELECT id FROM marketing_attribution WHERE lead_id = $1 AND touch_type = 'first_touch'`, [ids.m1])).rows;
    expect(r).toHaveLength(1);
    await expect(h.admin.query(`UPDATE marketing_attribution SET source = 'portal' WHERE id = $1`, [r[0].id])).rejects.toThrow(/first touch of a lead cannot be changed/);
    await expect(h.admin.query(`INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, source) VALUES ($1,$2,'first_touch','portal')`, [ws.tenantId, ids.m1])).rejects.toThrow(/uq_attribution_first_touch/);
    const grants = (await h.admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'marketing_attribution' AND grantee = 'crm_app_user' ORDER BY 1`)).rows.map((x: any) => x.privilege_type);
    expect(grants).toEqual(['INSERT', 'SELECT']);
  });

  it('every lead created through the app has exactly one first touch, with the source and campaign it was created with', async () => {
    const r = (await h.admin.query(`SELECT source, campaign, backfilled, is_direct FROM marketing_attribution WHERE lead_id = $1 AND touch_type = 'first_touch'`, [ids.m3])).rows;
    expect(r).toEqual([{ source: 'meta_ads', campaign: 'Brand', backfilled: false, is_direct: false }]);
    expect((await h.admin.query(`SELECT count(*)::int AS c FROM leads l WHERE l.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM marketing_attribution a WHERE a.lead_id = l.id AND a.touch_type = 'first_touch')`, [ws.tenantId])).rows[0].c).toBe(0);
  });
});

describe('zero denominators and ranges', () => {
  it('an empty range has zeros, null rates and no money panel, and never NaN or Infinity', async () => {
    const o = await report(ws, '?from=2001-01-01&to=2001-01-31');
    expect(o.totals).toMatchObject({ leads: 0, qualified: 0, won: 0, revenue: 0 });
    expect(o.sources).toEqual([]);
    expect(o.money).toBeNull();
    expect(o.tracking.sharePercent).toBeNull();
    expect(JSON.stringify(o)).not.toMatch(/NaN|Infinity/);
  });

  it('validates the range and caps it at a year', async () => {
    expect((await ws.get('/api/v1/attribution?from=2026-02-30')).status).toBe(400);
    expect((await ws.get('/api/v1/attribution?from=2026-03-10&to=2026-03-01')).status).toBe(400);
    expect((await ws.get('/api/v1/attribution?from=2024-01-01&to=2026-03-01')).status).toBe(400);
    expect((await ws.get('/api/v1/attribution?model=middle')).status).toBe(400);
  });
});

describe('spend', () => {
  let from: string;
  let to: string;
  beforeAll(async () => {
    const o = await report(ws);
    from = o.range.from;
    to = o.range.to;
  });

  it('with no spend there is no money panel; with spend it is pro-rated over the days of the range and every formula matches a hand calculation', async () => {
    expect((await report(ws)).money).toBeNull();
    // 3000 over 30 days that start 10 days before the range: the first 20 days of the range are covered → 2000
    const s = await ws.post('/api/v1/spend', { source: 'meta_ads', periodStart: addDays(from, -10), periodEnd: addDays(from, 19), amount: 3000, note: 'Diwali burst' });
    expect(s.status).toBe(201);
    expect(s.body.data).toMatchObject({ source: 'meta_ads', amount: 3000, currency: 'INR', sourceLabel: 'Meta ads' });
    const o = await report(ws);
    const meta = row(o.sources, 'meta_ads');
    expect(meta.spend.spend).toBe(2000);
    expect(meta.spend.costPerLead).toBeCloseTo(2000 / 3, 2);
    expect(meta.spend.costPerQualified).toBe(1000);
    expect(meta.spend.costPerVisit).toBe(2000);
    expect(meta.spend.costPerBooking).toBe(2000);
    expect(meta.spend.costPerSale).toBe(2000);
    expect(meta.spend.roi).toBeCloseTo((5_000_000 - 2000) / 2000, 3);
    expect(row(o.sources, 'google_ads').spend).toBeNull(); // no spend entered for it: no cost figures, not zero
    expect(o.money.spend).toBe(2000);
    expect(o.channels.find((c: any) => c.channel === 'paid_social').spend.spend).toBe(2000);
  });

  it('a campaign-level entry shows on that campaign and counts in its source once', async () => {
    const s = await ws.post('/api/v1/spend', { source: 'google_ads', campaign: 'Search A', periodStart: from, periodEnd: to, amount: 600 });
    expect(s.status).toBe(201);
    const o = await report(ws);
    expect(o.campaigns.find((c: any) => c.campaign === 'Search A').spend.spend).toBe(600);
    expect(row(o.sources, 'google_ads').spend.spend).toBe(600);
    expect(o.money.spend).toBe(2600);
  });

  it('refuses entries that overlap or repeat one for the same source, campaign and days, but not for another campaign', async () => {
    const dup = await ws.post('/api/v1/spend', { source: 'meta_ads', periodStart: addDays(from, 5), periodEnd: addDays(from, 12), amount: 10 });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe('spend_overlaps');
    expect((await ws.post('/api/v1/spend', { source: 'meta_ads', campaign: 'Brand', periodStart: addDays(from, 5), periodEnd: addDays(from, 12), amount: 10 })).status).toBe(201);
    expect((await ws.post('/api/v1/spend', { source: 'google_ads', campaign: 'SEARCH a', periodStart: from, periodEnd: to, amount: 5 })).status).toBe(409); // case-insensitive
    expect((await ws.post('/api/v1/spend', { source: 'website', periodStart: to, periodEnd: from, amount: 5 })).status).toBe(400);
    expect((await ws.post('/api/v1/spend', { source: 'website', periodStart: addDays(from, -400), periodEnd: to, amount: 5 })).status).toBe(400);
    expect((await ws.post('/api/v1/spend', { source: 'website', periodStart: from, periodEnd: to, amount: -1 })).status).toBe(400);
  });

  it('two simultaneous overlapping entries: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ws.post('/api/v1/spend', { source: 'portal', periodStart: from, periodEnd: addDays(from, 6), amount: 100 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('can be corrected (with a version check) and deleted, and both are audited', async () => {
    const created = (await ws.post('/api/v1/spend', { source: 'walk_in', periodStart: from, periodEnd: addDays(from, 3), amount: 400 })).body.data;
    const stale = await ws.patch(`/api/v1/spend/${created.id}`, { amount: 450 }, { 'If-Match': `"${created.version + 5}"` });
    expect(stale.status).toBe(412);
    const ok = await ws.patch(`/api/v1/spend/${created.id}`, { amount: 450 }, { 'If-Match': `"${created.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.data.amount).toBe(450);
    expect((await ws.delete(`/api/v1/spend/${created.id}`)).status).toBe(204);
    expect((await ws.delete(`/api/v1/spend/${created.id}`)).status).toBe(404);
    const acts = (await h.admin.query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`, [created.id])).rows.map((r: any) => r.action);
    expect(acts).toEqual(['spend.create', 'spend.update', 'spend.delete']);
  });

  it('CSV import: preview, import, and importing the same file again changes nothing', async () => {
    const csv = `source,campaign,from,to,amount,note\nGoogle Ads,Generic Search,${addDays(from, 0)},${addDays(from, 6)},"₹1,200",first week\nFacebook,,${addDays(from, 20)},${addDays(from, 25)},800.50,\n`;
    const dry = await ws.post('/api/v1/spend/import', { csv, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, created: 2, skipped: 0 });
    expect((await ws.get('/api/v1/spend')).body.data.filter((s: any) => s.campaign === 'Generic Search')).toHaveLength(0); // a preview saves nothing
    const real = await ws.post('/api/v1/spend/import', { csv });
    expect(real.body.data).toMatchObject({ created: 2, skipped: 0 });
    const again = await ws.post('/api/v1/spend/import', { csv });
    expect(again.body.data).toMatchObject({ created: 0, skipped: 2 });
    const saved = (await ws.get('/api/v1/spend')).body.data;
    expect(saved.filter((s: any) => s.campaign === 'Generic Search')).toHaveLength(1);
    expect(saved.find((s: any) => s.campaign === 'Generic Search').amount).toBe(1200);
  });

  it('CSV import is all or nothing: one bad row saves nothing and the response names the rows', async () => {
    const before = (await ws.get('/api/v1/spend')).body.data.length;
    const bad = `source,campaign,from,to,amount\nGoogle Ads,Good Row,${addDays(from, 7)},${addDays(from, 8)},100\nNowhere Ads,Bad Source,${addDays(from, 7)},${addDays(from, 8)},100\nMeta,Bad Amount,${addDays(from, 9)},${addDays(from, 10)},lots\n`;
    const r = await ws.post('/api/v1/spend/import', { csv: bad });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.errors)).toMatch(/row 3/);
    expect(JSON.stringify(r.body.errors)).toMatch(/row 4/);
    expect((await ws.get('/api/v1/spend')).body.data.length).toBe(before);
    expect((await ws.post('/api/v1/spend/import', { csv: 'campaign,amount\nx,1\n' })).status).toBe(400); // missing columns
    const overlap = await ws.post('/api/v1/spend/import', { csv: `source,from,to,amount\nMeta,${addDays(from, 1)},${addDays(from, 2)},5\n` });
    expect(overlap.status).toBe(409);
  });

  it('roles: marketing and admins manage spend; sales roles and auditors cannot; reading needs attribution access; another workspace sees nothing', async () => {
    const body = { source: 'referral', periodStart: from, periodEnd: addDays(from, 2), amount: 50 };
    expect((await agent.post('/api/v1/spend', body)).status).toBe(403);
    expect((await manager.post('/api/v1/spend', body)).status).toBe(403);
    expect((await auditor.post('/api/v1/spend', body)).status).toBe(403);
    expect((await agent.get('/api/v1/spend')).status).toBe(403);
    expect((await auditor.get('/api/v1/attribution')).status).toBe(403);
    expect((await manager.get('/api/v1/spend')).status).toBe(200);
    expect((await marketing.post('/api/v1/spend', body)).status).toBe(201);
    expect((await other.get('/api/v1/spend')).body.data).toEqual([]);
    expect((await report(other)).totals.leads).toBe(0);
    expect((await report(other)).money).toBeNull();
  });
});

describe('channels', () => {
  it('start from visible defaults, can be re-grouped by an admin or marketing, and the default removes the override', async () => {
    const t = (await ws.get('/api/v1/attribution/channels')).body.data;
    expect(t.find((c: any) => c.source === 'meta_ads')).toMatchObject({ channel: 'paid_social', isDefault: true });
    expect(t.find((c: any) => c.source === 'other')).toMatchObject({ channel: 'untracked', label: 'Not recorded' });
    expect((await agent.put('/api/v1/attribution/channels/website', { channel: 'referral' })).status).toBe(403);
    const r = await marketing.put('/api/v1/attribution/channels/website', { channel: 'referral' });
    expect(r.status).toBe(200);
    expect(r.body.data.find((c: any) => c.source === 'website')).toMatchObject({ channel: 'referral', isDefault: false });
    const o = await report(ws);
    expect(row(o.sources, 'website').channel).toBe('referral');
    expect(o.channels.find((c: any) => c.channel === 'referral').leads).toBe(row(o.sources, 'website').leads + row(o.sources, 'referral').leads);
    expect((await ws.put('/api/v1/attribution/channels/website', { channel: 'website' })).body.data.find((c: any) => c.source === 'website').isDefault).toBe(true);
    expect((await ws.put('/api/v1/attribution/channels/website', { channel: 'nonsense' })).status).toBe(400);
    expect((await other.get('/api/v1/attribution/channels')).body.data.find((c: any) => c.source === 'website').channel).toBe('website'); // another workspace is unaffected
  });
});

describe('reports', () => {
  const overview = async (u: AuthedUser, qs = '') => {
    const r = await u.get(`/api/v1/reports/overview${qs}`);
    if (r.status !== 200) throw new Error(`reports -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };

  it('the funnel equals the attribution totals and its drill-down lists; conversion rates are null when the previous step is empty', async () => {
    const o = await overview(ws);
    const a = await report(ws);
    expect(o.funnel.steps.map((s: any) => s.count)).toEqual([a.totals.leads, a.totals.qualified, a.totals.visits, a.totals.booked, a.totals.won]);
    for (const s of o.funnel.steps) {
      const d = await all(ws, `/api/v1/reports/leads?metric=${s.key}`);
      expect(d.total, s.key).toBe(s.count);
      expect(d.rows).toHaveLength(s.count);
    }
    expect(o.funnel.steps[1].ofPrevious).toBeCloseTo(4 / 6, 3);
    expect(o.funnel.revenue).toBe(5_000_000);
    expect(o.funnel.sales).toBe(1);
    expect(o.funnel.averageDealValue).toBe(5_000_000);
    const empty = await overview(ws, '?from=2001-01-01&to=2001-01-31');
    expect(empty.funnel.steps.every((s: any) => s.count === 0 && s.ofPrevious === null)).toBe(true);
    expect(empty.conversion.winRate).toBeNull();
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
  });

  it('conversion: win rate, why leads were lost and not a fit', async () => {
    const l = await lead(ws, { source: 'website' });
    expect((await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.lost, reasonCode: 'price_too_high' })).status).toBe(200);
    const nf = await lead(ws, { source: 'website' });
    expect((await ws.post(`/api/v1/leads/${nf.id}/stage`, { stageId: stages.not_a_fit, reasonCode: 'spam' })).status).toBe(200);
    const o = await overview(ws);
    expect(o.conversion).toMatchObject({ won: 1, lost: 1, notAFit: 1 });
    expect(o.conversion.winRate).toBeCloseTo(1 / 8, 3);
    expect(o.conversion.lostReasons).toEqual([{ code: 'price_too_high', label: 'Price too high', count: 1 }]);
    expect(o.conversion.notAFitReasons[0]).toMatchObject({ code: 'spam', count: 1 });
    await ws.delete(`/api/v1/leads/${l.id}`);
    await ws.delete(`/api/v1/leads/${nf.id}`);
  });

  it('the pipeline: stage counts add up to the open leads, value is an estimate, time in stage comes from the history', async () => {
    const o = await overview(ws);
    const open = o.pipeline.stages.filter((s: any) => !s.isClosed);
    expect(open.reduce((a: number, s: any) => a + s.count, 0) + o.pipeline.otherPipelines.count).toBe(o.pipeline.openLeads);
    const real = (await all(ws, '/api/v1/leads?state=open&test=exclude')).rows.length;
    expect(o.pipeline.openLeads).toBe(real);
    // move a lead through two stages with known gaps, then read the time in the first
    const l = await lead(ws, { source: 'website' });
    await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.contacted });
    await h.admin.query(`UPDATE lead_stage_history SET created_at = created_at - interval '3 days' WHERE lead_id = $1 AND to_stage_id = $2`, [l.id, stages.new]);
    await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.qualified });
    const o2 = await overview(ws);
    const contacted = o2.pipeline.stages.find((s: any) => s.id === stages.contacted);
    expect(contacted.observations).toBeGreaterThanOrEqual(1);
    expect(contacted.medianDays).not.toBeNull();
    expect(o2.pipeline.openValue).toBeGreaterThanOrEqual(0);
    await ws.delete(`/api/v1/leads/${l.id}`);
  });

  it('engagement: visits from the visit records, first replies, overdue follow-ups', async () => {
    const o = await overview(ws);
    expect(o.engagement.visits).toMatchObject({ held: 1 });
    expect(o.engagement.firstReply.leads).toBeGreaterThan(0);
    expect(o.engagement.firstReply.inTimeRate === null || (o.engagement.firstReply.inTimeRate >= 0 && o.engagement.firstReply.inTimeRate <= 1)).toBe(true);
    expect(o.engagement.followUps).toMatchObject({ leadsOverdue: expect.any(Number), tasksOverdue: expect.any(Number) });
  });

  it('inventory counts add up to the total', async () => {
    const o = await overview(ws);
    expect(Object.values(o.inventory.byStatus).reduce((a: number, b) => a + (b as number), 0)).toBe(o.inventory.total);
    expect(o.inventory.byStatus.sold).toBe(1);
    expect(o.inventory.byStatus.reserved).toBe(1);
  });

  it('team (managers only): leads, funnel steps and recorded sales per owner add up to the totals', async () => {
    const o = await overview(ws);
    expect(o.team).not.toBeNull();
    expect(o.team.reduce((a: number, t: any) => a + t.leads, 0)).toBe(o.funnel.steps[0].count);
    expect(o.team.reduce((a: number, t: any) => a + t.revenue, 0)).toBe(o.funnel.revenue);
    const mgr = o.team.find((t: any) => t.userId === manager.userId);
    expect(mgr).toMatchObject({ won: 1, revenue: 5_000_000 });
    const drill = await all(ws, `/api/v1/reports/leads?metric=leads&owner=${manager.userId}`);
    expect(drill.total).toBe(mgr.leads);
    expect(o.team.some((t: any) => t.userId === null && t.name === 'Unassigned')).toBe(true);
  });

  it('roles: salespeople have no reports; marketing sees leads but no team; auditors none; another workspace sees none of this one', async () => {
    expect((await agent.get('/api/v1/reports/overview')).status).toBe(403);
    expect((await auditor.get('/api/v1/reports/overview')).status).toBe(403);
    const m = await overview(marketing);
    expect(m.team).toBeNull();
    expect(m.funnel.steps[0].count).toBe(6);
    const o = await overview(other);
    expect(o.funnel.steps[0].count).toBe(0);
    expect(o.pipeline.openLeads).toBe(0);
    expect(o.team).toEqual([]);
  });

  it('export: a CSV of the same figures; sales roles cannot export; formulas are neutralised', async () => {
    const r = await ws.get('/api/v1/reports/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toMatch(/Section,Item,Value,Note/);
    expect(r.text).toMatch(/Funnel,Leads created,6/);
    expect(r.text).toMatch(/Won deal value \(INR\),5000000/);
    expect((await agent.get('/api/v1/reports/export')).status).toBe(403);
    await h.admin.query(`UPDATE users SET name = '=HYPERLINK("http://evil")' WHERE id = $1`, [manager.userId]);
    const again = await ws.get('/api/v1/reports/export');
    expect(again.text).toMatch(/'=HYPERLINK/);
    expect(again.text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('a lead at 23:30 workspace time on the last day is inside the range, one just after midnight is not', async () => {
    const tz = (await h.admin.query(`SELECT timezone FROM tenants WHERE id = $1`, [ws.tenantId])).rows[0].timezone as string;
    const a = await lead(ws, { source: 'website' });
    const b = await lead(ws, { source: 'website' });
    await h.admin.query(`UPDATE leads SET created_at = (timestamp '2031-06-15 23:30') AT TIME ZONE $2 WHERE id = $1`, [a.id, tz]);
    await h.admin.query(`UPDATE leads SET created_at = (timestamp '2031-06-16 00:10') AT TIME ZONE $2 WHERE id = $1`, [b.id, tz]);
    expect((await overview(ws, '?from=2031-06-15&to=2031-06-15')).funnel.steps[0].count).toBe(1);
    expect((await report(ws, '?from=2031-06-15&to=2031-06-15')).totals.leads).toBe(1);
    expect((await all(ws, '/api/v1/reports/leads?metric=leads&from=2031-06-15&to=2031-06-15')).rows.map((r: any) => r.id)).toEqual([a.id]);
  });
});
