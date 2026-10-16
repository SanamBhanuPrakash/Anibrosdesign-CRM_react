import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';
import { unzip } from '../modules/agency/xlsx';
import { parseCsv } from '../modules/leads/csv';
import { displayValue, fieldKeyFromLabel, normalizeOptions, normalizeValue, validateCustomFields, type FieldDef } from '../modules/custom-fields/validate';

const def = (over: Partial<FieldDef> & Pick<FieldDef, 'key' | 'type'>): FieldDef => ({ id: over.key, label: over.key, required: false, visible: true, options: [], defaultValue: null, helpText: null, showInList: false, order: 0, ...over });
const opts = (...labels: string[]) => labels.map((l) => ({ value: l.toLowerCase().replace(/\W+/g, '_'), label: l }));

describe('custom field rules (pure)', () => {
  it('keys come from the label, are always valid and unique', () => {
    expect(fieldKeyFromLabel('Treatment interested in', new Set())).toBe('treatment_interested_in');
    expect(fieldKeyFromLabel('Café & Crème (2nd visit)!', new Set())).toBe('cafe_creme_2nd_visit');
    expect(fieldKeyFromLabel('Party size', new Set(['party_size']))).toBe('party_size_2');
    expect(fieldKeyFromLabel('Party size', new Set(['party_size', 'party_size_2']))).toBe('party_size_3');
    expect(fieldKeyFromLabel('123 go', new Set())).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(fieldKeyFromLabel('!!!', new Set())).toBe('field');
    expect(fieldKeyFromLabel('x'.repeat(100), new Set()).length).toBeLessThanOrEqual(40);
  });

  it('options: names or {value,label}, stable values, no duplicates or blanks', () => {
    expect(normalizeOptions(['Dental', 'Skin / hair']).options).toEqual([{ value: 'dental', label: 'Dental' }, { value: 'skin_hair', label: 'Skin / hair' }]);
    expect(normalizeOptions([{ value: 'a1', label: 'Alpha' }]).options).toEqual([{ value: 'a1', label: 'Alpha' }]);
    expect(normalizeOptions(['A', 'a']).problems.length).toBeGreaterThan(0); // same name twice
    expect(normalizeOptions(['   ']).problems.length).toBeGreaterThan(0);
    expect(normalizeOptions([{ value: 'Bad Value', label: 'x' }]).problems.length).toBeGreaterThan(0);
    expect(normalizeOptions(Array.from({ length: 51 }, (_, i) => `o${i}`)).problems.length).toBeGreaterThan(0);
  });

  it('every type accepts what it should and refuses what it should not', () => {
    const ok = (d: ReturnType<typeof def>, raw: unknown) => normalizeValue(d, raw);
    expect(ok(def({ key: 'a', type: 'text' }), '  hi  ')).toEqual({ ok: true, value: 'hi' });
    expect(ok(def({ key: 'a', type: 'text' }), 'x'.repeat(501)).ok).toBe(false);
    expect(ok(def({ key: 'a', type: 'text' }), { a: 1 }).ok).toBe(false);
    expect(ok(def({ key: 'n', type: 'number' }), '1,250.5')).toEqual({ ok: true, value: 1250.5 });
    expect(ok(def({ key: 'n', type: 'number' }), 'abc').ok).toBe(false);
    expect(ok(def({ key: 'n', type: 'number' }), 1e14).ok).toBe(false);
    expect(ok(def({ key: 'n', type: 'number' }), Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(ok(def({ key: 'd', type: 'date' }), '2026-10-31')).toEqual({ ok: true, value: '2026-10-31' });
    expect(ok(def({ key: 'd', type: 'date' }), '2026-10-31T10:00:00Z')).toEqual({ ok: true, value: '2026-10-31' });
    expect(ok(def({ key: 'd', type: 'date' }), '2026-02-30').ok).toBe(false);
    expect(ok(def({ key: 'd', type: 'date' }), '31/10/2026').ok).toBe(false);
    expect(ok(def({ key: 'b', type: 'boolean' }), 'Yes')).toEqual({ ok: true, value: true });
    expect(ok(def({ key: 'b', type: 'boolean' }), false)).toEqual({ ok: true, value: false });
    expect(ok(def({ key: 'b', type: 'boolean' }), 'maybe').ok).toBe(false);
    const sel = def({ key: 's', type: 'select', options: opts('Dental', 'Skin') });
    expect(ok(sel, 'dental')).toEqual({ ok: true, value: 'dental' });
    expect(ok(sel, 'SKIN')).toEqual({ ok: true, value: 'skin' }); // by label too
    expect(ok(sel, 'eye').ok).toBe(false);
    const multi = def({ key: 'm', type: 'multi_select', options: opts('A', 'B', 'C') });
    expect(ok(multi, ['a', 'C', 'a'])).toEqual({ ok: true, value: ['a', 'c'] });
    expect(ok(multi, 'b; c')).toEqual({ ok: true, value: ['b', 'c'] });
    expect(ok(multi, ['z']).ok).toBe(false);
    expect(ok(def({ key: 'u', type: 'url' }), 'https://x.test/a')).toEqual({ ok: true, value: 'https://x.test/a' });
    expect(ok(def({ key: 'u', type: 'url' }), 'javascript:alert(1)').ok).toBe(false);
    expect(ok(def({ key: 'u', type: 'url' }), 'not a url').ok).toBe(false);
    expect(ok(def({ key: 'e', type: 'email' }), ' A@B.com ')).toEqual({ ok: true, value: 'a@b.com' });
    expect(ok(def({ key: 'e', type: 'email' }), 'nope').ok).toBe(false);
    for (const t of ['text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email'] as const) {
      for (const blank of [null, undefined, '', '   ', []]) expect(ok(def({ key: 'x', type: t, options: opts('A') }), blank)).toEqual({ ok: true, value: null });
    }
  });

  it('create: unknown or hidden keys fail, defaults fill, required is enforced only when asked', () => {
    const defs = [
      def({ key: 'size', type: 'number', required: true }),
      def({ key: 'mode', type: 'select', options: opts('Walk in', 'Online'), defaultValue: 'online' }),
      def({ key: 'old', type: 'text', visible: false }),
    ];
    const r = validateCustomFields(defs, { size: '4', ghost: 1, old: 'x' }, { mode: 'create', enforceRequired: true });
    expect(r.set).toEqual({ size: 4, mode: 'online' });
    expect(r.problems.map((p) => p.path).sort()).toEqual(['body.customFields.ghost', 'body.customFields.old']);
    expect(validateCustomFields(defs, {}, { mode: 'create', enforceRequired: true }).problems.map((p) => p.message)).toEqual(['size is required']);
    expect(validateCustomFields(defs, {}, { mode: 'create', enforceRequired: false })).toMatchObject({ problems: [], set: { mode: 'online' } });
  });

  it('patch: touches only the keys sent, blank clears, a required field cannot be cleared', () => {
    const defs = [def({ key: 'a', type: 'text' }), def({ key: 'b', type: 'number', required: true })];
    expect(validateCustomFields(defs, { a: '' }, { mode: 'patch', enforceRequired: true })).toEqual({ set: {}, clear: ['a'], problems: [] });
    expect(validateCustomFields(defs, { b: null }, { mode: 'patch', enforceRequired: true }).problems).toHaveLength(1);
    expect(validateCustomFields(defs, { b: null }, { mode: 'patch', enforceRequired: false })).toMatchObject({ clear: ['b'], problems: [] });
    expect(validateCustomFields(defs, {}, { mode: 'patch', enforceRequired: true })).toEqual({ set: {}, clear: [], problems: [] }); // nothing sent, nothing demanded
    const bad = validateCustomFields(defs, { a: 'ok', b: 'xyz' }, { mode: 'patch', enforceRequired: true });
    expect(bad.problems).toEqual([{ path: 'body.customFields.b', message: 'b: Enter a number' }]);
  });

  it('shows labels instead of codes', () => {
    const sel = def({ key: 's', type: 'select', options: opts('Dental') });
    expect(displayValue(sel, 'dental')).toBe('Dental');
    expect(displayValue(def({ key: 'm', type: 'multi_select', options: opts('A', 'B') }), ['a', 'b'])).toBe('A; B');
    expect(displayValue(def({ key: 'b', type: 'boolean' }), true)).toBe('Yes');
    expect(displayValue(def({ key: 'n', type: 'number' }), 5)).toBe(5);
    expect(displayValue(sel, undefined)).toBeNull();
  });
});

let h: ApiHarness;
let boss: AuthedUser;
let agent: AuthedUser; // sales_agent in the clinic
let manager: AuthedUser; // sales_manager in the clinic
let clinic: any;
let diner: any;
let other: any;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const H = (c: { id: string }) => ({ 'X-Tenant-Id': c.id });
const A = '/api/v1/agency';
const CF = '/api/v1/custom-fields';
const binary = (t: request.Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function joinStaff(name: string): Promise<AuthedUser> {
  const email = `cf${uniq()}@anibros.test`;
  const inv = await boss.post(`${A}/staff/invitations`, { email });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status}`);
  await h.runJobs();
  const token = h.mail.tokenFor(email, 'invited')!;
  const password = 'Violet-Lantern-Orbit-77';
  const acc = await request(h.app).post('/api/v1/invitations/accept').send({ token, name, password });
  const { cookies, csrf } = cookiesFrom(acc);
  const probe = h.as({ cookies, csrf });
  const me = await probe.get('/api/v1/me');
  return { email, password, name, userId: me.body.data.user.id, tenantId: me.body.data.activeTenantId, cookies, csrf, ...probe };
}
const mkClient = async (body: Record<string, unknown>) => (await boss.post(`${A}/clients`, body)).body.data as any;
const fields = async (c: { id: string }, hidden = false) => (await boss.get(`${CF}?includeHidden=${hidden}`, H(c))).body.data as any[];
const byLabel = async (c: { id: string }, label: string, hidden = true) => (await fields(c, hidden)).find((f) => f.label === label);
const lead = async (c: { id: string }, customFields?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  boss.post('/api/v1/leads', { contact: { firstName: `L${uniq()}`, email: `l${uniq()}@x.test` }, source: 'meta_ads', ...(customFields ? { customFields } : {}), ...extra }, H(c));

describe('per-client custom lead fields', () => {
  beforeAll(async () => {
    h = await bootApi({ restricted: true });
    boss = await h.register({ emailPrefix: 'cfboss', name: 'Cf Boss', organisationName: 'Cf Agency' });
    clinic = await mkClient({ name: 'Cf Clinic', industry: 'healthcare' });
    diner = await mkClient({ name: 'Cf Diner', industry: 'restaurant' });
    other = await mkClient({ name: 'Cf Other', industry: 'other' });
    agent = await joinStaff('Cf Agent');
    manager = await joinStaff('Cf Manager');
    await boss.put(`${A}/clients/${clinic.id}/team/${agent.userId}`, { role: 'sales_agent' });
    await boss.put(`${A}/clients/${clinic.id}/team/${manager.userId}`, { role: 'sales_manager' });
  }, 120_000);
  afterAll(async () => h?.close());

  it('a new client starts with the fields its industry usually needs; real estate and "other" start empty', async () => {
    expect((await fields(clinic)).map((f) => f.label)).toEqual(['Service needed', 'Preferred date', 'Preferred time', 'Existing patient']);
    expect((await fields(diner)).map((f) => f.label)).toEqual(['Party size', 'Occasion', 'Preferred date', 'Vegetarian only']);
    expect(await fields(other)).toEqual([]);
    const realco = await mkClient({ name: 'Cf Realty', industry: 'real_estate' });
    expect(await fields(realco)).toEqual([]);
    const svc = await byLabel(clinic, 'Service needed');
    expect(svc).toMatchObject({ key: 'service_needed', type: 'select', required: false, visible: true });
    expect(svc.options.map((o: any) => o.label)).toContain('Dental');
    expect(svc.options.find((o: any) => o.label === 'Skin / hair').value).toBe('skin_hair');
  });

  it('fields belong to one client: another client neither sees them nor can use them', async () => {
    expect((await fields(diner)).some((f) => f.key === 'service_needed')).toBe(false);
    const r = await lead(diner, { service_needed: 'dental' });
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ path: 'body.customFields.service_needed' });
    expect(r.body.errors[0].message).toContain('not a field of this client');
    expect((await lead(clinic, { service_needed: 'dental' })).status).toBe(201);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM custom_field_definitions WHERE tenant_id = $1`, [diner.id])).rows[0].n).toBe(4);
  });

  it('who may define fields: admins; employees can read the list but not change it', async () => {
    expect((await agent.get(CF, H(clinic))).status).toBe(200);
    expect((await agent.post(CF, { label: 'Nope', type: 'text' }, H(clinic))).status).toBe(403);
    expect((await manager.post(CF, { label: 'Nope', type: 'text' }, H(clinic))).status).toBe(403);
    const svc = await byLabel(clinic, 'Service needed');
    expect((await agent.patch(`${CF}/${svc.id}`, { required: true }, H(clinic))).status).toBe(403);
    expect((await agent.get(CF, H(diner))).status).toBe(403); // not their client
    expect((await boss.post(CF, { label: 'Admin made', type: 'text' }, H(other))).status).toBe(201);
  });

  it('creating a field: key from the label, options for dropdowns, clear errors, no duplicates', async () => {
    const r = await boss.post(CF, { label: 'Budget range', type: 'select', options: ['Under 10k', '10k–50k', 'Over 50k'], helpText: 'What they can spend' }, H(other));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ key: 'budget_range', type: 'select', required: false, helpText: 'What they can spend' });
    expect(r.body.data.options.map((o: any) => o.value)).toEqual(['under_10k', '10k_50k', 'over_50k']);
    expect((await boss.post(CF, { label: 'budget range', type: 'text' }, H(other))).status).toBe(409); // same name (any case)
    expect((await boss.post(CF, { label: 'Other name', type: 'text', key: 'budget_range' }, H(other))).status).toBe(409); // same key
    expect((await boss.post(CF, { label: 'Pick', type: 'select' }, H(other))).status).toBe(400); // dropdown needs options
    expect((await boss.post(CF, { label: 'Free', type: 'text', options: ['x'] }, H(other))).status).toBe(400); // only dropdowns have options
    expect((await boss.post(CF, { label: 'Bad key', type: 'text', key: 'Bad Key!' }, H(other))).status).toBe(400);
    expect((await boss.post(CF, { label: 'Weird', type: 'colour' }, H(other))).status).toBe(400);
    expect((await boss.post(CF, { label: 'Dflt', type: 'select', options: ['A'], defaultValue: 'zzz' }, H(other))).status).toBe(400);
    expect((await boss.post(CF, { label: '  ', type: 'text' }, H(other))).status).toBe(400);
    const audit = await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'custom_field.create'`, [other.id]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('a client can have at most 50 visible fields', async () => {
    const c = await mkClient({ name: `Cf Many ${uniq()}`, industry: 'other' });
    for (let i = 0; i < 50; i++) expect((await boss.post(CF, { label: `Field ${i}`, type: 'text' }, H(c))).status).toBe(201);
    expect((await boss.post(CF, { label: 'One too many', type: 'text' }, H(c))).status).toBe(422);
    const f = await byLabel(c, 'Field 0');
    expect((await boss.patch(`${CF}/${f.id}`, { visible: false }, H(c))).status).toBe(200); // hiding makes room
    expect((await boss.post(CF, { label: 'One more', type: 'text' }, H(c))).status).toBe(201);
    expect((await boss.patch(`${CF}/${f.id}`, { visible: true }, H(c))).status).toBe(422); // but not bringing it back past the limit
  }, 60_000);

  it('saving a lead checks every value against the client’s fields', async () => {
    const bad = await lead(clinic, { service_needed: 'astrology', preferred_date: '2026-13-45', existing_patient: 'perhaps', preferred_time: ['Morning'] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.path).sort()).toEqual(['body.customFields.existing_patient', 'body.customFields.preferred_date', 'body.customFields.preferred_time', 'body.customFields.service_needed']);
    const ok = await lead(clinic, { service_needed: 'Dental', preferred_date: '2026-11-02', existing_patient: 'yes', preferred_time: 'morning' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.customFields).toEqual({ service_needed: 'dental', preferred_date: '2026-11-02', existing_patient: true, preferred_time: 'morning' });
  });

  it('required fields are demanded of people saving a lead, not of automatic intake', async () => {
    const f = await boss.post(CF, { label: 'Consent given', type: 'boolean', required: true }, H(clinic));
    expect(f.status).toBe(201);
    const miss = await lead(clinic);
    expect(miss.status).toBe(400);
    expect(miss.body.errors[0].message).toBe('Consent given is required');
    expect((await lead(clinic, { consent_given: false })).status).toBe(201); // false is an answer
    // (an ad-form lead arrives without it and must not be lost: automatic intake does not go through this check)
    expect((await boss.patch(`${CF}/${f.body.data.id}`, { required: false }, H(clinic))).status).toBe(200);
  });

  it('defaults fill in what nobody answered', async () => {
    const f = await boss.post(CF, { label: 'Channel', type: 'select', options: ['Phone', 'Walk-in'], defaultValue: 'phone' }, H(other));
    expect(f.status).toBe(201);
    const r = await lead(other);
    expect(r.body.data.customFields.channel).toBe('phone');
    expect((await lead(other, { channel: 'walk_in' })).body.data.customFields.channel).toBe('walk_in');
  });

  it('editing merges: untouched fields stay, blank clears, required cannot be cleared, concurrent edits both survive', async () => {
    const created = (await lead(clinic, { service_needed: 'dental', preferred_time: 'morning' })).body.data;
    const url = `/api/v1/leads/${created.id}`;
    expect((await boss.patch(url, { customFields: { preferred_date: '2026-12-01' } }, H(clinic))).body.data.customFields).toEqual({ service_needed: 'dental', preferred_time: 'morning', preferred_date: '2026-12-01' });
    expect((await boss.patch(url, { customFields: { preferred_time: '' } }, H(clinic))).body.data.customFields).toEqual({ service_needed: 'dental', preferred_date: '2026-12-01' });
    expect((await boss.patch(url, { customFields: { nonsense: 1 } }, H(clinic))).status).toBe(400);
    // two people save different fields of the same lead at the same moment
    const [a, b] = await Promise.all([
      boss.patch(url, { customFields: { existing_patient: true } }, H(clinic)),
      manager.patch(url, { customFields: { preferred_time: 'evening' } }, H(clinic)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const final = (await boss.get(url, H(clinic))).body.data.customFields;
    expect(final).toEqual({ service_needed: 'dental', preferred_date: '2026-12-01', existing_patient: true, preferred_time: 'evening' });
    const req = await boss.post(CF, { label: 'Must have', type: 'text', required: true }, H(clinic));
    expect((await boss.patch(url, { customFields: { must_have: 'x' } }, H(clinic))).status).toBe(200);
    expect((await boss.patch(url, { customFields: { must_have: null } }, H(clinic))).status).toBe(400);
    await boss.patch(`${CF}/${req.body.data.id}`, { required: false, visible: false }, H(clinic));
  });

  it('dropdown options: renaming keeps saved values, removing one in use is refused, an unused one can go', async () => {
    const f = (await boss.post(CF, { label: 'Plan', type: 'select', options: ['Basic', 'Plus', 'Pro'] }, H(other))).body.data;
    const l1 = (await lead(other, { plan: 'plus' })).body.data;
    // rename "Plus" → "Plus+" (sent by name list: existing options are matched by name; the rename uses the explicit value)
    const rn = await boss.patch(`${CF}/${f.id}`, { options: [{ value: 'basic', label: 'Basic' }, { value: 'plus', label: 'Plus+' }, { value: 'pro', label: 'Pro' }] }, H(other));
    expect(rn.status).toBe(200);
    expect(rn.body.data.options.find((o: any) => o.value === 'plus').label).toBe('Plus+');
    expect((await boss.get(`/api/v1/leads/${l1.id}`, H(other))).body.data.customFields.plan).toBe('plus'); // saved value unchanged
    const used = await boss.patch(`${CF}/${f.id}`, { options: ['Basic', 'Pro'] }, H(other)); // drops "Plus+", which one lead uses
    expect(used.status).toBe(409);
    expect(used.body.detail).toContain('1 lead uses');
    const unused = await boss.patch(`${CF}/${f.id}`, { options: ['Basic', 'Plus+'] }, H(other)); // drops "Pro", unused
    expect(unused.status).toBe(200);
    expect(unused.body.data.options.map((o: any) => o.value)).toEqual(['basic', 'plus']);
    expect((await boss.patch(`${CF}/${f.id}`, { options: [] }, H(other))).status).toBe(400);
    expect((await boss.patch(`${CF}/${f.id}`, { type: 'text' }, H(other))).status).toBe(400); // the type never changes
    expect((await boss.patch(`${CF}/${f.id}`, { key: 'other' }, H(other))).status).toBe(400); // nor the key
  });

  it('hiding a field keeps every saved value; hidden fields accept nothing new; showing brings it back', async () => {
    const f = (await boss.post(CF, { label: 'Nickname', type: 'text' }, H(other))).body.data;
    const l = (await lead(other, { nickname: 'Bunty' })).body.data;
    expect((await boss.patch(`${CF}/${f.id}`, { visible: false }, H(other))).body.data.visible).toBe(false);
    expect((await fields(other)).some((x) => x.id === f.id)).toBe(false);
    expect((await fields(other, true)).some((x) => x.id === f.id)).toBe(true);
    expect((await boss.get(`/api/v1/leads/${l.id}`, H(other))).body.data.customFields.nickname).toBe('Bunty');
    const r = await boss.patch(`/api/v1/leads/${l.id}`, { customFields: { nickname: 'Other' } }, H(other));
    expect(r.status).toBe(400);
    expect(r.body.errors[0].message).toContain('hidden');
    expect((await boss.patch(`${CF}/${f.id}`, { visible: true }, H(other))).status).toBe(200);
    expect((await boss.patch(`/api/v1/leads/${l.id}`, { customFields: { nickname: 'Again' } }, H(other))).status).toBe(200);
    // a name can be reused once the field that had it is hidden
    await boss.patch(`${CF}/${f.id}`, { visible: false }, H(other));
    expect((await boss.post(CF, { label: 'Nickname', type: 'text' }, H(other))).status).toBe(201);
    expect((await boss.patch(`${CF}/${f.id}`, { visible: true }, H(other))).status).toBe(409); // but then the old one cannot come back under the same name
  });

  it('reordering', async () => {
    const list = await fields(clinic);
    const reversed = [...list].reverse().map((f) => f.id);
    const r = await boss.put(`${CF}/order`, { ids: reversed }, H(clinic));
    expect(r.status).toBe(200);
    expect(r.body.data.filter((f: any) => f.visible).slice(0, reversed.length).map((f: any) => f.id)).toEqual(reversed);
    expect((await boss.put(`${CF}/order`, { ids: [list[0].id, list[0].id] }, H(clinic))).status).toBe(400);
    expect((await boss.put(`${CF}/order`, { ids: [(await fields(diner))[0].id] }, H(clinic))).status).toBe(404); // another client's field
  });

  it('leads can be filtered by a custom field, inside a client and across clients', async () => {
    const t = uniq();
    const svc = await boss.post(CF, { label: `Topic ${t}`, type: 'multi_select', options: ['Implants', 'Braces', 'Whitening'] }, H(clinic));
    const key = svc.body.data.key;
    const a = (await lead(clinic, { [key]: ['implants', 'braces'] })).body.data;
    const b = (await lead(clinic, { [key]: 'whitening' })).body.data;
    await lead(clinic, {});
    const q = async (v: string) => (await boss.get(`/api/v1/leads?field=${key}&fieldValue=${v}&limit=100`, H(clinic))).body.data.map((l: any) => l.id);
    expect(await q('braces')).toEqual([a.id]); // multi-select: contains
    expect(await q('whitening')).toEqual([b.id]);
    expect(await q('nothing')).toEqual([]);
    expect((await boss.get(`/api/v1/leads?field=Bad%20Key&fieldValue=x`, H(clinic))).status).toBe(400);
    const all = (await boss.get(`${A}/leads?field=${key}&fieldValue=implants&pageSize=100`)).body.data;
    expect(all.items.map((i: any) => i.id)).toEqual([a.id]); // clients without this field match nothing
    expect(all.items[0].client.id).toBe(clinic.id);
    // single-value equality (select) and booleans as text
    const eq = (await boss.get(`/api/v1/leads?field=existing_patient&fieldValue=true&limit=100`, H(clinic))).body.data;
    expect(eq.every((l: any) => l.customFields.existing_patient === true)).toBe(true);
    expect(eq.length).toBeGreaterThan(0);
  });

  it('copying one client’s fields to another: definitions only, existing ones skipped, admins only', async () => {
    const target = await mkClient({ name: `Cf Clone ${uniq()}`, industry: 'other' });
    const r = await boss.post(`${A}/clients/${target.id}/custom-fields/copy`, { fromClientId: clinic.id });
    expect(r.status).toBe(200);
    const copiedLabels = (await fields(target)).map((f) => f.label);
    expect(copiedLabels).toEqual(expect.arrayContaining(['Service needed', 'Preferred date', 'Existing patient']));
    expect(r.body.data.copied.length).toBe(copiedLabels.length);
    expect((await byLabel(target, 'Service needed')).options.map((o: any) => o.value)).toEqual((await byLabel(clinic, 'Service needed')).options.map((o: any) => o.value));
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1`, [target.id])).rows[0].n).toBe(0); // no lead data travels
    const again = await boss.post(`${A}/clients/${target.id}/custom-fields/copy`, { fromClientId: clinic.id });
    expect(again.body.data.copied).toEqual([]);
    expect(again.body.data.skipped.length).toBe(copiedLabels.length);
    expect((await boss.post(`${A}/clients/${target.id}/custom-fields/copy`, { fromClientId: target.id })).status).toBe(400);
    expect((await boss.post(`${A}/clients/${target.id}/custom-fields/copy`, { fromClientId: randomId() })).status).toBe(404);
    expect((await manager.post(`${A}/clients/${clinic.id}/custom-fields/copy`, { fromClientId: diner.id })).status).toBe(403);
    await boss.post(`${A}/clients/${target.id}/archive`);
    expect((await boss.post(`${A}/clients/${target.id}/custom-fields/copy`, { fromClientId: clinic.id })).status).toBe(409);
  });

  it('downloads: every custom field is a real column with readable values; orphaned data is kept in one JSON column', async () => {
    const svc = await byLabel(clinic, 'Service needed');
    const tag = uniq();
    const one = (await lead(clinic, { service_needed: 'skin_hair', existing_patient: true, preferred_date: '2026-11-05' }, { contact: { firstName: `Exp${tag}`, email: `e${tag}@x.test` } })).body.data;
    // a value that has no definition (e.g. written by an older version): kept, not lost
    await h.admin.query(`UPDATE leads SET custom_fields = custom_fields || '{"legacy_note": "from an old import"}'::jsonb WHERE id = $1`, [one.id]);
    const diner1 = (await lead(diner, { party_size: 6, occasion: 'birthday', vegetarian_only: 'no' }, { contact: { firstName: `Din${tag}`, email: `d${tag}@x.test` } })).body.data;
    expect(svc).toBeTruthy();

    const res = await binary(boss.get(`${A}/leads/export?format=csv`));
    expect(res.status).toBe(200);
    const text = (res.body as Buffer).toString('utf8');
    const { header: head, rows } = parseCsv(text, { maxColumns: 500 }); // one column per custom field name: well over the importer's 60
    for (const c of ['Custom: Service needed', 'Custom: Existing patient', 'Custom: Preferred date', 'Custom: Party size', 'Custom: Occasion', 'Custom: Vegetarian only', 'Other custom data (JSON)']) expect(head, c).toContain(c);
    // "Preferred date" exists in both clinic and diner: ONE column, not two
    expect(head.filter((c) => c === 'Custom: Preferred date')).toHaveLength(1);
    const clinicRow = rows.find((r) => r.some((c) => c.includes(`Exp${tag}`)))!;
    const dinerRow = rows.find((r) => r.some((c) => c.includes(`Din${tag}`)))!;
    const cell = (row: string[], col: string) => row[head.indexOf(col)];
    expect(cell(clinicRow, 'Custom: Service needed')).toBe('Skin / hair'); // the label, not skin_hair
    expect(cell(clinicRow, 'Custom: Existing patient')).toBe('Yes');
    expect(cell(clinicRow, 'Custom: Preferred date')).toBe('2026-11-05');
    expect(cell(clinicRow, 'Custom: Party size')).toBe(''); // the clinic has no such field
    expect(cell(clinicRow, 'Other custom data (JSON)')).toContain('legacy_note');
    expect(cell(dinerRow, 'Custom: Party size')).toBe('6');
    expect(cell(dinerRow, 'Custom: Occasion')).toBe('Birthday');
    expect(cell(dinerRow, 'Custom: Vegetarian only')).toBe('No');
    expect(cell(dinerRow, 'Custom: Service needed')).toBe('');

    const xlsx = await binary(boss.get(`${A}/leads/export?clientId=${diner.id}`));
    const sheet1 = unzip(xlsx.body as Buffer).find((p) => p.name === 'xl/worksheets/sheet1.xml')!.data.toString('utf8');
    expect(sheet1).toContain('Custom: Party size');
    expect(sheet1).not.toContain('Custom: Service needed'); // a one-client file has only that client's fields
  });

  it('a hidden field still appears in downloads so no data is lost', async () => {
    const f = (await boss.post(CF, { label: 'Retired thing', type: 'text' }, H(other))).body.data;
    const l = (await lead(other, { retired_thing: 'keep me' })).body.data;
    await boss.patch(`${CF}/${f.id}`, { visible: false }, H(other));
    const csv = (await binary(boss.get(`${A}/leads/export?format=csv&clientId=${other.id}`))).body.toString('utf8');
    expect(csv).toContain('Custom: Retired thing');
    expect(csv).toContain('keep me');
    expect(l.id).toBeTruthy();
  });

  it('employees see the fields of the client they work in and fill them when logging a lead', async () => {
    const list = (await agent.get(CF, H(clinic))).body.data;
    expect(list.map((f: any) => f.key)).toContain('service_needed');
    const r = await agent.post('/api/v1/leads', { contact: { firstName: `Ag${uniq()}`, email: `ag${uniq()}@x.test` }, customFields: { service_needed: 'eye', preferred_time: 'afternoon' } }, H(clinic));
    expect(r.status).toBe(201);
    expect(r.body.data.customFields).toEqual({ service_needed: 'eye', preferred_time: 'afternoon' });
    const upd = await agent.patch(`/api/v1/leads/${r.body.data.id}`, { customFields: { existing_patient: false } }, H(clinic));
    expect(upd.status).toBe(200);
    expect(upd.body.data.customFields.existing_patient).toBe(false);
  });
});

function randomId() {
  return '00000000-0000-4000-8000-0000000000f1';
}
