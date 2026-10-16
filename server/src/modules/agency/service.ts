import type pg from 'pg';
import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import { scopeOf, type Role } from '../../platform/authz/matrix';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { logger } from '../../logger';
import { isValidTimeZone, writeClientArchived, writeClientProfile } from '../workspace/service';
import type { LeadsService } from '../leads/service';
import type { MembersService } from '../members/service';
import { loadFieldDefs, insertFieldDef, seedStarterFields } from '../custom-fields/service';
import { INDUSTRY_CODES, stageNamesFor, industryOf, type IndustryCode } from './industries';

/**
 * Agency layer: one organisation (the agency) owns many isolated client workspaces (tenants, kind = 'client') and one HQ workspace.
 * See docs/AGENCY_DESIGN.md. Nothing here weakens row-level security: every read of client data happens inside that client's own
 * tenant-scoped transaction, and every write to a client goes through `withTenant` for that client (so it is audited in that client).
 */

/** Roles an employee can hold INSIDE a client. Admin/owner/auditor are deliberately not assignable per client. */
export const CLIENT_ROLES = ['sales_agent', 'sales_manager', 'marketing_manager', 'marketing_analyst', 'executive_readonly'] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

export interface AgencyContext {
  organisationId: string;
  organisationName: string;
  hqTenantId: string;
  userId: string;
  hqRole: Role;
  /** HQ owner or admin: sees every client and every lead, manages clients and the team. */
  isAdmin: boolean;
  isOwner: boolean;
}

export interface ClientStats {
  totalLeads: number;
  openLeads: number;
  newLast7Days: number;
  unassigned: number;
  slaBreached: number;
  won: number;
  lastLeadAt: string | null;
  spendThisMonth: number | null;
  currency: string;
  /** Is lead capture wired up? null when the caller's role may not see integrations. */
  leadSources: { active: number; lastReceivedAt: string | null } | null;
  /** Live API keys of this client. null unless the caller manages keys. */
  apiKeys: number | null;
}

export interface ClientDto {
  id: string;
  name: string;
  slug: string;
  industry: IndustryCode | null;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  timezone: string;
  currency: string;
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt: string | null;
  /** The caller's role inside this client. */
  myRole: Role | null;
  /** Employees assigned to this client (agency admins are in every client and are not counted). */
  assignedStaff: number;
  /** null when the caller's role in this client may not see lead numbers. */
  stats: ClientStats | null;
}

export interface ClientInput {
  name: string;
  industry?: IndustryCode;
  website?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  timezone?: string;
  currency?: string;
  /** Employees to assign straight away. */
  staff?: Array<{ userId: string; role: ClientRole }>;
}
export type ClientPatch = Partial<Omit<ClientInput, 'staff'>>;

export interface StaffRow {
  userId: string;
  name: string;
  email: string;
  agencyRole: 'owner' | 'admin' | 'staff';
  status: string;
  joinedAt: string;
  clients: Array<{ clientId: string; clientName: string; role: Role; workChannels: string[] | null }>;
}

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
const nz = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class AgencyService {
  constructor(
    private db: Database,
    private leads: LeadsService,
    private members: MembersService
  ) {}

  // ── who is asking ────────────────────────────────────────────────────────────────────────────────────

  /** The caller must be an active member of their organisation's HQ (= agency staff). Derived from memberships, no second permission system. */
  async context(actor: Actor): Promise<AgencyContext> {
    if (actor.kind !== 'user' || !actor.userId) throw Errors.forbidden('Agency tools are for signed-in staff');
    const { rows } = await this.db.asUser(actor.userId).query(
      `SELECT o.id AS org_id, o.name AS org_name, hq.id AS hq_id, m.role
         FROM tenants cur
         JOIN organisations o ON o.id = cur.organisation_id
         JOIN tenants hq ON hq.organisation_id = cur.organisation_id AND hq.kind = 'agency_hq' AND hq.is_active
         JOIN tenant_memberships m ON m.tenant_id = hq.id AND m.user_id = $2 AND m.status = 'active' AND m.is_active
        WHERE cur.id = $1`,
      [actor.tenantId, actor.userId]
    );
    const r = rows[0];
    if (!r) throw Errors.forbidden('Only agency staff can use this');
    const role = r.role as Role;
    const ctx: AgencyContext = {
      organisationId: r.org_id,
      organisationName: r.org_name,
      hqTenantId: r.hq_id,
      userId: actor.userId,
      hqRole: role,
      isAdmin: role === 'tenant_owner' || role === 'tenant_admin',
      isOwner: role === 'tenant_owner',
    };
    await this.reconcileAccess(ctx);
    return ctx;
  }

  /**
   * Access inside clients is DERIVED from the HQ role (agency admin = in every client with the same role; employee = only what is
   * assigned, never an admin role). The generic Team screen can still change an HQ role directly, so this closes the gap: if a
   * person's client memberships disagree with their HQ role, fix them now. One cheap read per agency request; writes only on drift.
   */
  private async reconcileAccess(ctx: AgencyContext) {
    if (ctx.isAdmin) {
      const drift = await this.db.asUser(ctx.userId).query(
        `SELECT 1 FROM tenants t WHERE t.organisation_id = $1 AND t.kind = 'client'
            AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.user_id = $2 AND m.status = 'active' AND m.is_active AND m.role = $3::tenant_role) LIMIT 1`,
        [ctx.organisationId, ctx.userId, ctx.hqRole]
      );
      if (!drift.rowCount) return;
      await this.db.asUser(ctx.userId).query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, invited_by)
         SELECT t.id, $2, $3::tenant_role, 'active', true, $2 FROM tenants t WHERE t.organisation_id = $1 AND t.kind = 'client'
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', is_active = true`,
        [ctx.organisationId, ctx.userId, ctx.hqRole]
      );
      logger.warn('Agency admin was missing client memberships; reconciled', { userId: ctx.userId, organisationId: ctx.organisationId });
    } else {
      // Withdrawing a demoted person's stale admin rights is a repair of THEIR OWN memberships, and they are no longer an admin, so it cannot go
      // through the admin policy; the statement is pinned to that one user and agency.
      const stale = await this.db.identity.query(
        `UPDATE tenant_memberships m SET status = 'revoked', is_active = false
           FROM tenants t WHERE t.id = m.tenant_id AND t.organisation_id = $1 AND t.kind = 'client' AND m.user_id = $2
            AND m.status = 'active' AND m.is_active AND m.role IN ('tenant_owner', 'tenant_admin')`,
        [ctx.organisationId, ctx.userId]
      );
      if (stale.rowCount) logger.warn('Employee held an admin role inside clients without being an agency admin; revoked', { userId: ctx.userId, organisationId: ctx.organisationId, memberships: stale.rowCount });
    }
  }

  private requireAdmin(ctx: AgencyContext) {
    if (!ctx.isAdmin) throw Errors.forbidden('Only agency admins can do this');
  }

  /** A DB context for acting inside one client as the caller (used for audited writes). */
  private inClient(ctx: AgencyContext, clientId: string, actor: Actor) {
    return { tenantId: clientId, userId: ctx.userId, requestId: actor.requestId, ip: actor.ip };
  }

  /** `own: true` also accepts the agency's own workspace (its own leads), for read-only screens such as the overview. */
  private async clientRow(ctx: AgencyContext, id: string, opts: { forUpdate?: boolean; tx?: pg.PoolClient; own?: boolean } = {}) {
    const q = `SELECT t.*, m.role AS my_role FROM tenants t LEFT JOIN tenant_memberships m ON m.tenant_id = t.id AND m.user_id = $3 AND m.status = 'active' AND m.is_active
                WHERE t.id = $1 AND t.organisation_id = $2 AND (t.kind = 'client'${opts.own ? " OR (t.kind = 'agency_hq' AND t.is_active)" : ''})${opts.forUpdate ? ' FOR UPDATE OF t' : ''}`;
    const args = [id, ctx.organisationId, ctx.userId];
    const { rows } = opts.tx ? await opts.tx.query(q, args) : await this.db.asUser(ctx.userId).query(q, args);
    const r = rows[0];
    // 404 (not 403) so staff cannot probe for clients they are not assigned to
    if (!r || (!ctx.isAdmin && !r.my_role)) throw Errors.notFound('Client');
    return r;
  }

  // ── clients ──────────────────────────────────────────────────────────────────────────────────────────

  private toDto(r: any, assignedStaff: number, stats: ClientStats | null): ClientDto {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      industry: r.industry,
      website: r.website,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      notes: r.notes,
      timezone: r.timezone,
      currency: r.default_currency,
      status: r.archived_at ? 'archived' : 'active',
      createdAt: new Date(r.created_at).toISOString(),
      archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
      myRole: r.my_role ?? null,
      assignedStaff,
      stats,
    };
  }

  /** Lead numbers for one client, computed inside that client's own RLS-scoped transaction with the caller's own role there. */
  private async statsFor(ctx: AgencyContext, actor: Actor, c: { id: string; my_role: Role | null; default_currency: string }): Promise<ClientStats | null> {
    const role = c.my_role;
    const leadScope = scopeOf(role ?? undefined, 'leads:read');
    if (!role || !leadScope) return null;
    const spendScope = scopeOf(role, 'attribution:read');
    return this.db.readTenant(this.inClient(ctx, c.id, actor), async (tx) => {
      const params: unknown[] = [c.id];
      let own = '';
      if (leadScope === 'own') {
        params.push(ctx.userId);
        own = ` AND owner_id = $${params.length}`;
      }
      const r = (
        await tx.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
                  count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new7,
                  count(*) FILTER (WHERE closed_at IS NULL AND owner_id IS NULL)::int AS unassigned,
                  count(*) FILTER (WHERE first_response_at IS NULL AND closed_at IS NULL AND first_response_due_at < now())::int AS breached,
                  count(*) FILTER (WHERE status = 'won')::int AS won,
                  max(created_at) AS last_lead
             FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND NOT ('test' = ANY(tags))${own}`,
          params
        )
      ).rows[0];
      let spend: number | null = null;
      if (spendScope) {
        spend = Number(
          (
            await tx.query(
              `SELECT COALESCE(sum(amount), 0)::float8 AS s FROM marketing_spend
                WHERE tenant_id = $1 AND currency = $2 AND period_start >= date_trunc('month', now())::date`,
              [c.id, c.default_currency]
            )
          ).rows[0].s
        );
      }
      let leadSources: ClientStats['leadSources'] = null;
      if (scopeOf(role, 'integrations:read')) {
        const s = (await tx.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, max(last_received_at) AS last FROM inbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL`, [c.id])).rows[0];
        leadSources = { active: s.active, lastReceivedAt: s.last ? new Date(s.last).toISOString() : null };
      }
      let apiKeys: number | null = null;
      if (scopeOf(role, 'api_keys:manage')) {
        apiKeys = Number((await tx.query(`SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [c.id])).rows[0].n);
      }
      return {
        totalLeads: r.total,
        openLeads: r.open,
        newLast7Days: r.new7,
        unassigned: r.unassigned,
        slaBreached: r.breached,
        won: r.won,
        lastLeadAt: r.last_lead ? new Date(r.last_lead).toISOString() : null,
        spendThisMonth: spend,
        currency: c.default_currency,
        leadSources,
        apiKeys,
      };
    });
  }

  private async assignedCounts(ctx: AgencyContext, clientIds: string[]): Promise<Map<string, number>> {
    if (!clientIds.length) return new Map();
    const { rows } = await this.db.asUser(ctx.userId).query(
      `SELECT x.tenant_id, count(*)::int AS n
         FROM tenant_memberships x
         LEFT JOIN tenant_memberships hq ON hq.tenant_id = $2 AND hq.user_id = x.user_id AND hq.status = 'active' AND hq.is_active
        WHERE x.tenant_id = ANY($1::uuid[]) AND x.status = 'active' AND x.is_active AND COALESCE(hq.role::text, '') NOT IN ('tenant_owner', 'tenant_admin')
        GROUP BY x.tenant_id`,
      [clientIds, ctx.hqTenantId]
    );
    return new Map(rows.map((r) => [r.tenant_id as string, r.n as number]));
  }

  async listClients(actor: Actor, opts: { status: 'active' | 'archived' | 'all'; withStats: boolean }): Promise<ClientDto[]> {
    const ctx = await this.context(actor);
    const { rows } = await this.db.asUser(ctx.userId).query(
      `SELECT t.*, m.role AS my_role
         FROM tenants t LEFT JOIN tenant_memberships m ON m.tenant_id = t.id AND m.user_id = $2 AND m.status = 'active' AND m.is_active
        WHERE t.organisation_id = $1 AND t.kind = 'client'
          AND ($3::text = 'all' OR ($3::text = 'active' AND t.archived_at IS NULL) OR ($3::text = 'archived' AND t.archived_at IS NOT NULL))
          AND ($4::boolean OR m.role IS NOT NULL)
        ORDER BY lower(t.name), t.id`,
      [ctx.organisationId, ctx.userId, opts.status, ctx.isAdmin]
    );
    const counts = await this.assignedCounts(ctx, rows.map((r) => r.id));
    const stats = await mapLimit(rows, 6, (r) => (opts.withStats && !r.archived_at ? this.statsFor(ctx, actor, r) : Promise.resolve(null)));
    return rows.map((r, i) => this.toDto(r, counts.get(r.id) ?? 0, stats[i] ?? null));
  }

  async getClient(actor: Actor, id: string): Promise<ClientDto> {
    const ctx = await this.context(actor);
    const r = await this.clientRow(ctx, id, { own: true });
    const counts = await this.assignedCounts(ctx, [id]);
    return this.toDto(r, counts.get(id) ?? 0, r.archived_at ? null : await this.statsFor(ctx, actor, r));
  }

  async overview(actor: Actor) {
    const ctx = await this.context(actor);
    const clients = await this.listClients(actor, { status: 'all', withStats: true });
    const active = clients.filter((c) => c.status === 'active');
    const sum = (f: (s: ClientStats) => number) => active.reduce((n, c) => n + (c.stats ? f(c.stats) : 0), 0);
    const staff = ctx.isAdmin
      ? Number((await this.db.asUser(ctx.userId).query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' AND is_active`, [ctx.hqTenantId])).rows[0].n)
      : null;
    return {
      agency: { name: ctx.organisationName, hqTenantId: ctx.hqTenantId, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner },
      clients: { active: active.length, archived: clients.length - active.length },
      staff,
      totals: {
        totalLeads: sum((s) => s.totalLeads),
        openLeads: sum((s) => s.openLeads),
        newLast7Days: sum((s) => s.newLast7Days),
        unassigned: sum((s) => s.unassigned),
        slaBreached: sum((s) => s.slaBreached),
        won: sum((s) => s.won),
      },
    };
  }

  async createClient(actor: Actor, input: ClientInput): Promise<ClientDto> {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    const name = input.name.trim();
    const industry: IndustryCode = input.industry ?? 'other';
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) throw Errors.validation([{ path: 'body.timezone', message: 'Use an IANA time zone such as Asia/Kolkata' }]);

    const id = await this.db.asUser(ctx.userId).tx(async (tx) => {
      // One new client at a time per agency: makes the name/slug uniqueness checks below race-free.
      await tx.query(`SELECT id FROM organisations WHERE id = $1 FOR UPDATE`, [ctx.organisationId]);
      const taken = await tx.query(`SELECT slug, lower(name) AS lname FROM tenants WHERE organisation_id = $1 AND kind = 'client'`, [ctx.organisationId]);
      if (taken.rows.some((t) => t.lname === name.toLowerCase())) throw Errors.conflict('You already have a client with this name');
      const used = new Set(taken.rows.map((t) => t.slug as string));
      const base = slugify(name);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

      const hq = (await tx.query(`SELECT timezone, default_currency FROM tenants WHERE id = $1`, [ctx.hqTenantId])).rows[0];
      const currency = (input.currency ?? hq.default_currency).toUpperCase();
      const ins = await tx.query(
        `INSERT INTO tenants (organisation_id, name, slug, kind, industry, website, contact_name, contact_email, contact_phone, notes, timezone, default_currency, settings)
         VALUES ($1,$2,$3,'client',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
        [
          ctx.organisationId, name, slug, industry, nz(input.website) ?? null, nz(input.contactName) ?? null, nz(input.contactEmail) ?? null, nz(input.contactPhone) ?? null, nz(input.notes) ?? null,
          input.timezone ?? hq.timezone, currency,
          // New leads go to the least-busy assigned employee automatically; the first reply is due within 30 minutes.
          JSON.stringify({ leadAssignment: 'balanced', currency, sla: { firstResponseMinutes: 30 } }),
        ]
      );
      const clientId = ins.rows[0].id as string;

      // Agency admins are in every client (they run the agency); the owner keeps the owner role there.
      await tx.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, invited_by)
         SELECT $1, m.user_id, m.role, 'active', true, $3 FROM tenant_memberships m
          WHERE m.tenant_id = $2 AND m.status = 'active' AND m.is_active AND m.role IN ('tenant_owner', 'tenant_admin')`,
        [clientId, ctx.hqTenantId, ctx.userId]
      );
      for (const s of input.staff ?? []) await this.upsertAssignment(tx, ctx, clientId, s.userId, s.role);

      // From here the transaction acts as the caller inside the new client (guarded seed functions, audit, RLS).
      await tx.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_request_id', $3, true), set_config('app.current_ip', $4, true)`,
        [clientId, ctx.userId, actor.requestId ?? '', actor.ip ?? '']
      );
      const pipelineId = (await tx.query(`SELECT app.seed_beginner_pipeline($1) AS id`, [clientId])).rows[0].id as string;
      await tx.query(`SELECT app.seed_lead_scoring_config($1)`, [clientId]);
      const names = stageNamesFor(industry);
      if (names.length) {
        await tx.query(
          `UPDATE pipeline_stages s SET name = d.name FROM (SELECT unnest($3::text[]) AS key, unnest($4::text[]) AS name) d
            WHERE s.tenant_id = $1 AND s.pipeline_id = $2 AND s.stage_key = d.key`,
          [clientId, pipelineId, names.map((n) => n.key), names.map((n) => n.name)]
        );
      }
      // "Won needs a deal value tied to a property" is a real-estate rule.
      if (industry !== 'real_estate') await tx.query(`UPDATE pipelines SET deal_value_required = false WHERE id = $1 AND tenant_id = $2`, [pipelineId, clientId]);
      // The details this industry usually needs from a lead (editable afterwards, like any custom field).
      const starterFields = await seedStarterFields(tx, clientId, industry);
      await audit(tx, { action: 'client.create', entityType: 'tenant', entityId: clientId, after: { name, industry, staff: (input.staff ?? []).length, starterFields } });
      return clientId;
    });
    return this.getClient(actor, id);
  }

  async updateClient(actor: Actor, id: string, patch: ClientPatch): Promise<ClientDto> {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw Errors.validation([{ path: 'body.timezone', message: 'Use an IANA time zone such as Asia/Kolkata' }]);
    await this.db.withTenant(this.inClient(ctx, id, actor), async (tx) => {
      const cur = await this.clientRow(ctx, id, { forUpdate: true, tx });
      if (cur.archived_at) throw Errors.conflict('This client is archived. Restore it first.');
      const newName = patch.name?.trim();
      if (newName && newName.toLowerCase() !== String(cur.name).toLowerCase()) {
        const dup = await tx.query(`SELECT 1 FROM tenants WHERE organisation_id = $1 AND kind = 'client' AND lower(name) = lower($2) AND id <> $3`, [ctx.organisationId, newName, id]);
        if (dup.rowCount) throw Errors.conflict('You already have a client with this name');
      }
      const changed = await writeClientProfile(tx, id, {
        name: newName,
        industry: patch.industry,
        website: nz(patch.website),
        contactName: nz(patch.contactName),
        contactEmail: nz(patch.contactEmail),
        contactPhone: nz(patch.contactPhone),
        notes: nz(patch.notes),
        timezone: patch.timezone,
        currency: patch.currency,
      });
      if (!changed.length) return;
      await audit(tx, { action: 'client.update', entityType: 'tenant', entityId: id, after: { fields: changed } });
    });
    return this.getClient(actor, id);
  }

  /** Archiving removes everyone's access at once (the client is inactive: sessions and API keys stop resolving it). Nothing is deleted. */
  async setArchived(actor: Actor, id: string, archived: boolean): Promise<ClientDto> {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    await this.db.withTenant(this.inClient(ctx, id, actor), async (tx) => {
      const cur = await this.clientRow(ctx, id, { forUpdate: true, tx });
      if (Boolean(cur.archived_at) === archived) return;
      await writeClientArchived(tx, id, archived);
      await audit(tx, { action: archived ? 'client.archive' : 'client.restore', entityType: 'tenant', entityId: id });
    });
    // After archiving, the caller can no longer open the client's data; return its profile without stats.
    const ctx2 = await this.context(actor);
    const r = await this.clientRow(ctx2, id);
    const counts = await this.assignedCounts(ctx2, [id]);
    return this.toDto(r, counts.get(id) ?? 0, r.archived_at ? null : await this.statsFor(ctx2, actor, r));
  }

  /**
   * Copy the visible custom lead fields of one client to another (handy for similar clients, e.g. ten clinics). Fields the target already
   * has (same key or same name) are skipped, nothing existing is changed. Both clients stay isolated: this only copies the field DEFINITIONS.
   */
  async copyCustomFields(actor: Actor, targetId: string, sourceId: string) {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    if (targetId === sourceId) throw Errors.validation([{ path: 'body.fromClientId', message: 'Choose a different client to copy from' }]);
    const target = await this.clientRow(ctx, targetId);
    await this.clientRow(ctx, sourceId);
    if (target.archived_at) throw Errors.conflict('This client is archived. Restore it first.');
    const source = (await this.db.readTenant(this.inClient(ctx, sourceId, actor), (tx) => loadFieldDefs(tx, sourceId))).filter((d) => d.visible);
    return this.db.withTenant(this.inClient(ctx, targetId, actor), async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom-fields:' || $1, 0))`, [targetId]);
      let defs = await loadFieldDefs(tx, targetId);
      const copied: string[] = [];
      const skipped: string[] = [];
      for (const s of source) {
        const clash = defs.some((d) => d.key === s.key || (d.visible && d.label.trim().toLowerCase() === s.label.trim().toLowerCase()));
        if (clash) {
          skipped.push(s.label);
          continue;
        }
        const def = await insertFieldDef(tx, targetId, { label: s.label, type: s.type, key: s.key, required: s.required, options: s.options, defaultValue: s.defaultValue, helpText: s.helpText, showInList: s.showInList }, defs);
        defs = [...defs, def];
        copied.push(s.label);
      }
      await audit(tx, { action: 'custom_field.copy', entityType: 'tenant', entityId: targetId, after: { from: sourceId, copied: copied.length, skipped: skipped.length } });
      return { copied, skipped };
    });
  }

  // ── a client's team ──────────────────────────────────────────────────────────────────────────────────

  async team(actor: Actor, clientId: string) {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    await this.clientRow(ctx, clientId);
    const { rows } = await this.db.asUser(ctx.userId).query(
      `SELECT u.id AS "userId", u.name, u.email, m.role AS "clientRole", m.work_channels AS "workChannels", (hq.role IN ('tenant_owner', 'tenant_admin')) AS "isAgencyAdmin", m.created_at AS "assignedAt"
         FROM tenant_memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN tenant_memberships hq ON hq.tenant_id = $2 AND hq.user_id = m.user_id AND hq.status = 'active' AND hq.is_active
        WHERE m.tenant_id = $1 AND m.status = 'active' AND m.is_active AND u.is_active
        ORDER BY (hq.role IN ('tenant_owner', 'tenant_admin')) DESC NULLS LAST, lower(u.name)`,
      [clientId, ctx.hqTenantId]
    );
    return rows.map((r) => ({ ...r, isAgencyAdmin: Boolean(r.isAgencyAdmin) })) as Array<{ userId: string; name: string; email: string; clientRole: Role; workChannels: string[] | null; isAgencyAdmin: boolean; assignedAt: string }>;
  }

  /** channels: undefined keeps what the person handles today; null means everything; a list limits them to those kinds of work. */
  private async upsertAssignment(tx: pg.PoolClient, ctx: AgencyContext, clientId: string, userId: string, role: ClientRole, channels?: string[] | null) {
    const hq = (await tx.query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND is_active`, [ctx.hqTenantId, userId])).rows[0];
    if (!hq) throw Errors.validation([{ path: 'body.userId', message: 'Only agency employees can be assigned. Invite them to the agency first.' }]);
    if (hq.role === 'tenant_owner' || hq.role === 'tenant_admin') throw Errors.conflict('Agency admins are already in every client');
    await tx.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, invited_by, work_channels)
       VALUES ($1, $2, $3::tenant_role, 'active', true, $4, $6::text[])
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', is_active = true, invited_by = EXCLUDED.invited_by,
         work_channels = CASE WHEN $5::boolean THEN EXCLUDED.work_channels ELSE tenant_memberships.work_channels END`,
      [clientId, userId, role, ctx.userId, channels !== undefined, channels && channels.length ? channels : null]
    );
  }

  async assign(actor: Actor, clientId: string, userId: string, role: ClientRole, channels?: string[] | null) {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    await this.db.withTenant(this.inClient(ctx, clientId, actor), async (tx) => {
      const c = await this.clientRow(ctx, clientId, { forUpdate: true, tx });
      if (c.archived_at) throw Errors.conflict('This client is archived. Restore it first.');
      const before = (await tx.query(`SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [clientId, userId])).rows[0];
      await this.upsertAssignment(tx, ctx, clientId, userId, role, channels);
      await audit(tx, { action: 'client.member_assign', entityType: 'membership', entityId: userId, before: before ? { role: before.role, status: before.status } : undefined, after: { role, ...(channels !== undefined ? { channels: channels && channels.length ? channels : 'everything' } : {}) } });
    });
    return { userId, clientId, role };
  }

  /** Take an employee off a client: access ends now and their open leads there become unassigned (so nothing is stranded). */
  async unassign(actor: Actor, clientId: string, userId: string): Promise<{ leadsUnassigned: number }> {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    return this.db.withTenant(this.inClient(ctx, clientId, actor), async (tx) => {
      const c = await this.clientRow(ctx, clientId, { forUpdate: true, tx });
      if (c.archived_at) throw Errors.conflict('This client is archived. Restore it first.');
      return this.removeFromClient(tx, ctx, actor, clientId, userId, { allowAdmin: false });
    });
  }

  private async removeFromClient(tx: pg.PoolClient, ctx: AgencyContext, actor: Actor, clientId: string, userId: string, opts: { allowAdmin: boolean }) {
    const m = (
      await tx.query(
        `SELECT m.id, m.role, hq.role AS hq_role FROM tenant_memberships m
           LEFT JOIN tenant_memberships hq ON hq.tenant_id = $3 AND hq.user_id = m.user_id AND hq.status = 'active' AND hq.is_active
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.is_active FOR UPDATE OF m`,
        [clientId, userId, ctx.hqTenantId]
      )
    ).rows[0];
    if (!m) throw Errors.notFound('Assignment');
    if (!opts.allowAdmin && (m.hq_role === 'tenant_owner' || m.hq_role === 'tenant_admin')) throw Errors.conflict('Agency admins are in every client and cannot be removed from one');
    await tx.query(`UPDATE tenant_memberships SET status = 'revoked', is_active = false, updated_by = $3 WHERE id = $1 AND tenant_id = $2`, [m.id, clientId, ctx.userId]);
    await tx.query(`SELECT app.detach_sessions($1::uuid, $2::uuid)`, [clientId, userId]);
    await tx.query(`DELETE FROM lead_handlers WHERE tenant_id = $1 AND user_id = $2`, [clientId, userId]);
    const open = await tx.query(`SELECT id, owner_id FROM leads WHERE tenant_id = $1 AND owner_id = $2 AND closed_at IS NULL AND deleted_at IS NULL FOR UPDATE`, [clientId, userId]);
    const system: Actor = { kind: 'system', tenantId: clientId, userId: ctx.userId, role: 'tenant_owner', requestId: actor.requestId, ip: actor.ip };
    for (const l of open.rows) await this.leads.assignInTx(tx, system, { id: l.id, owner_id: l.owner_id }, null);
    await audit(tx, { action: 'client.member_unassign', entityType: 'membership', entityId: userId, before: { role: m.role }, after: { leadsUnassigned: open.rowCount ?? 0 } });
    return { leadsUnassigned: open.rowCount ?? 0 };
  }

  // ── the agency's employees ───────────────────────────────────────────────────────────────────────────

  async staff(actor: Actor) {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    const members = await this.db.asUser(ctx.userId).query(
      `SELECT u.id AS "userId", u.name, u.email, m.role, m.status, m.created_at AS "joinedAt"
         FROM tenant_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status IN ('active', 'suspended') ORDER BY lower(u.name)`,
      [ctx.hqTenantId]
    );
    const assignments = await this.db.asUser(ctx.userId).query(
      `SELECT m.user_id, t.id AS client_id, t.name AS client_name, m.role, m.work_channels
         FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE t.organisation_id = $1 AND t.kind = 'client' AND t.archived_at IS NULL AND m.status = 'active' AND m.is_active
        ORDER BY lower(t.name)`,
      [ctx.organisationId]
    );
    const byUser = new Map<string, StaffRow['clients']>();
    for (const a of assignments.rows) (byUser.get(a.user_id) ?? byUser.set(a.user_id, []).get(a.user_id)!).push({ clientId: a.client_id, clientName: a.client_name, role: a.role, workChannels: a.work_channels ?? null });
    // tenant_invitations is tenant-scoped (RLS): read it inside the HQ's own context.
    const invitations = await this.db.readTenant(this.inClient(ctx, ctx.hqTenantId, actor), (tx) =>
      tx.query(
        `SELECT id, email, created_at AS "createdAt", expires_at AS "expiresAt" FROM tenant_invitations
          WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
        [ctx.hqTenantId]
      )
    );
    const staff: StaffRow[] = members.rows.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      agencyRole: m.role === 'tenant_owner' ? 'owner' : m.role === 'tenant_admin' ? 'admin' : 'staff',
      status: m.status,
      joinedAt: new Date(m.joinedAt).toISOString(),
      clients: byUser.get(m.userId) ?? [],
    }));
    return { staff, invitations: invitations.rows as Array<{ id: string; email: string; createdAt: string; expiresAt: string }> };
  }

  /** Invite an employee to the agency (HQ). They are then assigned to clients one by one. */
  async inviteStaff(actor: Actor, email: string) {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    const name = (await this.db.asUser(ctx.userId).query(`SELECT name FROM users WHERE id = $1`, [ctx.userId])).rows[0]?.name ?? 'Your agency';
    const hqActor: Actor = { ...actor, tenantId: ctx.hqTenantId, role: ctx.hqRole };
    return this.members.invite(hqActor, { email, role: 'sales_agent' }, name);
  }

  /** Promote an employee to agency admin (every client, full control) or demote back to a normal employee. Owner only. */
  async setStaffRole(actor: Actor, userId: string, agencyRole: 'admin' | 'staff') {
    const ctx = await this.context(actor);
    if (!ctx.isOwner) throw Errors.forbidden('Only the agency owner can change who is an admin');
    return this.db.withTenant(this.inClient(ctx, ctx.hqTenantId, actor), async (tx) => {
      const m = (await tx.query(`SELECT id, role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND is_active FOR UPDATE`, [ctx.hqTenantId, userId])).rows[0];
      if (!m) throw Errors.notFound('Employee');
      if (m.role === 'tenant_owner') throw Errors.conflict('The agency owner’s role cannot be changed here');
      const target = agencyRole === 'admin' ? 'tenant_admin' : 'sales_agent';
      if (m.role === target) return { userId, agencyRole };
      await tx.query(`UPDATE tenant_memberships SET role = $3::tenant_role, updated_by = $4 WHERE id = $1 AND tenant_id = $2`, [m.id, ctx.hqTenantId, target, ctx.userId]);
      if (agencyRole === 'admin') {
        await tx.query(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, invited_by)
           SELECT t.id, $2, 'tenant_admin', 'active', true, $3 FROM tenants t WHERE t.organisation_id = $1 AND t.kind = 'client'
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'tenant_admin', status = 'active', is_active = true`,
          [ctx.organisationId, userId, ctx.userId]
        );
      } else {
        // Demoted: they keep only what is assigned to them afterwards, so their admin access to every client ends now.
        await tx.query(
          `UPDATE tenant_memberships SET status = 'revoked', is_active = false, updated_by = $3
            WHERE user_id = $2 AND role = 'tenant_admin' AND tenant_id IN (SELECT id FROM tenants WHERE organisation_id = $1 AND kind = 'client')`,
          [ctx.organisationId, userId, ctx.userId]
        );
        await tx.query(`SELECT app.detach_sessions(t.id, $2::uuid) FROM tenants t WHERE t.organisation_id = $1 AND t.kind = 'client'`, [ctx.organisationId, userId]);
      }
      await audit(tx, { action: 'staff.role_change', entityType: 'membership', entityId: userId, before: { role: m.role }, after: { role: target } });
      return { userId, agencyRole };
    });
  }

  /** Offboard an employee: no access to the agency or any client; their open leads become unassigned. Nothing they logged is deleted. */
  async removeStaff(actor: Actor, userId: string): Promise<{ leadsUnassigned: number; clientsLeft: number }> {
    const ctx = await this.context(actor);
    this.requireAdmin(ctx);
    if (userId === ctx.userId) throw Errors.conflict('You cannot remove yourself');
    const hq = (await this.db.asUser(ctx.userId).query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND is_active`, [ctx.hqTenantId, userId])).rows[0];
    if (!hq) throw Errors.notFound('Employee');
    if (hq.role === 'tenant_owner') throw Errors.conflict('The agency owner cannot be removed');
    if (hq.role === 'tenant_admin' && !ctx.isOwner) throw Errors.forbidden('Only the agency owner can remove an admin');

    const clients = await this.db.asUser(ctx.userId).query(
      `SELECT t.id FROM tenants t JOIN tenant_memberships m ON m.tenant_id = t.id AND m.user_id = $2 AND m.status = 'active' AND m.is_active
        WHERE t.organisation_id = $1 AND t.kind = 'client'`,
      [ctx.organisationId, userId]
    );
    let leadsUnassigned = 0;
    for (const c of clients.rows) {
      leadsUnassigned += await this.db.withTenant(this.inClient(ctx, c.id, actor), (tx) => this.removeFromClient(tx, ctx, actor, c.id, userId, { allowAdmin: true })).then((r) => r.leadsUnassigned);
    }
    await this.db.withTenant(this.inClient(ctx, ctx.hqTenantId, actor), async (tx) => {
      await tx.query(`UPDATE tenant_memberships SET status = 'revoked', is_active = false, updated_by = $3 WHERE tenant_id = $1 AND user_id = $2`, [ctx.hqTenantId, userId, ctx.userId]);
      await tx.query(`SELECT app.detach_sessions($1::uuid, $2::uuid)`, [ctx.hqTenantId, userId]);
      const open = await tx.query(`SELECT id, owner_id FROM leads WHERE tenant_id = $1 AND owner_id = $2 AND closed_at IS NULL AND deleted_at IS NULL FOR UPDATE`, [ctx.hqTenantId, userId]);
      const system: Actor = { kind: 'system', tenantId: ctx.hqTenantId, userId: ctx.userId, role: 'tenant_owner', requestId: actor.requestId, ip: actor.ip };
      for (const l of open.rows) await this.leads.assignInTx(tx, system, { id: l.id, owner_id: l.owner_id }, null);
      leadsUnassigned += open.rowCount ?? 0;
      await audit(tx, { action: 'staff.remove', entityType: 'membership', entityId: userId, after: { clientsLeft: clients.rowCount, leadsUnassigned } });
    });
    return { leadsUnassigned, clientsLeft: clients.rowCount ?? 0 };
  }
}

export { INDUSTRY_CODES, industryOf };
