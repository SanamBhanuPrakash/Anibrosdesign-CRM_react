import { describe, it, expect } from 'vitest';
import { MATRIX, PERMISSIONS, ROLES, can, scopeOf, capabilitiesFor, assignableRoles, type Permission, type Role } from '../platform/authz/matrix';
import { assertCan, assertCanActOn, scopeFor, canActOn, type Actor } from '../platform/authz/actor';

const actor = (role: Role, userId = 'u-1'): Actor => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId,
  role,
  kind: 'user',
});

describe('permission matrix — pinned outcomes (masterplan §4)', () => {
  // [permission, role, expected scope | undefined]
  const table: Array<[Permission, Role, 'all' | 'own' | undefined]> = [
    // Leads
    ['leads:read', 'tenant_owner', 'all'],
    ['leads:read', 'sales_manager', 'all'],
    ['leads:read', 'sales_agent', 'own'],
    ['leads:read', 'marketing_analyst', 'all'],
    ['leads:read', 'executive_readonly', 'all'],
    ['leads:read', 'auditor', undefined],
    ['leads:create', 'sales_agent', 'all'],
    ['leads:create', 'marketing_manager', undefined],
    ['leads:create', 'marketing_analyst', undefined],
    ['leads:create', 'executive_readonly', undefined],
    ['leads:create', 'auditor', undefined],
    ['leads:update', 'sales_agent', 'own'],
    ['leads:update', 'sales_manager', 'all'],
    ['leads:update', 'marketing_manager', undefined],
    ['leads:delete', 'tenant_admin', 'all'],
    ['leads:delete', 'sales_manager', undefined],
    ['leads:delete', 'sales_agent', undefined],
    ['leads:assign', 'sales_manager', 'all'],
    ['leads:assign', 'sales_agent', undefined],
    // Export: NOT sales_agent
    ['leads:export', 'sales_agent', undefined],
    ['leads:export', 'marketing_analyst', 'all'],
    ['leads:export', 'executive_readonly', undefined],
    // Properties / projects
    ['properties:read', 'sales_agent', 'all'],
    ['properties:create', 'sales_agent', undefined],
    ['properties:create', 'sales_manager', 'all'],
    ['properties:delete', 'sales_manager', undefined],
    ['properties:delete', 'tenant_owner', 'all'],
    // Administration
    ['members:invite', 'tenant_admin', 'all'],
    ['members:invite', 'sales_manager', undefined],
    ['members:read', 'auditor', 'all'],
    ['members:read', 'sales_agent', undefined],
    ['members:directory', 'sales_agent', 'all'],
    ['tenant:update', 'tenant_admin', 'all'],
    ['tenant:update', 'marketing_manager', undefined],
    ['pipeline:manage', 'sales_manager', undefined],
    ['pipeline:manage', 'tenant_owner', 'all'],
    ['custom_fields:manage', 'tenant_admin', 'all'],
    ['custom_fields:manage', 'marketing_manager', undefined],
    ['api_keys:manage', 'tenant_admin', 'all'],
    ['api_keys:manage', 'marketing_manager', undefined],
    // Integrations & automation
    ['integrations:manage', 'marketing_manager', 'all'],
    ['integrations:manage', 'sales_agent', undefined],
    ['integrations:delete', 'marketing_manager', undefined],
    ['automation:manage', 'marketing_manager', 'all'],
    ['automation:delete', 'marketing_manager', undefined],
    // Oversight
    ['audit:read', 'auditor', 'all'],
    ['audit:read', 'tenant_admin', 'all'],
    ['audit:read', 'sales_manager', undefined],
    ['operations:read', 'marketing_manager', 'all'],
    ['operations:manage', 'marketing_manager', 'all'],
    ['operations:manage', 'auditor', undefined],
    ['operations:read', 'auditor', 'all'],
    // Tasks / viewings own-scope
    ['tasks:update', 'sales_agent', 'own'],
    ['viewings:update', 'sales_agent', 'own'],
    ['viewings:read', 'sales_agent', 'own'],
    // Deals: a salesperson works their own buyers; auditors and marketing cannot create or change them
    ['attribution:manage', 'marketing_manager', 'all'],
    ['attribution:manage', 'tenant_admin', 'all'],
    ['attribution:manage', 'sales_manager', undefined],
    ['attribution:manage', 'executive_readonly', undefined],
    ['attribution:read', 'sales_agent', undefined],
    ['reservations:read', 'sales_agent', 'own'],
    ['reservations:create', 'sales_agent', 'own'],
    ['reservations:update', 'sales_agent', 'own'],
    ['reservations:update', 'sales_manager', 'all'],
    ['reservations:create', 'marketing_manager', undefined],
    ['reservations:update', 'marketing_manager', undefined],
    ['reservations:read', 'marketing_manager', 'all'],
    ['reservations:read', 'auditor', undefined],
    ['reservations:update', 'executive_readonly', undefined],
    // Read-only executives
    ['reports:read', 'executive_readonly', 'all'],
    ['reports:export', 'executive_readonly', undefined],
    ['dashboard:read', 'auditor', undefined],
  ];

  it.each(table)('%s for %s → %s', (perm, role, expected) => {
    expect(scopeOf(role, perm)).toBe(expected);
    expect(can(role, perm)).toBe(expected !== undefined);
  });

  it('fails closed for unknown roles and permissions', () => {
    expect(scopeOf('root', 'leads:read')).toBeUndefined();
    expect(scopeOf(undefined, 'leads:read')).toBeUndefined();
    expect(scopeOf('tenant_owner', 'nope:nothing' as Permission)).toBeUndefined();
  });

  it('every permission key is <resource>:<action> and grants only known roles', () => {
    for (const p of PERMISSIONS) {
      expect(p).toMatch(/^[a-z_]+:[a-z_]+$/);
      for (const r of Object.keys(MATRIX[p])) expect(ROLES as readonly string[]).toContain(r);
    }
  });

  it('auditor can never mutate business data', () => {
    const mutating = PERMISSIONS.filter((p) => /:(create|update|delete|assign|import|bulk|merge|send|manage)$/.test(p));
    const allowed = mutating.filter((p) => can('auditor', p));
    expect(allowed).toEqual([]);
  });

  it('read-only executive can never mutate business data', () => {
    // Personal UI preferences (saved filters/views) are the only deliberate exception: they are per-user, not tenant data.
    const PERSONAL_PREFERENCES: Permission[] = ['saved_views:manage'];
    const mutating = PERMISSIONS.filter(
      (p) => /:(create|update|delete|assign|import|bulk|merge|send|manage|invite|remove)$/.test(p) && !PERSONAL_PREFERENCES.includes(p)
    );
    expect(mutating.filter((p) => can('executive_readonly', p))).toEqual([]);
  });

  it('owners can do everything admins can', () => {
    for (const p of PERMISSIONS) if (can('tenant_admin', p)) expect(can('tenant_owner', p)).toBe(true);
  });

  it('capabilitiesFor exposes exactly the granted permissions', () => {
    const caps = capabilitiesFor('sales_agent');
    expect(caps['leads:read']).toBe('own');
    expect(caps['leads:delete']).toBeUndefined();
    expect(Object.keys(caps).every((k) => can('sales_agent', k as Permission))).toBe(true);
  });

  it('privilege-escalation guard: admins cannot grant owner', () => {
    expect(assignableRoles('tenant_admin')).not.toContain('tenant_owner');
    expect(assignableRoles('tenant_owner')).toContain('tenant_owner');
    expect(assignableRoles('sales_manager')).toEqual([]);
  });
});

describe('actor-level enforcement', () => {
  it('assertCan throws 403 AppError when denied', () => {
    expect(() => assertCan(actor('auditor'), 'leads:read')).toThrowError(/permission/i);
    expect(() => assertCan(actor('sales_agent'), 'leads:read')).not.toThrow();
  });

  it('own-scope: agent may act on own lead, other agent’s lead looks like 404 (not 403)', () => {
    const agent = actor('sales_agent', 'agent-1');
    expect(canActOn(agent, 'leads:update', 'agent-1')).toBe(true);
    expect(canActOn(agent, 'leads:update', 'agent-2')).toBe(false);
    expect(canActOn(agent, 'leads:update', null)).toBe(false);
    try {
      assertCanActOn(agent, 'leads:update', 'agent-2');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.status).toBe(404);
    }
  });

  it('all-scope roles may act on anything', () => {
    expect(canActOn(actor('sales_manager'), 'leads:update', 'someone-else')).toBe(true);
    expect(scopeFor(actor('sales_manager'), 'leads:read')).toBe('all');
  });

  it('API key allow-list can only narrow, never widen', () => {
    const key: Actor = { ...actor('tenant_owner'), kind: 'api_key', allowedPermissions: new Set<Permission>(['leads:read']) };
    expect(() => assertCan(key, 'leads:read')).not.toThrow();
    expect(() => assertCan(key, 'leads:delete')).toThrowError();
    const keyForAgent: Actor = { ...actor('sales_agent'), kind: 'api_key', allowedPermissions: new Set<Permission>(['leads:delete']) };
    expect(() => assertCan(keyForAgent, 'leads:delete')).toThrowError(); // role does not hold it
  });
});
