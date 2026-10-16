import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Slice 4: a buyer's shortlist, offers, reservations and the recorded sale (decision D3).
 * Restricted database role throughout. The recommended pipeline is used (Won needs a deal value; Won only from Booked).
 */
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
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

async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Mehta', email: `b${uniq()}@x.test` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
async function newProperty(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/properties', { title: `Unit ${uniq()}`, propertyType: 'apartment', listingType: 'sale', price: 7_000_000, locality: 'Whitefield', city: 'Bangalore', bedrooms: 3, ...extra });
  if (res.status !== 201) throw new Error(`property create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
const offerOn = async (u: AuthedUser, leadId: string, propertyId: string, extra: Record<string, unknown> = {}) => {
  const r = await u.post('/api/v1/reservations', { leadId, propertyId, offerPrice: 6_800_000, ...extra });
  if (r.status !== 201) throw new Error(`offer failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.reservation as any;
};
const reserveIt = (u: AuthedUser, id: string, extra: Record<string, unknown> = {}) => u.post(`/api/v1/reservations/${id}/reserve`, { tokenAmount: 100_000, agreedPrice: 6_900_000, ...extra });
const propStatus = async (id: string) => (await h.admin.query(`SELECT status FROM properties WHERE id = $1`, [id])).rows[0].status as string;
const leadState = async (id: string) => (await h.admin.query(`SELECT s.stage_key, l.status::text AS status FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id WHERE l.id = $1`, [id])).rows[0] as { stage_key: string; status: string };

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 'dlown', organisationName: 'Deals Co' });
  other = await h.register({ emailPrefix: 'dloth', organisationName: 'Other Deals Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', agent2: 'sales_agent', auditor: 'auditor', marketing: 'marketing_manager' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `dl${k}` });
    await addMember(u, owner.tenantId, role);
    made[k] = inWs(u, owner.tenantId);
  }
  ({ manager, agent, agent2, auditor, marketing } = made as Record<keyof typeof roles, AuthedUser>);
  stages = Object.fromEntries((await owner.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('a buyer’s shortlist', () => {
  it('adds a property, lists it with its status, and adding it again returns the same entry', async () => {
    const lead = await newLead(owner);
    const unit = await newProperty(owner);
    const a = await owner.post('/api/v1/shortlist', { leadId: lead.id, propertyId: unit.id, source: 'matching', matchScore: 82 });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ status: 'shortlisted', source: 'matching', matchScore: 82, deal: null, property: { id: unit.id, status: 'available' } });
    const again = await owner.post('/api/v1/shortlist', { leadId: lead.id, propertyId: unit.id });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(a.body.data.id);
    expect((await owner.get(`/api/v1/shortlist?leadId=${lead.id}`)).body.data).toHaveLength(1);
    // interest only: the unit is untouched
    expect(await propStatus(unit.id)).toBe('available');
  });

  it('can be changed, rejected and put back, and removed', async () => {
    const lead = await newLead(owner);
    const unit = await newProperty(owner);
    const id = (await owner.post('/api/v1/shortlist', { leadId: lead.id, propertyId: unit.id })).body.data.id;
    expect((await owner.patch(`/api/v1/shortlist/${id}`, { status: 'rejected', note: 'Too far from school' })).body.data).toMatchObject({ status: 'rejected', note: 'Too far from school' });
    expect((await owner.post('/api/v1/shortlist', { leadId: lead.id, propertyId: unit.id })).body.data.status).toBe('shortlisted');
    expect((await owner.delete(`/api/v1/shortlist/${id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/shortlist?leadId=${lead.id}`)).body.data).toHaveLength(0);
    expect((await owner.patch(`/api/v1/shortlist/${id}`, { status: 'interested' })).status).toBe(404);
  });

  it('a salesperson works their own buyers only; auditors and other workspaces get nothing', async () => {
    const mine = await newLead(owner, { ownerId: agent.userId });
    const theirs = await newLead(owner, { ownerId: agent2.userId });
    const unit = await newProperty(owner);
    expect((await agent.post('/api/v1/shortlist', { leadId: mine.id, propertyId: unit.id })).status).toBe(201);
    expect((await agent.post('/api/v1/shortlist', { leadId: theirs.id, propertyId: unit.id })).status).toBe(404);
    expect((await agent.get(`/api/v1/shortlist?leadId=${theirs.id}`)).status).toBe(404);
    expect((await manager.get(`/api/v1/shortlist?leadId=${mine.id}`)).body.data).toHaveLength(1);
    expect((await auditor.get(`/api/v1/shortlist?leadId=${mine.id}`)).status).toBe(403);
    expect((await other.get(`/api/v1/shortlist?leadId=${mine.id}`)).status).toBe(404);
    const foreignUnit = await newProperty(other);
    expect((await owner.post('/api/v1/shortlist', { leadId: mine.id, propertyId: foreignUnit.id })).status).toBe(400);
  });

  it('cannot be removed while the buyer has an open offer on the property', async () => {
    const lead = await newLead(owner);
    const unit = await newProperty(owner);
    await offerOn(owner, lead.id, unit.id);
    const item = (await owner.get(`/api/v1/shortlist?leadId=${lead.id}`)).body.data[0];
    expect(item).toMatchObject({ status: 'interested', source: 'offer', deal: { status: 'offered' } });
    expect((await owner.delete(`/api/v1/shortlist/${item.id}`)).status).toBe(409);
  });
});

describe('offers', () => {
  it('make the unit “under offer”, move the lead forward to negotiation, and say so', async () => {
    const lead = await newLead(owner);
    const unit = await newProperty(owner);
    const r = await owner.post('/api/v1/reservations', { leadId: lead.id, propertyId: unit.id, offerPrice: 6_500_000, note: 'Wants parking included' });
    expect(r.status).toBe(201);
    expect(r.headers.etag).toBeTruthy();
    expect(r.body.data.reservation).toMatchObject({ status: 'offered', offerPrice: 6_500_000, dealValue: null, currency: 'INR', lead: { id: lead.id }, property: { id: unit.id }, allowed: ['reserve', 'complete', 'close', 'edit'] });
    expect(r.body.data.leadStage).toMatchObject({ moved: true, stageName: expect.stringMatching(/negotiat/i) });
    expect(await propStatus(unit.id)).toBe('under_offer');
    expect(await leadState(lead.id)).toMatchObject({ stage_key: 'negotiation', status: 'negotiation' });
    const history = (await h.admin.query(`SELECT to_status, reason FROM property_status_history WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1`, [unit.id])).rows[0];
    expect(history).toMatchObject({ to_status: 'under_offer', reason: 'Offer received' });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'reservation.offer'`, [r.body.data.reservation.id])).rows[0].n).toBe(1);
  });

  it('never move a lead backwards', async () => {
    const lead = await newLead(owner);
    const unit = await newProperty(owner);
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.booking_reserved })).status).toBe(200);
    const r = await owner.post('/api/v1/reservations', { leadId: lead.id, propertyId: unit.id });
    expect(r.status).toBe(201);
    expect(r.body.data.leadStage.moved).toBe(false);
    expect((await leadState(lead.id)).stage_key).toBe('booking_reserved');
  });

  it('several buyers may offer on one unit, but one buyer cannot offer twice', async () => {
    const unit = await newProperty(owner);
    const a = await newLead(owner);
    const b = await newLead(owner);
    await offerOn(owner, a.id, unit.id);
    await offerOn(owner, b.id, unit.id);
    expect((await owner.get(`/api/v1/reservations/by-property/${unit.id}`)).body.data).toMatchObject({ status: 'under_offer', openOffers: 2, holder: null });
    const dup = await owner.post('/api/v1/reservations', { leadId: a.id, propertyId: unit.id });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe('already_open');
  });

  it('are refused for units that cannot take them, closed leads, archived leads and colleagues’ buyers', async () => {
    const lead = await newLead(owner);
    for (const status of ['inactive'] as const) {
      const unit = await newProperty(owner);
      expect((await owner.post(`/api/v1/properties/${unit.id}/status`, { status })).status).toBe(200);
      expect((await owner.post('/api/v1/reservations', { leadId: lead.id, propertyId: unit.id })).status).toBe(422);
    }
    const closed = await newLead(owner);
    expect((await owner.post(`/api/v1/leads/${closed.id}/stage`, { stageId: stages.lost, reasonCode: 'bought_elsewhere' })).status).toBe(200);
    expect((await owner.post('/api/v1/reservations', { leadId: closed.id, propertyId: (await newProperty(owner)).id })).status).toBe(422);
    const archived = await newLead(owner);
    expect((await owner.delete(`/api/v1/leads/${archived.id}`)).status).toBe(204);
    expect((await owner.post('/api/v1/reservations', { leadId: archived.id, propertyId: (await newProperty(owner)).id })).status).toBe(404);
    const theirs = await newLead(owner, { ownerId: agent2.userId });
    expect((await agent.post('/api/v1/reservations', { leadId: theirs.id, propertyId: (await newProperty(owner)).id })).status).toBe(404);
    expect((await auditor.post('/api/v1/reservations', { leadId: lead.id, propertyId: (await newProperty(owner)).id })).status).toBe(403);
    expect((await marketing.post('/api/v1/reservations', { leadId: lead.id, propertyId: (await newProperty(owner)).id })).status).toBe(403);
    expect((await other.post('/api/v1/reservations', { leadId: lead.id, propertyId: (await newProperty(other)).id })).status).toBe(404);
  });
});

describe('reserving a unit', () => {
  it('holds it for one buyer, moves the lead to Booked and tells other buyers’ agents', async () => {
    const unit = await newProperty(owner);
    const mine = await newLead(owner, { ownerId: agent.userId });
    const rival = await newLead(owner, { ownerId: agent2.userId });
    const offer = await offerOn(agent, mine.id, unit.id);
    await offerOn(agent2, rival.id, unit.id);
    const r = await reserveIt(agent, offer.id, { holdUntil: '2037-01-01T00:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.data.reservation).toMatchObject({ status: 'reserved', tokenAmount: 100_000, agreedPrice: 6_900_000, dealValue: null, holdOverdue: false });
    expect(r.body.data.leadStage).toMatchObject({ moved: true });
    expect(await propStatus(unit.id)).toBe('reserved');
    expect(await leadState(mine.id)).toMatchObject({ stage_key: 'booking_reserved' });
    // booking is a milestone, not a sale: nothing counts as won deal value
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM reservations WHERE id = $1 AND deal_value IS NOT NULL`, [offer.id])).rows[0].n).toBe(0);
    const note = (await h.admin.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'reservation_held'`, [agent2.userId])).rows;
    expect(note).toHaveLength(1);
  });

  it('shows who holds the unit, to people who may see that buyer and only the agent to everyone else', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner, { ownerId: agent.userId });
    const offer = await offerOn(agent, lead.id, unit.id);
    await reserveIt(agent, offer.id);
    const mgr = (await manager.get(`/api/v1/reservations/by-property/${unit.id}`)).body.data;
    expect(mgr).toMatchObject({ status: 'reserved', holder: { visible: true, reservationId: offer.id, leadId: lead.id, tokenAmount: 100_000, agreedPrice: 6_900_000 } });
    expect(mgr.holder.buyer).toBeTruthy();
    const colleague = (await agent2.get(`/api/v1/reservations/by-property/${unit.id}`)).body.data;
    expect(colleague.holder).toMatchObject({ visible: false, buyer: null, reservationId: null, leadId: null, tokenAmount: null, agreedPrice: null });
    expect(colleague.holder.agent).toBeTruthy();
    expect((await auditor.get(`/api/v1/reservations/by-property/${unit.id}`)).status).toBe(403);
  });

  it('two simultaneous reservations: exactly one wins, the others are told it is already reserved', async () => {
    const unit = await newProperty(owner);
    const buyers = await Promise.all(Array.from({ length: 6 }, () => newLead(owner)));
    const offers = [];
    for (const b of buyers) offers.push(await offerOn(owner, b.id, unit.id));
    const results = await Promise.all(offers.map((o) => reserveIt(owner, o.id)));
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status !== 200);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(5);
    for (const l of lost) expect(l.status).toBe(409);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM reservations WHERE property_id = $1 AND status = 'reserved'`, [unit.id])).rows[0].n).toBe(1);
    expect(await propStatus(unit.id)).toBe('reserved');
  });

  it('is guaranteed by the database too, not only by the code', async () => {
    const unit = await newProperty(owner);
    const a = await newLead(owner);
    const b = await newLead(owner);
    const oa = await offerOn(owner, a.id, unit.id);
    const ob = await offerOn(owner, b.id, unit.id);
    await reserveIt(owner, oa.id);
    await expect(h.admin.query(`UPDATE reservations SET status = 'reserved', reserved_at = now(), agreed_price = 1, token_amount = 1 WHERE id = $1`, [ob.id])).rejects.toThrow(/uq_reservation_one_holder/);
    // a second row for the same buyer and unit while one is open is also impossible
    await expect(h.admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, status, currency) VALUES ($1,$2,$3,'offered','INR')`, [owner.tenantId, a.id, unit.id])).rejects.toThrow(/uq_reservation_one_open_each/);
  });

  it('needs the token and the agreed price, only works from an offer, and not on a unit someone else holds', async () => {
    const unit = await newProperty(owner);
    const a = await newLead(owner);
    const b = await newLead(owner);
    const oa = await offerOn(owner, a.id, unit.id);
    const ob = await offerOn(owner, b.id, unit.id);
    expect((await owner.post(`/api/v1/reservations/${oa.id}/reserve`, { agreedPrice: 1 })).status).toBe(400);
    expect((await owner.post(`/api/v1/reservations/${oa.id}/reserve`, { tokenAmount: 1 })).status).toBe(400);
    expect((await reserveIt(owner, oa.id)).status).toBe(200);
    expect((await reserveIt(owner, oa.id)).status).toBe(409);
    // the screen is not offered actions the server would refuse
    expect((await owner.get(`/api/v1/reservations/${ob.id}`)).body.data.allowed).toEqual(['close', 'edit']);
    const refused = await reserveIt(owner, ob.id);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('already_reserved');
    // and a new buyer cannot even make an offer on a reserved unit
    expect((await owner.post('/api/v1/reservations', { leadId: (await newLead(owner)).id, propertyId: unit.id })).status).toBe(409);
  });

  it('stale edits are refused (If-Match) and agents cannot touch colleagues’ deals', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner, { ownerId: agent.userId });
    const offer = await offerOn(agent, lead.id, unit.id);
    const fresh = await agent.get(`/api/v1/reservations/${offer.id}`);
    const etag = fresh.headers.etag as string;
    expect((await agent.patch(`/api/v1/reservations/${offer.id}`, { offerPrice: 6_600_000 }, { 'If-Match': etag })).status).toBe(200);
    expect((await agent.patch(`/api/v1/reservations/${offer.id}`, { offerPrice: 6_700_000 }, { 'If-Match': etag })).status).toBe(412);
    expect((await agent.patch(`/api/v1/reservations/${offer.id}`, { agreedPrice: 5 })).status).toBe(400); // agreed price belongs to a reservation
    expect((await agent2.get(`/api/v1/reservations/${offer.id}`)).status).toBe(404);
    expect((await reserveIt(agent2, offer.id)).status).toBe(404);
    expect((await auditor.get(`/api/v1/reservations/${offer.id}`)).status).toBe(403); // auditors see the audit trail, not buyers
    expect((await reserveIt(auditor, offer.id)).status).toBe(403);
    expect((await other.get(`/api/v1/reservations/${offer.id}`)).status).toBe(404);
  });
});

describe('closing without a sale', () => {
  it('releasing a reservation puts the unit back on the market (or under offer while others are open)', async () => {
    const unit = await newProperty(owner);
    const a = await newLead(owner);
    const b = await newLead(owner);
    const oa = await offerOn(owner, a.id, unit.id);
    const ob = await offerOn(owner, b.id, unit.id);
    await reserveIt(owner, oa.id);
    const r = await owner.post(`/api/v1/reservations/${oa.id}/close`, { reason: 'financing_failed' });
    expect(r.status).toBe(200);
    expect(r.body.data.reservation).toMatchObject({ status: 'closed', closedReason: { code: 'financing_failed' } });
    expect(await propStatus(unit.id)).toBe('under_offer'); // b still has an offer
    expect((await owner.post(`/api/v1/reservations/${ob.id}/close`, { reason: 'other', note: 'Changed their mind' })).status).toBe(200);
    expect(await propStatus(unit.id)).toBe('available');
    // the lead stays where it was: nobody decided it is lost
    expect((await leadState(a.id)).stage_key).toBe('booking_reserved');
    // a freed unit can be reserved by someone else
    const c = await newLead(owner);
    expect((await reserveIt(owner, (await offerOn(owner, c.id, unit.id)).id)).status).toBe(200);
  });

  it('needs a listed reason, and “other” needs words; a closed deal stays closed', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner);
    const o = await offerOn(owner, lead.id, unit.id);
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, {})).status).toBe(400);
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, { reason: 'unit_taken' })).status).toBe(400); // system-only reason
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, { reason: 'other' })).status).toBe(400);
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, { reason: 'buyer_withdrew' })).status).toBe(200);
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, { reason: 'buyer_withdrew' })).status).toBe(409);
    expect((await reserveIt(owner, o.id)).status).toBe(409);
    expect((await owner.get('/api/v1/reservations/close-reasons')).body.data.map((r: any) => r.code)).toContain('hold_expired');
  });
});

describe('the sale: Won needs a recorded deal value tied to a unit (D3)', () => {
  it('records the sale from the reservation: deal value, unit sold, lead Won, rivals closed and told', async () => {
    const unit = await newProperty(owner);
    const buyer = await newLead(owner, { ownerId: agent.userId });
    const rival = await newLead(owner, { ownerId: agent2.userId });
    const offer = await offerOn(agent, buyer.id, unit.id);
    const rivalOffer = await offerOn(agent2, rival.id, unit.id);
    await reserveIt(agent, offer.id);
    const done = await agent.post(`/api/v1/reservations/${offer.id}/complete`, { dealValue: 6_850_000 });
    expect(done.status).toBe(200);
    expect(done.body.data.reservation).toMatchObject({ status: 'completed', dealValue: 6_850_000, allowed: [] });
    expect(done.body.data.leadStage).toMatchObject({ moved: true });
    expect(await propStatus(unit.id)).toBe('sold');
    expect(await leadState(buyer.id)).toMatchObject({ stage_key: 'won', status: 'won' });
    const lost = (await h.admin.query(`SELECT status, closed_reason FROM reservations WHERE id = $1`, [rivalOffer.id])).rows[0];
    expect(lost).toEqual({ status: 'closed', closed_reason: 'unit_taken' });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'reservation_closed'`, [agent2.userId])).rows[0].n).toBe(1);
    expect((await h.admin.query(`SELECT reason FROM property_status_history WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1`, [unit.id])).rows[0].reason).toBe('Sale recorded');
    // the sale is final: it cannot be completed or closed again, and the unit cannot be changed by hand
    expect((await agent.post(`/api/v1/reservations/${offer.id}/complete`, { dealValue: 1 })).status).toBe(409);
    expect((await agent.post(`/api/v1/reservations/${offer.id}/close`, { reason: 'buyer_withdrew' })).status).toBe(409);
    const manual = await manager.post(`/api/v1/properties/${unit.id}/status`, { status: 'available', reason: 'oops' });
    expect(manual.status).toBe(409);
    expect(manual.body.reason).toBe('recorded_sale');
  });

  it('a lead moved back after reserving is put back to Booked when the sale is recorded; one parked beyond Booked is refused cleanly', async () => {
    const back = await newLead(owner);
    const o1 = await offerOn(owner, back.id, (await newProperty(owner)).id);
    await reserveIt(owner, o1.id);
    expect((await owner.post(`/api/v1/leads/${back.id}/stage`, { stageId: stages.negotiation })).status).toBe(200);
    expect((await owner.post(`/api/v1/reservations/${o1.id}/complete`, { dealValue: 5_000_000 })).status).toBe(200);
    expect(await leadState(back.id)).toMatchObject({ stage_key: 'won' });

    const parked = await newLead(owner);
    const unit = await newProperty(owner);
    const o2 = await offerOn(owner, parked.id, unit.id);
    await reserveIt(owner, o2.id);
    await h.admin.query(`UPDATE leads SET next_followup_at = '2037-01-01T00:00:00Z' WHERE id = $1`, [parked.id]); // "Follow up later" needs a date
    expect((await owner.post(`/api/v1/leads/${parked.id}/stage`, { stageId: stages.follow_up_later })).status).toBe(200);
    const r = await owner.post(`/api/v1/reservations/${o2.id}/complete`, { dealValue: 5_000_000 });
    expect(r.status).toBe(409);
    expect(await leadState(parked.id)).toMatchObject({ stage_key: 'follow_up_later' });
    expect(await propStatus(unit.id)).toBe('reserved');
    expect((await h.admin.query(`SELECT status FROM reservations WHERE id = $1`, [o2.id])).rows[0].status).toBe('reserved');
  });

  it('a rental is recorded as rented', async () => {
    const unit = await newProperty(owner, { listingType: 'rent', price: 45_000 });
    const lead = await newLead(owner);
    const o = await offerOn(owner, lead.id, unit.id, { offerPrice: 42_000 });
    await reserveIt(owner, o.id, { tokenAmount: 42_000, agreedPrice: 43_000 });
    expect((await owner.post(`/api/v1/reservations/${o.id}/complete`, { dealValue: 43_000 })).status).toBe(200);
    expect(await propStatus(unit.id)).toBe('rented');
  });

  it('moving a lead to Won without a deal value is refused in this pipeline, and nothing changes', async () => {
    const lead = await newLead(owner);
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.booking_reserved })).status).toBe(200);
    const refused = await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.won });
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toBe('deal_value_required');
    expect(await leadState(lead.id)).toMatchObject({ stage_key: 'booking_reserved' });
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.won, deal: { dealValue: 0, propertyId: (await newProperty(owner)).id } })).status).toBe(400);
  });

  it('moving to Won with a deal records the sale in the same step (no reservation needed first)', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner);
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.booking_reserved })).status).toBe(200);
    const won = await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.won, deal: { propertyId: unit.id, dealValue: 6_400_000 } });
    expect(won.status).toBe(200);
    expect(await propStatus(unit.id)).toBe('sold');
    const row = (await h.admin.query(`SELECT status, deal_value::float8 AS v, lead_id FROM reservations WHERE property_id = $1`, [unit.id])).rows[0];
    expect(row).toEqual({ status: 'completed', v: 6_400_000, lead_id: lead.id });
  });

  it('is all-or-nothing: if the unit cannot be sold the lead does not become Won', async () => {
    const unit = await newProperty(owner);
    const holder = await newLead(owner);
    await reserveIt(owner, (await offerOn(owner, holder.id, unit.id)).id);
    const lead = await newLead(owner);
    expect((await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.booking_reserved })).status).toBe(200);
    const r = await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.won, deal: { propertyId: unit.id, dealValue: 5_000_000 } });
    expect(r.status).toBe(409);
    expect(await leadState(lead.id)).toMatchObject({ stage_key: 'booking_reserved' });
    expect(await propStatus(unit.id)).toBe('reserved');
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM reservations WHERE lead_id = $1`, [lead.id])).rows[0].n).toBe(0);
    // the pipeline's own rule still holds: Won only from Booked
    const early = await newLead(owner);
    const free = await newProperty(owner);
    const bad = await owner.post(`/api/v1/leads/${early.id}/stage`, { stageId: stages.won, deal: { propertyId: free.id, dealValue: 5_000_000 } });
    expect(bad.status).toBe(409);
    expect(await propStatus(free.id)).toBe('available');
  });

  it('bulk moves to Won are skipped with the reason, not half-done', async () => {
    const lead = await newLead(owner);
    await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.booking_reserved });
    const r = await owner.post('/api/v1/leads/bulk', { ids: [lead.id], action: 'move_stage', stageId: stages.won });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ updated: 0 });
    expect(r.body.data.skipped[0].reason).toMatch(/deal value/i);
  });

  it('pipelines made before this feature keep working until an admin switches the requirement on', async () => {
    const old = await h.register({ emailPrefix: 'dlold', organisationName: 'Old Pipeline Co', legacyPipeline: true });
    const p = (await old.get('/api/v1/pipelines')).body.data[0];
    expect(p.dealValueRequired).toBe(false);
    const st = Object.fromEntries(p.stages.map((s: any) => [s.stageKey, s.id]));
    const lead = await newLead(old);
    for (const k of ['contact_attempted', 'contacted', 'qualified', 'negotiation', 'booking_reserved']) await old.post(`/api/v1/leads/${lead.id}/stage`, { stageId: st[k] });
    expect((await old.post(`/api/v1/leads/${lead.id}/stage`, { stageId: st.won })).status).toBe(200);
    // …and its won leads are visible as "won without a recorded sale"
    expect((await old.get('/api/v1/dashboard/metrics')).body.data.leads).toMatchObject({ converted: 1, wonDealValue: 0, wonWithoutDealValue: 1 });
    // an admin can switch the requirement on
    expect((await old.patch(`/api/v1/pipelines/${p.id}`, { dealValueRequired: true })).body.data.dealValueRequired).toBe(true);
    const next = await newLead(old);
    for (const k of ['contact_attempted', 'contacted', 'qualified', 'negotiation', 'booking_reserved']) await old.post(`/api/v1/leads/${next.id}/stage`, { stageId: st[k] });
    expect((await old.post(`/api/v1/leads/${next.id}/stage`, { stageId: st.won })).status).toBe(422);
  });
});

describe('taking a recorded sale back', () => {
  it('reopening a won lead reverses the sale: the unit is available again and the deal stops counting', async () => {
    const ws = await h.register({ emailPrefix: 'dlrev', organisationName: 'Reverse Co' });
    const pst = Object.fromEntries((await ws.get('/api/v1/pipelines')).body.data[0].stages.map((s: any) => [s.stageKey, s.id]));
    const unit = await newProperty(ws);
    const lead = await newLead(ws);
    const o = await offerOn(ws, lead.id, unit.id);
    await reserveIt(ws, o.id);
    await ws.post(`/api/v1/reservations/${o.id}/complete`, { dealValue: 6_000_000 });
    expect((await ws.get('/api/v1/dashboard/metrics')).body.data.leads).toMatchObject({ wonDealValue: 6_000_000, converted: 1, wonWithoutDealValue: 0 });
    const re = await ws.post(`/api/v1/leads/${lead.id}/stage`, { stageId: pst.negotiation, reason: 'Buyer’s loan was refused' });
    expect(re.status).toBe(200);
    expect(await propStatus(unit.id)).toBe('available');
    const dealRow = (await h.admin.query(`SELECT status, closed_reason, closed_note FROM reservations WHERE id = $1`, [o.id])).rows[0];
    expect(dealRow).toEqual({ status: 'closed', closed_reason: 'deal_reversed', closed_note: 'Buyer’s loan was refused' });
    expect((await ws.get('/api/v1/dashboard/metrics')).body.data.leads).toMatchObject({ wonDealValue: 0, converted: 0 });
    expect((await h.admin.query(`SELECT reason FROM property_status_history WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1`, [unit.id])).rows[0].reason).toMatch(/^Reversed: /);
  });

  it('only people who manage inventory can do it: a salesperson is told to ask a manager, and nothing changes', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner, { ownerId: agent.userId });
    const o = await offerOn(agent, lead.id, unit.id);
    await reserveIt(agent, o.id);
    await agent.post(`/api/v1/reservations/${o.id}/complete`, { dealValue: 6_100_000 });
    const re = await agent.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.negotiation });
    expect(re.status).toBe(403);
    expect(await propStatus(unit.id)).toBe('sold');
    expect((await leadState(lead.id)).status).toBe('won');
    expect((await manager.post(`/api/v1/leads/${lead.id}/stage`, { stageId: stages.negotiation })).status).toBe(200);
    expect(await propStatus(unit.id)).toBe('available');
  });
});

describe('the unit and its deals stay in step', () => {
  it('the status cannot be changed by hand, or the unit archived, while a buyer has an open deal', async () => {
    const unit = await newProperty(owner);
    const lead = await newLead(owner);
    const o = await offerOn(owner, lead.id, unit.id);
    const a = await manager.post(`/api/v1/properties/${unit.id}/status`, { status: 'available' });
    expect(a.status).toBe(409);
    expect(a.body.reason).toBe('open_deal');
    expect((await owner.delete(`/api/v1/properties/${unit.id}`)).status).toBe(409);
    await reserveIt(owner, o.id);
    expect((await manager.post(`/api/v1/properties/${unit.id}/status`, { status: 'sold' })).status).toBe(409);
    expect((await owner.post(`/api/v1/reservations/${o.id}/close`, { reason: 'buyer_withdrew' })).status).toBe(200);
    expect((await manager.post(`/api/v1/properties/${unit.id}/status`, { status: 'inactive' })).status).toBe(200);
  });

  it('lists deals by buyer, unit and status, newest first, with own-scope for salespeople', async () => {
    const lead = await newLead(owner, { ownerId: agent.userId });
    const u1 = await newProperty(owner);
    const u2 = await newProperty(owner);
    const o1 = await offerOn(agent, lead.id, u1.id);
    const o2 = await offerOn(agent, lead.id, u2.id);
    await reserveIt(agent, o2.id);
    const all = (await agent.get(`/api/v1/reservations?leadId=${lead.id}`)).body.data;
    expect(all.map((r: any) => r.id)).toEqual([o2.id, o1.id]);
    expect((await agent.get(`/api/v1/reservations?leadId=${lead.id}&status=reserved`)).body.data.map((r: any) => r.id)).toEqual([o2.id]);
    expect((await agent.get(`/api/v1/reservations?propertyId=${u1.id}&status=offered,reserved`)).body.data).toHaveLength(1);
    expect((await agent.get('/api/v1/reservations?status=nonsense')).status).toBe(400);
    expect((await agent2.get(`/api/v1/reservations?leadId=${lead.id}`)).body.data).toHaveLength(0);
    expect((await manager.get(`/api/v1/reservations?leadId=${lead.id}`)).body.data).toHaveLength(2);
    expect((await other.get(`/api/v1/reservations?leadId=${lead.id}`)).body.data).toHaveLength(0);
    const page = await manager.get('/api/v1/reservations?limit=2');
    expect(page.body.data).toHaveLength(2);
    expect(page.body.page.hasMore).toBeTruthy();
  });
});

describe('people working on the same unit at the same moment', () => {
  it('never deadlock or leave the unit and its deals telling different stories', async () => {
    for (let round = 0; round < 4; round++) {
      const unit = await newProperty(owner);
      const [a, b, c] = await Promise.all([newLead(owner), newLead(owner), newLead(owner)]);
      const oa = await offerOn(owner, a.id, unit.id);
      const ob = await offerOn(owner, b.id, unit.id);
      await reserveIt(owner, oa.id);
      const results = await Promise.all([
        owner.post(`/api/v1/reservations/${oa.id}/complete`, { dealValue: 6_000_000 }),
        reserveIt(manager, ob.id),
        owner.post('/api/v1/reservations', { leadId: c.id, propertyId: unit.id }),
        manager.post(`/api/v1/reservations/${ob.id}/close`, { reason: 'buyer_withdrew' }),
        owner.post(`/api/v1/leads/${b.id}/stage`, { stageId: stages.booking_reserved }),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      expect(results[0].status).toBe(200);
      expect(await propStatus(unit.id)).toBe('sold');
      const rows = (await h.admin.query(`SELECT status, count(*)::int AS n FROM reservations WHERE property_id = $1 GROUP BY status`, [unit.id])).rows;
      const by = Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
      expect(by.completed).toBe(1);
      expect(by.reserved ?? 0).toBe(0);
      expect(by.offered ?? 0).toBe(0); // everything still open when the unit sold was closed
    }
  });
});

describe('reports agree with the ledger', () => {
  it('won deal value on the dashboard and the forecast is the sum of recorded sales, not the estimate typed on the lead', async () => {
    const ws = await h.register({ emailPrefix: 'dlrep', organisationName: 'Report Co' });
    const pipe = (await ws.get('/api/v1/pipelines')).body.data[0];
    let expected = 0;
    for (const value of [6_000_000, 4_500_000]) {
      const unit = await newProperty(ws);
      const lead = await newLead(ws, { estimatedValue: 9_999_999 });
      const o = await offerOn(ws, lead.id, unit.id);
      await reserveIt(ws, o.id);
      expect((await ws.post(`/api/v1/reservations/${o.id}/complete`, { dealValue: value })).status).toBe(200);
      expected += value;
    }
    // a third reservation that is only booked is not revenue
    const booked = await newLead(ws);
    await reserveIt(ws, (await offerOn(ws, booked.id, (await newProperty(ws)).id)).id);
    const sum = Number((await h.admin.query(`SELECT COALESCE(sum(deal_value),0) AS s FROM reservations WHERE tenant_id = $1 AND status = 'completed'`, [ws.tenantId])).rows[0].s);
    expect(sum).toBe(expected);
    const m = (await ws.get('/api/v1/dashboard/metrics')).body.data.leads;
    expect(m).toMatchObject({ converted: 2, wonDealValue: expected, wonWithoutDealValue: 0, wonValue: 2 * 9_999_999 });
    const f = (await ws.get(`/api/v1/pipelines/${pipe.id}/forecast`)).body.data;
    expect(f.won).toMatchObject({ count: 2, dealValue: expected, withoutDealValue: 0 });
  });
});
