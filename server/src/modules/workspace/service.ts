import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { ROUTING_SOURCES, parseRouting, type RoutingRule } from '../leads/service';

/**
 * Workspace settings: ONE typed, validated, merge-style writer of tenants.settings and the tenants.timezone column.
 *
 * Why this exists (audit finding S-6): the old Tenant Configuration page replaced the whole settings JSON with four keys, silently
 * deleting lead-assignment rules, the first-reply deadline, scoring weights and the default country; its timezone was saved to a
 * place the reminders never read. Here:
 *   - only known keys are accepted (unknown keys are a 400, not stored)
 *   - an update touches ONLY the keys it names; everything else in the blob is preserved
 *   - timezone lives in the column (what reminders read); a stale settings.timezone copy is removed when the column is written
 *   - an optional If-Match makes concurrent edits fail with 412 instead of overwriting each other
 *   - every change is audited with the names of the fields changed (never secrets: there are none here)
 */
export const ASSIGNMENT_MODES = ['creator', 'balanced', 'unassigned'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export interface WorkspaceDto {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  defaultCountry: string | null;
  leadAssignment: AssignmentMode;
  firstResponseMinutes: number;
  /** Leads from a source go to the named people (least busy first); see leads/service. */
  routing: RoutingRule[];
  primaryColor: string | null;
  accentColor: string | null;
  /** Opaque version for If-Match (milliseconds of the last change). */
  version: number;
}
export interface WorkspacePatch {
  name?: string;
  timezone?: string;
  currency?: string;
  defaultCountry?: string | null;
  leadAssignment?: AssignmentMode;
  firstResponseMinutes?: number;
  routing?: RoutingRule[];
  primaryColor?: string | null;
  accentColor?: string | null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC';
  } catch {
    return false;
  }
}

function toDto(r: any): WorkspaceDto {
  const s = (r.settings ?? {}) as Record<string, any>;
  const mode = s.leadAssignment;
  const mins = Number(s.sla?.firstResponseMinutes);
  return {
    name: r.name,
    slug: r.slug,
    timezone: r.timezone,
    currency: typeof s.currency === 'string' ? s.currency : 'INR',
    defaultCountry: typeof s.defaultCountry === 'string' ? s.defaultCountry : null,
    leadAssignment: mode === 'balanced' || mode === 'unassigned' ? mode : 'creator',
    firstResponseMinutes: Number.isFinite(mins) && mins >= 0 && mins <= 10_080 ? mins : 30,
    routing: parseRouting(s.routing),
    primaryColor: typeof s.primary_color === 'string' ? s.primary_color : null,
    accentColor: typeof s.accent_color === 'string' ? s.accent_color : null,
    version: new Date(r.updated_at).getTime(),
  };
}

export class WorkspaceService {
  constructor(private db: Database) {}

  async get(actor: Actor): Promise<WorkspaceDto> {
    assertCan(actor, 'tenant:read');
    return this.db.readTenant(actor, async (tx) => {
      const r = await tx.query(`SELECT name, slug, timezone, settings, updated_at FROM tenants WHERE id = $1`, [actor.tenantId]);
      if (!r.rows[0]) throw Errors.notFound('Workspace');
      return toDto(r.rows[0]);
    });
  }

  async update(actor: Actor, patch: WorkspacePatch, ifMatch?: number): Promise<WorkspaceDto> {
    assertCan(actor, 'tenant:update');
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw Errors.validation([{ path: 'body.timezone', message: 'Use an IANA time zone such as Asia/Kolkata' }]);
    return this.db.withTenant(actor, async (tx) => {
      const cur = (await tx.query(`SELECT name, slug, timezone, settings, updated_at FROM tenants WHERE id = $1 FOR UPDATE`, [actor.tenantId])).rows[0];
      if (!cur) throw Errors.notFound('Workspace');
      if (ifMatch !== undefined && ifMatch !== new Date(cur.updated_at).getTime()) throw Errors.preconditionFailed('Someone else changed the workspace settings. Reload and try again.');

      const before = toDto(cur);
      const settings: Record<string, any> = { ...(cur.settings ?? {}) };
      const changed: string[] = [];
      const setKey = (key: string, value: unknown, label: string) => {
        if (value === null) delete settings[key];
        else settings[key] = value;
        changed.push(label);
      };
      if (patch.currency !== undefined) setKey('currency', patch.currency.toUpperCase(), 'currency');
      if (patch.defaultCountry !== undefined) setKey('defaultCountry', patch.defaultCountry ? patch.defaultCountry.toUpperCase() : null, 'defaultCountry');
      if (patch.leadAssignment !== undefined) setKey('leadAssignment', patch.leadAssignment, 'leadAssignment');
      if (patch.primaryColor !== undefined) setKey('primary_color', patch.primaryColor, 'primaryColor');
      if (patch.accentColor !== undefined) setKey('accent_color', patch.accentColor, 'accentColor');
      if (patch.firstResponseMinutes !== undefined) {
        settings.sla = { ...(typeof settings.sla === 'object' && settings.sla ? settings.sla : {}), firstResponseMinutes: patch.firstResponseMinutes };
        changed.push('firstResponseMinutes');
      }
      if (patch.routing !== undefined) {
        const rules = patch.routing.filter((r) => (ROUTING_SOURCES as readonly string[]).includes(r.source));
        if (new Set(rules.map((r) => r.source)).size !== rules.length) throw Errors.validation([{ path: 'body.routing', message: 'Each source can have only one rule' }]);
        const ids = [...new Set(rules.flatMap((r) => r.userIds))];
        if (ids.length) {
          const ok = await tx.query(`SELECT tm.user_id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id AND u.is_active WHERE tm.tenant_id = $1 AND tm.status = 'active' AND tm.is_active AND tm.user_id = ANY($2::uuid[]) AND tm.role IN ('sales_agent', 'sales_manager', 'tenant_admin', 'tenant_owner')`, [actor.tenantId, ids]);
          const good = new Set(ok.rows.map((x) => x.user_id as string));
          const bad = ids.find((i) => !good.has(i));
          if (bad) throw Errors.validation([{ path: 'body.routing', message: 'Every person in a rule must work leads in this client' }]);
        }
        if (rules.length) settings.routing = rules;
        else delete settings.routing;
        changed.push('routing');
      }
      const newName = patch.name?.trim();
      const newZone = patch.timezone;
      if (newZone !== undefined) {
        delete settings.timezone; // the column is the single source of truth; do not leave a stale copy behind
        changed.push('timezone');
      }
      if (newName !== undefined) changed.push('name');
      if (!changed.length) return before;

      await tx.query(
        `UPDATE tenants SET settings = $2::jsonb, name = COALESCE($3, name), timezone = COALESCE($4, timezone), updated_at = clock_timestamp() WHERE id = $1`,
        [actor.tenantId, JSON.stringify(settings), newName ?? null, newZone ?? null]
      );
      const after = toDto((await tx.query(`SELECT name, slug, timezone, settings, updated_at FROM tenants WHERE id = $1`, [actor.tenantId])).rows[0]);
      await audit(tx, { action: 'workspace.update', entityType: 'workspace', entityId: actor.tenantId, before: pick(before, changed), after: pick(after, changed) });
      return after;
    });
  }
}

export interface ClientProfilePatch {
  name?: string;
  industry?: string;
  website?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  timezone?: string;
  currency?: string;
}

/**
 * Agency clients: the profile and lifecycle columns of the tenants row. Same rule as everything above: this module is the ONLY writer of
 * the tenants table, so the agency layer calls these instead of writing SQL of its own. Only whitelisted columns are touched. The
 * currency and time zone also live in `settings`/the column pair that other code reads, so they are kept consistent here.
 * Returns the labels of the fields that changed (for the audit entry). The caller authorises and audits.
 */
export async function writeClientProfile(tx: pg.PoolClient, tenantId: string, patch: ClientProfilePatch): Promise<string[]> {
  const sets: string[] = [];
  const vals: unknown[] = [tenantId];
  const changed: string[] = [];
  const set = (col: string, v: unknown, label: string) => {
    if (v === undefined) return;
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
    changed.push(label);
  };
  set('name', patch.name, 'name');
  set('industry', patch.industry, 'industry');
  set('website', patch.website, 'website');
  set('contact_name', patch.contactName, 'contactName');
  set('contact_email', patch.contactEmail, 'contactEmail');
  set('contact_phone', patch.contactPhone, 'contactPhone');
  set('notes', patch.notes, 'notes');
  set('timezone', patch.timezone, 'timezone');
  if (patch.timezone !== undefined) sets.push(`settings = settings - 'timezone'`); // the column is the single source of truth; no stale copy
  if (patch.currency !== undefined) {
    vals.push(patch.currency.toUpperCase());
    sets.push(`default_currency = $${vals.length}`, `settings = jsonb_set(settings, '{currency}', to_jsonb($${vals.length}::text))`);
    changed.push('currency');
  }
  if (!sets.length) return [];
  await tx.query(`UPDATE tenants SET ${sets.join(', ')}, updated_at = clock_timestamp() WHERE id = $1 AND kind = 'client'`, vals);
  return changed;
}

/** Archive or restore a client workspace: archived = inactive, so sessions, API keys and lead capture stop resolving it. Nothing is deleted. */
export async function writeClientArchived(tx: pg.PoolClient, tenantId: string, archived: boolean): Promise<void> {
  await tx.query(`UPDATE tenants SET archived_at = CASE WHEN $2::boolean THEN now() END, is_active = NOT $2::boolean, updated_at = clock_timestamp() WHERE id = $1 AND kind = 'client'`, [tenantId, archived]);
  if (archived) await tx.query(`SELECT app.detach_sessions($1::uuid)`, [tenantId]);
}

const pick = (o: WorkspaceDto, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as unknown as Record<string, unknown>)[k]]));
