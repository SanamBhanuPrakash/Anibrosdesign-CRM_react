import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';
import { buildIcs, icsEscape, icsFold } from '../modules/viewings/ics';

/**
 * Slice 3: the viewing lifecycle (reschedule, cancel, complete with an outcome, no-show), the reminder task behind every visit,
 * and the calendar file. Restricted database role throughout.
 */
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
let auditor: AuthedUser;
let stages: Record<string, string> = {};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
const inWs = (u: AuthedUser, tenantId: string): AuthedUser => {
  const hdr = { 'X-Tenant-Id': tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};

async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Shah', email: `b${uniq()}@x.test`, phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
async function newProperty(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 6_000_000, locality: 'Indiranagar', city: 'Bangalore', bedrooms: 3, bathrooms: 2, areaSqft: 1400, ...extra });
  if (res.status !== 201) throw new Error(`property create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
let slot = 0;
/** A far-future slot, unique per call, so tests never collide. */
const later = (hoursFromBase = 0) => new Date(Date.UTC(2036, 0, 1, 6, 0) + (slot++ * 5 + hoursFromBase) * 3600_000).toISOString();
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const book = async (u: AuthedUser, leadId: string, propertyId: string, scheduledAt: string, extra: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/viewings', { leadId, propertyId, scheduledAt, durationMinutes: 30, ...extra });
  if (r.status !== 201) throw new Error(`book failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
};
const taskOf = async (viewingId: string) => (await h.admin.query(`SELECT t.* FROM tasks t JOIN viewings v ON v.reminder_task_id = t.id WHERE v.id = $1`, [viewingId])).rows[0];

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 'v3own', organisationName: 'Visit Co' });
  other = await h.register({ emailPrefix: 'v3oth', organisationName: 'Other Visit Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', agent2: 'sales_agent', auditor: 'auditor' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `v3${k}` });
    await addMember(u, owner.tenantId, role);
    made[k] = inWs(u, owner.tenantId);
  }
  ({ manager, agent, agent2, auditor } = made as Record<keyof typeof roles, AuthedUser>);
  stages = Object.fromEntries((await owner.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('every visit has a real reminder task', () => {
  it('booking creates a task for the agent, due when the visit starts, with a reminder an hour before', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const at = later();
    const v = await book(agent, lead.id, unit.id, at, { notes: 'Bring the floor plan' });
    const t = await taskOf(v.id);
    expect(t).toMatchObject({ kind: 'meeting', status: 'pending', assigned_to: agent.userId, lead_id: lead.id, remind_before_minutes: 60 });
    expect(t.title).toContain(unit.title);
    expect(new Date(t.due_date).toISOString()).toBe(new Date(at).toISOString());
    expect(new Date(t.remind_at).getTime()).toBe(new Date(at).getTime() - 3600_000);
    // it is the lead's next follow-up, so it shows up wherever follow-ups do
    expect((await h.admin.query(`SELECT next_followup_at FROM leads WHERE id = $1`, [lead.id])).rows[0].next_followup_at.toISOString()).toBe(new Date(at).toISOString());
    expect(t.dedupe_key).toBe(`viewing:${v.id}:reminder`);
  });

  it('a manager booking for an agent gives that agent the task and a notification', async () => {
    const lead = await newLead(manager, { ownerId: agent2.userId });
    const unit = await newProperty(owner);
    const v = await book(manager, lead.id, unit.id, later(), { agentId: agent2.userId });
    const t = await taskOf(v.id);
    expect(t.assigned_to).toBe(agent2.userId);
    const notes = (await h.admin.query(`SELECT * FROM notifications WHERE entity_type = 'task' AND entity_id = $1 AND user_id = $2`, [t.id, agent2.userId])).rows;
    expect(notes).toHaveLength(1);
  });
});

describe('looking at one visit', () => {
  it('an agent sees their own, a colleague’s is a 404, another workspace’s is a 404, and the answer has an ETag', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const v = await book(agent, lead.id, unit.id, later());
    const mine = await agent.get(`/api/v1/viewings/${v.id}`);
    expect(mine.status).toBe(200);
    expect(mine.headers.etag).toBe(`"${v.version}"`);
    expect(mine.body.data.leadContact.firstName).toBeTruthy();
    expect((await agent2.get(`/api/v1/viewings/${v.id}`)).status).toBe(404);
    expect((await manager.get(`/api/v1/viewings/${v.id}`)).status).toBe(200);
    expect((await other.get(`/api/v1/viewings/${v.id}`)).status).toBe(404);
    expect((await auditor.get(`/api/v1/viewings/${v.id}`)).status).toBe(403);
    expect((await owner.get('/api/v1/viewings/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await owner.get('/api/v1/viewings/not-a-uuid')).status).toBe(400);
  });

  it('lists the fixed outcomes', async () => {
    const r = await agent.get('/api/v1/viewings/outcomes');
    expect(r.status).toBe(200);
    expect(r.body.data.map((o: any) => o.code)).toEqual(['interested', 'offer_expected', 'considering', 'wants_other_options', 'not_interested']);
  });
});

describe('rescheduling', () => {
  it('moves the visit and its reminder together, bumps the version and is audited', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const v = await book(agent, lead.id, unit.id, later());
    const to = later();
    const r = await agent.patch(`/api/v1/viewings/${v.id}`, { scheduledAt: to, durationMinutes: 45, notes: 'Parking is tight' }, { 'If-Match': `"${v.version}"` });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ durationMinutes: 45, notes: 'Parking is tight', version: v.version + 1 });
    expect(new Date(r.body.data.scheduledAt).toISOString()).toBe(new Date(to).toISOString());
    expect(r.headers.etag).toBe(`"${v.version + 1}"`);
    const t = await taskOf(v.id);
    expect(new Date(t.due_date).toISOString()).toBe(new Date(to).toISOString());
    expect(new Date(t.remind_at).getTime()).toBe(new Date(to).getTime() - 3600_000);
    expect(t.reminder_sent_at).toBeNull();
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'viewing.reschedule'`, [v.id])).rows[0].n).toBe(1);
    const timeline = (await agent.get(`/api/v1/leads/${lead.id}/activities?limit=20`)).body.data.map((a: any) => a.description);
    expect(timeline.some((d: string) => d.startsWith('Viewing rescheduled to'))).toBe(true);
  });

  it('refuses to overwrite a newer change (If-Match → 412)', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const v = await book(agent, lead.id, unit.id, later());
    expect((await agent.patch(`/api/v1/viewings/${v.id}`, { notes: 'first' }, { 'If-Match': `"${v.version}"` })).status).toBe(200);
    expect((await agent.patch(`/api/v1/viewings/${v.id}`, { notes: 'second' }, { 'If-Match': `"${v.version}"` })).status).toBe(412);
    expect((await agent.get(`/api/v1/viewings/${v.id}`)).body.data.notes).toBe('first');
  });

  it('cannot double-book the property or the agent, and a freed slot can be taken', async () => {
    const unit = await newProperty(owner);
    const base = Date.UTC(2037, 2, 1, 9, 0);
    const iso = (min: number) => new Date(base + min * 60_000).toISOString();
    const l1 = await newLead(agent);
    const l2 = await newLead(agent);
    const a = await book(agent, l1.id, unit.id, iso(0));
    const b = await book(agent, l2.id, unit.id, iso(60));
    const clash = await agent.patch(`/api/v1/viewings/${b.id}`, { scheduledAt: iso(15) });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
    // the same agent in a different property at the same time
    const unit2 = await newProperty(owner);
    const l3 = await newLead(agent);
    const c = await book(agent, l3.id, unit2.id, iso(300));
    const busy = await agent.patch(`/api/v1/viewings/${c.id}`, { scheduledAt: iso(10) });
    expect(busy.status).toBe(409);
    // after cancelling the first visit, its slot is free
    expect((await agent.post(`/api/v1/viewings/${a.id}/cancel`, {})).status).toBe(200);
    expect((await agent.patch(`/api/v1/viewings/${b.id}`, { scheduledAt: iso(15) })).status).toBe(200);
  });

  it('six simultaneous moves into one slot: exactly one wins', async () => {
    const unit = await newProperty(owner);
    const visits = [];
    for (let i = 0; i < 6; i++) visits.push(await book(manager, (await newLead(manager)).id, unit.id, later()));
    const target = new Date(Date.UTC(2038, 5, 1, 12, 0)).toISOString();
    const results = await Promise.all(visits.map((v) => manager.patch(`/api/v1/viewings/${v.id}`, { scheduledAt: target })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('applies the same availability rule as booking: a unit that is no longer open to visits cannot have its visit moved', async () => {
    const lead = await newLead(manager);
    const unit = await newProperty(owner);
    const v = await book(manager, lead.id, unit.id, later());
    expect((await owner.post(`/api/v1/properties/${unit.id}/status`, { status: 'reserved' })).status).toBe(200);
    const r = await manager.patch(`/api/v1/viewings/${v.id}`, { scheduledAt: later() });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/reserved/);
    // cancelling is still possible
    expect((await manager.post(`/api/v1/viewings/${v.id}/cancel`, { reason: 'Unit reserved for someone else' })).status).toBe(200);
  });

  it('validates the input, the agent and the roles', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    const unit = await newProperty(owner);
    const v = await book(manager, lead.id, unit.id, later(), { agentId: agent.userId });
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { durationMinutes: 1 })).status).toBe(400);
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { scheduledAt: 'tomorrow' })).status).toBe(400);
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { status: 'completed' })).status).toBe(400); // status is not editable this way
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { agentId: other.userId })).status).toBe(400); // not a member of this workspace
    expect((await agent.patch(`/api/v1/viewings/${v.id}`, { agentId: agent2.userId })).status).toBe(403); // an agent cannot hand work to a colleague
    expect((await agent2.patch(`/api/v1/viewings/${v.id}`, { notes: 'x' })).status).toBe(404); // not theirs
    expect((await auditor.patch(`/api/v1/viewings/${v.id}`, { notes: 'x' })).status).toBe(403);
    const handed = await manager.patch(`/api/v1/viewings/${v.id}`, { agentId: agent2.userId });
    expect(handed.status).toBe(200);
    expect(handed.body.data.agent.id).toBe(agent2.userId);
    expect((await taskOf(v.id)).assigned_to).toBe(agent2.userId); // the reminder follows the agent
  });

  it('a lead that has been archived blocks changes until it is restored', async () => {
    const lead = await newLead(manager);
    const unit = await newProperty(owner);
    const v = await book(manager, lead.id, unit.id, later());
    expect((await owner.delete(`/api/v1/leads/${lead.id}`)).status).toBe(204);
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { notes: 'x' })).status).toBe(409);
    expect((await owner.post(`/api/v1/leads/${lead.id}/restore`)).status).toBe(200);
    expect((await manager.patch(`/api/v1/viewings/${v.id}`, { notes: 'x' })).status).toBe(200);
  });
});

describe('cancelling', () => {
  it('records the reason, frees the slot, closes the reminder and says so on the lead', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const at = later();
    const v = await book(agent, lead.id, unit.id, at);
    const r = await agent.post(`/api/v1/viewings/${v.id}/cancel`, { reason: 'Buyer is travelling' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Buyer is travelling' });
    expect(r.body.data.closedAt).toBeTruthy();
    expect((await taskOf(v.id)).status).toBe('cancelled');
    expect((await h.admin.query(`SELECT next_followup_at FROM leads WHERE id = $1`, [lead.id])).rows[0].next_followup_at).toBeNull();
    expect((await agent.get(`/api/v1/leads/${lead.id}/activities?limit=20`)).body.data.map((a: any) => a.description)).toContain('Viewing cancelled: Buyer is travelling');
    // the same slot can be booked again
    expect((await agent.post('/api/v1/viewings', { leadId: lead.id, propertyId: unit.id, scheduledAt: at, durationMinutes: 30 })).status).toBe(201);
  });

  it('only a visit that has not happened can be cancelled, and only once', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const v = await book(agent, lead.id, unit.id, later());
    expect((await agent.post(`/api/v1/viewings/${v.id}/cancel`, {})).status).toBe(200);
    const again = await agent.post(`/api/v1/viewings/${v.id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.detail).toMatch(/already cancelled/);
    expect((await agent.patch(`/api/v1/viewings/${v.id}`, { notes: 'x' })).status).toBe(409);
    expect((await agent2.post(`/api/v1/viewings/${v.id}/cancel`, {})).status).toBe(404);
  });
});

describe('completing a visit', () => {
  const pastVisit = async (u: AuthedUser, leadOwner: AuthedUser = u, minutesAgo = 90) => {
    const lead = await newLead(leadOwner);
    const unit = await newProperty(owner);
    return { lead, unit, v: await book(u, lead.id, unit.id, ago(minutesAgo)) };
  };

  it('is refused before the visit starts', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const v = await book(agent, lead.id, unit.id, later());
    const r = await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested' });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/not started/);
    expect((await agent.get(`/api/v1/viewings/${v.id}`)).body.data.status).toBe('scheduled');
  });

  it('records the outcome, closes the reminder, creates exactly one follow-up, and OFFERS the next stage without moving the lead', async () => {
    const { lead, v } = await pastVisit(agent);
    const due = new Date(Date.now() + 2 * 86400_000).toISOString();
    const r = await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'offer_expected', note: 'Loved the balcony', followUp: { dueAt: due } });
    expect(r.status).toBe(200);
    expect(r.body.data.viewing).toMatchObject({ status: 'completed', outcome: { code: 'offer_expected', label: 'Likely to make an offer' }, outcomeNote: 'Loved the balcony' });
    expect(r.body.data.followUp.title).toMatch(/^Follow up after the visit: /);
    expect(new Date(r.body.data.followUp.dueDate).toISOString()).toBe(due);
    expect(r.body.data.suggestedStage).toMatchObject({ name: 'Site visit done' });
    // offered, not applied
    expect((await agent.get(`/api/v1/leads/${lead.id}`)).body.data.stageName).toBe('New enquiry');
    expect((await taskOf(v.id)).status).toBe('completed');
    const follow = (await h.admin.query(`SELECT * FROM tasks WHERE lead_id = $1 AND kind = 'follow_up'`, [lead.id])).rows;
    expect(follow).toHaveLength(1);
    expect(follow[0].assigned_to).toBe(agent.userId);
    // the person follows the offer and the move works
    expect((await agent.post(`/api/v1/leads/${lead.id}/stage`, { stageId: r.body.data.suggestedStage.stageId })).status).toBe(200);
    expect((await agent.get(`/api/v1/leads/${lead.id}`)).body.data.stageName).toBe('Site visit done');
    expect((await agent.get(`/api/v1/leads/${lead.id}/activities?limit=20`)).body.data.map((a: any) => a.description).some((d: string) => d.startsWith('Viewing completed: Likely to make an offer'))).toBe(true);
  });

  it('completing twice is refused and creates no second follow-up', async () => {
    const { lead, v } = await pastVisit(agent);
    const due = new Date(Date.now() + 86400_000).toISOString();
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'considering', followUp: { dueAt: due } })).status).toBe(200);
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'considering', followUp: { dueAt: due } })).status).toBe(409);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1 AND kind = 'follow_up'`, [lead.id])).rows[0].n).toBe(1);
  });

  it('offers no stage when the lead is already beyond it, and creates no follow-up unless asked', async () => {
    const { lead, v } = await pastVisit(manager);
    expect((await manager.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.negotiation })).status).toBe(200);
    const r = await manager.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested' });
    expect(r.body.data.suggestedStage).toBeNull();
    expect(r.body.data.followUp).toBeNull();
  });

  it('a manager’s follow-up goes to the lead’s owner', async () => {
    const lead = await newLead(manager, { ownerId: agent2.userId });
    const unit = await newProperty(owner);
    const v = await book(manager, lead.id, unit.id, ago(60), { agentId: agent.userId });
    const r = await manager.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'not_interested', followUp: { dueAt: new Date(Date.now() + 86400_000).toISOString(), title: 'Ask for feedback' } });
    expect(r.status).toBe(200);
    expect(r.body.data.followUp.title).toBe('Ask for feedback');
    expect((await h.admin.query(`SELECT assigned_to FROM tasks WHERE id = $1`, [r.body.data.followUp.id])).rows[0].assigned_to).toBe(agent2.userId);
  });

  it('validates the outcome, the note and the role', async () => {
    const { v } = await pastVisit(agent);
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, {})).status).toBe(400);
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'great' })).status).toBe(400);
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested', note: 'x'.repeat(1001) })).status).toBe(400);
    expect((await agent.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested', followUp: { dueAt: 'soon' } })).status).toBe(400);
    expect((await auditor.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested' })).status).toBe(403);
    expect((await agent2.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested' })).status).toBe(404);
    expect((await other.post(`/api/v1/viewings/${v.id}/complete`, { outcome: 'interested' })).status).toBe(404);
  });
});

describe('no-show', () => {
  it('is refused before the visit was due, then recorded, closing the reminder', async () => {
    const lead = await newLead(agent);
    const unit = await newProperty(owner);
    const future = await book(agent, lead.id, unit.id, later());
    expect((await agent.post(`/api/v1/viewings/${future.id}/no-show`, {})).status).toBe(409);
    const past = await book(agent, lead.id, (await newProperty(owner)).id, ago(45));
    const r = await agent.post(`/api/v1/viewings/${past.id}/no-show`, { note: 'Phone was off' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'no_show', outcomeNote: 'Phone was off' });
    expect((await taskOf(past.id)).status).toBe('cancelled');
    expect((await agent.post(`/api/v1/viewings/${past.id}/no-show`, {})).status).toBe(409);
  });
});

describe('the calendar file', () => {
  it('is a valid iCalendar event with the right time, and carries no phone number or e-mail address', async () => {
    const lead = await newLead(agent, { contact: { firstName: 'Meera', lastName: 'Nair', email: 'meera.private@example.com', phone: '+919845012345' } });
    const unit = await newProperty(owner, { title: 'Lakeview 3BHK' });
    const at = later();
    const v = await book(agent, lead.id, unit.id, at, { notes: 'Gate code 4455' });
    const res = await agent.get(`/api/v1/viewings/${v.id}/ics`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="site-visit-2036-/);
    const body = res.text;
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body).toContain('SUMMARY:Site visit: Lakeview 3BHK');
    expect(body).toContain(`UID:viewing-${v.id}@anibros.crm`);
    expect(body).toMatch(/DTSTART:20360\d{3}T\d{6}Z/);
    const start = new Date(at);
    const stamp = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}${String(start.getUTCDate()).padStart(2, '0')}T${String(start.getUTCHours()).padStart(2, '0')}${String(start.getUTCMinutes()).padStart(2, '0')}00Z`;
    expect(body).toContain(`DTSTART:${stamp}`);
    expect(body).toContain('Meera Nair');
    expect(body).toContain('Gate code 4455');
    expect(body).not.toContain('meera.private');
    expect(body).not.toContain('9845012345');
    expect(body.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
    // the same rules as reading: a colleague's visit, another workspace and an auditor get nothing
    expect((await agent2.get(`/api/v1/viewings/${v.id}/ics`)).status).toBe(404);
    expect((await other.get(`/api/v1/viewings/${v.id}/ics`)).status).toBe(404);
    expect((await auditor.get(`/api/v1/viewings/${v.id}/ics`)).status).toBe(403);
    expect((await request(h.app).get(`/api/v1/viewings/${v.id}/ics`)).status).toBe(401);
  });

  it('reflects a cancellation', async () => {
    const lead = await newLead(agent);
    const v = await book(agent, lead.id, (await newProperty(owner)).id, later());
    await agent.post(`/api/v1/viewings/${v.id}/cancel`, {});
    expect((await agent.get(`/api/v1/viewings/${v.id}/ics`)).text).toContain('STATUS:CANCELLED');
  });
});

describe('ICS building (units)', () => {
  it('escapes separators and line breaks so a note can never add properties', () => {
    expect(icsEscape('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    const ics = buildIcs({ id: 'x', scheduledAt: '2036-01-01T06:00:00Z', durationMinutes: 30, status: 'scheduled', notes: 'hello\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:evil', propertyTitle: 'Flat; 2, "B"', propertyLocation: null, buyerName: 'Asha', agentName: null });
    expect(ics.match(/^END:VEVENT$/gm)).toHaveLength(1);
    expect(ics.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1);
    expect(ics).not.toMatch(/^SUMMARY:evil/m);
    expect(ics).toContain('SUMMARY:Site visit: Flat\\; 2\\, "B"');
  });

  it('folds long lines at 75 octets without splitting a multi-byte character', () => {
    const long = 'DESCRIPTION:' + 'é'.repeat(80);
    const folded = icsFold(long);
    for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('uses UTC times and a stable UID', () => {
    const ics = buildIcs({ id: 'abc', scheduledAt: '2036-03-04T05:06:07+05:30', durationMinutes: 90, status: 'confirmed', notes: null, propertyTitle: 'T', propertyLocation: 'Whitefield', buyerName: null, agentName: null }, new Date('2030-01-01T00:00:00Z'));
    expect(ics).toContain('DTSTART:20360303T233607Z');
    expect(ics).toContain('DTEND:20360304T010607Z');
    expect(ics).toContain('UID:viewing-abc@anibros.crm');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('LOCATION:Whitefield');
  });
});
