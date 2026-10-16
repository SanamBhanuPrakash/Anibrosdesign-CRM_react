import crypto from 'crypto';
import type { Response } from 'express';
import type { Database } from '../../platform/db';
import { config } from '../../platform/config';
import type { Role } from '../../platform/authz/matrix';

/**
 * Server-side sessions.
 *  - Token: 256-bit random, only its SHA-256 is stored (a DB leak yields nothing replayable).
 *  - Two clocks: absolute expiry (created + 14 d) and sliding idle expiry (last_seen + 12 h).
 *  - ONE query validates a request (user + memberships + MFA flag), no N+1 per request.
 *  - Active workspace is stored on the session (server-side), not guessed from membership ordering.
 *  - `last_seen_at` writes are throttled to ≤ 1/min per session (no write amplification on busy sessions).
 */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const generateToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export interface TenantMembershipInfo {
  id: string;
  name: string;
  slug: string;
  role: Role;
  timezone: string;
  currency: string;
  kind: 'agency_hq' | 'client';
  industry: string | null;
  /** What kinds of work this person may log in this client; null = everything. */
  workChannels: string[] | null;
}

export interface ValidatedSession {
  sessionId: string;
  authLevel: 1 | 2;
  activeTenantId: string | null;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    avatarUrl: string | null;
    emailVerified: boolean;
    timezone: string;
    locale: string;
    mfaEnabled: boolean;
  };
  tenants: TenantMembershipInfo[];
}

export interface SessionListItem {
  id: string;
  deviceLabel: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

/** Friendly device label from a User-Agent (no fingerprinting, display only). */
export function deviceLabel(userAgent?: string): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

export class SessionService {
  constructor(private db: Database) {}

  async create(
    userId: string,
    meta: { ip?: string; userAgent?: string; activeTenantId?: string | null; authLevel?: 1 | 2 }
  ): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + config.sessionAbsoluteMs);
    const { rows } = await this.db.identity.query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, device_label, expires_at, active_tenant_id, auth_level, mfa_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::smallint, CASE WHEN $8::smallint = 2 THEN now() END)
       RETURNING id`,
      [userId, hashToken(token), meta.ip ?? null, meta.userAgent?.slice(0, 400) ?? null, deviceLabel(meta.userAgent), expiresAt, meta.activeTenantId ?? null, meta.authLevel ?? 1]
    );
    return { token, expiresAt, sessionId: rows[0].id };
  }

  async validate(token: string | undefined): Promise<ValidatedSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const { rows } = await this.db.identity.query(
      `SELECT s.id AS session_id, s.auth_level, s.active_tenant_id, s.created_at AS session_created, s.last_seen_at,
              u.id AS user_id, u.email, u.name, u.phone, u.avatar_url, u.email_verified, u.timezone, u.locale,
              EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa_enabled,
              COALESCE((
                SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'role', tm.role,
                                                  'timezone', t.timezone, 'currency', t.default_currency, 'kind', t.kind, 'industry', t.industry, 'workChannels', tm.work_channels) ORDER BY tm.created_at)
                  FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
                 WHERE tm.user_id = u.id AND tm.status = 'active' AND tm.is_active AND t.is_active
              ), '[]'::json) AS tenants
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(secs => $2::int) AND u.is_active`,
      [hashToken(token), Math.floor(config.sessionIdleMs / 1000)]
    );
    const r = rows[0];
    if (!r) return null;

    // Sliding idle window: refresh at most once a minute.
    if (Date.now() - new Date(r.last_seen_at).getTime() > 60_000) {
      void this.db.identity
        .query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`, [r.session_id])
        .catch(() => undefined);
    }

    return {
      sessionId: r.session_id,
      authLevel: r.auth_level,
      activeTenantId: r.active_tenant_id,
      createdAt: r.session_created,
      user: {
        id: r.user_id,
        email: r.email,
        name: r.name,
        phone: r.phone,
        avatarUrl: r.avatar_url,
        emailVerified: Boolean(r.email_verified),
        timezone: r.timezone,
        locale: r.locale,
        mfaEnabled: r.mfa_enabled,
      },
      tenants: r.tenants,
    };
  }

  async revokeByToken(token: string): Promise<void> {
    await this.db.identity.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)]);
  }

  /** Revoke one of the user's own sessions (id must belong to the user). */
  async revokeOwn(userId: string, sessionId: string): Promise<boolean> {
    const r = await this.db.identity.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    const r = await this.db.identity.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null]
    );
    return r.rowCount ?? 0;
  }

  async list(userId: string, currentSessionId: string): Promise<SessionListItem[]> {
    const { rows } = await this.db.identity.query(
      `SELECT id, device_label, ip_address, created_at, last_seen_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(secs => $2::int)
        ORDER BY last_seen_at DESC LIMIT 50`,
      [userId, Math.floor(config.sessionIdleMs / 1000)]
    );
    return rows.map((r) => ({ id: r.id, deviceLabel: r.device_label, ip: r.ip_address, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentSessionId }));
  }

  async setActiveTenant(sessionId: string, tenantId: string): Promise<void> {
    await this.db.identity.query(`UPDATE sessions SET active_tenant_id = $2 WHERE id = $1`, [sessionId, tenantId]);
  }
}

// ── cookies ─────────────────────────────────────────────────────────────────────────────────────────────────────
// In production the cookie is `__Host-` prefixed: forces Secure, Path=/ and no Domain, defeating subdomain cookie injection.
export const sessionCookieName = () => (config.isProduction ? `__Host-${config.SESSION_COOKIE_NAME}` : config.SESSION_COOKIE_NAME);

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(sessionCookieName(), token, { httpOnly: true, secure: config.isProduction, sameSite: 'lax', expires: expiresAt, path: '/' });
}
export function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName(), { httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/' });
}
