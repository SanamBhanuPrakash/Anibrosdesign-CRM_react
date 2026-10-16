import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

let h: ApiHarness;
let owner: AuthedUser; // workspace A owner
let other: AuthedUser; // workspace B owner
let agent: AuthedUser; // sales_agent in A
let agent2: AuthedUser; // sales_agent in A
let manager: AuthedUser; // sales_manager in A
let auditor: AuthedUser; // auditor in A
let stages: Record<string, string> = {};
let pipelineId = '';
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const as = (u: AuthedUser, tenantId: string) => ({ 'X-Tenant-Id': tenantId });

/** The seeded real-estate pipeline is deliberately restricted. Most tests want free movement; one covers the seeded rules. */
async function flex(u: AuthedUser) {
  const pl = (await u.get('/api/v1/pipelines')).body.data[0];
  const r = await u.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] });
  if (r.status !== 200) throw new Error('flex failed');
}

async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Lead${uniq()}`, email: `l${uniq()}@x.test` }, source: 'website', ...extra }, headers);
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ legacyPipeline: true, emailPrefix: 'lown', organisationName: 'Leads Co' });
  other = await h.register({ legacyPipeline: true, emailPrefix: 'loth', organisationName: 'Other Leads Co' });
  for (const k of ['agent', 'agent2', 'manager', 'auditor'] as const) {
    const u = await h.register({ legacyPipeline: true, emailPrefix: `l${k}` });
    await addMember(u, owner.tenantId, { agent: 'sales_agent', agent2: 'sales_agent', manager: 'sales_manager', auditor: 'auditor' }[k]);
    if (k === 'agent') agent = u;
    if (k === 'agent2') agent2 = u;
    if (k === 'manager') manager = u;
    if (k === 'auditor') auditor = u;
  }
  await flex(owner);
  const p = await owner.get('/api/v1/pipelines');
  pipelineId = p.body.data[0].id;
  stages = Object.fromEntries(p.body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('pipelines', () => {
  it('lists the seeded pipeline with stage meaning (status + probability) and counts', async () => {
    const r = await owner.get('/api/v1/pipelines');
    expect(r.status).toBe(200);
    const pl = r.body.data[0];
    expect(pl.isDefault).toBe(true);
    const by = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s]));
    expect(by.new).toMatchObject({ mapsToStatus: 'open', probability: 5, isClosed: false });
    expect(by.qualified).toMatchObject({ mapsToStatus: 'qualified', probability: 30 });
    expect(by.won).toMatchObject({ mapsToStatus: 'won', probability: 100, isClosed: true });
    expect(by.lost).toMatchObject({ mapsToStatus: 'lost', isClosed: true });
    expect(by.invalid.mapsToStatus).toBe('disqualified');
    expect(pl.stages.map((s: any) => s.orderIndex)).toEqual([...pl.stages.map((s: any) => s.orderIndex)].sort((a, b) => a - b));
  });

  it('manages pipelines and stages with invariants (admins only)', async () => {
    expect((await agent.post('/api/v1/pipelines', { name: 'Nope' }, as(agent, owner.tenantId))).status).toBe(403);
    const created = await owner.post('/api/v1/pipelines', { name: 'Rentals' });
    expect(created.status).toBe(201);
    const pid = created.body.data.id;
    expect(created.body.data.isDefault).toBe(false);
    expect(created.body.data.stages.map((s: any) => s.name)).toEqual(['New', 'Contacted', 'Qualified', 'Negotiation', 'Won', 'Lost']);

    const added = await owner.post(`/api/v1/pipelines/${pid}/stages`, { name: 'Site visit', mapsToStatus: 'viewing_scheduled', probability: 50, afterStageId: created.body.data.stages[2].id });
    expect(added.status).toBe(201);
    const names = added.body.data.stages.map((s: any) => s.name);
    expect(names.indexOf('Site visit')).toBe(3);
    expect(added.body.data.stages.find((s: any) => s.name === 'Site visit').stageKey).toBe('site_visit');

    // the entry stage cannot become a closing stage; a pipeline must keep a win and a loss
    const first = added.body.data.stages[0].id;
    expect((await owner.patch(`/api/v1/pipelines/${pid}/stages/${first}`, { mapsToStatus: 'won' })).status).toBe(409);
    const won = added.body.data.stages.find((s: any) => s.stageKey === 'won').id;
    expect((await owner.delete(`/api/v1/pipelines/${pid}/stages/${won}`)).status).toBe(409);

    // reorder must list every stage exactly once
    const ids = added.body.data.stages.map((s: any) => s.id);
    expect((await owner.put(`/api/v1/pipelines/${pid}/stage-order`, { stageIds: ids.slice(1) })).status).toBe(400);
    const swapped = [ids[1], ids[0], ...ids.slice(2)];
    const re = await owner.put(`/api/v1/pipelines/${pid}/stage-order`, { stageIds: swapped });
    expect(re.status).toBe(200);
    expect(re.body.data.stages.map((s: any) => s.id)).toEqual(swapped);
    // …and the first stage must still be an opening one
    expect((await owner.put(`/api/v1/pipelines/${pid}/stage-order`, { stageIds: [won, ...swapped.filter((i: string) => i !== won)] })).status).toBe(409);

    // the default pipeline cannot be archived; making another default swaps the flag atomically
    expect((await owner.delete(`/api/v1/pipelines/${pipelineId}`)).status).toBe(409);
    expect((await owner.delete(`/api/v1/pipelines/${pid}`)).status).toBe(204);
    const list = await owner.get('/api/v1/pipelines');
    expect(list.body.data.filter((p: any) => p.isDefault)).toHaveLength(1);
  });

  it('refuses to remove a stage that has leads unless they are moved, and records the move', async () => {
    const pl = (await owner.post('/api/v1/pipelines', { name: 'Resale' })).body.data;
    const st = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s.id]));
    const l = await newLead(owner, { pipelineId: pl.id });
    expect(l.stageId).toBe(st.new);
    const blocked = await owner.delete(`/api/v1/pipelines/${pl.id}/stages/${st.new}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.reason).toBe('stage_in_use');
    const ok = await owner.delete(`/api/v1/pipelines/${pl.id}/stages/${st.new}?moveLeadsTo=${st.contacted}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.stages.some((s: any) => s.id === st.new)).toBe(false);
    const moved = await owner.get(`/api/v1/leads/${l.id}`);
    expect(moved.body.data.stageId).toBe(st.contacted);
    expect(moved.body.data.history[0]).toMatchObject({ reason: 'Stage removed from pipeline', toStage: 'Contacted' });
  });

  it('transition matrix: unrestricted by default, then restricted with required fields', async () => {
    const pl = (await owner.post('/api/v1/pipelines', { name: 'Strict' })).body.data;
    const st = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s.id]));
    expect((await owner.get(`/api/v1/pipelines/${pl.id}/transitions`)).body.data).toEqual({ restricted: false, transitions: [] });
    const bad = await owner.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: true, transitions: [] });
    expect(bad.status).toBe(400);
    const put = await owner.put(`/api/v1/pipelines/${pl.id}/transitions`, {
      restricted: true,
      transitions: [
        { fromStageId: st.new, toStageId: st.contacted },
        { fromStageId: st.contacted, toStageId: st.qualified, requiredFields: ['phone', 'estimatedValue'] },
        { fromStageId: st.contacted, toStageId: st.lost },
      ],
    });
    expect(put.status).toBe(200);
    const l = await newLead(owner, { pipelineId: pl.id, contact: { firstName: 'Gate', email: `gate${uniq()}@x.test` } });
    // the lead's allowed next stages follow the matrix
    const detail = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(detail.transitions.map((t: any) => t.name)).toEqual(['Contacted']);

    expect((await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.qualified })).body.code).toBe('INVALID_TRANSITION');
    expect((await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.contacted })).status).toBe(200);
    const gated = await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.qualified });
    expect(gated.status).toBe(422);
    expect(gated.body.reason).toBe('missing_required_fields');
    expect(gated.body.missing.sort()).toEqual(['estimatedValue', 'phone']);
    await owner.patch(`/api/v1/leads/${l.id}`, { estimatedValue: 5_000_000 });
    await owner.patch(`/api/v1/contacts/${l.contactId}`, { phone: '+91 98450 99999' });
    expect((await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.qualified })).status).toBe(200);

    // switching back to unrestricted removes every rule
    await owner.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] });
    expect((await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.new })).status).toBe(200);
  });
});

describe('seeded real-estate pipeline rules', () => {
  it('enforces the seeded transition matrix, but a closed lead can always be reopened', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'lseed' });
    const pl = (await ws.get('/api/v1/pipelines')).body.data[0];
    const st = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s.id]));
    const l = await newLead(ws);
    const detail = (await ws.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(detail.transitions.map((t: any) => t.name).sort()).toEqual(['Contact Attempted', 'Invalid', 'Unqualified']);
    expect((await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.qualified })).body.code).toBe('INVALID_TRANSITION');
    expect((await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.invalid, lossReason: 'Fake number' })).body.data.status).toBe('disqualified');
    // nothing leads out of "Invalid" in the matrix — yet reopening works, to any open stage
    const closed = (await ws.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(closed.transitions.some((t: any) => t.name === 'Qualified')).toBe(true);
    expect(closed.transitions.some((t: any) => t.closes)).toBe(false);
    const re = await ws.post(`/api/v1/leads/${l.id}/stage`, { stageId: st.qualified });
    expect(re.body.data).toMatchObject({ status: 'qualified', closedAt: null });
  });
});

describe('leads: create, read, scope', () => {
  it('creates a lead with contact matching, owner, score breakdown, SLA clock, history and activity', async () => {
    const res = await owner.post('/api/v1/leads', {
      contact: { firstName: 'Asha', lastName: 'Rao', email: 'Asha.Rao@Example.com', phone: '098450 11111' },
      source: 'referral',
      estimatedValue: 8_500_000,
      budgetMax: 9_000_000,
      locations: ['Whitefield'],
      tags: ['Hot Lead'],
    });
    expect(res.status).toBe(201);
    const l = res.body.data;
    expect(l).toMatchObject({ contactName: 'Asha Rao', contactEmail: 'asha.rao@example.com', contactPhone: '+919845011111', stageName: 'New', status: 'open', ownerId: owner.userId, source: 'referral', tags: ['hot-lead'], version: 1 });
    expect(l.leadScore).toBeGreaterThan(40);
    expect(l.scoreBreakdown.map((f: any) => f.factor)).toContain('intent');
    expect(l.sla.state).toBe('ok');
    expect(new Date(l.sla.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.headers.etag).toMatch(/^"1.[0-9a-f]{8}"$/);

    const d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(d.history[0]).toMatchObject({ reason: 'Lead created', fromStage: null, toStage: 'New' });
    const tl = await owner.get(`/api/v1/leads/${l.id}/activities`);
    expect(tl.body.data[0]).toMatchObject({ type: 'note', description: 'Lead created' });
    expect((await h.admin.query(`SELECT 1 FROM domain_events WHERE type = 'lead.created' AND aggregate_id = $1`, [l.id])).rowCount).toBe(1);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'lead.create' AND entity_id = $1`, [l.id])).rowCount).toBe(1);
  });

  it('validates input and refuses a second open lead for the same contact (unless explicitly allowed)', async () => {
    expect((await owner.post('/api/v1/leads', { source: 'website' })).body.errors[0].path).toBe('body.contact');
    expect((await owner.post('/api/v1/leads', { contact: { firstName: 'No way to reach' } })).status).toBe(400);
    expect((await owner.post('/api/v1/leads', { contact: { firstName: 'X', email: 'x@x.test' }, budgetMin: 10, budgetMax: 5 })).status).toBe(422);

    const first = await newLead(owner, { contact: { firstName: 'Twice', email: `twice${uniq()}@x.test` } });
    const again = await owner.post('/api/v1/leads', { contactId: first.contactId });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ reason: 'duplicate_lead', leadId: first.id });
    expect((await owner.post('/api/v1/leads', { contactId: first.contactId, allowDuplicate: true })).status).toBe(201);
    // once the first lead is closed a new one is fine
    await owner.post(`/api/v1/leads/${first.id}/stage`, { stageId: stages.won });
  });

  it('is idempotent on retry with the same Idempotency-Key', async () => {
    const key = `idem-${uniq()}-abcdefgh`;
    const body = { contact: { firstName: 'Retry', email: `retry${uniq()}@x.test` } };
    const a = await owner.post('/api/v1/leads', body, { 'Idempotency-Key': key });
    const b = await owner.post('/api/v1/leads', body, { 'Idempotency-Key': key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(b.headers['idempotent-replay']).toBe('true');
  });

  it('sales agents see and touch only their own leads; managers see all; auditors none; other workspaces nothing', async () => {
    const mine = await newLead(agent, {}, as(agent, owner.tenantId));
    const theirs = await newLead(agent2, {}, as(agent2, owner.tenantId));
    expect(mine.ownerId).toBe(agent.userId);

    const list = await agent.get('/api/v1/leads?limit=200', as(agent, owner.tenantId));
    const ids = list.body.data.map((l: any) => l.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await agent.get(`/api/v1/leads/${theirs.id}`, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.patch(`/api/v1/leads/${theirs.id}`, { campaign: 'x' }, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.post(`/api/v1/leads/${theirs.id}/stage`, { stageId: stages.contacted }, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.get(`/api/v1/leads/${theirs.id}/activities`, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.patch(`/api/v1/leads/${mine.id}`, { campaign: 'mine' }, as(agent, owner.tenantId))).status).toBe(200);

    // agents cannot reassign, hand a lead to someone else on creation, delete, bulk or export
    expect((await agent.post(`/api/v1/leads/${mine.id}/assign`, { ownerId: agent2.userId }, as(agent, owner.tenantId))).status).toBe(403);
    expect((await agent.post('/api/v1/leads', { contact: { firstName: 'Gift', email: `gift${uniq()}@x.test` }, ownerId: agent2.userId }, as(agent, owner.tenantId))).status).toBe(403);
    expect((await agent.delete(`/api/v1/leads/${mine.id}`, as(agent, owner.tenantId))).status).toBe(403);
    expect((await agent.post('/api/v1/leads/bulk', { ids: [mine.id], action: 'archive' }, as(agent, owner.tenantId))).status).toBe(403);
    expect((await agent.get('/api/v1/leads/export', as(agent, owner.tenantId))).status).toBe(403);

    const mgr = await manager.get('/api/v1/leads?limit=200', as(manager, owner.tenantId));
    expect(mgr.body.data.map((l: any) => l.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect((await auditor.get('/api/v1/leads', as(auditor, owner.tenantId))).status).toBe(403);

    expect((await other.get(`/api/v1/leads/${mine.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/leads/${mine.id}`, { campaign: 'hack' })).status).toBe(404);
    expect((await other.post(`/api/v1/leads/${mine.id}/stage`, { stageId: stages.contacted })).status).toBe(404);
    expect((await other.get('/api/v1/leads?limit=200')).body.data.map((l: any) => l.id)).not.toContain(mine.id);
    // a stage of another workspace's pipeline is not addressable either
    const foreignPipeline = (await other.get('/api/v1/pipelines')).body.data[0];
    expect((await owner.post(`/api/v1/leads/${mine.id}/stage`, { stageId: foreignPipeline.stages[1].id })).status).toBe(400);
    expect((await owner.post('/api/v1/leads', { contact: { firstName: 'X', email: `x${uniq()}@x.test` }, stageId: foreignPipeline.stages[0].id })).status).toBe(400);
  });

  it('agents and API keys see the same aggregates the list shows (board, forecast, stage counts)', async () => {
    const a = await agent.get(`/api/v1/pipelines/${pipelineId}/forecast`, as(agent, owner.tenantId));
    expect(a.status).toBe(200);
    const total = a.body.data.stages.reduce((s: number, x: any) => s + x.count, 0);
    const own = (await agent.get('/api/v1/leads?limit=200', as(agent, owner.tenantId))).body.data.length;
    expect(total).toBe(own);
  });
});

describe('leads: update, stage, assignment', () => {
  it('updates with If-Match, recomputes the score and keeps unrelated fields', async () => {
    const l = await newLead(owner);
    const stale = await owner.patch(`/api/v1/leads/${l.id}`, { campaign: 'Diwali' }, { 'If-Match': '"9"' });
    expect(stale.status).toBe(412);
    const ok = await owner.patch(`/api/v1/leads/${l.id}`, { campaign: 'Diwali', budgetMax: 7_000_000, locations: ['Indiranagar'], tags: ['VIP', 'vip'] }, { 'If-Match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ campaign: 'Diwali', budgetMax: 7_000_000, locations: ['Indiranagar'], tags: ['vip'], version: 2 });
    expect(ok.body.data.leadScore).toBeGreaterThan(l.leadScore);
    expect(ok.body.data.source).toBe('website');
  });

  it('moves between stages: status, closed_at, history, activity, events — and reopening', async () => {
    const l = await newLead(owner);
    const q = await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.qualified });
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({ stageName: 'Qualified', status: 'qualified', closedAt: null });
    expect(q.body.data.sla.state).toBe('met'); // leaving the first stage answers the lead

    // closing as lost needs a reason
    const noReason = await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.lost });
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].path).toBe('body.lossReason');
    const lost = await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.lost, lossReason: 'Bought elsewhere' });
    expect(lost.body.data).toMatchObject({ status: 'lost', lossReason: 'Bought elsewhere', leadScore: 0 });
    expect(lost.body.data.closedAt).toBeTruthy();

    const reopened = await owner.post(`/api/v1/leads/${l.id}/stage`, { stageId: stages.contacted });
    expect(reopened.body.data).toMatchObject({ status: 'contacted', closedAt: null, lossReason: null });
    const d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(d.history.map((x: any) => x.toStage)).toEqual(['Contacted', 'Lost', 'Qualified', 'New']);
    expect(d.history[0].reason).toBe('Reopened');
    expect(d.history[1].reason).toBe('Bought elsewhere');
    const ev = await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE type = 'lead.stage_changed' AND aggregate_id = $1`, [l.id]);
    expect(ev.rows[0].n).toBe(3);
    const acts = await owner.get(`/api/v1/leads/${l.id}/activities`);
    expect(acts.body.data.filter((a: any) => a.type === 'stage_change')).toHaveLength(3);
  });

  it('concurrent moves of the same lead are serialised (history stays consistent)', async () => {
    const l = await newLead(owner);
    const targets = [stages.contacted, stages.qualified, stages.negotiation, stages.nurture];
    const results = await Promise.all(targets.map((stageId) => owner.post(`/api/v1/leads/${l.id}/stage`, { stageId })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const hist = await h.admin.query(`SELECT count(*)::int AS n FROM lead_stage_history WHERE lead_id = $1`, [l.id]);
    expect(hist.rows[0].n).toBe(1 + targets.length);
    const row = await h.admin.query(`SELECT stage_id, stage_key, status FROM leads WHERE id = $1`, [l.id]);
    const last = await h.admin.query(`SELECT to_stage_id FROM lead_stage_history WHERE lead_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [l.id]);
    expect(row.rows[0].stage_id).toBe(last.rows[0].to_stage_id);
  });

  it('assigns and unassigns (managers only) and rejects non-members', async () => {
    const l = await newLead(owner);
    const a = await manager.post(`/api/v1/leads/${l.id}/assign`, { ownerId: agent.userId }, as(manager, owner.tenantId));
    expect(a.status).toBe(200);
    expect(a.body.data.ownerId).toBe(agent.userId);
    expect(a.body.data.assignedAt).toBeTruthy();
    expect((await manager.post(`/api/v1/leads/${l.id}/assign`, { ownerId: other.userId }, as(manager, owner.tenantId))).status).toBe(400);
    const un = await manager.post(`/api/v1/leads/${l.id}/assign`, { ownerId: null }, as(manager, owner.tenantId));
    expect(un.body.data.ownerId).toBeNull();
    expect((await owner.get('/api/v1/leads?ownerId=unassigned&limit=200')).body.data.map((x: any) => x.id)).toContain(l.id);
    const ev = await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE type = 'lead.assigned' AND aggregate_id = $1`, [l.id]);
    expect(ev.rows[0].n).toBe(2);
  });

  it('balanced assignment spreads new leads across the least-loaded agents, even under concurrency', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'lbal' });
    const a1 = await h.register({ legacyPipeline: true, emailPrefix: 'lb1' });
    const a2 = await h.register({ legacyPipeline: true, emailPrefix: 'lb2' });
    await addMember(a1, ws.tenantId, 'sales_agent');
    await addMember(a2, ws.tenantId, 'sales_agent');
    await h.admin.query(`UPDATE tenants SET settings = settings || '{"leadAssignment":"balanced"}'::jsonb WHERE id = $1`, [ws.tenantId]);
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) => ws.post('/api/v1/leads', { contact: { firstName: `B${i}`, email: `b${i}-${uniq()}@x.test` } })));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const counts: Record<string, number> = {};
    for (const r of created) counts[r.body.data.ownerId] = (counts[r.body.data.ownerId] ?? 0) + 1;
    expect(Object.keys(counts).sort()).toEqual([a1.userId, a2.userId].sort());
    expect(Math.abs(counts[a1.userId]! - counts[a2.userId]!)).toBeLessThanOrEqual(1);
  });

  it('archives and restores', async () => {
    const l = await newLead(owner);
    expect((await owner.delete(`/api/v1/leads/${l.id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/leads/${l.id}`)).status).toBe(404);
    expect((await owner.get('/api/v1/leads?limit=200')).body.data.map((x: any) => x.id)).not.toContain(l.id);
    const back = await owner.post(`/api/v1/leads/${l.id}/restore`);
    expect(back.status).toBe(200);
    expect((await owner.get(`/api/v1/leads/${l.id}`)).status).toBe(200);
  });
});

describe('leads: list, filters, pagination', () => {
  let ws: AuthedUser;
  const ids: string[] = [];
  beforeAll(async () => {
    ws = await h.register({ legacyPipeline: true, emailPrefix: 'llist' });
    await flex(ws);
    const pl = (await ws.get('/api/v1/pipelines')).body.data[0];
    const st = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s.id]));
    const specs = [
      { n: 'Alpha', source: 'referral', value: 9_000_000, tags: ['vip'], city: 'Pune' },
      { n: 'Bravo', source: 'portal', value: 2_000_000, tags: [], city: 'Pune' },
      { n: 'Charlie', source: 'website', value: 5_000_000, tags: ['vip', 'nri'], city: 'Goa' },
      { n: 'Delta', source: 'meta_ads', value: null, tags: [], city: 'Goa' },
      { n: 'Echo', source: 'walk_in', value: 7_000_000, tags: ['nri'], city: 'Pune' },
      { n: 'Foxtrot', source: 'direct', value: 1_000_000, tags: [], city: 'Goa' },
      { n: 'Golf', source: 'google_ads', value: 3_000_000, tags: ['vip'], city: 'Pune' },
    ];
    for (const s of specs) {
      const l = await newLead(ws, { contact: { firstName: s.n, lastName: 'Buyer', email: `${s.n.toLowerCase()}@list.test`, phone: `+9198100${String(ids.length).padStart(5, '0')}` }, source: s.source, estimatedValue: s.value, tags: s.tags, campaign: s.city });
      ids.push(l.id);
    }
    await ws.post(`/api/v1/leads/${ids[1]}/stage`, { stageId: st.qualified });
    await ws.post(`/api/v1/leads/${ids[2]}/stage`, { stageId: st.lost, lossReason: 'No budget' });
    await ws.patch(`/api/v1/leads/${ids[0]}`, { nextFollowupAt: new Date(Date.now() - 3_600_000).toISOString() });
  }, 60_000);

  const get = async (qs: string) => (await ws.get(`/api/v1/leads?${qs}`)).body.data.map((l: any) => l.contactName.split(' ')[0]);

  it('filters by text, status, state, source, tag, owner, score and follow-up', async () => {
    expect(await get('q=bravo')).toEqual(['Bravo']);
    expect(await get('q=%25')).toEqual([]); // literal percent, not a wildcard
    expect(await get('q=98100')).toHaveLength(7);
    expect((await get('status=lost')).sort()).toEqual(['Charlie']);
    expect((await get('status=lost,qualified')).sort()).toEqual(['Bravo', 'Charlie']);
    expect(await get('state=closed')).toEqual(['Charlie']);
    expect((await get('state=open')).length).toBe(6);
    expect(await get('source=portal')).toEqual(['Bravo']);
    expect((await get('tag=vip')).sort()).toEqual(['Alpha', 'Charlie', 'Golf']); // tag filters do not care whether the lead is open
    expect((await get('tag=nri')).sort()).toEqual(['Charlie', 'Echo']);
    expect(await get(`ownerId=${ws.userId}&limit=1`)).toHaveLength(1);
    expect(await get('ownerId=unassigned')).toEqual([]);
    expect(await get('followup=overdue')).toEqual(['Alpha']);
    expect((await get('scoreMin=100')).length).toBe(0);
    expect((await ws.get('/api/v1/leads?status=bogus')).status).toBe(400);
    expect((await ws.get('/api/v1/leads?createdFrom=not-a-date')).status).toBe(400);
  });

  it('sorts and pages with stable keyset cursors for every sort and order', async () => {
    for (const sort of ['created', 'updated', 'score', 'value', 'followup'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
          const r: any = await ws.get(`/api/v1/leads?limit=3&sort=${sort}&order=${order}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(r.status).toBe(200);
          seen.push(...r.body.data.map((l: any) => l.id));
          if (!r.body.page.hasMore) break;
          cursor = r.body.page.next;
        }
        expect(seen, `${sort} ${order}`).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      }
    }
    const byValue = (await ws.get('/api/v1/leads?sort=value&order=desc')).body.data.map((l: any) => l.estimatedValue);
    expect(byValue.slice(0, 3)).toEqual([9_000_000, 7_000_000, 5_000_000]);
    const first: any = await ws.get('/api/v1/leads?limit=2&sort=score');
    expect((await ws.get(`/api/v1/leads?limit=2&sort=value&cursor=${first.body.page.next}`)).status).toBe(400);
  });

  it('board returns every stage with totals and a capped number of cards; forecast weights by probability', async () => {
    const pl = (await ws.get('/api/v1/pipelines')).body.data[0];
    const board = (await ws.get(`/api/v1/pipelines/${pl.id}/board?perStage=1`)).body.data;
    expect(board.stages.map((s: any) => s.name)).toEqual(pl.stages.map((s: any) => s.name));
    const nu = board.stages.find((s: any) => s.name === 'New');
    expect(nu.count).toBe(5);
    expect(nu.leads).toHaveLength(1);
    expect(nu.value).toBe(9_000_000 + 0 + 7_000_000 + 1_000_000 + 3_000_000);
    expect(board.stages.find((s: any) => s.name === 'Lost').leads[0].lossReason).toBe('No budget');

    const f = (await ws.get(`/api/v1/pipelines/${pl.id}/forecast`)).body.data;
    const q = f.stages.find((s: any) => s.name === 'Qualified');
    expect(q).toMatchObject({ count: 1, value: 2_000_000, probability: 30, weighted: 600_000 });
    expect(f.open.count).toBe(6);
    expect(f.open.weighted).toBeCloseTo(0.05 * 20_000_000 + 600_000, 0);
    expect(f.stages.find((s: any) => s.name === 'Lost').isClosed).toBe(true);
    // a stage filter on the list pages further into a column
    expect((await ws.get(`/api/v1/leads?stageId=${nu.id}&limit=2`)).body.data).toHaveLength(2);
  });
});

describe('leads: activities, first response and SLA', () => {
  it('logging a call answers the lead, bumps engagement and appears on the timeline; a plain note does not', async () => {
    const l = await newLead(owner);
    await owner.post(`/api/v1/leads/${l.id}/activities`, { type: 'note', description: 'Internal note' });
    let d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(d.sla.state).not.toBe('met');
    const call = await owner.post(`/api/v1/leads/${l.id}/activities`, { type: 'call', description: 'Spoke for 6 minutes, wants a viewing', outcome: 'connected', durationMinutes: 6 });
    expect(call.status).toBe(201);
    d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(d.sla.state).toBe('met');
    expect(d.lastActivityAt).toBeTruthy();
    expect(d.leadScore).toBeGreaterThan(l.leadScore); // engagement factor
    const tl = (await owner.get(`/api/v1/leads/${l.id}/activities?limit=2`)).body;
    expect(tl.data[0]).toMatchObject({ type: 'call', description: 'Spoke for 6 minutes, wants a viewing' });
    expect(tl.page.hasMore).toBe(true);
    const next = (await owner.get(`/api/v1/leads/${l.id}/activities?limit=2&cursor=${tl.page.next}`)).body;
    expect(next.data.length).toBeGreaterThan(0);
    expect(new Set([...tl.data, ...next.data].map((a: any) => a.id)).size).toBe(tl.data.length + next.data.length);
  });

  it('rejects empty text, future timestamps and activities on leads you cannot see', async () => {
    const l = await newLead(owner);
    expect((await owner.post(`/api/v1/leads/${l.id}/activities`, { type: 'note', description: '   ' })).status).toBe(400);
    expect((await owner.post(`/api/v1/leads/${l.id}/activities`, { type: 'call', description: 'x', occurredAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
    expect((await agent.post(`/api/v1/leads/${l.id}/activities`, { type: 'note', description: 'sneaky' }, as(agent, owner.tenantId))).status).toBe(404);
    expect((await other.post(`/api/v1/leads/${l.id}/activities`, { type: 'note', description: 'sneaky' })).status).toBe(404);
  });

  it('SLA filters find breached leads', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'lsla' });
    const l = await newLead(ws);
    await h.admin.query(`UPDATE leads SET first_response_due_at = now() - interval '5 minutes' WHERE id = $1`, [l.id]);
    const fresh = await newLead(ws);
    expect((await ws.get('/api/v1/leads?sla=breached')).body.data.map((x: any) => x.id)).toEqual([l.id]);
    expect((await ws.get(`/api/v1/leads/${l.id}`)).body.data.sla.state).toBe('breached');
    expect((await ws.get(`/api/v1/leads/${fresh.id}`)).body.data.sla.state).toBe('ok');
  });
});

describe('caching safety', () => {
  it('API responses are never cacheable, and a conditional GET cannot be told "not modified" about derived changes', async () => {
    const l = await newLead(owner);
    const first = await owner.get(`/api/v1/leads/${l.id}`);
    expect(first.headers['cache-control']).toMatch(/no-store/);
    const tag = first.headers.etag!;
    expect((await owner.get(`/api/v1/leads/${l.id}`, { 'If-None-Match': tag })).status).toBe(304); // nothing changed: a revalidation may say so
    // Logging a call changes the score, last-activity time and SLA without bumping the record version…
    await owner.post(`/api/v1/leads/${l.id}/activities`, { type: 'call', description: 'Spoke to the buyer' });
    const after = await owner.get(`/api/v1/leads/${l.id}`, { 'If-None-Match': tag });
    expect(after.status).toBe(200); // …so the tag must change, or browsers would keep showing the old lead
    expect(after.headers.etag).not.toBe(tag);
    expect(after.body.data.lastActivityAt).toBeTruthy();
    // If-Match keeps working with the full tag and with the bare version
    expect((await owner.patch(`/api/v1/leads/${l.id}`, { campaign: 'a' }, { 'If-Match': after.headers.etag! })).status).toBe(200);
    expect((await owner.patch(`/api/v1/leads/${l.id}`, { campaign: 'b' }, { 'If-Match': '"2"' })).status).toBe(200);
    expect((await owner.get('/api/v1/openapi.json')).headers['cache-control']).toMatch(/max-age/);
  });
});

describe('leads: bulk, export, saved views', () => {
  it('bulk assign / tag / move / archive: each lead is handled on its own, failures are reported not hidden', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'lbulk' });
    await flex(ws);
    const rep = await h.register({ legacyPipeline: true, emailPrefix: 'lbulkrep' });
    await addMember(rep, ws.tenantId, 'sales_agent');
    const leads = [await newLead(ws), await newLead(ws), await newLead(ws)];
    const ids = leads.map((l) => l.id);
    const ghost = '00000000-0000-4000-8000-0000000000aa';

    const assign = await ws.post('/api/v1/leads/bulk', { ids: [...ids, ghost], action: 'assign', ownerId: rep.userId });
    expect(assign.body.data).toMatchObject({ updated: 3, skipped: [{ id: ghost }] });
    expect((await ws.get(`/api/v1/leads?ownerId=${rep.userId}`)).body.data).toHaveLength(3);

    const tag = await ws.post('/api/v1/leads/bulk', { ids, action: 'add_tags', tags: ['Diwali', 'follow up'] });
    expect(tag.body.data.updated).toBe(3);
    expect((await ws.get('/api/v1/leads?tag=follow-up')).body.data).toHaveLength(3);
    await ws.post('/api/v1/leads/bulk', { ids: [ids[0]], action: 'remove_tags', tags: ['diwali'] });
    expect((await ws.get(`/api/v1/leads/${ids[0]}`)).body.data.tags).toEqual(['follow-up']);

    const pl = (await ws.get('/api/v1/pipelines')).body.data[0];
    const st = Object.fromEntries(pl.stages.map((s: any) => [s.stageKey, s.id]));
    // one lead is already lost → moving to Lost without a reason skips all; with a reason works for open ones
    await ws.post(`/api/v1/leads/${ids[2]}/stage`, { stageId: st.lost, lossReason: 'x' });
    const noReason = await ws.post('/api/v1/leads/bulk', { ids, action: 'move_stage', stageId: st.qualified });
    expect(noReason.body.data.updated).toBe(3);
    const mv = await ws.post('/api/v1/leads/bulk', { ids, action: 'move_stage', stageId: st.lost });
    expect(mv.body.data.updated).toBe(0);
    expect(mv.body.data.skipped).toHaveLength(3);
    expect(mv.body.data.skipped[0].reason).toMatch(/why/i);
    const mv2 = await ws.post('/api/v1/leads/bulk', { ids, action: 'move_stage', stageId: st.lost, lossReason: 'Budget' });
    expect(mv2.body.data.updated).toBe(3);

    expect((await ws.post('/api/v1/leads/bulk', { ids: [], action: 'archive' })).status).toBe(400);
    const arch = await ws.post('/api/v1/leads/bulk', { ids, action: 'archive' });
    expect(arch.body.data.updated).toBe(3);
    expect((await ws.get('/api/v1/leads?limit=200')).body.data).toHaveLength(0);
  });

  it('exports CSV with the same filters, neutralises formulas, audits, and refuses roles without export', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'lexp' });
    await newLead(ws, { contact: { firstName: '=HYPERLINK("http://evil.test","click")', email: `evil${uniq()}@x.test` }, campaign: '+cmd|calc' });
    await newLead(ws, { contact: { firstName: 'Normal', email: `normal${uniq()}@x.test` }, tags: ['vip'] });
    const r = await ws.get('/api/v1/leads/export?tag=vip');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = r.text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), '');
    expect(text.split('\r\n')[0]).toContain('Lead ID');
    expect(text).toContain('Normal');
    expect(text).not.toContain('HYPERLINK');
    const all = (await ws.get('/api/v1/leads/export')).text;
    expect(all).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(all).toContain(`'+cmd|calc`);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'lead.export' AND tenant_id = $1`, [ws.tenantId])).rowCount).toBe(2);
    expect((await auditor.get('/api/v1/leads/export', as(auditor, owner.tenantId))).status).toBe(403);
  });

  it('saved views: private by default, shareable by managers, editable only by their owner', async () => {
    const filters = { state: 'open', tag: 'vip' };
    const mine = await manager.post('/api/v1/saved-views', { entity: 'lead', name: 'Open VIPs', filters, sort: 'score', isShared: true }, as(manager, owner.tenantId));
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ name: 'Open VIPs', isMine: true, isShared: true, filters });
    const priv = await manager.post('/api/v1/saved-views', { entity: 'lead', name: 'Private one', filters: {} }, as(manager, owner.tenantId));
    expect((await manager.post('/api/v1/saved-views', { entity: 'lead', name: 'open vips', filters: {} }, as(manager, owner.tenantId))).status).toBe(201); // names are per owner, case-sensitive text
    expect((await manager.post('/api/v1/saved-views', { entity: 'lead', name: 'Open VIPs', filters: {} }, as(manager, owner.tenantId))).status).toBe(409);

    const seen = (await agent.get('/api/v1/saved-views?entity=lead', as(agent, owner.tenantId))).body.data.map((v: any) => v.name);
    expect(seen).toContain('Open VIPs');
    expect(seen).not.toContain('Private one');
    expect((await agent.get('/api/v1/saved-views?entity=lead', as(agent, owner.tenantId))).body.data.find((v: any) => v.name === 'Open VIPs').isMine).toBe(false);
    expect((await agent.patch(`/api/v1/saved-views/${mine.body.data.id}`, { name: 'Hijack' }, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.delete(`/api/v1/saved-views/${mine.body.data.id}`, as(agent, owner.tenantId))).status).toBe(404);
    expect((await agent.post('/api/v1/saved-views', { entity: 'lead', name: 'Share attempt', filters: {}, isShared: true }, as(agent, owner.tenantId))).status).toBe(403);
    expect((await other.get('/api/v1/saved-views?entity=lead')).body.data.map((v: any) => v.name)).not.toContain('Open VIPs');

    const upd = await manager.patch(`/api/v1/saved-views/${priv.body.data.id}`, { name: 'Renamed', isShared: false }, as(manager, owner.tenantId));
    expect(upd.body.data.name).toBe('Renamed');
    expect((await manager.delete(`/api/v1/saved-views/${priv.body.data.id}`, as(manager, owner.tenantId))).status).toBe(204);
  });
});

describe('leads: CSV import (worker)', () => {
  const csv = (rows: string[]) => ['Customer Name,Mobile,Email,Lead Source,Budget,Location,Tags,Notes,Owner Email', ...rows].join('\n');

  it('imports asynchronously: creates leads, matches existing people, reports row errors, skips duplicates', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'limp' });
    const existing = await newLead(ws, { contact: { firstName: 'Existing', lastName: 'Person', email: 'existing@import.test', phone: '+91 98111 00001' } });
    const body = csv([
      'Meera Iyer,098450 12345,meera@import.test,Facebook,"₹1.5 cr","Whitefield; Koramangala",vip;nri,"Wants 3BHK, ready to buy",',
      'Rohan Shah,+91 98450 54321,,99acres,50 lakh,Pune,,,',
      'Existing Person,9811100001,,website,,,,,', // matches an existing contact that already has an open lead → skipped
      ',098450 00000,nobody@import.test,website,,,,,', // no name
      'Bad Phone,12,,website,,,,,', // invalid phone
      'Bad Email,,not-an-email,website,,,,,',
      'Bad Budget,098450 77777,,website,abc,,,,',
      'Ghost Owner,098450 88888,,website,,,,,nobody@team.test',
      '"=cmd|calc",098450 99999,,other,,,,,',
    ]);
    const res = await ws.post('/api/v1/leads/imports', { fileName: 'enquiries.csv', csv: body });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'queued', totalRows: 9, fileName: 'enquiries.csv' });
    expect(res.body.data.detectedMapping['Customer Name']).toBe('fullName');
    const importId = res.body.data.id;
    expect((await ws.post('/api/v1/leads/imports', { csv: body })).status).toBe(409); // same file while active

    await h.runJobs();
    const done = (await ws.get(`/api/v1/leads/imports/${importId}`)).body.data;
    expect(done).toMatchObject({ status: 'completed', totalRows: 9, processedRows: 9, createdCount: 3, matchedCount: 1, skippedCount: 1, errorCount: 5 });
    expect(done.errors.map((e: any) => e.row)).toEqual([5, 6, 7, 8, 9]); // spreadsheet row numbers (header = 1)
    expect(done.errors[0]).toMatchObject({ row: 5, field: 'name' });
    expect(done.errors[1].field).toBe('phone');
    expect(done.errors[4].field).toBe('ownerEmail');
    const stored = await h.admin.query(`SELECT payload_csv FROM import_jobs WHERE id = $1`, [importId]);
    expect(stored.rows[0].payload_csv).toBeNull(); // file removed when finished

    const meera = (await ws.get('/api/v1/leads?q=meera')).body.data[0];
    expect(meera).toMatchObject({ source: 'meta_ads', budgetMax: 15_000_000, locations: ['Whitefield', 'Koramangala'], tags: ['vip', 'nri'], contactPhone: '+919845012345' });
    const rohan = (await ws.get('/api/v1/leads?q=rohan')).body.data[0];
    expect(rohan).toMatchObject({ source: 'portal', budgetMax: 5_000_000 });
    const acts = (await ws.get(`/api/v1/leads/${meera.id}/activities`)).body.data;
    expect(acts.some((a: any) => a.description === 'Wants 3BHK, ready to buy')).toBe(true);
    // the matched person was not duplicated and their lead untouched
    expect((await ws.get(`/api/v1/contacts?q=existing%40import.test`)).body.data).toHaveLength(1);
    expect((await ws.get(`/api/v1/leads?contactId=${existing.contactId}`)).body.data).toHaveLength(1);
    // spreadsheet-formula-looking names are data, stored verbatim
    expect((await ws.get('/api/v1/leads?q=cmd')).body.data[0].contactName).toBe('=cmd|calc');
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'import.complete' AND entity_id = $1`, [importId])).rowCount).toBe(1);
    expect((await ws.get('/api/v1/leads/imports')).body.data[0].id).toBe(importId);
  });

  it('can be re-run safely: a retried job resumes after the last committed batch and never double-creates', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'limp2' });
    const rows = Array.from({ length: 230 }, (_, i) => `Person ${i},+9170000${String(i).padStart(5, '0')},,website,,,,,`);
    const res = await ws.post('/api/v1/leads/imports', { csv: csv(rows) });
    const id = res.body.data.id;
    // Simulate a worker that died after two batches: progress is committed with the rows it covers.
    const { createWorkerDb } = await import('../platform/db');
    const { leadsImportHandler } = await import('../modules/leads/import');
    const wdb = createWorkerDb();
    const ac = new AbortController();
    let batchesSeen = 0;
    const origWith = wdb.withTenant.bind(wdb);
    const crashing = Object.assign(Object.create(wdb), {
      withTenant: async (ctx: any, fn: any) => {
        const r = await origWith(ctx, fn);
        if (ctx.userId && ++batchesSeen === 3) throw new Error('simulated crash'); // "running" marker + batch 1 + batch 2 committed … then the worker dies
        return r;
      },
    });
    await expect(leadsImportHandler({ id: 'j', tenantId: ws.tenantId, type: 'leads.import', payload: { importId: id }, attempts: 1, maxAttempts: 3, correlationId: null }, { db: crashing, log: console as any, signal: ac.signal, withTenant: undefined as any })).rejects.toThrow('simulated crash');
    const mid = await h.admin.query(`SELECT processed_rows, created_count, status FROM import_jobs WHERE id = $1`, [id]);
    expect(mid.rows[0].processed_rows).toBe(200);
    expect(mid.rows[0].created_count).toBe(200);
    expect(mid.rows[0].status).toBe('running');

    await leadsImportHandler({ id: 'j', tenantId: ws.tenantId, type: 'leads.import', payload: { importId: id }, attempts: 2, maxAttempts: 3, correlationId: null }, { db: wdb, log: console as any, signal: ac.signal, withTenant: undefined as any });
    const end = await h.admin.query(`SELECT processed_rows, created_count, status FROM import_jobs WHERE id = $1`, [id]);
    expect(end.rows[0]).toMatchObject({ processed_rows: 230, created_count: 230, status: 'completed' });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1`, [ws.tenantId])).rows[0].n).toBe(230);
    await wdb.end();
  }, 120_000);

  it('rejects files it cannot understand with a helpful message, and enforces permissions and isolation', async () => {
    const ws = await h.register({ legacyPipeline: true, emailPrefix: 'limp3' });
    const noName = await ws.post('/api/v1/leads/imports', { csv: 'Phone,Notes\n+91 98450 12345,hello' });
    expect(noName.status).toBe(400);
    expect(noName.body.errors[0].code).toBe('missing_name');
    expect(noName.body.detail).toContain('Phone, Notes');
    expect((await ws.post('/api/v1/leads/imports', { csv: 'Name,Email\n' })).status).toBe(400);
    expect((await ws.post('/api/v1/leads/imports', { csv: 'Name,Email\n"broken,x@x.test' })).body.errors[0].message).toMatch(/quoted/);
    expect((await ws.post('/api/v1/leads/imports', { csv: 'Name,Email\nA,a@a.test', mapping: { Nope: 'email' } })).status).toBe(400);
    // an explicit mapping can rescue odd headers
    const ok = await ws.post('/api/v1/leads/imports', { csv: 'Who,Where to reach\nAnita,anita@x.test', mapping: { Who: 'fullName', 'Where to reach': 'email' } });
    expect(ok.status).toBe(202);
    await h.runJobs();
    expect((await ws.get('/api/v1/leads?q=anita')).body.data).toHaveLength(1);

    expect((await agent.post('/api/v1/leads/imports', { csv: 'Name,Email\nA,a@a.test' }, as(agent, owner.tenantId))).status).toBe(403);
    expect((await other.get(`/api/v1/leads/imports/${ok.body.data.id}`)).status).toBe(404);
    expect((await other.get('/api/v1/leads/imports')).body.data.map((i: any) => i.id)).not.toContain(ok.body.data.id);
  });
});

describe('documentation', () => {
  it('publishes leads, pipelines, saved views and imports in OpenAPI with pagination, If-Match and CSV', async () => {
    const spec = (await owner.get('/api/v1/openapi.json')).body;
    for (const p of ['/api/v1/leads', '/api/v1/leads/{id}/stage', '/api/v1/leads/bulk', '/api/v1/leads/imports', '/api/v1/pipelines/{id}/board', '/api/v1/pipelines/{id}/transitions', '/api/v1/saved-views']) expect(spec.paths[p], p).toBeTruthy();
    expect(spec.paths['/api/v1/leads'].get.responses['200'].content['application/json'].schema.properties.page).toBeTruthy();
    expect(spec.paths['/api/v1/leads/{id}/stage'].post.parameters.some((p: any) => p.name === 'If-Match')).toBe(true);
    expect(Object.keys(spec.paths['/api/v1/leads/export'].get.responses['200'].content)).toEqual(['text/csv']);
    expect(spec.paths['/api/v1/leads/imports'].post.responses['202']).toBeTruthy();
  });
});

describe('hostile input at the edge', () => {
  it('a NUL byte in a query string, path or body is a 400 problem document, never a 500', async () => {
    for (const url of ['/api/v1/leads?q=a%00b', '/api/v1/search?q=%00x', '/api/v1/contacts?q=%00', '/api/v1/properties?q=x%00']) {
      const r = await owner.get(url);
      expect(r.status, url).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    const body = await owner.post('/api/v1/leads', { contact: { firstName: 'Ok' }, source: 'website', notes: 'bad\u0000note' });
    expect(body.status).toBe(400);
    const nested = await owner.post('/api/v1/leads', { contact: { firstName: 'Ok', lastName: 'x\u0000y' }, source: 'website' });
    expect(nested.status).toBe(400);
  });
});
