import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Database } from '../../platform/db';
import { Errors } from '../../platform/errors';
import type { Actor } from '../../platform/authz/actor';
import { PERMISSIONS, type Permission, type Role, isRole, scopeOf } from '../../platform/authz/matrix';
import { safeEqual } from '../../platform/crypto/field-encryption';
import { authDenied } from '../../platform/observability/metrics';
import { makeLimiter, type Limiter } from '../../platform/http/rate-limit';
import { config } from '../../platform/config';
import { sessionCookieName, hashToken, type SessionService, type ValidatedSession } from './sessions';

/**
 * Authentication middleware → `req.actor`.
 *
 *  Browser:  HttpOnly session cookie  (+ CSRF double-submit enforced separately for unsafe methods)
 *  Machine:  `Authorization: Bearer crm_live_<prefix>_<secret>`  (API key; hashed at rest; scoped; may only narrow its role)
 *
 * Tenant selection is explicit and verified:  X-Tenant-Id header (must be an active membership)
 *   → session.active_tenant_id (if still a member) → first membership. A header can never grant access to a tenant
 *   the user is not a member of.
 *
 * Failures are deliberately uniform (401 "Authentication is required") — no hint whether a token existed.
 */
export const API_KEY_RE = /^crm_live_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/;

function legacyCompat(req: Request, actor: Actor, session?: ValidatedSession) {
  // Fields consumed by routes that have not been ported yet. Removed when the legacy API is deleted.
  if (session) {
    const active = session.tenants.find((t) => t.id === actor.tenantId)!;
    req.user = { id: session.user.id, email: session.user.email, name: session.user.name, phone: session.user.phone, avatarUrl: session.user.avatarUrl, emailVerified: session.user.emailVerified };
    req.tenantId = actor.tenantId;
    req.tenantRole = actor.role;
    req.sessionData = {
      sessionId: session.sessionId,
      user: req.user,
      activeTenant: { id: active.id, name: active.name, slug: active.slug, role: active.role },
      allTenants: session.tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, role: t.role })),
    };
  } else {
    req.tenantId = actor.tenantId;
    req.tenantRole = actor.role;
    req.user = { id: actor.userId ?? actor.apiKeyId ?? 'api-key', email: '', name: 'API key', phone: null, avatarUrl: null, emailVerified: true };
  }
}

export interface AuthContext {
  session?: ValidatedSession;
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * How hard one caller may hit the API. Generous for people (a screen fires several requests at once) and for integrations (20 a second,
 * all day), but a runaway script or a leaked key cannot take the service down or scrape it. Wrong API keys from one address are limited far
 * harder, so guessing keys is not a pastime. Buckets live in memory: with more than one API process, swap in a shared store (see rate-limit.ts).
 */
export interface AuthLimits {
  apiKey: Limiter;
  user: Limiter;
  badKey: Limiter;
}
export const defaultAuthLimits = (db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): AuthLimits => {
  const shared = config.RATE_LIMIT_STORE === 'postgres';
  return {
    apiKey: makeLimiter({ name: 'api_key', capacity: 300, refillPerSecond: 20 }, db, shared),
    user: makeLimiter({ name: 'api_user', capacity: 600, refillPerSecond: 40 }, db, shared),
    badKey: makeLimiter({ name: 'bad_key', capacity: 20, refillPerSecond: 0.2 }, db, shared),
  };
};

export function createAuthenticator(sessions: SessionService, db: Database, limits: AuthLimits = defaultAuthLimits(db)): RequestHandler {
  /** Charge one request to this caller; answer 429 with Retry-After when they are past their allowance. */
  const charge = async (limiter: Limiter, key: string, res: Response, req: Request, next: NextFunction): Promise<boolean> => {
    const d = await limiter.takeAsync(key);
    res.setHeader('RateLimit-Limit', String(d.limit));
    res.setHeader('RateLimit-Remaining', String(d.remaining));
    if (d.allowed) return true;
    req.logger?.warn('API rate limit exceeded', { limiter: limiter.opts.name });
    next(Errors.rateLimited(d.retryAfterSeconds));
    return false;
  };
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : undefined;
      const cookie = req.cookies?.[sessionCookieName()] as string | undefined;

      // ── API key ──────────────────────────────────────────────────────────────────────────────────
      if (bearer) {
        // A wrong key counts against the address it came from; past a handful the answer becomes "slow down" instead of "no".
        // Valid keys are never held up by someone else's mistakes on the same address (an office, a shared server).
        const ip = req.ip ?? 'unknown';
        const reject = async (reason: string) => {
          const d = await limits.badKey.takeAsync(ip);
          if (!d.allowed) {
            authDenied.inc({ reason: 'api_key_guessing' });
            return next(Errors.rateLimited(d.retryAfterSeconds));
          }
          return deny(next, reason);
        };
        const m = API_KEY_RE.exec(bearer);
        if (!m) return await reject('bad_api_key_format');
        const { rows } = await db.query(`SELECT * FROM app.resolve_api_key($1)`, [m[1]]);
        const k = rows[0];
        const presented = hashToken(m[2]);
        // Compare even when the key is unknown, so timing does not reveal valid prefixes.
        const stored = k?.secret_hash ?? hashToken('no-such-key');
        const matches = safeEqual(presented, stored) && Boolean(k);
        if (!matches || k.revoked_at || (k.expires_at && new Date(k.expires_at) < new Date()) || !k.tenant_active || !isRole(k.role)) {
          return await reject('api_key_rejected');
        }
        const allowed = new Set<Permission>(
          (k.scopes as string[]).filter((s): s is Permission => (PERMISSIONS as string[]).includes(s) && scopeOf(k.role, s as Permission) !== undefined)
        );
        const actor: Actor = { kind: 'api_key', tenantId: k.tenant_id, userId: null, role: k.role as Role, apiKeyId: k.id, allowedPermissions: allowed, requestId: req.id, ip: req.ip };
        if (!(await charge(limits.apiKey, k.id, res, req, next))) return;
        req.actor = actor;
        legacyCompat(req, actor);
        void db.query(`SELECT app.touch_api_key($1, $2)`, [k.id, req.ip ?? null]).catch(() => undefined);
        return next();
      }

      // ── Session cookie ───────────────────────────────────────────────────────────────────────────
      const session = await sessions.validate(cookie);
      if (!session) return deny(next, cookie ? 'session_invalid' : 'no_credentials');
      if (!session.user.emailVerified) {
        authDenied.inc({ reason: 'email_unverified' });
        return next(Errors.emailNotVerified());
      }
      if (session.tenants.length === 0) return deny(next, 'no_membership');

      const requested = (req.headers['x-tenant-id'] as string | undefined)?.trim();
      let tenant = requested ? session.tenants.find((t) => t.id === requested) : undefined;
      if (requested && !tenant) {
        authDenied.inc({ reason: 'tenant_not_member' });
        return next(Errors.forbidden('You are not a member of the requested workspace'));
      }
      tenant ??= session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0];

      const actor: Actor = { kind: 'user', tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: req.id, ip: req.ip };
      if (!(await charge(limits.user, session.user.id, res, req, next))) return;
      req.actor = actor;
      req.auth = { session };
      legacyCompat(req, actor, session);
      next();
    } catch (err) {
      next(err);
    }
  };
}

function deny(next: NextFunction, reason: string) {
  authDenied.inc({ reason });
  next(Errors.unauthenticated());
}

/** Generate an API key: returns the plaintext (shown ONCE) plus the parts to persist. */
export function generateApiKey(): { plaintext: string; prefix: string; secretHash: string } {
  const prefix = crypto.randomBytes(8).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, '0');
  const secret = crypto.randomBytes(32).toString('base64url'); // 43 chars
  return { plaintext: `crm_live_${prefix}_${secret}`, prefix, secretHash: hashToken(secret) };
}
