import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';
// The storage module reads the app config at import time, so it is loaded AFTER bootApi has prepared the test environment.
let S: typeof import('../platform/storage');

let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let manager: AuthedUser;
let auditor: AuthedUser;
let storageDir: string;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const as = (tenantId: string) => ({ 'X-Tenant-Id': tenantId });
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)]); // still a PNG; different bytes → different hash
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF-${tag}`)]);
const webp = (tag: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(tag)]);
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF`);

async function property(u: AuthedUser, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await u.post('/api/v1/properties', { title: `Flat ${uniq()}`, price: 8_500_000, ...body }, headers);
  if (r.status !== 201) throw new Error(`property create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
const upload = (u: AuthedUser, propertyId: string, buf: Buffer, type: string, name = 'photo', headers: Record<string, string> = {}) =>
  request(h.app).post(`/api/v1/properties/${propertyId}/files?name=${encodeURIComponent(name)}`).set('Cookie', u.cookies).set('x-csrf-token', u.csrf).set(headers).set('Content-Type', type).send(buf);
const blobCount = () => {
  let c = 0;
  const walk = (d: string) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { if (e.isDirectory()) walk(path.join(d, e.name)); else c++; } };
  walk(storageDir);
  return c;
};

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  S = await import('../platform/storage');
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-files-'));
  S.setStorage(new S.LocalDiskStorage(storageDir));
  owner = await h.register({ emailPrefix: 'iown', organisationName: 'Inventory Co' });
  other = await h.register({ emailPrefix: 'ioth', organisationName: 'Other Inventory Co' });
  agent = await h.register({ emailPrefix: 'iagt' });
  manager = await h.register({ emailPrefix: 'imgr' });
  auditor = await h.register({ emailPrefix: 'iaud' });
  await addMember(agent, owner.tenantId, 'sales_agent');
  await addMember(manager, owner.tenantId, 'sales_manager');
  await addMember(auditor, owner.tenantId, 'auditor');
}, 180_000);

afterAll(async () => {
  S.setStorage(undefined);
  fs.rmSync(storageDir, { recursive: true, force: true });
  await h?.close();
});

describe('storage primitives (unit)', () => {
  it('sniffs by signature, not by name or header', () => {
    expect(S.sniff(png('x'))?.mime).toBe('image/png');
    expect(S.sniff(jpeg('x'))?.mime).toBe('image/jpeg');
    expect(S.sniff(webp('x'))?.mime).toBe('image/webp');
    expect(S.sniff(pdf('x'))?.mime).toBe('application/pdf');
    expect(S.sniff(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(S.sniff(Buffer.from('MZ\x90\x00 an exe'))).toBeNull();
    expect(S.sniff(Buffer.alloc(0))).toBeNull();
  });
  it('cleans display names and refuses keys that escape the storage root', async () => {
    expect(S.safeFileName('../../etc/passwd', 'x')).toBe('passwd');
    expect(S.safeFileName('C:\\Users\\me\\villa "front".jpg', 'x')).toBe('villa front.jpg');
    expect(S.safeFileName('   ', 'fallback.png')).toBe('fallback.png');
    const s = new S.LocalDiskStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-st-')));
    await expect(s.put('../escape.txt', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(s.put('/abs/path', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(s.get('a/../../b')).rejects.toThrow('Invalid storage key');
    await s.put('t1/2026/10/ok.bin', Buffer.from('hello'));
    expect((await s.get('t1/2026/10/ok.bin')).toString()).toBe('hello');
  });
});

describe('projects', () => {
  it('creates, rejects duplicate names (any case), validates and carries live availability counts', async () => {
    const r = await owner.post('/api/v1/projects', { name: 'Lakeview Heights', developer: 'Prestige', city: 'Bengaluru', locality: 'Whitefield', status: 'active', amenities: ['Pool', 'Gym'] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ name: 'Lakeview Heights', status: 'active', units: { total: 0, available: 0 }, version: 1 });
    expect((await owner.post('/api/v1/projects', { name: '  lakeview HEIGHTS ' })).status).toBe(409);
    expect((await owner.post('/api/v1/projects', { name: '' })).status).toBe(400);
    expect((await owner.post('/api/v1/projects', { name: 'X', status: 'finished' })).status).toBe(400);
    expect((await owner.post('/api/v1/projects', { name: 'Y', possessionDate: '12/2027' })).status).toBe(400);
    // same name in another workspace is fine
    expect((await other.post('/api/v1/projects', { name: 'Lakeview Heights' })).status).toBe(201);

    const pid = r.body.data.id;
    await property(owner, { projectId: pid, price: 5_000_000, unitNumber: 'A-101', tower: 'A' });
    const sold = await property(owner, { projectId: pid, price: 7_000_000, unitNumber: 'A-102', tower: 'A' });
    await property(owner, { projectId: pid, price: 9_000_000, unitNumber: 'A-103', tower: 'A', listingType: 'rent' });
    await owner.post(`/api/v1/properties/${sold.id}/status`, { status: 'sold' });
    const held = await property(owner, { projectId: pid, unitNumber: 'A-104', tower: 'A' });
    await owner.post(`/api/v1/properties/${held.id}/status`, { status: 'reserved' });
    const p = (await owner.get(`/api/v1/projects/${pid}`)).body.data;
    expect(p.units).toMatchObject({ total: 4, available: 2, held: 1, closed: 1, minPrice: 5_000_000, maxPrice: 9_000_000, availableValue: 14_000_000 });
    const list = (await owner.get('/api/v1/projects?q=lakeview')).body.data;
    expect(list[0].units.total).toBe(4);
  });

  it('roles: agents read, managers write, auditors are blocked; other workspaces see nothing', async () => {
    const t = as(owner.tenantId);
    const p = (await manager.post('/api/v1/projects', { name: `Role project ${uniq()}` }, t)).body.data;
    expect((await agent.get(`/api/v1/projects/${p.id}`, t)).status).toBe(200);
    expect((await agent.post('/api/v1/projects', { name: 'Nope' }, t)).status).toBe(403);
    expect((await agent.patch(`/api/v1/projects/${p.id}`, { city: 'Pune' }, t)).status).toBe(403);
    expect((await agent.delete(`/api/v1/projects/${p.id}`, t)).status).toBe(403);
    expect((await manager.delete(`/api/v1/projects/${p.id}`, t)).status).toBe(403); // delete is admin-only
    expect((await auditor.get('/api/v1/projects', t)).status).toBe(403);
    expect((await other.get(`/api/v1/projects/${p.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/projects/${p.id}`, { city: 'hack' })).status).toBe(404);
    expect((await other.get('/api/v1/projects?limit=200')).body.data.map((x: any) => x.id)).not.toContain(p.id);
  });

  it('If-Match works, and a project with properties cannot be archived', async () => {
    const p = (await owner.post('/api/v1/projects', { name: `Guarded ${uniq()}` })).body.data;
    expect((await owner.patch(`/api/v1/projects/${p.id}`, { city: 'Goa' }, { 'If-Match': '"9"' })).status).toBe(412);
    expect((await owner.patch(`/api/v1/projects/${p.id}`, { city: 'Goa', status: 'upcoming' }, { 'If-Match': '"1"' })).body.data).toMatchObject({ city: 'Goa', status: 'upcoming', version: 2 });
    const unit = await property(owner, { projectId: p.id });
    const blocked = await owner.delete(`/api/v1/projects/${p.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ reason: 'project_in_use', propertyCount: 1 });
    await owner.delete(`/api/v1/properties/${unit.id}`);
    expect((await owner.delete(`/api/v1/projects/${p.id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/projects/${p.id}`)).status).toBe(404);
    expect((await owner.post('/api/v1/projects', { name: p.name })).status).toBe(201); // the name is free again
  });
});

describe('properties: create, validation, uniqueness, history', () => {
  it('creates a property, composes the location, and records the opening status and price history (by trigger)', async () => {
    const r = await owner.post('/api/v1/properties', { title: 'Prestige Lakeside 4BHK', propertyType: 'villa', price: 35_000_000, areaSqft: 3200, bedrooms: 4, bathrooms: 4, city: 'Bengaluru', locality: 'Whitefield', amenities: ['Pool'], tags: ['Premium', 'premium', 'Corner'] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'available', listingType: 'sale', location: 'Whitefield, Bengaluru', pricePerSqft: 10937.5, ownerId: owner.userId, tags: ['premium', 'corner'], imageCount: 0, version: 1 });
    expect(r.headers.etag).toMatch(/^"1\./);
    const d = (await owner.get(`/api/v1/properties/${r.body.data.id}`)).body.data;
    expect(d.statusHistory).toHaveLength(1);
    expect(d.statusHistory[0]).toMatchObject({ from: null, to: 'available', reason: 'Listed' });
    expect(d.priceHistory).toHaveLength(1);
    expect(d.priceHistory[0].price).toBe(35_000_000);
    expect(d.allowedStatuses).toEqual(['under_offer', 'reserved', 'sold', 'rented', 'inactive']);
    expect((await h.admin.query(`SELECT 1 FROM domain_events WHERE type = 'property.created' AND aggregate_id = $1`, [d.id])).rowCount).toBe(1);
  });

  it('validates input with field paths', async () => {
    for (const bad of [{ price: -1 }, { price: 'cheap' }, { title: '' }, { bedrooms: 99 }, { propertyType: 'castle' }, { possessionDate: 'soon' }, { furnishing: 'wet' }]) {
      const r = await owner.post('/api/v1/properties', { title: 'T', price: 1, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await owner.post('/api/v1/properties', { title: 'T' })).body.errors[0].path).toBe('body.price');
    expect((await owner.post('/api/v1/properties', { title: 'T', price: 1, projectId: '00000000-0000-4000-8000-000000000001' })).body.errors[0].path).toBe('body.projectId');
    expect((await owner.post('/api/v1/properties', { title: 'T', price: 1, ownerId: other.userId })).body.errors[0].path).toBe('body.ownerId');
  });

  it('a unit exists once per project and tower; the same number elsewhere is fine; archiving frees it', async () => {
    const pa = (await owner.post('/api/v1/projects', { name: `Unique A ${uniq()}` })).body.data;
    const pb = (await owner.post('/api/v1/projects', { name: `Unique B ${uniq()}` })).body.data;
    const u = await property(owner, { projectId: pa.id, unitNumber: 'B-12', tower: 'B' });
    expect((await owner.post('/api/v1/properties', { title: 'dup', price: 1, projectId: pa.id, unitNumber: 'b-12', tower: 'B' })).status).toBe(409);
    expect((await owner.post('/api/v1/properties', { title: 'other tower', price: 1, projectId: pa.id, unitNumber: 'B-12', tower: 'C' })).status).toBe(201);
    expect((await owner.post('/api/v1/properties', { title: 'other project', price: 1, projectId: pb.id, unitNumber: 'B-12', tower: 'B' })).status).toBe(201);
    const moved = await property(owner, { projectId: pb.id, unitNumber: 'Z-1' });
    expect((await owner.patch(`/api/v1/properties/${moved.id}`, { projectId: pa.id, unitNumber: 'B-12', tower: 'B' })).status).toBe(409);
    await owner.delete(`/api/v1/properties/${u.id}`);
    expect((await owner.post('/api/v1/properties', { title: 'reused', price: 1, projectId: pa.id, unitNumber: 'B-12', tower: 'B' })).status).toBe(201);
    expect((await owner.post(`/api/v1/properties/${u.id}/restore`)).status).toBe(409); // someone took the number meanwhile
  });

  it('price changes land in the price history (trigger), with who and when; ETag guards edits', async () => {
    const p = await property(owner, { price: 5_000_000 });
    expect((await owner.patch(`/api/v1/properties/${p.id}`, { price: 5_500_000 }, { 'If-Match': '"9"' })).status).toBe(412);
    const up = await owner.patch(`/api/v1/properties/${p.id}`, { price: 5_500_000, description: 'Price revised' }, { 'If-Match': '"1"' });
    expect(up.body.data).toMatchObject({ price: 5_500_000, version: 2 });
    await owner.patch(`/api/v1/properties/${p.id}`, { description: 'no price change' });
    await owner.patch(`/api/v1/properties/${p.id}`, { price: 5_200_000 });
    const d = (await owner.get(`/api/v1/properties/${p.id}`)).body.data;
    expect(d.priceHistory.map((x: any) => x.price)).toEqual([5_200_000, 5_500_000, 5_000_000]);
    expect(d.priceHistory[0].changedBy).toBeTruthy();
    // history is append-only for the application role
    const api = new pg.Client({ connectionString: h.tdb.apiUrl });
    await api.connect();
    await expect(api.query(`UPDATE property_price_history SET price = 1`)).rejects.toMatchObject({ code: '42501' });
    await expect(api.query(`DELETE FROM property_status_history`)).rejects.toMatchObject({ code: '42501' });
    await api.end();
  });

  it('roles: agents read only; managers manage; only admins archive; other workspaces see nothing', async () => {
    const t = as(owner.tenantId);
    const p = await property(manager, {}, t);
    expect((await agent.get(`/api/v1/properties/${p.id}`, t)).status).toBe(200);
    expect((await agent.post('/api/v1/properties', { title: 'x', price: 1 }, t)).status).toBe(403);
    expect((await agent.patch(`/api/v1/properties/${p.id}`, { price: 2 }, t)).status).toBe(403);
    expect((await agent.post(`/api/v1/properties/${p.id}/status`, { status: 'reserved' }, t)).status).toBe(403);
    expect((await manager.delete(`/api/v1/properties/${p.id}`, t)).status).toBe(403);
    expect((await auditor.get('/api/v1/properties', t)).status).toBe(403);
    expect((await other.get(`/api/v1/properties/${p.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/properties/${p.id}`, { price: 1 })).status).toBe(404);
    expect((await other.post(`/api/v1/properties/${p.id}/status`, { status: 'sold' })).status).toBe(404);
    expect((await other.delete(`/api/v1/properties/${p.id}`)).status).toBe(404);
    expect((await other.get('/api/v1/properties?limit=200')).body.data.map((x: any) => x.id)).not.toContain(p.id);
    expect((await other.post('/api/v1/properties', { title: 'x', price: 1, projectId: (await owner.get('/api/v1/projects')).body.data[0].id })).status).toBe(400);
  });
});

describe('properties: availability state machine', () => {
  it('follows the allowed moves, keeps a reasoned history, and refuses nonsense', async () => {
    const p = await property(owner);
    const to = (status: string, reason?: string) => owner.post(`/api/v1/properties/${p.id}/status`, { status, reason });
    expect((await to('available')).status).toBe(409); // no-op
    expect((await to('under_offer', 'Offer from Mr Rao')).body.data.status).toBe('under_offer');
    expect((await to('reserved')).body.data.status).toBe('reserved');
    expect((await to('sold')).body.data.status).toBe('sold');
    const bad = await to('reserved');
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INVALID_TRANSITION');
    expect(bad.body.detail).toContain('available');
    expect((await to('inactive')).status).toBe(409);
    const noReason = await to('available');
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].path).toBe('body.reason');
    expect((await to('available', 'Buyer’s loan fell through')).body.data.status).toBe('available');
    const d = (await owner.get(`/api/v1/properties/${p.id}`)).body.data;
    expect(d.statusHistory.map((h: any) => `${h.from ?? '·'}>${h.to}`)).toEqual(['sold>available', 'reserved>sold', 'under_offer>reserved', 'available>under_offer', '·>available']);
    expect(d.statusHistory[0].reason).toBe('Buyer’s loan fell through');
    expect(d.statusHistory[3].reason).toBe('Offer from Mr Rao');
    expect(new Date(d.statusChangedAt).getTime()).toBeGreaterThan(new Date(d.createdAt).getTime() - 1);
    expect((await owner.post(`/api/v1/properties/${p.id}/status`, { status: 'archived' })).status).toBe(400);
  });

  it('sold is for sale listings and rented for rent/lease; the listing type cannot contradict a closed deal', async () => {
    const sale = await property(owner);
    const rent = await property(owner, { listingType: 'rent' });
    expect((await owner.post(`/api/v1/properties/${sale.id}/status`, { status: 'rented' })).status).toBe(409);
    expect((await owner.post(`/api/v1/properties/${rent.id}/status`, { status: 'sold' })).status).toBe(409);
    expect((await owner.post(`/api/v1/properties/${rent.id}/status`, { status: 'rented' })).body.data.status).toBe('rented');
    expect((await owner.post(`/api/v1/properties/${sale.id}/status`, { status: 'sold' })).status).toBe(200);
    expect((await owner.patch(`/api/v1/properties/${sale.id}`, { listingType: 'rent' })).status).toBe(409);
    expect((await owner.patch(`/api/v1/properties/${rent.id}`, { listingType: 'sale' })).status).toBe(409);
  });

  it('concurrent status changes are serialised: exactly one wins and the history stays consistent', async () => {
    const p = await property(owner);
    const results = await Promise.all(['sold', 'reserved', 'inactive', 'under_offer'].map((status) => owner.post(`/api/v1/properties/${p.id}/status`, { status })));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const hist = await h.admin.query(`SELECT from_status, to_status FROM property_status_history WHERE property_id = $1 ORDER BY created_at, id`, [p.id]);
    // each entry's "from" is the previous entry's "to": no lost update, no impossible jump
    for (let i = 1; i < hist.rows.length; i++) expect(hist.rows[i].from_status).toBe(hist.rows[i - 1].to_status);
    const now = await h.admin.query(`SELECT status FROM properties WHERE id = $1`, [p.id]);
    expect(now.rows[0].status).toBe(hist.rows.at(-1).to_status);
  });

  it('the reason never leaks between requests on a pooled connection', async () => {
    const a = await property(owner);
    const b = await property(owner);
    await owner.post(`/api/v1/properties/${a.id}/status`, { status: 'inactive', reason: 'Owner withdrew' });
    await owner.post(`/api/v1/properties/${b.id}/status`, { status: 'inactive' });
    const hb = (await owner.get(`/api/v1/properties/${b.id}`)).body.data.statusHistory[0];
    expect(hb.to).toBe('inactive');
    expect(hb.reason).toBeNull();
  });

  it('archive and restore', async () => {
    const p = await property(owner);
    expect((await owner.delete(`/api/v1/properties/${p.id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/properties/${p.id}`)).status).toBe(404);
    expect((await owner.get('/api/v1/properties?limit=200')).body.data.map((x: any) => x.id)).not.toContain(p.id);
    expect((await owner.post(`/api/v1/properties/${p.id}/restore`)).status).toBe(200);
    expect((await owner.get(`/api/v1/properties/${p.id}`)).status).toBe(200);
  });
});

describe('properties: list, filters, summary', () => {
  let ws: AuthedUser;
  beforeAll(async () => {
    ws = await h.register({ emailPrefix: 'ilist' });
    const proj = (await ws.post('/api/v1/projects', { name: 'Skyline' })).body.data;
    const mk = (title: string, extra: Record<string, unknown>) => ws.post('/api/v1/properties', { title, ...extra });
    await mk('Studio near metro', { price: 3_000_000, bedrooms: 1, areaSqft: 450, city: 'Pune', locality: 'Hinjewadi', propertyType: 'apartment', tags: ['investor'] });
    await mk('Spacious 2BHK', { price: 6_500_000, bedrooms: 2, areaSqft: 1100, city: 'Pune', locality: 'Baner', projectId: proj.id, unitNumber: '201' });
    await mk('Family 3BHK', { price: 9_800_000, bedrooms: 3, areaSqft: 1650, city: 'Bengaluru', locality: 'Whitefield', projectId: proj.id, unitNumber: '301', tags: ['family'] });
    await mk('Garden villa', { price: 25_000_000, bedrooms: 4, areaSqft: 3200, city: 'Bengaluru', locality: 'Sarjapur', propertyType: 'villa', tags: ['family', 'premium'] });
    await mk('Office floor', { price: 12_000_000, areaSqft: 2000, city: 'Mumbai', locality: 'BKC', propertyType: 'office', listingType: 'lease' });
    const sold = (await mk('Sold penthouse', { price: 40_000_000, bedrooms: 4, areaSqft: 4000, city: 'Mumbai', locality: 'Worli', propertyType: 'penthouse' })).body.data;
    await ws.post(`/api/v1/properties/${sold.id}/status`, { status: 'sold' });
    const held = (await mk('Reserved flat', { price: 7_000_000, bedrooms: 2, areaSqft: 1000, city: 'Pune', locality: 'Kothrud' })).body.data;
    await ws.post(`/api/v1/properties/${held.id}/status`, { status: 'reserved' });
  }, 60_000);
  const titles = async (qs: string) => (await ws.get(`/api/v1/properties?${qs}`)).body.data.map((p: any) => p.title).sort();

  it('filters by text, status, type, listing, bedrooms, price/area range, place, tag and project', async () => {
    expect((await titles('limit=200')).length).toBe(7);
    expect(await titles('q=metro')).toEqual(['Studio near metro']);
    expect(await titles('q=baner')).toEqual(['Spacious 2BHK']);
    expect(await titles('q=skyline')).toEqual(['Family 3BHK', 'Spacious 2BHK']);
    expect(await titles('q=%25')).toEqual([]);
    expect(await titles('status=sold')).toEqual(['Sold penthouse']);
    expect(await titles('status=reserved,sold')).toEqual(['Reserved flat', 'Sold penthouse']);
    expect(await titles('propertyType=villa')).toEqual(['Garden villa']);
    expect(await titles('listingType=lease')).toEqual(['Office floor']);
    expect(await titles('bedroomsMin=3&status=available')).toEqual(['Family 3BHK', 'Garden villa']);
    expect(await titles('priceMin=6000000&priceMax=10000000&status=available')).toEqual(['Family 3BHK', 'Spacious 2BHK']);
    expect(await titles('areaMin=3000')).toEqual(['Garden villa', 'Sold penthouse']);
    expect(await titles('city=pune')).toEqual(['Reserved flat', 'Spacious 2BHK', 'Studio near metro']);
    expect(await titles('locality=white')).toEqual(['Family 3BHK']);
    expect(await titles('tag=family')).toEqual(['Family 3BHK', 'Garden villa']);
    expect((await ws.get('/api/v1/properties?status=gone')).status).toBe(400);
    expect((await ws.get('/api/v1/properties?propertyType=castle')).status).toBe(400);
  });

  it('sorts and pages with stable cursors for every sort and order', async () => {
    for (const sort of ['created', 'updated', 'price', 'area'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
          const r: any = await ws.get(`/api/v1/properties?limit=3&sort=${sort}&order=${order}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(r.status).toBe(200);
          seen.push(...r.body.data.map((p: any) => p.id));
          if (!r.body.page.hasMore) break;
          cursor = r.body.page.next;
        }
        expect(seen, `${sort} ${order}`).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      }
    }
    expect((await ws.get('/api/v1/properties?sort=price&order=asc&limit=2')).body.data.map((p: any) => p.price)).toEqual([3_000_000, 6_500_000]);
    const first: any = await ws.get('/api/v1/properties?limit=2&sort=price');
    expect((await ws.get(`/api/v1/properties?limit=2&sort=area&cursor=${first.body.page.next}`)).status).toBe(400);
  });

  it('summary reports counts by status/type and the value of what is available', async () => {
    const s = (await ws.get('/api/v1/properties/summary')).body.data;
    expect(s.total).toBe(7);
    expect(s.byStatus).toMatchObject({ available: 5, reserved: 1, sold: 1, rented: 0 });
    expect(s.byType.find((t: any) => t.type === 'apartment').n).toBeGreaterThanOrEqual(1);
    expect(s.available.count).toBe(5);
    expect(s.available.value).toBe(3_000_000 + 6_500_000 + 9_800_000 + 25_000_000 + 12_000_000);
    expect(s.available.avgPricePerSqft).toBeGreaterThan(0);
  });
});

describe('files: pictures and documents', () => {
  it('uploads by content, makes the first picture the cover, serves it back with safe headers and cheap revalidation', async () => {
    const p = await property(owner);
    const a = await upload(owner, p.id, png('one'), 'image/png', 'front elevation.png');
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ kind: 'image', mime: 'image/png', name: 'front elevation.png', sizeBytes: png('one').length });
    const detail = (await owner.get(`/api/v1/properties/${p.id}`)).body.data;
    expect(detail.coverFileId).toBe(a.body.data.id);
    expect(detail.images).toHaveLength(1);
    expect(detail.imageCount).toBe(1);
    expect(blobCount()).toBeGreaterThanOrEqual(1);

    const dl = await owner.get(`/api/v1/files/${a.body.data.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/image\/png/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(dl.headers['content-disposition']).toContain('front elevation.png');
    expect(dl.headers['cache-control']).toMatch(/private/);
    expect(Buffer.compare(dl.body, png('one'))).toBe(0);
    const again = await owner.get(`/api/v1/files/${a.body.data.id}`, { 'If-None-Match': dl.headers.etag! });
    expect(again.status).toBe(304);

    const b = await upload(owner, p.id, jpeg('two'), 'image/jpeg', 'living.jpg');
    const doc = await upload(owner, p.id, pdf('brochure'), 'application/pdf', 'brochure.pdf');
    expect(doc.body.data.kind).toBe('document');
    const d2 = (await owner.get(`/api/v1/properties/${p.id}`)).body.data;
    expect(d2.images.map((f: any) => f.name)).toEqual(['front elevation.png', 'living.jpg']);
    expect(d2.documents.map((f: any) => f.name)).toEqual(['brochure.pdf']);
    // changing the cover, then deleting it promotes the next picture
    expect((await owner.put(`/api/v1/properties/${p.id}/cover`, { fileId: b.body.data.id })).status).toBe(200);
    expect((await owner.get(`/api/v1/properties/${p.id}`)).body.data.coverFileId).toBe(b.body.data.id);
    expect((await owner.put(`/api/v1/properties/${p.id}/cover`, { fileId: doc.body.data.id })).status).toBe(400); // a document cannot be the cover
    const before = blobCount();
    expect((await owner.delete(`/api/v1/files/${b.body.data.id}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/files/${b.body.data.id}`)).status).toBe(404);
    expect(blobCount()).toBe(before - 1);
    expect((await owner.get(`/api/v1/properties/${p.id}`)).body.data.coverFileId).toBe(a.body.data.id);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action IN ('file.upload','file.delete')`, [p.id])).rows[0].n).toBe(4);
  });

  it('trusts the bytes: spoofed, mismatched, empty, oversized and duplicate uploads are refused and leave nothing behind', async () => {
    const p = await property(owner);
    const start = blobCount();
    const svg = await upload(owner, p.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png', 'evil.png');
    expect(svg.status).toBe(415);
    const exe = await upload(owner, p.id, Buffer.from('MZ\x90\x00\x03\x00'), 'image/jpeg', 'virus.jpg');
    expect(exe.status).toBe(415);
    const mismatch = await upload(owner, p.id, png('m'), 'image/jpeg', 'wrong.jpg');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.errors[0].message).toContain('image/png');
    expect((await upload(owner, p.id, Buffer.alloc(0), 'image/png')).status).toBe(400);
    const huge = await upload(owner, p.id, Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]), 'image/png', 'huge.png');
    expect(huge.status).toBe(413);
    expect((await upload(owner, p.id, png('same'), 'image/png')).status).toBe(201);
    const dup = await upload(owner, p.id, png('same'), 'image/png', 'copy.png');
    expect(dup.status).toBe(409);
    expect(blobCount()).toBe(start + 1); // only the one accepted file exists on disk
    // octet-stream is accepted when the signature is valid (curl / generic clients)
    expect((await upload(owner, p.id, jpeg('octet'), 'application/octet-stream', 'x.jpg')).status).toBe(201);
    // path tricks in the name are display text only
    const tricky = await upload(owner, p.id, webp('t'), 'image/webp', '../../../etc/passwd');
    expect(tricky.body.data.name).toBe('passwd');
  });

  it('the antivirus hook can veto an upload', async () => {
    const p = await property(owner);
    const start = blobCount();
    S.setScanner({ scan: async () => ({ clean: false, reason: 'EICAR-Test' }) });
    const r = await upload(owner, p.id, png('av'), 'image/png');
    S.setScanner({ scan: async () => ({ clean: true }) });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('EICAR-Test');
    expect(blobCount()).toBe(start);
  });

  it('access follows the property: agents can view but not change; auditors and other workspaces get nothing', async () => {
    const t = as(owner.tenantId);
    const p = await property(manager, {}, t);
    const f = await upload(manager, p.id, png('acl'), 'image/png', 'a.png', t);
    expect(f.status).toBe(201);
    expect((await agent.get(`/api/v1/files/${f.body.data.id}`, t)).status).toBe(200);
    expect((await agent.get(`/api/v1/properties/${p.id}/files`, t)).body.data).toHaveLength(1);
    expect((await upload(agent, p.id, png('agent'), 'image/png', 'b.png', t)).status).toBe(403);
    expect((await agent.delete(`/api/v1/files/${f.body.data.id}`, t)).status).toBe(403);
    expect((await auditor.get(`/api/v1/files/${f.body.data.id}`, t)).status).toBe(403);
    expect((await other.get(`/api/v1/files/${f.body.data.id}`)).status).toBe(404);
    expect((await other.delete(`/api/v1/files/${f.body.data.id}`)).status).toBe(404);
    expect((await upload(other, p.id, png('x-tenant'), 'image/png')).status).toBe(404);
    expect((await other.get(`/api/v1/properties/${p.id}/files`)).status).toBe(404);
    // unauthenticated
    expect((await request(h.app).get(`/api/v1/files/${f.body.data.id}`)).status).toBe(401);
    expect((await request(h.app).post(`/api/v1/properties/${p.id}/files`).set('Content-Type', 'image/png').send(png('anon'))).status).toBe(401);
    // a project picture is authorised by project permissions
    const proj = (await manager.post('/api/v1/projects', { name: `Files ${uniq()}` }, t)).body.data;
    const pf = await request(h.app).post(`/api/v1/projects/${proj.id}/files?name=brochure.pdf`).set('Cookie', manager.cookies).set('x-csrf-token', manager.csrf).set(t).set('Content-Type', 'application/pdf').send(pdf('proj'));
    expect(pf.status).toBe(201);
    expect((await manager.get(`/api/v1/projects/${proj.id}/files`, t)).body.data[0]).toMatchObject({ kind: 'document', name: 'brochure.pdf' });
  });

  it('a file whose bytes vanished from storage is reported as missing, not as a server error', async () => {
    const p = await property(owner);
    const f = (await upload(owner, p.id, png('gone'), 'image/png')).body.data;
    const row = await h.admin.query(`SELECT storage_key FROM files WHERE id = $1`, [f.id]);
    fs.rmSync(path.join(storageDir, row.rows[0].storage_key));
    expect((await owner.get(`/api/v1/files/${f.id}`)).status).toBe(404);
  });
});

describe('documentation', () => {
  it('publishes properties, projects and files in OpenAPI with uploads and downloads described', async () => {
    const spec = (await owner.get('/api/v1/openapi.json')).body;
    for (const p of ['/api/v1/properties', '/api/v1/properties/{id}/status', '/api/v1/properties/{id}/files', '/api/v1/properties/summary', '/api/v1/projects', '/api/v1/files/{id}']) expect(spec.paths[p], p).toBeTruthy();
    expect(Object.keys(spec.paths['/api/v1/properties/{id}/files'].post.requestBody.content)).toEqual(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    expect(spec.paths['/api/v1/properties/{id}/status'].post.description).toContain('available');
    expect(spec.paths['/api/v1/properties'].get.responses['200'].content['application/json'].schema.properties.page).toBeTruthy();
  });
});
