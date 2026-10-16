/**
 * Request type augmentation used by the authenticator (req.user / req.tenantId / req.tenantRole / req.sessionData).
 * The legacy requireRoles / executeInTenantContext / pool helpers were removed in remediation Slice 0: new code uses the permission
 * matrix (assertCan) and db.withTenant / db.readTenant.
 */

export interface LegacyUser { id: string; email: string; name: string; phone: string | null; avatarUrl: string | null; emailVerified: boolean }
export interface LegacySessionData {
  sessionId: string;
  user: LegacyUser;
  activeTenant: { id: string; name: string; slug: string; role: string };
  allTenants: Array<{ id: string; name: string; slug: string; role: string }>;
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      // Legacy fields consumed by routes that have not been ported to the declarative route layer yet.
      user?: LegacyUser;
      tenantId?: string;
      tenantRole?: string;
      sessionData?: LegacySessionData;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

