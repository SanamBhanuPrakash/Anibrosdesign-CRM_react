import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Slice 2 acceptance: the recommended beginner pipeline for NEW workspaces, reason codes for Lost / Not a fit, history that does not
 * change when stages are renamed, and the explicit audited action for EXISTING workspaces. Restricted database role throughout.
 */
let h: ApiHarness;
let owner: AuthedUser; // new workspace: recommended pipeline
let manager: AuthedUser;
let agent: AuthedUser;
let other: AuthedUser;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const inWs = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};

async function stagesOf(u: AuthedUser, pipelineId?: string): Promise<Record<string, string>> {
  const list = (await u.get('/api/v1/pipelines')).body.data as any[];
  const p = pipelineId ? list.find((x) => x.id === pipelineId) : list.find((x) => x.isDefault);
  return Object.fromEntries(p.stages.map((s: any) => [s.stageKey, s.id]));
}
async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Menon', email: `b${uniq()}@x.test` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
const move = (u: AuthedUser, leadId: string, stageId: string, extra: Record<string, unknown> = {}) => u.post(`/api/v1/leads/${leadId}/stage`, { stageId, ...extra });
/** Winning needs a recorded deal value tied to a unit in the recommended pipeline (Slice 4, decision D3). */
const winWithDeal = async (u: AuthedUser, leadId: string, stageId: string) => {
  const unit = await u.post('/api/v1/properties', { title: `Sold unit ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, propertyType: 'apartment', listingType: 'sale', price: 5_000_000 });
  return move(u, leadId, stageId, { deal: { propertyId: unit.body.data.id, dealValue: 4_900_000 } });
};

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 's2own', organisationName: 'Slice Two Co' });
  other = await h.register({ emailPrefix: 's2oth', organisationName: 'Other Slice Two Co' });
  const m = await h.register({ emailPrefix: 's2mgr' });
  const a = await h.register({ emailPrefix: 's2agt' });
  await addMember(m, owner.tenantId, 'sales_manager');
  await addMember(a, owner.tenantId, 'sales_agent');
  manager = inWs(m, owner.tenantId);
  agent = inWs(a, owner.tenantId);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('a new workspace starts with the recommended pipeline', () => {
  it('has the nine open stages and three outcomes, in plain words, with the right meaning and weight', async () => {
    const list = (await owner.get('/api/v1/pipelines')).body.data as any[];
    expect(list).toHaveLength(1);
    const p = list[0];
    expect(p).toMatchObject({ name: 'Sales pipeline', isDefault: true, template: 'beginner_v1', reasonCodesRequired: true });
    expect(p.stages.map((s: any) => s.name)).toEqual(['New enquiry', 'Trying to reach', 'In conversation', 'Qualified', 'Site visit booked', 'Site visit done', 'Negotiating', 'Booked', 'Follow up later', 'Won', 'Lost', 'Not a fit']);
    const by = Object.fromEntries(p.stages.map((s: any) => [s.stageKey, s]));
    expect(by.new).toMatchObject({ mapsToStatus: 'open', probability: 5, isClosed: false });
    expect(by.booking_reserved).toMatchObject({ mapsToStatus: 'negotiation', probability: 90 });
    expect(by.won).toMatchObject({ mapsToStatus: 'won', probability: 100, isClosed: true });
    expect(by.lost).toMatchObject({ mapsToStatus: 'lost', isClosed: true });
    expect(by.not_a_fit).toMatchObject({ mapsToStatus: 'disqualified', isClosed: true });
    // there is exactly ONE "not a fit" outcome: the old Invalid / Unqualified split is gone for new workspaces
    expect(p.stages.filter((s: any) => s.mapsToStatus === 'disqualified')).toHaveLength(1);
    expect(p.stages.map((s: any) => s.orderIndex)).toEqual([...p.stages.keys()]);
  });

  it('a beginner can walk a lead from enquiry to won without ever being refused', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    // skips steps on purpose ("In conversation" straight from the enquiry) and goes backwards once: all allowed
    for (const key of ['contacted', 'qualified', 'viewing_scheduled', 'contact_attempted', 'viewing_scheduled', 'viewing_completed', 'negotiation', 'booking_reserved']) {
      const r = await move(owner, lead.id, st[key]);
      expect(r.status, key).toBe(200);
    }
    const won = await winWithDeal(owner, lead.id, st.won);
    expect(won.status).toBe(200);
    expect(won.body.data.status).toBe('won');
    const history = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data.history.map((x: any) => x.toStage).reverse();
    expect(history).toEqual(['New enquiry', 'In conversation', 'Qualified', 'Site visit booked', 'Trying to reach', 'Site visit booked', 'Site visit done', 'Negotiating', 'Booked', 'Won']);
  });

  it('only Won needs Booked first', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    for (const key of ['new', 'contacted', 'qualified', 'negotiation']) {
      if (key !== 'new') expect((await move(owner, lead.id, st[key])).status).toBe(200);
      const r = await move(owner, lead.id, st.won);
      expect(r.status, key).toBe(409);
      expect(r.body.code).toBe('INVALID_TRANSITION');
    }
    expect((await move(owner, lead.id, st.booking_reserved)).status).toBe(200);
    expect((await winWithDeal(owner, lead.id, st.won)).status).toBe(200);
  });

  it('offers the right moves: every open stage and both outcomes, never Won before Booked', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    const names = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data.transitions.map((t: any) => t.name);
    expect(names).toHaveLength(10); // 8 other open stages + Lost + Not a fit (Won is not offered yet)
    expect(names).not.toContain('Won');
    expect(names).toEqual(expect.arrayContaining(['Lost', 'Not a fit', 'Follow up later']));
    expect((await move(owner, lead.id, st.booking_reserved)).status).toBe(200);
    expect((await owner.get(`/api/v1/leads/${lead.id}`)).body.data.transitions.map((t: any) => t.name)).toContain('Won');
  });

  it('"Follow up later" needs a follow-up date, and says so', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    const refused = await move(owner, lead.id, st.follow_up_later);
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toMatch(/follow-up date/);
    const detail = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data;
    expect(detail.transitions.find((t: any) => t.name === 'Follow up later').requiredFields).toEqual(['nextFollowupAt']);
    expect((await owner.patch(`/api/v1/leads/${lead.id}`, { nextFollowupAt: new Date(Date.now() + 7 * 86400_000).toISOString() })).status).toBe(200);
    expect((await move(owner, lead.id, st.follow_up_later)).status).toBe(200);
    expect((await move(owner, lead.id, st.contacted)).status).toBe(200); // and it comes back into the pipeline
  });
});

describe('reason codes for Lost and Not a fit', () => {
  it('lists the fixed reasons; "other" is in both', async () => {
    const r = await owner.get('/api/v1/pipelines/reason-codes');
    expect(r.status).toBe(200);
    expect(r.body.data.lost.map((x: any) => x.code)).toEqual(['bought_elsewhere', 'price_too_high', 'financing', 'timing', 'changed_mind', 'no_response', 'other']);
    expect(r.body.data.not_a_fit.map((x: any) => x.code)).toEqual(['spam', 'wrong_number', 'duplicate', 'not_a_buyer', 'test', 'other']);
    expect(r.body.data.lost.every((x: any) => x.label.length > 3)).toBe(true);
    expect((await agent.get('/api/v1/pipelines/reason-codes')).status).toBe(200);
  });

  it('a code is mandatory where the pipeline requires it', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    for (const stageKey of ['lost', 'not_a_fit']) {
      const none = await move(owner, lead.id, st[stageKey]);
      expect(none.status, stageKey).toBe(400);
      expect(none.body.errors[0].path).toBe('body.reasonCode');
      // a written reason alone is not enough in this pipeline
      expect((await move(owner, lead.id, st[stageKey], { lossReason: 'they said no' })).status, stageKey).toBe(400);
    }
    expect((await owner.get(`/api/v1/leads/${lead.id}`)).body.data.status).toBe('open'); // nothing changed
  });

  it('rejects an unknown code, a code from the other list, and "other" without words', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    expect((await move(owner, lead.id, st.lost, { reasonCode: 'because' })).status).toBe(400);
    expect((await move(owner, lead.id, st.lost, { reasonCode: 'spam' })).status).toBe(400); // spam is a Not a fit reason
    expect((await move(owner, lead.id, st.not_a_fit, { reasonCode: 'price_too_high' })).status).toBe(400);
    const noWords = await move(owner, lead.id, st.lost, { reasonCode: 'other' });
    expect(noWords.status).toBe(400);
    expect(noWords.body.errors[0].path).toBe('body.lossReason');
    expect((await move(owner, lead.id, st.contacted, { reasonCode: 'spam' })).status).toBe(400); // a code only applies to closing stages
  });

  it('a chosen code is stored on the lead and in history; its label becomes the written reason; reopening clears it', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    const lost = await move(owner, lead.id, st.lost, { reasonCode: 'price_too_high' });
    expect(lost.status).toBe(200);
    expect(lost.body.data).toMatchObject({ status: 'lost', lossReasonCode: 'price_too_high', lossReason: 'Price too high' });
    const h1 = (await h.admin.query(`SELECT reason_code, reason FROM lead_stage_history WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [lead.id])).rows[0];
    expect(h1).toEqual({ reason_code: 'price_too_high', reason: 'Price too high' });
    const reopened = await move(owner, lead.id, st.contacted);
    expect(reopened.body.data).toMatchObject({ status: 'contacted', lossReasonCode: null, lossReason: null });

    const other2 = await move(owner, lead.id, st.not_a_fit, { reasonCode: 'other', lossReason: 'A relative of the owner, not buying' });
    expect(other2.body.data).toMatchObject({ status: 'disqualified', lossReasonCode: 'other', lossReason: 'A relative of the owner, not buying' });
    const dup = await newLead(owner);
    expect((await move(owner, dup.id, st.not_a_fit, { reasonCode: 'duplicate' })).body.data.lossReasonCode).toBe('duplicate');
  });

  it('bulk moves to Lost need the code too, and report the lead as skipped instead of half-applying', async () => {
    const st = await stagesOf(owner);
    const a = await newLead(owner);
    const b = await newLead(owner);
    const bad = await owner.post('/api/v1/leads/bulk', { ids: [a.id, b.id], action: 'move_stage', stageId: st.lost });
    expect(bad.status).toBe(200);
    expect(bad.body.data.updated).toBe(0);
    expect(bad.body.data.skipped).toHaveLength(2);
    const good = await owner.post('/api/v1/leads/bulk', { ids: [a.id, b.id], action: 'move_stage', stageId: st.lost, reasonCode: 'no_response' });
    expect(good.body.data.updated).toBe(2);
    expect((await owner.get(`/api/v1/leads/${a.id}`)).body.data.lossReasonCode).toBe('no_response');
  });

  it('a pipeline made earlier keeps its original rule (a written reason), and the requirement can be switched on or off', async () => {
    const legacy = await h.register({ emailPrefix: 's2leg', legacyPipeline: true });
    const p = (await legacy.get('/api/v1/pipelines')).body.data.find((x: any) => x.isDefault);
    expect(p).toMatchObject({ reasonCodesRequired: false, template: null });
    const st = Object.fromEntries(p.stages.map((s: any) => [s.stageKey, s.id]));
    await legacy.put(`/api/v1/pipelines/${p.id}/transitions`, { restricted: false, transitions: [] });
    const l1 = await newLead(legacy);
    const noText = await move(legacy, l1.id, st.lost);
    expect(noText.status).toBe(400);
    expect(noText.body.errors[0].path).toBe('body.lossReason'); // today's rule, unchanged
    const withText = await move(legacy, l1.id, st.lost, { lossReason: 'Went with a competitor' });
    expect(withText.body.data).toMatchObject({ status: 'lost', lossReason: 'Went with a competitor', lossReasonCode: null });
    // a code is welcome but optional there
    const l2 = await newLead(legacy);
    expect((await move(legacy, l2.id, st.lost, { reasonCode: 'timing' })).body.data).toMatchObject({ lossReasonCode: 'timing', lossReason: 'Timing did not work' });
    // switch the requirement on: now a code is needed
    expect((await legacy.patch(`/api/v1/pipelines/${p.id}`, { reasonCodesRequired: true })).body.data.reasonCodesRequired).toBe(true);
    const l3 = await newLead(legacy);
    expect((await move(legacy, l3.id, st.lost, { lossReason: 'free text' })).status).toBe(400);
    expect((await move(legacy, l3.id, st.lost, { reasonCode: 'financing' })).status).toBe(200);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'pipeline.update'`, [legacy.tenantId])).rows[0].n).toBeGreaterThan(0);
  });

  it('reports group outcomes by reason, and old leads without one are shown as "No reason recorded"', async () => {
    const ws = await h.register({ emailPrefix: 's2rep' });
    const st = await stagesOf(ws);
    for (const [key, code] of [['lost', 'price_too_high'], ['lost', 'price_too_high'], ['lost', 'timing'], ['not_a_fit', 'spam']] as const) {
      const l = await newLead(ws);
      expect((await move(ws, l.id, st[key], { reasonCode: code })).status).toBe(200);
    }
    const old = await newLead(ws);
    expect((await move(ws, old.id, st.lost, { reasonCode: 'other', lossReason: 'x y' })).status).toBe(200);
    await h.admin.query(`UPDATE leads SET loss_reason_code = NULL WHERE id = $1`, [old.id]); // as if it had been closed before codes existed
    const m = (await ws.get('/api/v1/dashboard/metrics')).body.data.outcomeReasons;
    expect(m.lost).toEqual([
      { code: 'price_too_high', label: 'Price too high', count: 2 },
      { code: 'timing', label: 'Timing did not work', count: 1 },
      { code: 'unspecified', label: 'No reason recorded', count: 1 },
    ]);
    expect(m.notAFit).toEqual([{ code: 'spam', label: 'Spam or junk', count: 1 }]);
  });
});

describe('history does not change when a stage is renamed or re-weighted', () => {
  it('shows each move with the stage name and weight it had at that time', async () => {
    const st = await stagesOf(owner);
    const pid = (await owner.get('/api/v1/pipelines')).body.data[0].id;
    const lead = await newLead(owner);
    expect((await move(owner, lead.id, st.qualified)).status).toBe(200);
    expect((await move(owner, lead.id, st.negotiation)).status).toBe(200);
    // the business renames the stage and changes how likely a deal in it is to close
    expect((await owner.patch(`/api/v1/pipelines/${pid}/stages/${st.negotiation}`, { name: 'Price talks', probability: 40 })).status).toBe(200);
    expect((await move(owner, lead.id, st.booking_reserved)).status).toBe(200);
    const history = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data.history; // newest first
    expect(history.map((x: any) => `${x.fromStage ?? '-'} > ${x.toStage}`)).toEqual(['Price talks > Booked', 'Qualified > Negotiating', 'New enquiry > Qualified', '- > New enquiry']);
    const rows = (await h.admin.query(`SELECT to_stage_name, to_probability, to_status, snapshot_backfilled FROM lead_stage_history WHERE lead_id = $1 ORDER BY created_at`, [lead.id])).rows;
    expect(rows.map((r) => r.to_stage_name)).toEqual(['New enquiry', 'Qualified', 'Negotiating', 'Booked']);
    expect(rows.map((r) => r.to_probability)).toEqual([5, 30, 70, 90]); // 70, not the new 40
    expect(rows.every((r) => r.snapshot_backfilled === false)).toBe(true);
    // the live stage itself did change
    expect((await owner.get('/api/v1/pipelines')).body.data[0].stages.find((s: any) => s.id === st.negotiation)).toMatchObject({ name: 'Price talks', probability: 40 });
  });

  it('the database fills the snapshot whichever code path writes history', async () => {
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    await h.admin.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, reason) VALUES ($1,$2,$3,$4,'written by raw SQL')`, [lead.id, owner.tenantId, st.new, st.qualified]);
    const r = (await h.admin.query(`SELECT from_stage_name, to_stage_name, to_status, to_probability FROM lead_stage_history WHERE lead_id = $1 AND reason = 'written by raw SQL'`, [lead.id])).rows[0];
    expect(r).toMatchObject({ from_stage_name: 'New enquiry', to_stage_name: 'Qualified', to_status: 'qualified', to_probability: 30 });
  });

  it('archiving a stage with leads in it keeps the history readable', async () => {
    const pid = (await owner.get('/api/v1/pipelines')).body.data[0].id;
    const st = await stagesOf(owner);
    const lead = await newLead(owner);
    expect((await move(owner, lead.id, st.viewing_completed)).status).toBe(200);
    const gone = await owner.delete(`/api/v1/pipelines/${pid}/stages/${st.viewing_completed}?moveLeadsTo=${st.negotiation}`);
    expect(gone.status).toBe(200);
    const history = (await owner.get(`/api/v1/leads/${lead.id}`)).body.data.history.map((x: any) => x.toStage);
    expect(history[0]).toBe('Price talks'); // the move made by the archive, using the name at that time
    expect(history).toContain('Site visit done'); // the archived stage still reads correctly
  });
});

describe('adding the recommended pipeline to an existing workspace (explicit, audited, never destructive)', () => {
  let ws: AuthedUser;
  let legacyPipelineId: string;
  let leadId: string;
  beforeAll(async () => {
    ws = await h.register({ emailPrefix: 's2apply', legacyPipeline: true, organisationName: 'Apply Co' });
    legacyPipelineId = (await ws.get('/api/v1/pipelines')).body.data.find((p: any) => p.isDefault).id;
    leadId = (await newLead(ws)).id;
  });

  it('only people who manage pipelines may do it', async () => {
    const m = await h.register({ emailPrefix: 's2apm' });
    await addMember(m, ws.tenantId, 'sales_manager');
    expect((await inWs(m, ws.tenantId).post('/api/v1/pipelines/apply-recommended', {})).status).toBe(403);
    const a = await h.register({ emailPrefix: 's2apa' });
    await addMember(a, ws.tenantId, 'sales_agent');
    expect((await inWs(a, ws.tenantId).post('/api/v1/pipelines/apply-recommended', {})).status).toBe(403);
    expect((await ws.get('/api/v1/pipelines')).body.data).toHaveLength(1); // the refusals changed nothing
  });

  it('adds a second pipeline; the existing pipeline stays the default and nothing moves', async () => {
    const before = (await ws.get(`/api/v1/leads/${leadId}`)).body.data;
    const r = await ws.post('/api/v1/pipelines/apply-recommended', {});
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(true);
    expect(r.body.data.pipeline).toMatchObject({ name: 'Recommended pipeline', template: 'beginner_v1', isDefault: false, reasonCodesRequired: true });
    expect(r.body.data.pipeline.stages).toHaveLength(12);
    const list = (await ws.get('/api/v1/pipelines')).body.data;
    expect(list).toHaveLength(2);
    expect(list.find((p: any) => p.isDefault).id).toBe(legacyPipelineId);
    const after = (await ws.get(`/api/v1/leads/${leadId}`)).body.data;
    expect([after.pipelineId, after.stageId, after.status, after.version]).toEqual([before.pipelineId, before.stageId, before.status, before.version]);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'pipeline.apply_recommended'`, [ws.tenantId])).rows[0].n).toBe(1);
  });

  it('is safe to repeat: the second call changes nothing and says so', async () => {
    const r = await ws.post('/api/v1/pipelines/apply-recommended', {});
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(false);
    expect((await ws.get('/api/v1/pipelines')).body.data).toHaveLength(2);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'pipeline.apply_recommended'`, [ws.tenantId])).rows[0].n).toBe(1);
  });

  it('"make it the default" is a separate, explicit choice that only affects where NEW leads start', async () => {
    const r = await ws.post('/api/v1/pipelines/apply-recommended', { makeDefault: true });
    expect(r.status).toBe(200);
    expect(r.body.data.pipeline.isDefault).toBe(true);
    const list = (await ws.get('/api/v1/pipelines')).body.data;
    expect(list.find((p: any) => p.id === legacyPipelineId).isDefault).toBe(false);
    expect(list.filter((p: any) => p.isDefault)).toHaveLength(1);
    // the old lead is still in the old pipeline, untouched
    expect((await ws.get(`/api/v1/leads/${leadId}`)).body.data.pipelineId).toBe(legacyPipelineId);
    // a new lead starts in the recommended pipeline's first stage
    const fresh = await newLead(ws);
    expect(fresh.stageName).toBe('New enquiry');
    expect(fresh.pipelineId).toBe(r.body.data.pipeline.id);
  });

  it('never touches another workspace', async () => {
    expect((await other.get('/api/v1/pipelines')).body.data).toHaveLength(1);
    expect((await other.get('/api/v1/pipelines')).body.data[0].name).toBe('Sales pipeline');
  });
});

describe('database guarantees around seeding', () => {
  it('the seed functions cannot be called by the application role for another workspace or without a workspace', async () => {
    const c = new pg.Client({ connectionString: h.tdb.apiUrl });
    await c.connect();
    try {
      await expect(c.query(`SELECT app.seed_beginner_pipeline($1)`, [owner.tenantId])).rejects.toThrow(/FORBIDDEN|tenant context/);
      await expect(c.query(`SELECT app.seed_beginner_pipeline_unsafe($1)`, [owner.tenantId])).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('a workspace can hold only one pipeline created from the recommendation', async () => {
    await expect(
      h.admin.query(`INSERT INTO pipelines (tenant_id, name, template) VALUES ($1, 'second copy', 'beginner_v1')`, [owner.tenantId])
    ).rejects.toThrow(/uq_pipeline_template/);
  });

  it('reason codes stored on a lead must look like codes', async () => {
    const lead = await newLead(owner);
    await expect(h.admin.query(`UPDATE leads SET loss_reason_code = 'Not A Code!' WHERE id = $1`, [lead.id])).rejects.toThrow(/ck_leads_reason_code/);
  });
});

describe('one writer of workspace settings', () => {
  it('no code other than the workspace service updates the tenants table', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(process.cwd(), 'server/src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'tests') walk(p);
        } else if (e.name.endsWith('.ts') && /UPDATE\s+tenants\b/i.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p).split(path.sep).join('/'));
      }
    };
    walk(root);
    expect(hits).toEqual(['modules/workspace/service.ts']);
  });
});
