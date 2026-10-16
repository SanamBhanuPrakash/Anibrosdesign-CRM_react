import { z } from 'zod';
import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import { assignableRoles, PERMISSIONS, ROLES, scopeOf, can, type Permission, type Role } from '../../platform/authz/matrix';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { defineRoute, created, noContent, type RouteSpec } from '../../platform/http/route';
import { generateApiKey } from '../identity/authenticate';

/**
 * API keys for machine-to-machine access (public REST API, integrations, Zapier/Make, website forms).
 *
 *  - The plaintext (`crm_live_<prefix>_<secret>`) is returned ONCE at creation; only SHA-256(secret) is stored.
 *  - A key has a ceiling role and an explicit scope list. Scopes ⊆ the role's permissions ⊆ the creator's own permissions:
 *    nobody can mint a key more powerful than themselves.
 *  - Keys are revoked, never deleted (audit trail). Optional expiry. Last-used time/IP are tracked.
 */
const MAX_ACTIVE_KEYS = 25;

/** Permissions that make no sense for machines (interactive/identity-bound). */
const NOT_FOR_KEYS: Permission[] = ['api_keys:manage', 'members:invite', 'members:update', 'members:remove', 'privacy:manage', 'notifications:read', 'saved_views:manage'];

/**
 * Ready-made keys for the two things people actually do, so nobody has to pick scopes by hand:
 *   in   another system sends leads INTO the CRM (website form, Zapier, Make, a custom form): it can add leads and contacts, nothing else
 *   out  another system READS data OUT of the CRM (a dashboard, a spreadsheet, a BI tool): read-only, no way to change anything
 * (Getting told when something happens is a webhook, not a key: see /webhooks.)
 */
export interface KeyTemplate {
  id: 'send-leads-in' | 'read-data-out';
  direction: 'in' | 'out';
  title: string;
  description: string;
  role: Role;
  scopes: Permission[];
  expiresInDays: number | null;
  suggestedName: string;
}
export const KEY_TEMPLATES: KeyTemplate[] = [
  {
    id: 'send-leads-in',
    direction: 'in',
    title: 'Send leads into the CRM',
    description: 'For a website form, Zapier, Make or your own system. It can add leads and contacts and nothing else: it cannot read or change anything you already have.',
    role: 'sales_agent',
    scopes: ['leads:create', 'contacts:create'],
    expiresInDays: 365,
    suggestedName: 'Lead intake',
  },
  {
    id: 'read-data-out',
    direction: 'out',
    title: 'Read data out of the CRM',
    description: 'For a dashboard, a spreadsheet or a reporting tool. Read-only: leads, contacts, activity and reports. It can never change or delete anything.',
    role: 'marketing_analyst',
    scopes: ['leads:read', 'contacts:read', 'activities:read', 'dashboard:read', 'reports:read', 'attribution:read'],
    expiresInDays: 365,
    suggestedName: 'Reporting (read-only)',
  },
];

export class ApiKeyService {
  constructor(private db: Database) {}

  /** The templates this person may actually create (nobody can mint a key more powerful than themselves). */
  templates(actor: Actor): KeyTemplate[] {
    const grantable = new Set(this.availableScopes(actor));
    return KEY_TEMPLATES.filter((t) => assignableRoles(actor.role).includes(t.role) && t.scopes.every((s) => grantable.has(s) && scopeOf(t.role, s) !== undefined));
  }

  availableScopes(actor: Actor): Permission[] {
    return PERMISSIONS.filter((p) => can(actor.role, p) && !NOT_FOR_KEYS.includes(p));
  }

  async list(actor: Actor) {
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, name, prefix, role, scopes, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", last_used_ip AS "lastUsedIp",
                revoked_at AS "revokedAt", created_at AS "createdAt", created_by AS "createdBy"
           FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [actor.tenantId]
      );
      return rows;
    });
  }

  async create(actor: Actor, input: { name: string; role: Role; scopes: Permission[]; expiresInDays?: number }) {
    if (!assignableRoles(actor.role).includes(input.role)) throw Errors.forbidden(`Your role cannot create a key with role "${input.role}"`);
    const grantable = new Set(this.availableScopes(actor));
    const bad = input.scopes.filter((s) => !grantable.has(s) || scopeOf(input.role, s) === undefined);
    if (bad.length) throw Errors.validation(bad.map((s) => ({ path: 'scopes', message: `"${s}" cannot be granted to this key` })));
    if (!input.scopes.length) throw Errors.validation([{ path: 'scopes', message: 'Select at least one scope' }]);

    const key = generateApiKey();
    return this.db.withTenant(actor, async (tx) => {
      const active = await tx.query(`SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL`, [actor.tenantId]);
      if (active.rows[0].n >= MAX_ACTIVE_KEYS) throw Errors.conflict(`A workspace can have at most ${MAX_ACTIVE_KEYS} active API keys`);
      const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
      const { rows } = await tx.query(
        `INSERT INTO api_keys (name, prefix, secret_hash, role, scopes, created_by, expires_at)
         VALUES ($1, $2, $3, $4::tenant_role, $5::text[], $6, $7)
         RETURNING id, name, prefix, role, scopes, expires_at AS "expiresAt", created_at AS "createdAt"`,
        [input.name, key.prefix, key.secretHash, input.role, input.scopes, actor.userId, expires]
      );
      await audit(tx, { action: 'api_key.create', entityType: 'api_key', entityId: rows[0].id, after: { name: input.name, role: input.role, scopes: input.scopes, prefix: key.prefix } });
      return { ...rows[0], key: key.plaintext };
    });
  }

  async revoke(actor: Actor, id: string) {
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING name, prefix`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('API key');
      await audit(tx, { action: 'api_key.revoke', entityType: 'api_key', entityId: id, before: r.rows[0] });
    });
  }
}

export function createApiKeyRoutes(svc: ApiKeyService): RouteSpec[] {
  const permission = z.enum(PERMISSIONS as [Permission, ...Permission[]]);
  return [
    defineRoute({
      method: 'get',
      path: '/scopes',
      summary: 'Scopes you can grant to a key',
      tags: ['API keys'],
      permission: 'api_keys:manage',
      handler: async ({ actor }) => ({ scopes: svc.availableScopes(actor), roles: assignableRoles(actor.role) }),
    }),
    defineRoute({
      method: 'get',
      path: '/templates',
      summary: 'Ready-made key templates',
      description: 'One-click starting points: send leads in, or read data out. Create from a template by posting its role and scopes to POST /api-keys.',
      tags: ['API keys'],
      permission: 'api_keys:manage',
      handler: async ({ actor }) => svc.templates(actor),
    }),
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List API keys',
      description: 'Never returns secrets; only the public prefix, scopes, expiry and usage metadata.',
      tags: ['API keys'],
      permission: 'api_keys:manage',
      handler: async ({ actor }) => svc.list(actor),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create an API key',
      description: 'The full key is returned **once** in `key`. Use it as `Authorization: Bearer <key>`. Scopes must be a subset of the permissions of the chosen role, which must not exceed your own.',
      tags: ['API keys'],
      permission: 'api_keys:manage',
      idempotent: true,
      body: z.object({
        name: z.string().trim().min(1).max(100),
        role: z.enum(ROLES).default('sales_agent'),
        scopes: z.array(permission).min(1).max(60),
        expiresInDays: z.number().int().min(1).max(730).optional(),
      }),
      handler: async ({ body, actor }) => created(await svc.create(actor, body)),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Revoke an API key',
      description: 'Takes effect immediately. Revoked keys remain listed for audit.',
      tags: ['API keys'],
      permission: 'api_keys:manage',
      params: z.object({ id: z.string().uuid() }),
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.revoke(actor, params.id);
        return noContent();
      },
    }),
  ];
}
