import { Errors } from '../errors';
import { can, scopeOf, type Permission, type Role, type Scope } from './matrix';
import type { DbContext } from '../db';

/**
 * The authenticated principal performing an operation. Created by the auth middleware, passed explicitly into
 * services (never read from globals), and doubles as the DB tenant context.
 */
export interface Actor extends DbContext {
  tenantId: string;
  userId: string | null;
  role: Role;
  kind: 'user' | 'api_key' | 'system';
  /** API keys carry an explicit allow-list narrower than the role. */
  apiKeyId?: string;
  allowedPermissions?: ReadonlySet<Permission>;
  requestId?: string;
  ip?: string;
}

function permitted(actor: Actor, permission: Permission): boolean {
  if (actor.kind === 'system') return true;
  if (actor.allowedPermissions && !actor.allowedPermissions.has(permission)) return false;
  return can(actor.role, permission);
}

/** Throws 403 unless the actor holds `permission` (any scope). */
export function assertCan(actor: Actor, permission: Permission): void {
  if (!permitted(actor, permission)) throw Errors.forbidden();
}

/**
 * Effective scope for list/read filters. Throws 403 when denied.
 * `own` means the service must add its ownership predicate (e.g. `l.owner_id = $actor`).
 */
export function scopeFor(actor: Actor, permission: Permission): Scope {
  if (actor.kind === 'system') return 'all';
  assertCan(actor, permission);
  return scopeOf(actor.role, permission)!;
}

/** Effective scope, or undefined when the actor lacks the permission (never throws): for aggregates that must degrade, not 403. */
export function scopeIfAllowed(actor: Actor, permission: Permission): Scope | undefined {
  if (actor.kind === 'system') return 'all';
  return permitted(actor, permission) ? scopeOf(actor.role, permission) : undefined;
}

/** True when the actor may act on a record owned by `ownerId` for this permission. */
export function canActOn(actor: Actor, permission: Permission, ownerId: string | null | undefined): boolean {
  if (!permitted(actor, permission)) return false;
  const scope = actor.kind === 'system' ? 'all' : scopeOf(actor.role, permission);
  if (scope === 'all') return true;
  return Boolean(ownerId) && ownerId === actor.userId;
}

export function assertCanActOn(actor: Actor, permission: Permission, ownerId: string | null | undefined): void {
  // 404 (not 403) for out-of-scope records so existence is not revealed to an agent probing other agents' leads.
  if (!permitted(actor, permission)) throw Errors.forbidden();
  if (!canActOn(actor, permission, ownerId)) throw Errors.notFound();
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      /** Set by the authentication middleware for session / API-key authenticated routes. */
      actor?: Actor;
    }
  }
}
