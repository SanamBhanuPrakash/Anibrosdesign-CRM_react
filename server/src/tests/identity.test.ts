import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, cookiesFrom, type ApiHarness, type AuthedUser } from './support/app-harness';
import { base32Decode, hotp, timeStep } from '../modules/identity/totp';

let h: ApiHarness;
const api = () => request(h.app);

beforeAll(async () => {
  h = await bootApi({ restricted: true }); // production-style: RLS enforced, not superuser
}, 90_000);
afterAll(async () => h?.close());

const totpNow = (secret: string, stepOffset = 0) => hotp(base32Decode(secret), timeStep() + stepOffset);

describe('runtime configuration', () => {
  it('the app is running as a restricted DB role (RLS enforced), not a superuser', async () => {
    const { getDb } = await import('../platform/db');
    const info = await getDb().assertRuntimeRoleSafe('test');
    expect(info.superuser).toBe(false);
    expect(info.bypassRls).toBe(false);
  });

  it('GET /healthz and /readyz report status; readiness includes schema version', async () => {
    expect((await api().get('/healthz')).body.status).toBe('ok');
    const r = await api().get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body.schemaVersion).toMatch(/^\d+$/);
  });
});

describe('signup & email verification', () => {
  const email = `alice${Date.now()}@anibros.test`;
  const password = 'Correct-Horse-Battery-7';

  it('returns an identical 202 for new and already-registered emails (no account enumeration)', async () => {
    const first = await api().post('/api/v1/auth/signup').send({ email, password, name: 'Alice Director', organisationName: 'Alice Realty' });
    h.mail.clear();
    const again = await api().post('/api/v1/auth/signup').send({ email, password: 'Another-Strong-Pass-1', name: 'Mallory', organisationName: 'Evil Co' });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    // no second workspace was created for the existing email
    const tenants = await h.admin.query(`SELECT count(*)::int n FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE u.email=$1`, [email]);
    expect(tenants.rows[0].n).toBe(1);
  });

  it('delivers the verification email via the job queue; the token is NOT stored in plaintext', async () => {
    await h.runJobs();
    const token = h.mail.tokenFor(email, 'Verify');
    expect(token).toBeTruthy();
    const jobs = await h.admin.query(`SELECT payload FROM jobs WHERE type='mail.send'`);
    expect(JSON.stringify(jobs.rows)).not.toContain(token!);
    const stored = await h.admin.query(`SELECT token_hash FROM email_verification_tokens`);
    expect(stored.rows.map((r) => r.token_hash)).not.toContain(token);
  });

  it('rejects weak passwords with field-level errors and a requestId', async () => {
    const res = await api().post('/api/v1/auth/signup').send({ email: `weak${Date.now()}@anibros.test`, password: 'password123', name: 'Weak One' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(res.body.errors.some((e: any) => e.path === 'password')).toBe(true);
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('rejects malformed input before any work is done', async () => {
    const r = await api().post('/api/v1/auth/signup').send({ email: 'not-an-email', password: 'x', name: '' });
    expect(r.status).toBe(400);
    expect(r.body.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('client cannot self-verify: unknown fields like autoVerify are ignored', async () => {
    const rogue = `rogue${Date.now()}@anibros.test`;
    const r = await api().post('/api/v1/auth/signup').send({ email: rogue, password: 'Violet-Lantern-Orbit-42', name: 'Eve Mallory', autoVerify: true, emailVerified: true, role: 'platform_owner' });
    expect(r.status).toBe(202);
    const row = await h.admin.query(`SELECT email_verified FROM users WHERE email=$1`, [rogue]);
    expect(row.rows[0].email_verified).toBe(false);
  });

  it('unverified users cannot sign in (403 EMAIL_NOT_VERIFIED) and cannot use the API', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('verification: sets HttpOnly SameSite=Lax session cookie; replay is rejected', async () => {
    const token = h.mail.tokenFor(email, 'Verify')!;
    const ok = await api().post('/api/v1/auth/verify-email').send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('authenticated');
    const cookie = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('anibrosdesign_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect((await api().post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('concurrent use of ONE verification link yields exactly one success (atomic consume)', async () => {
    const u = `race${Date.now()}@anibros.test`;
    await api().post('/api/v1/auth/signup').send({ email: u, password: 'Race-Condition-Test-5', name: 'Racer One' });
    await h.runJobs();
    const token = h.mail.tokenFor(u, 'Verify')!;
    const results = await Promise.all(Array.from({ length: 8 }, () => api().post('/api/v1/auth/verify-email').send({ token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(7);
  });

  it('concurrent signups with the same email create exactly one account (no 500s)', async () => {
    const u = `dup${Date.now()}@anibros.test`;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api().post('/api/v1/auth/signup').send({ email: u, password: `Duplicate-Race-${i}-Pass`, name: 'Dup Racer' })));
    expect(rs.every((r) => r.status === 202)).toBe(true);
    expect((await h.admin.query(`SELECT count(*)::int n FROM users WHERE email=$1`, [u])).rows[0].n).toBe(1);
  });
});

describe('sign-in, session & CSRF', () => {
  let user: AuthedUser;
  beforeAll(async () => {
    user = await h.register({ name: 'Bob Broker', emailPrefix: 'bob' });
  });

  it('GET /me returns identity, workspaces and role-derived capabilities', async () => {
    const r = await user.get('/api/v1/me');
    expect(r.status).toBe(200);
    expect(r.body.data.user.email).toBe(user.email);
    expect(r.body.data.activeTenantId).toBe(user.tenantId);
    expect(r.body.data.tenants[0].role).toBe('tenant_owner');
    expect(r.body.data.capabilities['leads:delete']).toBe('all');
    expect(r.body.data.user).not.toHaveProperty('password_hash');
  });

  it('unauthenticated request → 401 problem+json', async () => {
    const r = await api().get('/api/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('wrong password and unknown user are indistinguishable (same status + message)', async () => {
    const wrong = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'Totally-Wrong-Password-1' });
    const ghost = await api().post('/api/v1/auth/login').send({ email: `ghost${Date.now()}@anibros.test`, password: 'Totally-Wrong-Password-1' });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body.detail).toBe(ghost.body.detail);
    expect(wrong.body.code).toBe(ghost.body.code);
  });

  it('CSRF: cookie-authenticated mutation without the token is refused', async () => {
    const r = await api().post('/api/v1/me/password').set('Cookie', user.cookies).send({ currentPassword: 'x', newPassword: 'y' });
    expect(r.status).toBe(403);
    expect(r.body.detail).toMatch(/CSRF/i);
  });

  it('CSRF: a request from a foreign Origin is refused even with valid cookies and token', async () => {
    const r = await user.post('/api/v1/me/switch-tenant', { tenantId: user.tenantId }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('logout revokes the session server-side', async () => {
    const fresh = await h.loginAs(user.email, user.password);
    expect((await fresh.get('/api/v1/me')).status).toBe(200);
    expect((await fresh.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await fresh.get('/api/v1/me')).status).toBe(401);
  });

  it('idle timeout: a session unused beyond the idle window is rejected', async () => {
    const s = await h.loginAs(user.email, user.password);
    await h.admin.query(`UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = $1`, [s.userId]);
    expect((await s.get('/api/v1/me')).status).toBe(401);
  });

  it('absolute timeout: an expired session is rejected', async () => {
    const s = await h.loginAs(user.email, user.password);
    await h.admin.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NULL`, [s.userId]);
    expect((await s.get('/api/v1/me')).status).toBe(401);
  });

  it('deactivating a user takes effect on the very next request', async () => {
    const victim = await h.register({ emailPrefix: 'victim' });
    expect((await victim.get('/api/v1/me')).status).toBe(200);
    await h.admin.query(`UPDATE users SET is_active = false WHERE id = $1`, [victim.userId]);
    expect((await victim.get('/api/v1/me')).status).toBe(401);
    const login = await api().post('/api/v1/auth/login').send({ email: victim.email, password: victim.password });
    expect(login.status).toBe(401);
  });

  it('revoking the only membership locks the user out immediately', async () => {
    const u = await h.register({ emailPrefix: 'evicted' });
    await h.admin.query(`UPDATE tenant_memberships SET status='revoked', is_active=false WHERE user_id=$1`, [u.userId]);
    expect((await u.get('/api/v1/me')).status).toBe(401);
  });

  it('X-Request-Id: safe client values are echoed, unsafe ones are replaced', async () => {
    const good = await api().get('/healthz').set('X-Request-Id', 'client-trace-12345');
    expect(good.headers['x-request-id']).toBe('client-trace-12345');
    const bad = await api().get('/healthz').set('X-Request-Id', "x'); DROP TABLE users;--");
    expect(bad.headers['x-request-id']).not.toContain('DROP');
  });

  it('unknown routes return problem+json 404 (no HTML, no stack)', async () => {
    const r = await api().get('/api/v1/definitely-not-here');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(JSON.stringify(r.body)).not.toMatch(/stack|at \w+ \(/);
  });
});

describe('password reset & change', () => {
  it('request is uniform for unknown emails; complete is single-use and revokes ALL sessions', async () => {
    const u = await h.register({ emailPrefix: 'reset' });
    const other = await h.loginAs(u.email, u.password); // second session
    h.mail.clear();

    const unknown = await api().post('/api/v1/auth/password-reset/request').send({ email: `nobody${Date.now()}@anibros.test` });
    const known = await api().post('/api/v1/auth/password-reset/request').send({ email: u.email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);

    await h.runJobs();
    expect(h.mail.sent.map((m) => m.to)).toEqual([u.email]); // only the real owner got mail
    const token = h.mail.tokenFor(u.email, 'Reset')!;
    expect(token).toBeTruthy();

    const newPw = 'Brand-New-Passphrase-2026';
    const results = await Promise.all(Array.from({ length: 6 }, () => api().post('/api/v1/auth/password-reset/complete').send({ token, password: newPw })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1); // atomic single use under concurrency

    expect((await u.get('/api/v1/me')).status).toBe(401);
    expect((await other.get('/api/v1/me')).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: u.email, password: newPw })).status).toBe(200);
    await h.runJobs();
    expect(h.mail.sent.some((m) => m.subject.includes('password was changed'))).toBe(true);
  });

  it('reset token is rejected when expired', async () => {
    const u = await h.register({ emailPrefix: 'expired' });
    await api().post('/api/v1/auth/password-reset/request').send({ email: u.email });
    await h.runJobs();
    const token = h.mail.tokenFor(u.email, 'Reset')!;
    await h.admin.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`);
    const r = await api().post('/api/v1/auth/password-reset/complete').send({ token, password: 'Another-Fine-Passphrase-8' });
    expect(r.status).toBe(400);
  });

  it('change password: needs the current password, enforces policy, signs out other sessions only', async () => {
    const u = await h.register({ emailPrefix: 'chg' });
    const other = await h.loginAs(u.email, u.password);
    expect((await u.post('/api/v1/me/password', { currentPassword: 'wrong', newPassword: 'Fresh-Strong-Passphrase-3' })).status).toBe(403);
    expect((await u.post('/api/v1/me/password', { currentPassword: u.password, newPassword: 'weak' })).status).toBe(400);
    expect((await u.post('/api/v1/me/password', { currentPassword: u.password, newPassword: 'Fresh-Strong-Passphrase-3' })).status).toBe(204);
    expect((await u.get('/api/v1/me')).status).toBe(200); // current session survives
    expect((await other.get('/api/v1/me')).status).toBe(401); // others revoked
  });
});

describe('throttling (strict limiters injected; production defaults are covered by unit tests)', () => {
  it('blocks the 6th attempt per (ip,email) with 429 + Retry-After — even with the CORRECT password', async () => {
    const { AuthService, defaultLimiters } = await import('../modules/identity/auth.service');
    const { SessionService } = await import('../modules/identity/sessions');
    const { getDb } = await import('../platform/db');
    const { RateLimiter } = await import('../platform/http/rate-limit');
    const u = await h.register({ emailPrefix: 'thr' });
    const limiters = { ...defaultLimiters(), loginIpEmail: new RateLimiter({ name: 'x', capacity: 5, refillPerSecond: 0.0001 }) };
    const svc = new AuthService(getDb(), new SessionService(getDb()), limiters);
    const meta = { ip: '198.51.100.7' };
    for (let i = 0; i < 5; i++) await expect(svc.login({ email: u.email, password: 'nope-nope-nope-1' }, meta)).rejects.toMatchObject({ status: 401 });
    const blocked = await svc.login({ email: u.email, password: u.password }, meta).catch((e) => e);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['Retry-After']).toBeDefined();
    // a different IP is unaffected → an attacker cannot lock the real user out from elsewhere
    await expect(svc.login({ email: u.email, password: u.password }, { ip: '198.51.100.99' })).resolves.toMatchObject({ kind: 'session' });
  });
});

describe('sessions & workspaces', () => {
  it('lists sessions, revokes one, signs out everywhere else', async () => {
    const a = await h.register({ emailPrefix: 'sess' });
    const b = await h.loginAs(a.email, a.password);
    const c = await h.loginAs(a.email, a.password);
    const list = await a.get('/api/v1/me/sessions');
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
    expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);

    const bId = (await b.get('/api/v1/me')).body.data.sessionId;
    expect((await a.delete(`/api/v1/me/sessions/${bId}`)).status).toBe(204);
    expect((await b.get('/api/v1/me')).status).toBe(401);
    expect((await c.get('/api/v1/me')).status).toBe(200);

    const all = await a.delete('/api/v1/me/sessions');
    expect(all.body.data.revoked).toBeGreaterThanOrEqual(1);
    expect((await c.get('/api/v1/me')).status).toBe(401);
    expect((await a.get('/api/v1/me')).status).toBe(200);
  });

  it('cannot revoke another user’s session (404, not 403)', async () => {
    const a = await h.register({ emailPrefix: 'owner1' });
    const b = await h.register({ emailPrefix: 'owner2' });
    const bSession = (await b.get('/api/v1/me')).body.data.sessionId;
    expect((await a.delete(`/api/v1/me/sessions/${bSession}`)).status).toBe(404);
    expect((await b.get('/api/v1/me')).status).toBe(200);
  });

  it('workspace switching is explicit, server-verified and persisted on the session', async () => {
    const a = await h.register({ emailPrefix: 'multi', organisationName: 'Primary Realty' });
    const other = await h.register({ emailPrefix: 'sibling', organisationName: 'Other Realty' });
    await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'sales_agent','active',true)`, [other.tenantId, a.userId]);

    const me = await a.get('/api/v1/me');
    expect(me.body.data.tenants).toHaveLength(2);
    expect(me.body.data.activeTenantId).toBe(a.tenantId); // not "whichever sorts first"

    const sw = await a.post('/api/v1/me/switch-tenant', { tenantId: other.tenantId });
    expect(sw.status).toBe(200);
    expect(sw.body.data.activeTenantId).toBe(other.tenantId);
    const after = await a.get('/api/v1/me');
    expect(after.body.data.activeTenantId).toBe(other.tenantId);
    expect(after.body.data.capabilities['leads:delete']).toBeUndefined(); // sales_agent there, not owner

    // header override works only for real memberships
    const stranger = await h.register({ emailPrefix: 'stranger' });
    expect((await a.get('/api/v1/me', { 'X-Tenant-Id': stranger.tenantId })).status).toBe(403);
    expect((await a.get('/api/v1/me', { 'X-Tenant-Id': a.tenantId })).body.data.activeTenantId).toBe(a.tenantId);
    // cannot switch into a workspace without membership
    expect((await a.post('/api/v1/me/switch-tenant', { tenantId: stranger.tenantId })).status).toBe(404);
  });
});

describe('multi-factor authentication (TOTP)', () => {
  it('setup → confirm → login requires a code; codes are single-use; recovery codes work once', async () => {
    const u = await h.register({ emailPrefix: 'mfa' });
    const setup = await u.post('/api/v1/me/mfa/setup');
    expect(setup.status).toBe(200);
    const secret: string = setup.body.data.secret;
    expect(setup.body.data.otpauthUri).toContain('otpauth://totp/');

    // not yet active: password alone still signs in
    expect((await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password })).body.data.status).toBe('authenticated');

    expect((await u.post('/api/v1/me/mfa/confirm', { code: '000000' })).status).toBe(400);
    const confirm = await u.post('/api/v1/me/mfa/confirm', { code: totpNow(secret) });
    expect(confirm.status).toBe(200);
    const recovery: string[] = confirm.body.data.recoveryCodes;
    expect(recovery).toHaveLength(10);
    // secret is encrypted at rest
    const stored = await h.admin.query(`SELECT secret_enc FROM mfa_factors WHERE user_id=$1`, [u.userId]);
    expect(stored.rows[0].secret_enc).not.toContain(secret);

    const step1 = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect(step1.body.data.status).toBe('mfa_required');
    expect(step1.headers['set-cookie']).toBeUndefined(); // no session until the 2nd factor
    const challenge = step1.body.data.challenge;

    expect((await api().post('/api/v1/auth/login/mfa').send({ challenge, code: '123456' })).status).toBe(401);
    // forged challenge
    expect((await api().post('/api/v1/auth/login/mfa').send({ challenge: challenge.slice(0, -4) + 'AAAA', code: totpNow(secret) })).status).toBe(401);

    // the confirm step already consumed the current time-step; the NEXT step is a fresh, valid code (replay protection)
    const ok = await api().post('/api/v1/auth/login/mfa').send({ challenge, code: totpNow(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('authenticated');
    const lvl = await h.admin.query(`SELECT auth_level FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.userId]);
    expect(lvl.rows[0].auth_level).toBe(2);
    // replaying the same code is refused
    expect((await api().post('/api/v1/auth/login/mfa').send({ challenge, code: totpNow(secret, 1) })).status).toBe(401);

    // recovery code: works exactly once
    const again = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    const rc = recovery[0];
    expect((await api().post('/api/v1/auth/login/mfa').send({ challenge: again.body.data.challenge, recoveryCode: rc })).status).toBe(200);
    const again2 = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect((await api().post('/api/v1/auth/login/mfa').send({ challenge: again2.body.data.challenge, recoveryCode: rc })).status).toBe(401);
  });

  it('disabling requires password + a valid code', async () => {
    const u = await h.register({ emailPrefix: 'mfaoff' });
    const secret: string = (await u.post('/api/v1/me/mfa/setup')).body.data.secret;
    const rc = (await u.post('/api/v1/me/mfa/confirm', { code: totpNow(secret) })).body.data.recoveryCodes[0];
    expect((await u.post('/api/v1/me/mfa/disable', { password: 'wrong-password-1', code: rc })).status).toBe(403);
    expect((await u.post('/api/v1/me/mfa/disable', { password: u.password, code: '999999' })).status).toBe(403);
    expect((await u.post('/api/v1/me/mfa/disable', { password: u.password, code: rc })).status).toBe(204);
    expect((await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password })).body.data.status).toBe('authenticated');
  });
});

describe('cookie helper', () => {
  it('cookiesFrom extracts session and CSRF cookies', async () => {
    const u = await h.register({ emailPrefix: 'ck' });
    const r = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    const { cookies, csrf } = cookiesFrom(r);
    expect(cookies.some((c) => c.startsWith('anibrosdesign_session='))).toBe(true);
    expect(csrf.length).toBeGreaterThan(20);
  });
});
