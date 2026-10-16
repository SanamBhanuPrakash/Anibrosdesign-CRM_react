import crypto from 'crypto';
import type pg from 'pg';
import type { Database } from '../../platform/db';
import { config } from '../../platform/config';
import { AppError, Errors } from '../../platform/errors';
import { makeLimiter, type Limiter } from '../../platform/http/rate-limit';
import { enqueueMail } from '../../platform/mail';
import { audit } from '../../platform/audit';
import { decryptField, encryptField, safeEqual } from '../../platform/crypto/field-encryption';
import { authDenied } from '../../platform/observability/metrics';
import { hashPassword, verifyPassword, verifyAgainstDummy, needsRehash } from './passwords';
import { passwordProblems } from './password-policy';
import { generateToken, hashToken, type SessionService, type ValidatedSession } from './sessions';
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from './totp';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface Limiters {
  loginIpEmail: Limiter;
  loginIp: Limiter;
  loginEmail: Limiter;
  mfa: Limiter;
  signupIp: Limiter;
  resetIp: Limiter;
  resetEmail: Limiter;
}

/**
 * Throttling design (see docs/SECURITY_MODEL.md):
 *  - per (ip,email): stops guessing one account from one machine
 *  - per ip: stops credential stuffing across many accounts
 *  - per email (generous): bounds distributed guessing without letting an attacker LOCK a victim out (account
 *    lock-out is a denial-of-service primitive, so we slow rather than lock)
 */
export function defaultLimiters(db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Limiters {
  const shared = config.RATE_LIMIT_STORE === 'postgres';
  const mk = (opts: { name: string; capacity: number; refillPerSecond: number }) => makeLimiter(opts, db, shared);
  // Tests drive hundreds of requests from one loopback IP; production values apply everywhere else. Strict limits are
  // exercised by injecting dedicated limiters (see identity.test.ts), never by disabling limiting.
  const scale = config.isTest ? 1000 : 1;
  const per = (n: number, windowSec: number) => ({ capacity: n * scale, refillPerSecond: (n * scale) / windowSec });
  return {
    loginIpEmail: mk({ name: 'login_ip_email', ...per(5, 900) }),
    // An agency office shares one public IP: this is the broad "many accounts from one address" guard, sized for a whole team signing in at
    // the start of the day (LOGIN_IP_LIMIT per 15 min). Guessing a given account is still held to 5 per IP+email and 50 per hour per email.
    loginIp: mk({ name: 'login_ip', ...per(config.LOGIN_IP_LIMIT, 900) }),
    loginEmail: mk({ name: 'login_email', ...per(50, 3600) }),
    mfa: mk({ name: 'mfa', ...per(6, 300) }),
    signupIp: mk({ name: 'signup_ip', ...per(10, 3600) }),
    resetIp: mk({ name: 'reset_ip', ...per(10, 3600) }),
    resetEmail: mk({ name: 'reset_email', ...per(3, 3600) }),
  };
}

export interface LoginSuccess {
  kind: 'session';
  token: string;
  expiresAt: Date;
  session: ValidatedSession;
}
export interface LoginMfaRequired {
  kind: 'mfa_required';
  challenge: string;
}

const INVALID_CREDENTIALS = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials', { detail: 'Invalid email or password' });
const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 3_600_000;
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;

export class AuthService {
  constructor(
    private db: Database,
    private sessions: SessionService,
    private limiters: Limiters = defaultLimiters(db)
  ) {}

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Signup — uniform response whether or not the email is already registered (no account enumeration)
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  async signup(input: { email: string; password: string; name: string; organisationName?: string }, meta: RequestMeta): Promise<void> {
    await this.take(this.limiters.signupIp, `ip:${meta.ip}`);
    const email = input.email.trim().toLowerCase();
    const problems = passwordProblems(input.password, { email, name: input.name });
    if (problems.length) throw Errors.validation(problems.map((m) => ({ path: 'password', message: m })));

    const passwordHash = await hashPassword(input.password);
    const orgName = (input.organisationName?.trim() || `${input.name.trim()}'s Agency`).slice(0, 120);
    const slugBase = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

    const outcome = await this.db.identity.tx(async (tx) => {
      const ins = await tx.query(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id`, [email, passwordHash, input.name.trim()]);
      if (!ins.rowCount) return { created: false as const };
      const userId = ins.rows[0].id as string;

      const org = await tx.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`, [orgName, `${slugBase}-${crypto.randomBytes(3).toString('hex')}`, userId]);
      // The agency's own workspace (HQ): its staff directory and own sales leads. Client workspaces are added later from the agency layer.
      const tenant = await tx.query(`INSERT INTO tenants (organisation_id, name, slug, kind) VALUES ($1, $2, 'main', 'agency_hq') RETURNING id`, [org.rows[0].id, orgName]);
      const tenantId = tenant.rows[0].id as string;

      // From here the transaction acts AS the new owner in the new tenant (guarded seed function, audit defaults, RLS).
      await tx.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_request_id', $3, true), set_config('app.current_ip', $4, true)`,
        [tenantId, userId, meta.requestId ?? '', meta.ip ?? '']
      );
      await tx.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1, $2, 'tenant_owner', 'active', true)`, [tenantId, userId]);
      await tx.query(`SELECT app.seed_beginner_pipeline($1)`, [tenantId]);
      await tx.query(`SELECT app.seed_lead_scoring_config($1)`, [tenantId]);
      await audit(tx, { action: 'tenant.create', entityType: 'tenant', entityId: tenantId, after: { owner: userId, organisation: orgName } });
      await this.issueVerification(tx, userId, email, input.name.trim());
      return { created: true as const };
    });

    if (!outcome.created) {
      // Existing account: tell the OWNER of the mailbox (not the requester) what to do. Response to caller is identical.
      const { rows } = await this.db.identity.query(`SELECT id, name, email_verified, is_active FROM users WHERE email = $1`, [email]);
      const u = rows[0];
      if (u?.is_active) {
        await this.db.identity.tx(async (tx) => {
          if (u.email_verified) {
            await enqueueMail(tx, { template: 'account_exists', to: email, data: { name: u.name }, dedupeKey: `exists:${u.id}:${new Date().toISOString().slice(0, 10)}` });
          } else {
            await this.issueVerification(tx, u.id, email, u.name);
          }
        });
      }
    }
  }

  private async issueVerification(tx: pg.PoolClient, userId: string, email: string, name: string) {
    const token = generateToken(32);
    await tx.query(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [userId, hashToken(token), new Date(Date.now() + VERIFY_TTL_MS)]);
    await enqueueMail(tx, { template: 'verify_email', to: email, data: { name }, token });
  }

  async resendVerification(emailRaw: string, meta: RequestMeta): Promise<void> {
    await this.take(this.limiters.resetIp, `ip:${meta.ip}`);
    const email = emailRaw.trim().toLowerCase();
    if (!(await this.limiters.resetEmail.takeAsync(`resend:${email}`)).allowed) return; // silently ignore: response must not differ
    const { rows } = await this.db.identity.query(`SELECT id, name, email_verified, is_active FROM users WHERE email = $1`, [email]);
    const u = rows[0];
    if (u?.is_active && !u.email_verified) await this.db.identity.tx((tx) => this.issueVerification(tx, u.id, email, u.name));
  }

  /** Atomic, single-use consumption: concurrent replays of the same link yield exactly one success. */
  async verifyEmail(token: string, meta: RequestMeta): Promise<LoginSuccess> {
    const userId = await this.db.identity.tx(async (tx) => {
      const used = await tx.query(
        `UPDATE email_verification_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [hashToken(token)]
      );
      if (!used.rowCount) return null;
      await tx.query(`UPDATE users SET email_verified = true WHERE id = $1`, [used.rows[0].user_id]);
      // any other outstanding links for this user are now pointless
      await tx.query(`UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [used.rows[0].user_id]);
      return used.rows[0].user_id as string;
    });
    if (!userId) throw Errors.badRequest('This verification link is invalid or has expired');
    return this.startSession(userId, meta, 1);
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Login
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  async login(input: { email: string; password: string }, meta: RequestMeta): Promise<LoginSuccess | LoginMfaRequired> {
    const email = input.email.trim().toLowerCase();
    await this.take(this.limiters.loginIp, `ip:${meta.ip}`, 'Too many sign-in attempts. Try again later.');
    await this.take(this.limiters.loginIpEmail, `${meta.ip}:${email}`, 'Too many sign-in attempts for this account. Try again later.');
    await this.take(this.limiters.loginEmail, `email:${email}`, 'Too many sign-in attempts for this account. Try again later.');

    const { rows } = await this.db.identity.query(`SELECT id, password_hash, email_verified, is_active FROM users WHERE email = $1`, [email]);
    const user = rows[0];
    // Always do one Argon2 verification so response time is independent of account existence.
    const ok = user ? await verifyPassword(input.password, user.password_hash) : await verifyAgainstDummy(input.password);
    if (!user || !ok || !user.is_active) {
      await this.recordAttempt(email, meta.ip, false);
      authDenied.inc({ reason: 'bad_credentials' });
      throw INVALID_CREDENTIALS();
    }
    await this.recordAttempt(email, meta.ip, true);

    if (!user.email_verified) throw Errors.emailNotVerified();
    if (needsRehash(user.password_hash)) {
      void hashPassword(input.password).then((h) => this.db.identity.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, h])).catch(() => undefined);
    }

    const mfa = await this.db.identity.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [user.id]);
    if (mfa.rowCount) return { kind: 'mfa_required', challenge: this.signChallenge(user.id) };
    return this.startSession(user.id, meta, 1);
  }

  async completeMfa(input: { challenge: string; code?: string; recoveryCode?: string }, meta: RequestMeta): Promise<LoginSuccess> {
    const userId = this.verifyChallenge(input.challenge);
    if (!userId) throw Errors.unauthenticated('The sign-in session expired; start again');
    await this.take(this.limiters.mfa, `user:${userId}`, 'Too many verification attempts. Try again in a few minutes.');

    let ok = false;
    if (input.code) ok = await this.checkTotp(userId, input.code);
    else if (input.recoveryCode) ok = await this.useRecoveryCode(userId, input.recoveryCode);
    if (!ok) {
      authDenied.inc({ reason: 'bad_mfa' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid code', { detail: 'That code is not valid' });
    }
    return this.startSession(userId, meta, 2);
  }

  private async startSession(userId: string, meta: RequestMeta, authLevel: 1 | 2): Promise<LoginSuccess> {
    const memberships = await this.db.identity.query(
      `SELECT tm.tenant_id FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1 AND tm.status = 'active' AND tm.is_active AND t.is_active ORDER BY tm.created_at LIMIT 1`,
      [userId]
    );
    if (!memberships.rowCount) throw Errors.forbidden('This account has no active workspace. Ask an administrator for access.');
    const created = await this.sessions.create(userId, { ip: meta.ip, userAgent: meta.userAgent, activeTenantId: memberships.rows[0].tenant_id, authLevel });
    const session = await this.sessions.validate(created.token);
    if (!session) throw Errors.internal();
    return { kind: 'session', token: created.token, expiresAt: created.expiresAt, session };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.sessions.revokeByToken(token);
  }

  private async recordAttempt(email: string, ip: string | undefined, success: boolean) {
    await this.db.identity.query(`INSERT INTO login_attempts (email, ip_address, success) VALUES ($1, $2, $3)`, [email, ip ?? null, success]).catch(() => undefined);
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Password reset / change
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  async requestPasswordReset(emailRaw: string, meta: RequestMeta): Promise<void> {
    await this.take(this.limiters.resetIp, `ip:${meta.ip}`);
    const email = emailRaw.trim().toLowerCase();
    if (!(await this.limiters.resetEmail.takeAsync(`reset:${email}`)).allowed) return; // uniform response
    const { rows } = await this.db.identity.query(`SELECT id, name, is_active FROM users WHERE email = $1`, [email]);
    const u = rows[0];
    if (!u?.is_active) return;
    const token = generateToken(32);
    await this.db.identity.tx(async (tx) => {
      await tx.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [u.id, hashToken(token), new Date(Date.now() + RESET_TTL_MS)]);
      await enqueueMail(tx, { template: 'password_reset', to: email, data: { name: u.name }, token });
    });
  }

  async completePasswordReset(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const peek = await this.db.identity.query(
      `SELECT u.email, u.name FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [hashToken(token)]
    );
    if (!peek.rowCount) throw Errors.badRequest('This reset link is invalid or has expired');
    const problems = passwordProblems(newPassword, { email: peek.rows[0].email, name: peek.rows[0].name });
    if (problems.length) throw Errors.validation(problems.map((m) => ({ path: 'password', message: m })));
    const hash = await hashPassword(newPassword);

    const email = await this.db.identity.tx(async (tx) => {
      // Atomic consume: of N concurrent submissions of the same link, exactly one passes this statement.
      const used = await tx.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [hashToken(token)]);
      if (!used.rowCount) return null;
      const userId = used.rows[0].user_id as string;
      const u = await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1 RETURNING email, name`, [userId, hash]);
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await tx.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await enqueueMail(tx, { template: 'password_changed', to: u.rows[0].email, data: { name: u.rows[0].name } });
      return u.rows[0].email as string;
    });
    if (!email) throw Errors.badRequest('This reset link is invalid or has expired');
    void meta;
  }

  async changePassword(userId: string, currentSessionId: string, input: { current: string; next: string }): Promise<void> {
    const { rows } = await this.db.identity.query(`SELECT password_hash, email, name FROM users WHERE id = $1`, [userId]);
    const u = rows[0];
    if (!u || !(await verifyPassword(input.current, u.password_hash))) throw Errors.forbidden('Your current password is incorrect');
    const problems = passwordProblems(input.next, { email: u.email, name: u.name });
    if (problems.length) throw Errors.validation(problems.map((m) => ({ path: 'next', message: m })));
    const hash = await hashPassword(input.next);
    await this.db.identity.tx(async (tx) => {
      await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [userId, hash]);
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`, [userId, currentSessionId]);
      await enqueueMail(tx, { template: 'password_changed', to: u.email, data: { name: u.name } });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // MFA (TOTP)
  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  async mfaBeginSetup(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
    const confirmed = await this.db.identity.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [userId]);
    if (confirmed.rowCount) throw Errors.conflict('Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await this.db.identity.tx(async (tx) => {
      await tx.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL`, [userId]);
      await tx.query(`INSERT INTO mfa_factors (user_id, secret_enc) VALUES ($1, $2)`, [userId, encryptField(secret, `mfa:${userId}`)]);
    });
    return { secret, otpauthUri: otpauthUri(email, secret) };
  }

  async mfaConfirmSetup(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    return this.db.identity.tx(async (tx) => {
      const f = await tx.query(`SELECT id, secret_enc FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL FOR UPDATE`, [userId]);
      if (!f.rowCount) throw Errors.badRequest('Start two-factor setup first');
      const step = verifyTotp(decryptField(f.rows[0].secret_enc, `mfa:${userId}`), code);
      if (step === null) throw Errors.badRequest('That code is not valid. Check your authenticator app and try again.');
      await tx.query(`UPDATE mfa_factors SET confirmed_at = now(), last_used_step = $2 WHERE id = $1`, [f.rows[0].id, step]);
      return { recoveryCodes: await this.replaceRecoveryCodes(tx, userId) };
    });
  }

  async mfaDisable(userId: string, password: string, code: string): Promise<void> {
    const { rows } = await this.db.identity.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) throw Errors.forbidden('Your password is incorrect');
    if (!(await this.checkTotp(userId, code)) && !(await this.useRecoveryCode(userId, code))) throw Errors.forbidden('That code is not valid');
    await this.db.identity.tx(async (tx) => {
      await tx.query(`DELETE FROM mfa_factors WHERE user_id = $1`, [userId]);
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
    });
  }

  async mfaRegenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    if (!(await this.checkTotp(userId, code))) throw Errors.forbidden('That code is not valid');
    return this.db.identity.tx((tx) => this.replaceRecoveryCodes(tx, userId));
  }

  private async replaceRecoveryCodes(tx: pg.PoolClient, userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes(10);
    await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
    for (const c of codes) await tx.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hashToken(normalizeRecoveryCode(c))]);
    return codes;
  }

  /** Verifies a TOTP code with replay protection (a code can be used once per 30 s step). */
  private async checkTotp(userId: string, code: string): Promise<boolean> {
    return this.db.identity.tx(async (tx) => {
      const f = await tx.query(`SELECT id, secret_enc, last_used_step FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`, [userId]);
      if (!f.rowCount) return false;
      const step = verifyTotp(decryptField(f.rows[0].secret_enc, `mfa:${userId}`), code, { lastUsedStep: f.rows[0].last_used_step === null ? null : Number(f.rows[0].last_used_step) });
      if (step === null) return false;
      await tx.query(`UPDATE mfa_factors SET last_used_step = $2 WHERE id = $1`, [f.rows[0].id, step]);
      return true;
    });
  }

  private async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const r = await this.db.identity.query(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
      [userId, hashToken(normalizeRecoveryCode(code))]
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ── stateless, short-lived MFA challenge (binds "password was correct" to the second step) ─────────────────────
  private signChallenge(userId: string): string {
    const body = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + MFA_CHALLENGE_TTL_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }
  private verifyChallenge(challenge: string): string | null {
    const [body, sig] = challenge.split('.');
    if (!body || !sig || !safeEqual(sig, this.mac(body))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u: string; e: number };
      return p.e > Date.now() ? p.u : null;
    } catch {
      return null;
    }
  }
  private mac(body: string): string {
    return crypto.createHmac('sha256', `mfa-challenge:${config.COOKIE_SECRET}`).update(body).digest('base64url');
  }

  private async take(limiter: Limiter, key: string, message = 'Too many requests. Please try again later.') {
    const d = await limiter.takeAsync(key);
    if (!d.allowed) {
      authDenied.inc({ reason: `rate_${limiter.opts.name}` });
      throw Errors.rateLimited(d.retryAfterSeconds, message);
    }
  }
}
