import { z } from 'zod';
import type { Database } from '../../platform/db';
import { Errors } from '../../platform/errors';
import { defineRoute, noContent, type RouteSpec } from '../../platform/http/route';
import { capabilitiesFor, ROLES } from '../../platform/authz/matrix';
import { setCsrfCookie } from '../../middleware/csrf';
import { AuthService, type LoginSuccess } from './auth.service';
import { clearSessionCookie, sessionCookieName, setSessionCookie, type SessionService, type ValidatedSession } from './sessions';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordInput = z.string().min(1).max(128);

const tenantInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(ROLES),
  timezone: z.string(),
  currency: z.string(),
  kind: z.enum(['agency_hq', 'client']).describe('agency_hq = the agency’s own workspace; client = one client’s isolated workspace'),
  industry: z.string().nullable(),
  workChannels: z.array(z.string()).nullable().describe('What kinds of work this person may log in this workspace (call, whatsapp, sms, email, instagram, meeting); null = everything'),
});
const userInfo = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  mfaEnabled: z.boolean(),
});
const meResponse = z.object({
  user: userInfo,
  tenants: z.array(tenantInfo),
  activeTenantId: z.string().uuid(),
  capabilities: z.record(z.string(), z.enum(['all', 'own'])),
  sessionId: z.string().uuid(),
});

function describeSession(s: ValidatedSession, activeTenantId: string, role: string) {
  return {
    user: {
      id: s.user.id,
      email: s.user.email,
      name: s.user.name,
      phone: s.user.phone,
      avatarUrl: s.user.avatarUrl,
      timezone: s.user.timezone,
      locale: s.user.locale,
      mfaEnabled: s.user.mfaEnabled,
    },
    tenants: s.tenants,
    activeTenantId,
    capabilities: capabilitiesFor(role),
    sessionId: s.sessionId,
  };
}

export function createIdentityRoutes(auth: AuthService, sessions: SessionService, db: Database) {
  const meta = (req: any) => ({ ip: req.ip as string | undefined, userAgent: req.get('user-agent') as string | undefined, requestId: req.id as string });

  const issueCookies = (res: any, s: LoginSuccess) => {
    setSessionCookie(res, s.token, s.expiresAt);
    return setCsrfCookie(res);
  };

  // ───────────────────────────── public auth routes ─────────────────────────────
  const authRoutes: RouteSpec[] = [
    defineRoute({
      method: 'get',
      path: '/csrf',
      auth: 'public',
      summary: 'Obtain a CSRF token',
      description: 'Sets the `anibrosdesign_csrf` cookie and returns the token. Send it back in the `x-csrf-token` header on every cookie-authenticated mutation. API-key clients do not need this.',
      tags: ['Auth'],
      response: z.object({ csrfToken: z.string() }),
      handler: async ({ res }) => ({ csrfToken: setCsrfCookie(res) }),
    }),

    defineRoute({
      method: 'post',
      path: '/signup',
      auth: 'public',
      summary: 'Create an account and workspace',
      description:
        'Always responds identically whether or not the email is already registered (prevents account enumeration). A verification email is sent; the workspace becomes usable after verification.',
      tags: ['Auth'],
      body: z.object({
        email: emailSchema,
        password: passwordInput,
        name: z.string().trim().min(2).max(100),
        organisationName: z.string().trim().min(2).max(120).optional(),
      }),
      response: z.object({ status: z.literal('verification_sent') }),
      successStatus: 202,
      handler: async ({ body, req }) => {
        await auth.signup(body, meta(req));
        return { status: 'verification_sent' as const };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/login',
      auth: 'public',
      summary: 'Sign in with email and password',
      description: 'Returns `authenticated` (session cookie set) or `mfa_required` with a short-lived `challenge` to submit to `/auth/login/mfa`.',
      tags: ['Auth'],
      body: z.object({ email: emailSchema, password: passwordInput }),
      successStatus: 200,
      handler: async ({ body, req, res }) => {
        const r = await auth.login(body, meta(req));
        if (r.kind === 'mfa_required') return { status: 'mfa_required' as const, challenge: r.challenge };
        const csrfToken = issueCookies(res, r);
        const active = r.session.tenants.find((t) => t.id === r.session.activeTenantId) ?? r.session.tenants[0];
        return { status: 'authenticated' as const, csrfToken, ...describeSession(r.session, active.id, active.role) };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/login/mfa',
      auth: 'public',
      summary: 'Complete sign-in with a TOTP code or recovery code',
      tags: ['Auth'],
      body: z.object({ challenge: z.string().min(20).max(400), code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(32).optional() }).refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), { message: 'Provide either code or recoveryCode' }),
      successStatus: 200,
      handler: async ({ body, req, res }) => {
        const r = await auth.completeMfa(body, meta(req));
        const csrfToken = issueCookies(res, r);
        const active = r.session.tenants.find((t) => t.id === r.session.activeTenantId) ?? r.session.tenants[0];
        return { status: 'authenticated' as const, csrfToken, ...describeSession(r.session, active.id, active.role) };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/logout',
      auth: 'public',
      summary: 'Sign out (revokes the current session)',
      tags: ['Auth'],
      successStatus: 204,
      handler: async ({ req, res }) => {
        await auth.logout(req.cookies?.[sessionCookieName()]);
        clearSessionCookie(res);
        return noContent();
      },
    }),

    defineRoute({
      method: 'post',
      path: '/verify-email',
      auth: 'public',
      summary: 'Verify an email address and sign in',
      tags: ['Auth'],
      body: z.object({ token: z.string().min(20).max(200) }),
      successStatus: 200,
      handler: async ({ body, req, res }) => {
        const r = await auth.verifyEmail(body.token, meta(req));
        const csrfToken = issueCookies(res, r);
        const active = r.session.tenants.find((t) => t.id === r.session.activeTenantId) ?? r.session.tenants[0];
        return { status: 'authenticated' as const, csrfToken, ...describeSession(r.session, active.id, active.role) };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/resend-verification',
      auth: 'public',
      summary: 'Resend the verification email',
      description: 'Always returns 202, regardless of whether the address exists or is already verified.',
      tags: ['Auth'],
      body: z.object({ email: emailSchema }),
      successStatus: 202,
      handler: async ({ body, req }) => {
        await auth.resendVerification(body.email, meta(req));
        return { status: 'accepted' as const };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/password-reset/request',
      auth: 'public',
      summary: 'Request a password-reset email',
      description: 'Always returns 202 (no account enumeration). The link expires after 1 hour and works once.',
      tags: ['Auth'],
      body: z.object({ email: emailSchema }),
      successStatus: 202,
      handler: async ({ body, req }) => {
        await auth.requestPasswordReset(body.email, meta(req));
        return { status: 'accepted' as const };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/password-reset/complete',
      auth: 'public',
      summary: 'Set a new password using a reset token',
      description: 'Revokes every active session of the account.',
      tags: ['Auth'],
      body: z.object({ token: z.string().min(20).max(200), password: passwordInput }),
      successStatus: 200,
      handler: async ({ body, req }) => {
        await auth.completePasswordReset(body.token, body.password, meta(req));
        return { status: 'password_updated' as const };
      },
    }),
  ];

  // ───────────────────────────── current user ─────────────────────────────
  const meRoutes: RouteSpec[] = [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Current user, workspaces and capabilities',
      description: '`capabilities` maps each permission the caller holds to its scope (`all` or `own`). Use it to drive UI affordances; the server enforces regardless.',
      tags: ['Me'],
      response: meResponse,
      handler: async ({ actor, req }) => {
        const s = req.auth?.session;
        if (!s) throw Errors.badRequest('This endpoint requires a user session, not an API key');
        return describeSession(s, actor.tenantId, actor.role);
      },
    }),

    defineRoute({
      method: 'patch',
      path: '/',
      summary: 'Update your profile',
      tags: ['Me'],
      body: z
        .object({
          name: z.string().trim().min(2).max(100).optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown IANA time zone').optional(),
          locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
        })
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      handler: async ({ body, actor }) => {
        if (!actor.userId) throw Errors.forbidden();
        const { rows } = await db.asUser(actor.userId).query(
          `UPDATE users SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                  timezone = COALESCE($5, timezone), locale = COALESCE($6, locale)
            WHERE id = $1 RETURNING id, email, name, phone, timezone, locale`,
          [actor.userId, body.name ?? null, body.phone !== undefined, body.phone ?? null, body.timezone ?? null, body.locale ?? null]
        );
        return rows[0];
      },
    }),

    defineRoute({
      method: 'post',
      path: '/password',
      summary: 'Change your password',
      description: 'Signs out all your other sessions.',
      tags: ['Me'],
      body: z.object({ currentPassword: passwordInput, newPassword: passwordInput }),
      successStatus: 204,
      handler: async ({ body, actor, req }) => {
        const s = req.auth!.session!;
        await auth.changePassword(actor.userId!, s.sessionId, { current: body.currentPassword, next: body.newPassword });
        return noContent();
      },
    }),

    defineRoute({
      method: 'post',
      path: '/switch-tenant',
      summary: 'Switch the active workspace for this session',
      tags: ['Me'],
      body: z.object({ tenantId: z.string().uuid() }),
      successStatus: 200,
      handler: async ({ body, req }) => {
        const s = req.auth!.session!;
        const target = s.tenants.find((t) => t.id === body.tenantId);
        if (!target) throw Errors.notFound('Workspace');
        await sessions.setActiveTenant(s.sessionId, target.id);
        return describeSession(s, target.id, target.role);
      },
    }),

    defineRoute({
      method: 'get',
      path: '/sessions',
      summary: 'List your active sessions',
      tags: ['Me'],
      handler: async ({ actor, req }) => sessions.list(actor.userId!, req.auth!.session!.sessionId),
    }),

    defineRoute({
      method: 'delete',
      path: '/sessions/:id',
      summary: 'Sign out one of your sessions',
      tags: ['Me'],
      params: z.object({ id: z.string().uuid() }),
      successStatus: 204,
      handler: async ({ params, actor }) => {
        if (!(await sessions.revokeOwn(actor.userId!, params.id))) throw Errors.notFound('Session');
        return noContent();
      },
    }),

    defineRoute({
      method: 'delete',
      path: '/sessions',
      summary: 'Sign out everywhere except this session',
      tags: ['Me'],
      handler: async ({ actor, req }) => ({ revoked: await sessions.revokeAll(actor.userId!, req.auth!.session!.sessionId) }),
    }),

    // ── MFA ──
    defineRoute({
      method: 'post',
      path: '/mfa/setup',
      summary: 'Begin two-factor setup',
      description: 'Returns the secret and an `otpauth://` URI to render as a QR code. Setup is not active until confirmed with a valid code.',
      tags: ['Me'],
      successStatus: 200,
      handler: async ({ actor, req }) => auth.mfaBeginSetup(actor.userId!, req.auth!.session!.user.email),
    }),
    defineRoute({
      method: 'post',
      path: '/mfa/confirm',
      summary: 'Confirm two-factor setup',
      description: 'Returns 10 single-use recovery codes. They are shown once.',
      tags: ['Me'],
      body: z.object({ code: z.string().regex(/^\d{6}$/) }),
      successStatus: 200,
      handler: async ({ body, actor }) => auth.mfaConfirmSetup(actor.userId!, body.code),
    }),
    defineRoute({
      method: 'post',
      path: '/mfa/recovery-codes',
      summary: 'Regenerate recovery codes',
      tags: ['Me'],
      body: z.object({ code: z.string().regex(/^\d{6}$/) }),
      successStatus: 200,
      handler: async ({ body, actor }) => ({ recoveryCodes: await auth.mfaRegenerateRecoveryCodes(actor.userId!, body.code) }),
    }),
    defineRoute({
      method: 'post',
      path: '/mfa/disable',
      summary: 'Disable two-factor authentication',
      description: 'Requires your password and a current code (or recovery code).',
      tags: ['Me'],
      body: z.object({ password: passwordInput, code: z.string().min(6).max(32) }),
      successStatus: 204,
      handler: async ({ body, actor }) => {
        await auth.mfaDisable(actor.userId!, body.password, body.code);
        return noContent();
      },
    }),
  ];

  return { authRoutes, meRoutes };
}
