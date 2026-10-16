import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';

let h: ApiHarness;
const api = () => request(h.app);
beforeAll(async () => {
  h = await bootApi({ restricted: true });
}, 90_000);
afterAll(async () => h?.close());

let seq = 0;
/** Invite a brand-new person into `owner`'s workspace with `role` and complete acceptance through the public API. */
async function joinAs(owner: AuthedUser, role: string, name = 'Teammate Person'): Promise<AuthedUser> {
  const email = `member${Date.now().toString(36)}${seq++}@anibros.test`;
  const inv = await owner.post('/api/v1/members/invitations', { email, role });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  await h.runJobs();
  const token = h.mail.tokenFor(email, 'invited')!;
  const password = 'Violet-Lantern-Orbit-77';
  const acc = await api().post('/api/v1/invitations/accept').send({ token, name, password });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  const { cookies, csrf } = cookiesFrom(acc);
  const probe = h.as({ cookies, csrf });
  const me = await probe.get('/api/v1/me');
  return { email, password, name, userId: me.body.data.user.id, tenantId: me.body.data.activeTenantId, cookies, csrf, ...probe };
}

describe('members & invitations', () => {
  let owner: AuthedUser;
  let admin: AuthedUser;
  let agent: AuthedUser;
  beforeAll(async () => {
    owner = await h.register({ emailPrefix: 'own', organisationName: 'Members Realty' });
    admin = await joinAs(owner, 'tenant_admin', 'Ada Admin');
    agent = await joinAs(owner, 'sales_agent', 'Sam Seller');
  });

  it('invited users land in the inviter’s workspace with exactly the invited role', async () => {
    expect(admin.tenantId).toBe(owner.tenantId);
    expect(agent.tenantId).toBe(owner.tenantId);
    expect((await agent.get('/api/v1/me')).body.data.tenants[0].role).toBe('sales_agent');
    // the invited address is marked verified (the invitation proves mailbox ownership)
    const v = await h.admin.query(`SELECT email_verified FROM users WHERE id=$1`, [agent.userId]);
    expect(v.rows[0].email_verified).toBe(true);
  });

  it('the invitation token is never stored in plaintext and never exposed by the API', async () => {
    const e = `leak${Date.now()}@anibros.test`;
    await owner.post('/api/v1/members/invitations', { email: e, role: 'sales_agent' });
    await h.runJobs();
    const token = h.mail.tokenFor(e, 'invited')!;
    const list = await owner.get('/api/v1/members');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain('token_hash');
    const jobs = await h.admin.query(`SELECT payload::text p FROM jobs WHERE type='mail.send'`);
    expect(jobs.rows.some((r) => r.p.includes(token))).toBe(false);
    // and the restricted DB role cannot read token hashes even directly
    const { getDb } = await import('../platform/db');
    await expect(getDb().withTenant({ tenantId: owner.tenantId }, (c) => c.query('SELECT token_hash FROM tenant_invitations'))).rejects.toMatchObject({ code: '42501' });
  });

  it('permissions: agent sees the directory but not the member list; admin sees both', async () => {
    expect((await agent.get('/api/v1/members/directory')).status).toBe(200);
    expect((await agent.get('/api/v1/members/directory')).body.data[0]).not.toHaveProperty('email');
    expect((await agent.get('/api/v1/members')).status).toBe(403);
    expect((await admin.get('/api/v1/members')).status).toBe(200);
    expect((await agent.post('/api/v1/members/invitations', { email: 'x@anibros.test', role: 'sales_agent' })).status).toBe(403);
  });

  it('privilege escalation: an admin cannot invite an owner or promote anyone to owner or touch an owner', async () => {
    expect((await admin.post('/api/v1/members/invitations', { email: `esc${Date.now()}@anibros.test`, role: 'tenant_owner' })).status).toBe(403);
    const members = (await owner.get('/api/v1/members')).body.data.members;
    const agentM = members.find((m: any) => m.userId === agent.userId);
    const ownerM = members.find((m: any) => m.userId === owner.userId);
    expect((await admin.patch(`/api/v1/members/${agentM.membershipId}`, { role: 'tenant_owner' })).status).toBe(403);
    expect((await admin.patch(`/api/v1/members/${ownerM.membershipId}`, { role: 'sales_agent' })).status).toBe(403);
    expect((await admin.delete(`/api/v1/members/${ownerM.membershipId}`)).status).toBe(403);
    expect((await agent.patch(`/api/v1/members/${agentM.membershipId}`, { role: 'tenant_admin' })).status).toBe(403); // self-promotion
  });

  it('an invitation can be accepted exactly once and cannot be replayed', async () => {
    const email = `once${Date.now()}@anibros.test`;
    await owner.post('/api/v1/members/invitations', { email, role: 'sales_agent' });
    await h.runJobs();
    const token = h.mail.tokenFor(email, 'invited')!;
    const tries = await Promise.all(
      Array.from({ length: 5 }, (_, i) => api().post('/api/v1/invitations/accept').send({ token, name: `Racer ${i} Person`, password: `Orbit-Violet-Lantern-${i}9` }))
    );
    expect(tries.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await h.admin.query(`SELECT count(*)::int n FROM users WHERE email=$1`, [email])).rows[0].n).toBe(1);
  });

  it('expired / revoked invitations are rejected; preview reveals nothing for bad tokens', async () => {
    const e1 = `exp${Date.now()}@anibros.test`;
    await owner.post('/api/v1/members/invitations', { email: e1, role: 'sales_agent' });
    await h.runJobs();
    const t1 = h.mail.tokenFor(e1, 'invited')!;
    await h.admin.query(`UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE email=$1`, [e1]);
    expect((await api().post('/api/v1/invitations/accept').send({ token: t1, name: 'Late Comer', password: 'Orbit-Violet-Lantern-88' })).status).toBe(404);

    const e2 = `rev${Date.now()}@anibros.test`;
    const inv = await owner.post('/api/v1/members/invitations', { email: e2, role: 'sales_agent' });
    await h.runJobs();
    const t2 = h.mail.tokenFor(e2, 'invited')!;
    expect((await owner.delete(`/api/v1/members/invitations/${inv.body.data.id}`)).status).toBe(204);
    expect((await api().post('/api/v1/invitations/preview').send({ token: t2 })).status).toBe(404);
    expect((await api().post('/api/v1/invitations/preview').send({ token: 'z'.repeat(40) })).status).toBe(404);
  });

  it('existing account: must be signed in as the invited address; a different signed-in user cannot hijack the link', async () => {
    const guest = await h.register({ emailPrefix: 'guest' });
    const stranger = await h.register({ emailPrefix: 'stranger' });
    await owner.post('/api/v1/members/invitations', { email: guest.email, role: 'sales_manager' });
    await h.runJobs();
    const token = h.mail.tokenFor(guest.email, 'invited')!;

    const pre = await api().post('/api/v1/invitations/preview').send({ token });
    expect(pre.body.data).toMatchObject({ accountExists: true, role: 'sales_manager' });
    // anonymous → asked to sign in; stranger (signed in) → refused, invitation stays valid
    expect((await api().post('/api/v1/invitations/accept').send({ token })).status).toBe(400);
    const wrong = await stranger.post('/api/v1/invitations/accept', { token });
    expect(wrong.status).toBe(409);
    expect(wrong.body.detail).toMatch(/signed in as .* invitation is for .*Sign out/);
    expect((await stranger.post('/api/v1/invitations/accept', { token: 'z'.repeat(40) })).status).toBe(404); // invalid links stay indistinguishable
    // the rightful invitee succeeds and can then switch workspace
    expect((await guest.post('/api/v1/invitations/accept', { token })).body.data).toMatchObject({ status: 'joined', tenantId: owner.tenantId });
    expect((await guest.post('/api/v1/me/switch-tenant', { tenantId: owner.tenantId })).body.data.activeTenantId).toBe(owner.tenantId);
  });

  it('new person opening the link in a browser where someone else is signed in gets a clear explanation, and the invitation survives', async () => {
    const email = `newbie${Date.now().toString(36)}@anibros.test`;
    await owner.post('/api/v1/members/invitations', { email, role: 'sales_agent' });
    await h.runJobs();
    const token = h.mail.tokenFor(email, 'invited')!;
    const body = { token, name: 'Newbie Person', password: 'Violet-Lantern-Orbit-55' };
    const res = await owner.post('/api/v1/invitations/accept', body); // the owner is signed in in this "browser"
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/Sign out/);
    expect((await api().post('/api/v1/invitations/preview').send({ token })).status).toBe(200); // not consumed
    expect((await api().post('/api/v1/invitations/accept').send(body)).status).toBe(200); // works once signed out
  });

  it('role change takes effect on the very next request', async () => {
    const temp = await joinAs(owner, 'sales_manager', 'Temp Manager');
    expect((await temp.get('/api/v1/members')).status).toBe(403); // managers cannot list members
    const m = (await owner.get('/api/v1/members')).body.data.members.find((x: any) => x.userId === temp.userId);
    expect((await owner.patch(`/api/v1/members/${m.membershipId}`, { role: 'tenant_admin' })).status).toBe(200);
    expect((await temp.get('/api/v1/members')).status).toBe(200);
    expect((await owner.patch(`/api/v1/members/${m.membershipId}`, { status: 'suspended' })).status).toBe(200);
    expect((await temp.get('/api/v1/me')).status).toBe(401); // suspended → no active membership
  });

  it('removal locks the member out immediately and is audited', async () => {
    const temp = await joinAs(owner, 'sales_agent', 'Leaver Person');
    const m = (await owner.get('/api/v1/members')).body.data.members.find((x: any) => x.userId === temp.userId);
    expect((await owner.delete(`/api/v1/members/${m.membershipId}`)).status).toBe(204);
    expect((await temp.get('/api/v1/me')).status).toBe(401);
    const a = await h.admin.query(`SELECT action, actor_id FROM audit_logs WHERE entity_id=$1 AND action='member.remove'`, [m.membershipId]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].actor_id).toBe(owner.userId);
  });

  it('the workspace always keeps one owner — even when two owners demote each other concurrently', async () => {
    const solo = await h.register({ emailPrefix: 'solo', organisationName: 'Two Owners Ltd' });
    const second = await joinAs(solo, 'tenant_owner', 'Second Owner');
    const members = (await solo.get('/api/v1/members')).body.data.members;
    const mSolo = members.find((m: any) => m.userId === solo.userId);
    const mSecond = members.find((m: any) => m.userId === second.userId);

    // sole-owner guard
    const lonely = await h.register({ emailPrefix: 'lonely' });
    const lm = (await lonely.get('/api/v1/members')).body.data.members[0];
    expect((await lonely.patch(`/api/v1/members/${lm.membershipId}`, { role: 'sales_agent' })).status).toBe(409);
    expect((await lonely.delete(`/api/v1/members/${lm.membershipId}`)).status).toBe(409);

    // race: each owner demotes the other at the same instant
    const [r1, r2] = await Promise.all([
      solo.patch(`/api/v1/members/${mSecond.membershipId}`, { role: 'sales_agent' }),
      second.patch(`/api/v1/members/${mSolo.membershipId}`, { role: 'sales_agent' }),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
    const owners = await h.admin.query(`SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id=$1 AND role='tenant_owner' AND status='active'`, [solo.tenantId]);
    expect(owners.rows[0].n).toBe(1);
  });

  it('cross-tenant: an owner cannot read or modify another workspace’s members', async () => {
    const other = await h.register({ emailPrefix: 'other', organisationName: 'Other Realty' });
    const om = (await other.get('/api/v1/members')).body.data.members[0];
    expect((await owner.patch(`/api/v1/members/${om.membershipId}`, { role: 'sales_agent' })).status).toBe(404);
    expect((await owner.delete(`/api/v1/members/${om.membershipId}`)).status).toBe(404);
    const mine = (await owner.get('/api/v1/members')).body.data.members.map((m: any) => m.userId);
    expect(mine).not.toContain(other.userId);
  });
});

describe('API keys', () => {
  let owner: AuthedUser;
  let admin: AuthedUser;
  let agent: AuthedUser;
  beforeAll(async () => {
    owner = await h.register({ emailPrefix: 'keyown', organisationName: 'Keys Realty' });
    admin = await joinAs(owner, 'tenant_admin', 'Key Admin');
    agent = await joinAs(owner, 'sales_agent', 'Key Agent');
  });

  const bearer = (key: string) => ({ get: (p: string) => request(h.app).get(p).set('Authorization', `Bearer ${key}`) });

  it('create → plaintext shown once; list never exposes secrets; key authenticates within its scopes only', async () => {
    const c = await owner.post('/api/v1/api-keys', { name: 'Zapier', role: 'sales_manager', scopes: ['members:directory'], expiresInDays: 30 });
    expect(c.status).toBe(201);
    const key: string = c.body.data.key;
    expect(key).toMatch(/^crm_live_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/);

    const list = await owner.get('/api/v1/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(key.split('_').pop()!);
    expect(JSON.stringify(list.body)).not.toContain('secret');
    const stored = await h.admin.query(`SELECT secret_hash FROM api_keys WHERE id=$1`, [c.body.data.id]);
    expect(key).not.toContain(stored.rows[0].secret_hash);
    expect(stored.rows[0].secret_hash).toHaveLength(64); // sha-256 hex

    expect((await bearer(key).get('/api/v1/members/directory')).status).toBe(200); // in scope
    expect((await bearer(key).get('/api/v1/members')).status).toBe(403); // role could, scope does not
    expect((await bearer(key).get('/api/v1/api-keys')).status).toBe(403); // keys can never manage keys
    const used = await h.admin.query(`SELECT last_used_at FROM api_keys WHERE id=$1`, [c.body.data.id]);
    expect(used.rows[0].last_used_at).not.toBeNull();
  });

  it('wrong secret, malformed key, unknown prefix → 401 with the same shape', async () => {
    const c = await owner.post('/api/v1/api-keys', { name: 'Probe', role: 'sales_agent', scopes: ['members:directory'] });
    const key: string = c.body.data.key;
    const parts = key.split('_');
    const forged = `${parts[0]}_${parts[1]}_${parts[2]}_${'A'.repeat(43)}`;
    const unknown = `crm_live_${'z'.repeat(10)}_${'A'.repeat(43)}`;
    for (const bad of [forged, unknown, 'crm_live_short', 'garbage']) {
      const r = await bearer(bad).get('/api/v1/members/directory');
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('revocation is immediate; expiry is enforced', async () => {
    const c = await owner.post('/api/v1/api-keys', { name: 'Temp', role: 'sales_agent', scopes: ['members:directory'] });
    expect((await bearer(c.body.data.key).get('/api/v1/members/directory')).status).toBe(200);
    expect((await owner.delete(`/api/v1/api-keys/${c.body.data.id}`)).status).toBe(204);
    expect((await bearer(c.body.data.key).get('/api/v1/members/directory')).status).toBe(401);

    const e = await owner.post('/api/v1/api-keys', { name: 'Expiring', role: 'sales_agent', scopes: ['members:directory'], expiresInDays: 1 });
    await h.admin.query(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id=$1`, [e.body.data.id]);
    expect((await bearer(e.body.data.key).get('/api/v1/members/directory')).status).toBe(401);
  });

  it('nobody can mint a key more powerful than themselves', async () => {
    // admin cannot create an owner-role key
    expect((await admin.post('/api/v1/api-keys', { name: 'x', role: 'tenant_owner', scopes: ['members:directory'] })).status).toBe(403);
    // scope must be within the chosen role (agents cannot delete leads → neither can their key)
    expect((await owner.post('/api/v1/api-keys', { name: 'x', role: 'sales_agent', scopes: ['leads:delete'] })).status).toBe(400);
    // machine-inappropriate scopes are refused
    expect((await owner.post('/api/v1/api-keys', { name: 'x', role: 'tenant_owner', scopes: ['api_keys:manage'] })).status).toBe(400);
    // unknown scope strings are refused by validation
    expect((await owner.post('/api/v1/api-keys', { name: 'x', role: 'sales_agent', scopes: ['everything:*'] })).status).toBe(400);
    // roles without api_keys:manage cannot create keys at all
    expect((await agent.post('/api/v1/api-keys', { name: 'x', role: 'sales_agent', scopes: ['members:directory'] })).status).toBe(403);
    expect((await agent.get('/api/v1/api-keys')).status).toBe(403);
  });

  it('a key inherits its tenant only: it cannot be pointed at another workspace by header', async () => {
    const other = await h.register({ emailPrefix: 'keyother' });
    const c = await owner.post('/api/v1/api-keys', { name: 'Scoped', role: 'sales_agent', scopes: ['members:directory'] });
    const r = await request(h.app).get('/api/v1/members/directory').set('Authorization', `Bearer ${c.body.data.key}`).set('X-Tenant-Id', other.tenantId);
    expect(r.status).toBe(200);
    const ids = r.body.data.map((m: any) => m.userId);
    expect(ids).not.toContain(other.userId); // still answers for the key's own workspace
    expect(ids).toContain(owner.userId);
  });

  it('Idempotency-Key: a retried create returns the SAME key once; reuse with a different body is rejected', async () => {
    const idem = `idem-${Date.now()}-abcdef`;
    const body = { name: 'Idempotent', role: 'sales_agent', scopes: ['members:directory'] };
    const a = await owner.post('/api/v1/api-keys', body, { 'Idempotency-Key': idem });
    await new Promise((r) => setTimeout(r, 150)); // response persisted on finish
    const b = await owner.post('/api/v1/api-keys', body, { 'Idempotency-Key': idem });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(b.body.data.key).toBe(a.body.data.key);
    const n = await h.admin.query(`SELECT count(*)::int n FROM api_keys WHERE name='Idempotent'`);
    expect(n.rows[0].n).toBe(1);
    const conflict = await owner.post('/api/v1/api-keys', { ...body, name: 'Different' }, { 'Idempotency-Key': idem });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('every key lifecycle action is audited', async () => {
    const rows = await h.admin.query(`SELECT action FROM audit_logs WHERE entity_type='api_key' AND tenant_id=$1`, [owner.tenantId]);
    const actions = new Set(rows.rows.map((r) => r.action));
    expect(actions.has('api_key.create')).toBe(true);
    expect(actions.has('api_key.revoke')).toBe(true);
  });
});
