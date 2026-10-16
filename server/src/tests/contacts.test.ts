import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';
import { normalizeEmail, normalizePhone, normalizeTags, escapeLike } from '../modules/contacts/normalize';

describe('contact normalisation (unit)', () => {
  it('treats every common spelling of a number as the same E.164 key', () => {
    const variants = ['+91 98765 43210', '098765 43210', '9876543210', '+91-98765-43210', '(+91) 98765.43210'];
    expect(new Set(variants.map((v) => normalizePhone(v, 'IN'))).size).toBe(1);
    expect(normalizePhone('9876543210', 'IN')).toBe('+919876543210');
    expect(normalizePhone('+44 20 7946 0958', 'IN')).toBe('+442079460958');
  });
  it('rejects things that are not phone numbers', () => {
    for (const bad of ['', 'abc', '123', '+', '000']) expect(normalizePhone(bad, 'IN')).toBeNull();
  });
  it('lower-cases and validates e-mail', () => {
    expect(normalizeEmail('  Asha.Rao@Example.COM ')).toBe('asha.rao@example.com');
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.d', 'x'.repeat(260) + '@a.com']) expect(normalizeEmail(bad)).toBeNull();
  });
  it('normalises tags and escapes LIKE wildcards', () => {
    expect(normalizeTags([' Hot Lead ', 'hot-lead', 'VIP', ''])).toEqual(['hot-lead', 'vip']);
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let auditor: AuthedUser;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function addMember(user: AuthedUser, tenantId: string, role: string) {
  await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, user.userId, role]);
}
const asTenant = (u: AuthedUser, tenantId: string) => ({ 'X-Tenant-Id': tenantId });

async function addLead(tenantId: string, contactId: string, ownerId: string | null) {
  const s = await h.admin.query(
    `SELECT p.id AS pipeline, s.id AS stage, s.stage_key FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id = p.id WHERE p.tenant_id = $1 ORDER BY s.order_index LIMIT 1`,
    [tenantId]
  );
  const r = await h.admin.query(
    `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, stage_key, source, owner_id) VALUES ($1,$2,$3,$4,$5,'website',$6) RETURNING id`,
    [tenantId, contactId, s.rows[0].pipeline, s.rows[0].stage, s.rows[0].stage_key, ownerId]
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 'cown', organisationName: 'Contacts Co' });
  other = await h.register({ emailPrefix: 'coth', organisationName: 'Other Co' });
  agent = await h.register({ emailPrefix: 'cagt' });
  auditor = await h.register({ emailPrefix: 'caud' });
  await addMember(agent, owner.tenantId, 'sales_agent');
  await addMember(auditor, owner.tenantId, 'auditor');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('contacts API (restricted DB role)', () => {
  it('creates a contact with normalised identifiers, an ETag and an owner', async () => {
    const res = await owner.post('/api/v1/contacts', { firstName: ' Asha ', lastName: 'Rao', email: ' ASHA@Example.com ', phone: '098765 43210', tags: ['Hot Lead', 'vip'], company: 'Rao & Sons' });
    expect(res.status).toBe(201);
    const c = res.body.data;
    expect(c).toMatchObject({ firstName: 'Asha', displayName: 'Asha Rao', email: 'asha@example.com', phone: '+919876543210', tags: ['hot-lead', 'vip'], ownerId: owner.userId, version: 1, leadCount: 0 });
    expect(res.headers.etag).toMatch(/^"1(.[0-9a-f]{8})?"$/);
    const evt = await h.admin.query(`SELECT 1 FROM domain_events WHERE type = 'contact.created' AND aggregate_id = $1`, [c.id]);
    expect(evt.rowCount).toBe(1);
    const aud = await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'contact.create' AND entity_id = $1`, [c.id]);
    expect(aud.rowCount).toBe(1);
  });

  it('validates input with field paths', async () => {
    const bad = await owner.post('/api/v1/contacts', { firstName: 'X', phone: 'not-a-phone', email: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.errors.map((e: any) => e.path)).toContain('body.phone');
    const noName = await owner.post('/api/v1/contacts', { lastName: 'Only' });
    expect(noName.status).toBe(400);
    expect(noName.body.errors[0].path).toBe('body.firstName');
  });

  it('refuses duplicates by any spelling of the e-mail or phone and says who it clashes with', async () => {
    const a = await owner.post('/api/v1/contacts', { firstName: 'Dup', email: `dup${uniq()}@x.com`, phone: '+91 90000 11111', alternatePhones: ['+91 90000 22222'] });
    const emailDup = await owner.post('/api/v1/contacts', { firstName: 'Again', email: a.body.data.email.toUpperCase() });
    expect(emailDup.status).toBe(409);
    expect(emailDup.body.reason).toBe('duplicate_contact');
    expect(emailDup.body.duplicates[0]).toMatchObject({ id: a.body.data.id, matchedOn: ['email'] });
    const altDup = await owner.post('/api/v1/contacts', { firstName: 'Again', phone: '090000 22222' });
    expect(altDup.status).toBe(409);
    expect(altDup.body.duplicates[0].id).toBe(a.body.data.id);

    const look = await owner.get(`/api/v1/contacts/lookup?phone=${encodeURIComponent('90000 11111')}`);
    expect(look.body.data).toEqual([{ id: a.body.data.id, displayName: 'Dup', matchedOn: ['phone'] }]);
  });

  it('is race-safe: eight parallel creates with the same e-mail produce exactly one contact', async () => {
    const email = `race${uniq()}@x.com`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => owner.post('/api/v1/contacts', { firstName: `Racer${i}`, email })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const count = await h.admin.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND email = $2`, [owner.tenantId, email]);
    expect(count.rows[0].n).toBe(1);
  });

  it('isolates tenants: same e-mail is fine elsewhere, ids from another workspace are 404', async () => {
    const email = `iso${uniq()}@x.com`;
    const mine = await owner.post('/api/v1/contacts', { firstName: 'Mine', email });
    const theirs = await other.post('/api/v1/contacts', { firstName: 'Theirs', email });
    expect(theirs.status).toBe(201);
    expect((await other.get(`/api/v1/contacts/${mine.body.data.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/contacts/${mine.body.data.id}`, { firstName: 'Hacked' })).status).toBe(404);
    expect((await other.delete(`/api/v1/contacts/${mine.body.data.id}`)).status).toBe(404);
    const list = await other.get('/api/v1/contacts?limit=200');
    expect(list.body.data.map((c: any) => c.id)).not.toContain(mine.body.data.id);
    // Cannot be smuggled in as an owner or via merge either
    const m = await other.post(`/api/v1/contacts/${theirs.body.data.id}/merge`, { duplicateIds: [mine.body.data.id] });
    expect(m.status).toBe(404);
    const still = await owner.get(`/api/v1/contacts/${mine.body.data.id}`);
    expect(still.status).toBe(200);
  });

  it('enforces roles: auditor blocked, agent limited to what they own and cannot delete or reassign', async () => {
    const t = asTenant(auditor, owner.tenantId);
    expect((await auditor.get('/api/v1/contacts', t)).status).toBe(403);

    const at = asTenant(agent, owner.tenantId);
    const mgrContact = await owner.post('/api/v1/contacts', { firstName: 'Manager-owned', email: `mo${uniq()}@x.com` });
    const mine = await agent.post('/api/v1/contacts', { firstName: 'Agent-owned', email: `ao${uniq()}@x.com` }, at);
    expect(mine.status).toBe(201);
    expect(mine.body.data.ownerId).toBe(agent.userId);

    expect((await agent.get(`/api/v1/contacts/${mgrContact.body.data.id}`, at)).status).toBe(200); // contacts are readable
    expect((await agent.patch(`/api/v1/contacts/${mgrContact.body.data.id}`, { city: 'Pune' }, at)).status).toBe(404); // …but not editable
    expect((await agent.patch(`/api/v1/contacts/${mine.body.data.id}`, { city: 'Pune' }, at)).status).toBe(200);
    expect((await agent.patch(`/api/v1/contacts/${mine.body.data.id}`, { ownerId: owner.userId }, at)).status).toBe(403);
    expect((await agent.post('/api/v1/contacts', { firstName: 'Gift', ownerId: owner.userId }, at)).status).toBe(403);
    expect((await agent.delete(`/api/v1/contacts/${mine.body.data.id}`, at)).status).toBe(403);
    expect((await agent.post(`/api/v1/contacts/${mine.body.data.id}/merge`, { duplicateIds: [mgrContact.body.data.id] }, at)).status).toBe(403);
  });

  it('rejects an owner who is not a member of the workspace', async () => {
    const r = await owner.post('/api/v1/contacts', { firstName: 'Odd', ownerId: other.userId });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toBe('body.ownerId');
  });

  it('updates with optimistic concurrency and keeps identifiers consistent', async () => {
    const email = `upd${uniq()}@x.com`;
    const c = (await owner.post('/api/v1/contacts', { firstName: 'Upd', email, phone: '+91 91111 00000' })).body.data;

    const stale = await owner.patch(`/api/v1/contacts/${c.id}`, { city: 'Delhi' }, { 'If-Match': '"99"' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('PRECONDITION_FAILED');
    const ok = await owner.patch(`/api/v1/contacts/${c.id}`, { city: 'Delhi', lastName: null, phone: null, alternateEmails: [`alt${uniq()}@x.com`] }, { 'If-Match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ city: 'Delhi', phone: null, version: 2, email });
    expect(ok.body.data.alternateEmails).toHaveLength(1);
    expect(ok.headers.etag).toMatch(/^"2(.[0-9a-f]{8})?"$/);

    // phone was cleared → somebody else may now use it; the old email is still ours
    const reuse = await owner.post('/api/v1/contacts', { firstName: 'Reuse', phone: '+91 91111 00000' });
    expect(reuse.status).toBe(201);
    expect((await owner.post('/api/v1/contacts', { firstName: 'Clash', email })).status).toBe(409);

    // changing to an identifier that belongs to someone else is refused, keeping your own is fine
    const clash = await owner.patch(`/api/v1/contacts/${c.id}`, { phone: '+91 91111 00000' });
    expect(clash.status).toBe(409);
    const self = await owner.patch(`/api/v1/contacts/${c.id}`, { email });
    expect(self.status).toBe(200);
  });

  it('paginates with stable keyset cursors for every sort and rejects a cursor from another ordering', async () => {
    const t = await h.register({ emailPrefix: 'pag' });
    for (let i = 0; i < 7; i++) await t.post('/api/v1/contacts', { firstName: `P${String(i).padStart(2, '0')}`, email: `p${i}-${uniq()}@x.com` });
    for (const sort of ['created', 'updated', 'name'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
          const r: any = await t.get(`/api/v1/contacts?limit=3&sort=${sort}&order=${order}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(r.status).toBe(200);
          seen.push(...r.body.data.map((c: any) => c.id));
          if (!r.body.page.hasMore) break;
          cursor = r.body.page.next;
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      }
    }
    const first: any = await t.get('/api/v1/contacts?limit=2&sort=name');
    const wrong = await t.get(`/api/v1/contacts?limit=2&sort=created&cursor=${first.body.page.next}`);
    expect(wrong.status).toBe(400);
    const names: any = await t.get('/api/v1/contacts?limit=7&sort=name&order=asc');
    expect(names.body.data.map((c: any) => c.displayName)).toEqual(['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06']);
  });

  it('searches by name, company, e-mail fragment and phone digits; wildcards are literal', async () => {
    const t = await h.register({ emailPrefix: 'srch' });
    const a = (await t.post('/api/v1/contacts', { firstName: 'Meera', lastName: 'Iyer', company: 'Lakeview Realty', email: 'meera@lake.test', phone: '+91 98450 12345' })).body.data;
    await t.post('/api/v1/contacts', { firstName: 'Rohan', lastName: 'Shah', company: '100%_Homes' });
    const find = async (q: string) => (await t.get(`/api/v1/contacts?q=${encodeURIComponent(q)}`)).body.data.map((c: any) => c.id);
    expect(await find('meer')).toEqual([a.id]);
    expect(await find('lakeview')).toEqual([a.id]);
    expect(await find('@lake.test')).toEqual([a.id]);
    expect(await find('98450')).toEqual([a.id]);
    expect(await find('%')).toHaveLength(1); // only the company that literally contains '%'
    expect(await find('zzz')).toEqual([]);
  });

  it('archives (freeing identifiers) and restores, refusing when an identifier was taken meanwhile', async () => {
    const email = `arc${uniq()}@x.com`;
    const c = (await owner.post('/api/v1/contacts', { firstName: 'Arc', email, phone: '+91 92222 00000' })).body.data;
    expect((await owner.delete(`/api/v1/contacts/${c.id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/contacts/${c.id}`)).status).toBe(404);
    const taken = await owner.post('/api/v1/contacts', { firstName: 'New owner of the email', email });
    expect(taken.status).toBe(201);
    const blocked = await owner.post(`/api/v1/contacts/${c.id}/restore`);
    expect(blocked.status).toBe(409);
    await owner.delete(`/api/v1/contacts/${taken.body.data.id}`);
    const back = await owner.post(`/api/v1/contacts/${c.id}/restore`);
    expect(back.status).toBe(200);
    expect(back.body.data).toMatchObject({ email, phone: '+919222200000' });
  });

  it('merges duplicates (data moves, nothing is overwritten) and can undo it', async () => {
    const s = (await owner.post('/api/v1/contacts', { firstName: 'Surv', email: `s${uniq()}@x.com`, tags: ['a'] })).body.data;
    const d = (await owner.post('/api/v1/contacts', { firstName: 'Dupe', lastName: 'Filled', company: 'Acme Homes', email: `d${uniq()}@x.com`, phone: '+91 93333 00000', tags: ['b'] })).body.data;
    const leadId = await addLead(owner.tenantId, d.id, owner.userId);
    await owner.post(`/api/v1/contacts/${d.id}/consents`, { channel: 'whatsapp', action: 'grant', source: 'form' });

    const m = await owner.post(`/api/v1/contacts/${s.id}/merge`, { duplicateIds: [d.id] });
    expect(m.status).toBe(200);
    const c = m.body.data.contact;
    expect(c).toMatchObject({ firstName: 'Surv', lastName: 'Filled', company: 'Acme Homes', email: s.email, phone: '+919333300000', leadCount: 1 });
    expect(c.tags.sort()).toEqual(['a', 'b']);
    expect(c.alternateEmails).toEqual([d.email]);
    expect((await owner.get(`/api/v1/contacts/${d.id}`)).status).toBe(404);
    const consent = await owner.get(`/api/v1/contacts/${s.id}/consents`);
    expect(consent.body.data.current.find((x: any) => x.channel === 'whatsapp').granted).toBe(true);
    const moved = await h.admin.query(`SELECT contact_id FROM leads WHERE id = $1`, [leadId]);
    expect(moved.rows[0].contact_id).toBe(s.id);

    const undo = await owner.post(`/api/v1/contacts/merges/${m.body.data.merges[0].id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.data.restored).toMatchObject({ id: d.id, email: d.email, phone: '+919333300000', leadCount: 1 });
    expect(undo.body.data.survivor.leadCount).toBe(0);
    expect((await owner.post(`/api/v1/contacts/merges/${m.body.data.merges[0].id}/undo`)).status).toBe(409);
  });

  it('merge input is validated and concurrent merges of the same pair cannot both win', async () => {
    const a = (await owner.post('/api/v1/contacts', { firstName: 'MA', email: `ma${uniq()}@x.com` })).body.data;
    const b = (await owner.post('/api/v1/contacts', { firstName: 'MB', email: `mb${uniq()}@x.com` })).body.data;
    expect((await owner.post(`/api/v1/contacts/${a.id}/merge`, { duplicateIds: [] })).status).toBe(400);
    expect((await owner.post(`/api/v1/contacts/${a.id}/merge`, { duplicateIds: [a.id] })).status).toBe(400);
    const [x, y] = await Promise.all([owner.post(`/api/v1/contacts/${a.id}/merge`, { duplicateIds: [b.id] }), owner.post(`/api/v1/contacts/${b.id}/merge`, { duplicateIds: [a.id] })]);
    expect([x.status, y.status].sort()).toEqual([200, 404]);
    const live = await h.admin.query(`SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [[a.id, b.id]]);
    expect(live.rows[0].n).toBe(1);
  });

  it('records consent grants and revocations with an audit trail', async () => {
    const c = (await owner.post('/api/v1/contacts', { firstName: 'Consent', phone: '+91 94444 00000' })).body.data;
    const fresh = await owner.get(`/api/v1/contacts/${c.id}/consents`);
    expect(fresh.body.data.current.every((x: any) => !x.granted)).toBe(true);
    const g = await owner.post(`/api/v1/contacts/${c.id}/consents`, { channel: 'whatsapp', action: 'grant', source: 'form', proofUrl: 'https://example.com/form/1' });
    expect(g.status).toBe(200);
    expect(g.body.data.current.find((x: any) => x.channel === 'whatsapp')).toMatchObject({ granted: true, source: 'form' });
    const r = await owner.post(`/api/v1/contacts/${c.id}/consents`, { channel: 'whatsapp', action: 'revoke', source: 'manual', reason: 'Asked to stop' });
    expect(r.body.data.current.find((x: any) => x.channel === 'whatsapp').granted).toBe(false);
    expect(r.body.data.history[0]).toMatchObject({ status: 'revoked', revokeReason: 'Asked to stop' });
    const aud = await h.admin.query(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action LIKE 'consent.%' ORDER BY created_at`, [c.id]);
    expect(aud.rows.map((x) => x.action)).toEqual(['consent.grant', 'consent.revoke']);
  });

  it('documents the contact endpoints in OpenAPI, including pagination and If-Match', async () => {
    const spec = (await owner.get('/api/v1/openapi.json')).body;
    expect(spec.paths['/api/v1/contacts'].get.responses['200'].content['application/json'].schema.properties.page).toBeTruthy();
    expect(spec.paths['/api/v1/contacts/{id}'].patch.parameters.some((p: any) => p.name === 'If-Match')).toBe(true);
    expect(spec.paths['/api/v1/contacts/{id}'].patch.responses['412']).toBeTruthy();
    expect(spec.paths['/api/v1/contacts/{id}/merge'].post['x-required-permissions']).toEqual(['contacts:merge']);
  });
});

describe('contact intake (find-or-create used by lead capture)', () => {
  const intake = async (input: { firstName: string; email?: string | null; phone?: string | null }, who = owner) => {
    const { getDb } = await import('../platform/db');
    const { ContactsService } = await import('../modules/contacts/service');
    const db = getDb();
    return db.withTenant({ tenantId: who.tenantId, userId: who.userId }, (tx) => new ContactsService(db).findOrCreateInTx(tx, { tenantId: who.tenantId, userId: who.userId }, input));
  };

  it('reuses the contact that already owns the phone number, whatever the formatting', async () => {
    const first = await intake({ firstName: 'Walk-in', phone: '98765 00001' });
    expect(first.created).toBe(true);
    const again = await intake({ firstName: 'Same person, new form', phone: '+91 98765-00001' });
    expect(again).toEqual({ id: first.id, created: false });
    const viaEmail = await intake({ firstName: 'X', email: `intake${uniq()}@x.com`, phone: '09876500001' });
    expect(viaEmail.id).toBe(first.id);
  });

  it('survives a burst of simultaneous enquiries from the same person (exactly one contact)', async () => {
    const email = `burst${uniq()}@x.com`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => intake({ firstName: `Burst${i}`, email })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('keeps unparsable values as text without making them identity keys', async () => {
    const r = await intake({ firstName: 'Messy', phone: 'call after 5', email: 'not an email' });
    expect(r.created).toBe(true);
    const row = await h.admin.query(`SELECT phone, email::text AS email FROM contacts WHERE id = $1`, [r.id]);
    expect(row.rows[0]).toEqual({ phone: 'call after 5', email: 'not an email' });
    const ids = await h.admin.query(`SELECT count(*)::int AS n FROM contact_identifiers WHERE contact_id = $1`, [r.id]);
    expect(ids.rows[0].n).toBe(0);
  });

  it('never matches across workspaces', async () => {
    const a = await intake({ firstName: 'Shared number', phone: '+91 98111 22222' }, owner);
    const b = await intake({ firstName: 'Shared number', phone: '+91 98111 22222' }, other);
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });
});
