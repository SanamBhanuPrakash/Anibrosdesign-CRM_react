/**
 * PERMISSION MATRIX — single source of truth for authorization.
 *
 * Used by: route guards, service-layer scope filters, the `/me/capabilities` endpoint (drives the UI),
 * API-key scopes, WebSocket event filtering and the public docs. Derived from masterplan.md §4.
 *
 * Scope semantics
 *   all   — every record in the tenant
 *   own   — only records the actor owns/is assigned to (leads.owner_id, tasks.assigned_to, viewings.agent_id …)
 *   (absent) — denied
 *
 * Adding a feature = adding its permission keys here. The test `authz.test.ts` pins the intended outcome of every
 * role × permission pair that matters, so an accidental widening fails CI.
 */
export const ROLES = [
  'tenant_owner',
  'tenant_admin',
  'sales_manager',
  'sales_agent',
  'marketing_manager',
  'marketing_analyst',
  'executive_readonly',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];
export type Scope = 'all' | 'own';

const OWNER: Role = 'tenant_owner';
const ADMIN: Role = 'tenant_admin';
const SM: Role = 'sales_manager';
const SA: Role = 'sales_agent';
const MM: Role = 'marketing_manager';
const MA: Role = 'marketing_analyst';
const EXEC: Role = 'executive_readonly';
const AUD: Role = 'auditor';

type Grants = Partial<Record<Role, Scope>>;

function g(scope: Scope, ...roles: Role[]): Grants {
  return Object.fromEntries(roles.map((r) => [r, scope])) as Grants;
}
function merge(...parts: Grants[]): Grants {
  return Object.assign({}, ...parts);
}

const ADMINS = [OWNER, ADMIN] as const;
const EVERYONE_BUT_AUDITOR = [OWNER, ADMIN, SM, SA, MM, MA, EXEC] as const;

export const MATRIX = {
  // ── Leads ─────────────────────────────────────────────────────────────────────────────────────────
  'leads:read': merge(g('all', OWNER, ADMIN, SM, MM, MA, EXEC), g('own', SA)),
  'leads:create': g('all', OWNER, ADMIN, SM, SA),
  'leads:update': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),
  'leads:delete': g('all', ...ADMINS),
  'leads:assign': g('all', OWNER, ADMIN, SM),
  // Take an unowned lead for yourself (the pool): callers can, so work gets picked up without waiting for a manager.
  'leads:claim': g('all', OWNER, ADMIN, SM, SA),
  'leads:import': g('all', OWNER, ADMIN, SM, MM),
  'leads:export': g('all', OWNER, ADMIN, SM, MM, MA),
  'leads:bulk': g('all', OWNER, ADMIN, SM),

  // ── Contacts ──────────────────────────────────────────────────────────────────────────────────────
  'contacts:read': g('all', ...EVERYONE_BUT_AUDITOR),
  'contacts:create': g('all', OWNER, ADMIN, SM, SA),
  'contacts:update': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),
  'contacts:delete': g('all', ...ADMINS),
  'contacts:merge': g('all', OWNER, ADMIN, SM),
  'contacts:export': g('all', OWNER, ADMIN, SM, MM, MA),

  // ── Activities & notes (follow the lead's visibility) ──────────────────────────────────────────────────
  'activities:read': merge(g('all', OWNER, ADMIN, SM, MM, MA, EXEC), g('own', SA)),
  'activities:create': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),

  // ── Inventory ─────────────────────────────────────────────────────────────────────────────────────
  'properties:read': g('all', ...EVERYONE_BUT_AUDITOR),
  'properties:create': g('all', OWNER, ADMIN, SM),
  'properties:update': g('all', OWNER, ADMIN, SM),
  'properties:delete': g('all', ...ADMINS),
  'projects:read': g('all', ...EVERYONE_BUT_AUDITOR),
  'projects:create': g('all', OWNER, ADMIN, SM),
  'projects:update': g('all', OWNER, ADMIN, SM),
  'projects:delete': g('all', ...ADMINS),
  'matching:use': g('all', OWNER, ADMIN, SM, SA, MM),

  // ── Scheduling ────────────────────────────────────────────────────────────────────────────────────
  // Agents see their own viewings (ones they run or that belong to their own leads): buyers' contact details are not for everyone.
  'viewings:read': merge(g('all', OWNER, ADMIN, SM, MM, MA, EXEC), g('own', SA)),
  'viewings:create': g('all', OWNER, ADMIN, SM, SA),
  'viewings:update': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),

  // ── Deals: a buyer's shortlist, offers, reservations and the recorded sale ──────────────────────────────────
  // A salesperson works their own buyers' deals; managers see and act on all of them. Releasing or reversing someone else's deal is therefore a manager action by scope.
  'reservations:read': merge(g('all', OWNER, ADMIN, SM, MM, MA, EXEC), g('own', SA)),
  'reservations:create': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),
  'reservations:update': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),
  'tasks:read': merge(g('all', OWNER, ADMIN, SM, MM), g('own', SA)),
  'tasks:create': g('all', OWNER, ADMIN, SM, SA, MM),
  'tasks:update': merge(g('all', OWNER, ADMIN, SM), g('own', SA, MM)),
  'tasks:delete': g('all', OWNER, ADMIN, SM),

  // ── Pipeline configuration ────────────────────────────────────────────────────────────────────────
  'pipeline:read': g('all', ...EVERYONE_BUT_AUDITOR),
  'pipeline:manage': g('all', ...ADMINS),

  // ── Analytics ─────────────────────────────────────────────────────────────────────────────────────
  'dashboard:read': merge(g('all', OWNER, ADMIN, SM, MM, MA, EXEC), g('own', SA)),
  'reports:read': g('all', OWNER, ADMIN, SM, MM, MA, EXEC),
  'reports:export': g('all', OWNER, ADMIN, SM, MM, MA),
  'attribution:read': g('all', OWNER, ADMIN, SM, MM, MA, EXEC),
  // marketing spend entries and the source-to-channel table: the people who run marketing and the workspace admins
  'attribution:manage': g('all', OWNER, ADMIN, MM),

  // ── Marketing / integrations / automation ──────────────────────────────────────────────────────────
  'integrations:read': g('all', OWNER, ADMIN, SM, MM, MA, EXEC),
  'integrations:manage': g('all', OWNER, ADMIN, MM),
  'integrations:delete': g('all', ...ADMINS),
  'automation:read': g('all', OWNER, ADMIN, SM, MM, MA),
  'automation:manage': g('all', OWNER, ADMIN, MM),
  'automation:delete': g('all', ...ADMINS),
  'custom_fields:read': g('all', ...EVERYONE_BUT_AUDITOR),
  'custom_fields:manage': g('all', ...ADMINS),
  'templates:read': g('all', OWNER, ADMIN, SM, SA, MM),
  'templates:manage': g('all', OWNER, ADMIN, MM),
  'messages:send': merge(g('all', OWNER, ADMIN, SM), g('own', SA)),

  // ── Workspace administration ──────────────────────────────────────────────────────────────────────
  'members:directory': g('all', ...EVERYONE_BUT_AUDITOR), // id + display name only (assignee pickers)
  'members:read': g('all', OWNER, ADMIN, AUD),
  'members:invite': g('all', ...ADMINS),
  'members:update': g('all', ...ADMINS),
  'members:remove': g('all', ...ADMINS),
  'tenant:read': g('all', ...EVERYONE_BUT_AUDITOR, AUD),
  'tenant:update': g('all', ...ADMINS),
  'branches:manage': g('all', ...ADMINS),
  'api_keys:manage': g('all', ...ADMINS),
  'webhooks:manage': g('all', ...ADMINS),
  'saved_views:manage': g('all', ...EVERYONE_BUT_AUDITOR),
  'tags:manage': g('all', OWNER, ADMIN, SM, SA, MM),

  // ── Oversight ─────────────────────────────────────────────────────────────────────────────────────
  'audit:read': g('all', OWNER, ADMIN, AUD),
  'operations:read': g('all', OWNER, ADMIN, AUD, MM),
  'operations:manage': g('all', OWNER, ADMIN, MM),
  'privacy:manage': g('all', ...ADMINS),

  // ── Everyone ──────────────────────────────────────────────────────────────────────────────────────
  'notifications:read': g('all', ...EVERYONE_BUT_AUDITOR, AUD),
  'search:use': g('all', ...EVERYONE_BUT_AUDITOR),
  'ai:use': g('all', OWNER, ADMIN, SM, SA, MM),
} as const satisfies Record<string, Grants>;

export type Permission = keyof typeof MATRIX;
export const PERMISSIONS = Object.keys(MATRIX) as Permission[];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Scope granted to `role` for `permission`; undefined = denied. Unknown roles/permissions are denied (fail closed). */
export function scopeOf(role: string | undefined, permission: Permission): Scope | undefined {
  if (!role || !isRole(role)) return undefined;
  const grants = MATRIX[permission] as Grants | undefined;
  return grants?.[role];
}

export function can(role: string | undefined, permission: Permission): boolean {
  return scopeOf(role, permission) !== undefined;
}

/** Flattened view for the UI: { 'leads:read': 'own', … } containing only granted permissions. */
export function capabilitiesFor(role: string): Partial<Record<Permission, Scope>> {
  const out: Partial<Record<Permission, Scope>> = {};
  for (const p of PERMISSIONS) {
    const s = scopeOf(role, p);
    if (s) out[p] = s;
  }
  return out;
}

/** Roles a given role may assign to others (privilege-escalation guard). Owners may grant anything; admins may not grant owner. */
export function assignableRoles(actorRole: string): Role[] {
  if (actorRole === 'tenant_owner') return [...ROLES];
  if (actorRole === 'tenant_admin') return ROLES.filter((r) => r !== 'tenant_owner');
  return [];
}
