import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import { scopeOf, type Role } from '../../platform/authz/matrix';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { slaOf, type LeadFilters, type LeadsService, type SlaState } from '../leads/service';
import { toCsv } from '../leads/csv';
import { buildXlsx, localDateTime, type Cell, type Sheet } from './xlsx';
import { loadFieldDefs } from '../custom-fields/service';
import { displayValue } from '../custom-fields/validate';
import { mapLimit, type AgencyService, type AgencyContext } from './service';

/**
 * All leads across the clients the caller may see.
 *
 * Row-level security stops one query from crossing tenants, on purpose. So this runs the SAME lead filter (LeadsService.whereFor,
 * which also applies own/all visibility) once per client, each inside that client's own tenant-scoped transaction using the caller's
 * role in that client, and merges the results. A client the caller is not a member of is never queried.
 */

export const SORTS = ['created', 'updated', 'score', 'value'] as const;
export type AgencySort = (typeof SORTS)[number];
const SORT_SQL: Record<AgencySort, string> = {
  created: 'l.created_at',
  updated: 'l.updated_at',
  score: 'l.lead_score',
  value: 'COALESCE(l.estimated_value, 0)::float8',
};
/** Largest merged window (page × pageSize). Past it, narrow by client or date, or export. */
export const MAX_WINDOW = 5_000;
export const MAX_EXPORT_LEADS = 20_000;
export const MAX_EXPORT_ACTIVITIES = 100_000;

export interface AgencyLeadFilters extends Omit<LeadFilters, 'pipelineId' | 'stageId' | 'contactId' | 'ownerId'> {
  clientId?: string;
  /** a user id, 'unassigned', or 'me' */
  ownerId?: string;
}
export interface AgencyLeadQuery extends AgencyLeadFilters {
  page: number;
  pageSize: number;
  sort: AgencySort;
  order: 'asc' | 'desc';
}

export interface Target {
  id: string;
  name: string;
  industry: string | null;
  timezone: string;
  role: Role;
}

const TOUCH_TYPES = `('call','whatsapp','sms','email','instagram','meeting')`;
const FROM = `leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id LEFT JOIN users o ON o.id = l.owner_id`;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export class AgencyLeadsService {
  constructor(
    private db: Database,
    private agency: AgencyService,
    private leads: LeadsService
  ) {}

  /** The clients the caller belongs to, whose role grants `permission`. `clientId` narrows to one (404 if it is not one of them). */
  async targets(_actor: Actor, ctx: AgencyContext, permission: 'leads:read' | 'leads:export' | 'activities:read' | 'tasks:read', clientId?: string): Promise<Target[]> {
    const { rows } = await this.db.asUser(ctx.userId).query(
      `SELECT t.id, t.name, t.industry, t.timezone, m.role
         FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active' AND m.is_active
          AND t.organisation_id = $2 AND (t.kind = 'client' OR (t.kind = 'agency_hq' AND $3::uuid IS NOT NULL)) AND t.is_active AND t.archived_at IS NULL
          AND ($3::uuid IS NULL OR t.id = $3)
        ORDER BY lower(t.name), t.id`,
      [ctx.userId, ctx.organisationId, clientId ?? null]
    );
    if (clientId && !rows.length) throw Errors.notFound('Client');
    const allowed = (rows as Target[]).filter((t) => scopeOf(t.role, permission) !== undefined);
    if (clientId && !allowed.length) throw Errors.forbidden();
    return allowed;
  }

  actorIn(ctx: AgencyContext, actor: Actor, t: Target): Actor {
    return { kind: 'user', tenantId: t.id, userId: ctx.userId, role: t.role, requestId: actor.requestId, ip: actor.ip };
  }

  private filtersFor(ctx: AgencyContext, f: AgencyLeadFilters): LeadFilters {
    const { clientId: _c, ownerId, ...rest } = f;
    return { ...rest, ...(ownerId ? { ownerId: ownerId === 'me' ? ctx.userId : ownerId } : {}) };
  }

  // ── list ─────────────────────────────────────────────────────────────────────────────────────────────

  async list(actor: Actor, q: AgencyLeadQuery) {
    const ctx = await this.agency.context(actor);
    const take = q.page * q.pageSize;
    if (take > MAX_WINDOW) throw Errors.unprocessable(`That page is too deep (the first ${MAX_WINDOW} leads can be paged). Narrow by client, date or status, or download the data.`);
    const targets = await this.targets(actor, ctx, 'leads:read', q.clientId);
    const filters = this.filtersFor(ctx, q);
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const keySql = SORT_SQL[q.sort];

    const parts = await mapLimit(targets, 6, async (t) => {
      const a = this.actorIn(ctx, actor, t);
      return this.db.readTenant(a, async (tx) => {
        const params: unknown[] = [t.id];
        const where = this.leads.whereFor(a, filters, params).join(' AND ');
        const total = Number((await tx.query(`SELECT count(*)::int AS n FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE ${where}`, params)).rows[0].n);
        params.push(take);
        const { rows } = await tx.query(
          `SELECT l.id, l.created_at, l.updated_at, c.display_name AS contact_name, c.phone, c.email::text AS email, s.name AS stage_name, s.color AS stage_color,
                  l.status, l.owner_id, o.name AS owner_name, l.source, l.campaign, l.lead_score, l.estimated_value::float8 AS estimated_value, l.currency, l.tags,
                  l.next_followup_at, l.last_activity_at, l.first_response_due_at, l.first_response_at, l.closed_at, ${keySql} AS _k
             FROM ${FROM} WHERE ${where} ORDER BY ${keySql} ${dir}, l.id ${dir} LIMIT $${params.length}`,
          params
        );
        return { t, total, rows };
      });
    });

    const keyOf = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
    const merged = parts.flatMap((p) => p.rows.map((r) => ({ t: p.t, r })));
    merged.sort((x, y) => {
      const d = keyOf(x.r._k) - keyOf(y.r._k);
      const byKey = d !== 0 ? d : x.r.id < y.r.id ? -1 : x.r.id > y.r.id ? 1 : 0;
      return q.order === 'asc' ? byKey : -byKey;
    });
    const pageRows = merged.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

    // Touch counts for the rows on this page only (one query per client that appears on it).
    const touchByLead = new Map<string, { calls: number; connected: number; total: number; lastTouchAt: string | null }>();
    const perClient = new Map<string, { t: Target; ids: string[] }>();
    for (const { t, r } of pageRows) (perClient.get(t.id) ?? perClient.set(t.id, { t, ids: [] }).get(t.id)!).ids.push(r.id);
    await mapLimit([...perClient.values()], 6, async ({ t, ids }) => {
      const a = this.actorIn(ctx, actor, t);
      await this.db.readTenant(a, async (tx) => {
        const { rows } = await tx.query(
          `SELECT lead_id, count(*) FILTER (WHERE type = 'call')::int AS calls, count(*) FILTER (WHERE type = 'call' AND outcome = 'connected')::int AS connected,
                  count(*) FILTER (WHERE type IN ${TOUCH_TYPES})::int AS total, max(created_at) FILTER (WHERE type IN ${TOUCH_TYPES}) AS last_touch
             FROM activities WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) GROUP BY lead_id`,
          [t.id, ids]
        );
        for (const x of rows) touchByLead.set(x.lead_id, { calls: x.calls, connected: x.connected, total: x.total, lastTouchAt: iso(x.last_touch) });
      });
    });

    const items = pageRows.map(({ t, r }) => ({
      id: r.id as string,
      client: { id: t.id, name: t.name, industry: t.industry },
      contactName: r.contact_name as string | null,
      contactPhone: r.phone as string | null,
      contactEmail: r.email as string | null,
      stageName: r.stage_name as string,
      stageColor: r.stage_color as string,
      status: r.status as string,
      ownerId: r.owner_id as string | null,
      ownerName: r.owner_name as string | null,
      source: r.source as string,
      campaign: r.campaign as string | null,
      leadScore: r.lead_score as number,
      estimatedValue: r.estimated_value as number | null,
      currency: r.currency as string,
      tags: r.tags as string[],
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      lastActivityAt: iso(r.last_activity_at),
      nextFollowupAt: iso(r.next_followup_at),
      sla: slaOf(r.first_response_due_at, r.first_response_at, r.closed_at !== null, r.created_at) as { state: SlaState; dueAt: string | null },
      touches: touchByLead.get(r.id) ?? { calls: 0, connected: 0, total: 0, lastTouchAt: null },
    }));
    const total = parts.reduce((n, p) => n + p.total, 0);
    return {
      items,
      page: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
      byClient: parts.map((p) => ({ clientId: p.t.id, clientName: p.t.name, total: p.total })),
    };
  }

  // ── my tasks, across clients ──────────────────────────────────────────────────────────────────────────

  /**
   * The caller's own open tasks that are overdue or due today in each client (day boundaries in that client's time zone), soonest first.
   * One query per client, each inside that client's own tenant transaction, so an employee on five clients sees one list instead of five.
   */
  async myTasks(actor: Actor) {
    const ctx = await this.agency.context(actor);
    const targets = await this.targets(actor, ctx, 'tasks:read');
    const parts = await mapLimit(targets, 6, async (t) => {
      const a = this.actorIn(ctx, actor, t);
      return this.db.readTenant(a, async (tx) => {
        const { rows } = await tx.query(
          `SELECT tk.id, tk.title, tk.kind, tk.priority, tk.due_date, tk.lead_id, c.display_name AS lead_name
             FROM tasks tk
             LEFT JOIN leads l ON l.id = tk.lead_id AND l.tenant_id = tk.tenant_id
             LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
            WHERE tk.tenant_id = $1 AND tk.deleted_at IS NULL AND tk.status IN ('pending', 'in_progress') AND tk.assigned_to = $2 AND tk.due_date IS NOT NULL
              AND tk.due_date < ((date_trunc('day', now() AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3)
            ORDER BY tk.due_date, tk.id LIMIT 10`,
          [t.id, ctx.userId, t.timezone]
        );
        return rows.map((r) => ({
          id: r.id as string,
          client: { id: t.id, name: t.name },
          title: r.title as string,
          kind: r.kind as string,
          priority: r.priority as string,
          dueDate: iso(r.due_date)!,
          overdue: new Date(r.due_date).getTime() < Date.now(),
          leadId: (r.lead_id as string | null) ?? null,
          leadName: (r.lead_name as string | null) ?? null,
        }));
      });
    });
    return parts.flat().sort((x, y) => (x.dueDate < y.dueDate ? -1 : x.dueDate > y.dueDate ? 1 : 0)).slice(0, 30);
  }
  // ── unread notifications, per client ─────────────────────────────────────────────────────────────────

  /** Notifications are kept inside each client, so this counts the caller's unread ones in every client they belong to (for the badge on each client tab). */
  async unreadByClient(actor: Actor): Promise<Array<{ clientId: string; unread: number }>> {
    const ctx = await this.agency.context(actor);
    const targets = await this.targets(actor, ctx, 'leads:read');
    const parts = await mapLimit(targets, 6, async (t) => {
      const a = this.actorIn(ctx, actor, t);
      return this.db.readTenant(a, async (tx) => {
        const n = Number((await tx.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND NOT is_read`, [t.id, ctx.userId])).rows[0].n);
        return { clientId: t.id, unread: n };
      });
    });
    return parts.filter((p) => p.unread > 0);
  }
  // ── what each employee did ───────────────────────────────────────────────────────────────────────────

  /**
   * Calls, messages, e-mails and meetings logged per employee per client over a period (default: today, in the caller's time zone).
   * Admins and team leads (who may assign leads in a client) see everyone in it; everyone else sees only their own work.
   */
  async activity(actor: Actor, q: { clientId?: string; from?: string; to?: string }) {
    const ctx = await this.agency.context(actor);
    const targets = await this.targets(actor, ctx, 'activities:read', q.clientId);
    const tz = String((await this.db.asUser(ctx.userId).query(`SELECT timezone FROM users WHERE id = $1`, [ctx.userId])).rows[0]?.timezone || 'Asia/Kolkata');
    const today = (await this.db.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0].d as string;
    const from = q.from ?? q.to ?? today;
    const to = q.to ?? q.from ?? today;
    if (from > to) throw Errors.validation([{ path: 'query.from', message: 'The start date is after the end date' }]);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw Errors.validation([{ path: 'query.to', message: 'Choose a period of at most a year' }]);

    const parts = await mapLimit(targets, 6, async (t) => {
      const a = this.actorIn(ctx, actor, t);
      const seeAll = ctx.isAdmin || scopeOf(t.role, 'leads:assign') === 'all';
      return this.db.readTenant(a, async (tx) => {
        const params: unknown[] = [t.id, from, to, tz];
        let own = '';
        if (!seeAll) {
          params.push(ctx.userId);
          own = ` AND a.user_id = $${params.length}`;
        }
        const { rows } = await tx.query(
          `SELECT a.user_id, u.name, u.email::text AS email,
                  count(*) FILTER (WHERE a.type = 'call')::int AS calls,
                  count(*) FILTER (WHERE a.type = 'call' AND a.outcome = 'connected')::int AS connected,
                  count(*) FILTER (WHERE a.type = 'whatsapp')::int AS whatsapp,
                  count(*) FILTER (WHERE a.type = 'sms')::int AS sms,
                  count(*) FILTER (WHERE a.type = 'email')::int AS emails,
                  count(*) FILTER (WHERE a.type = 'instagram')::int AS instagram,
                  count(*) FILTER (WHERE a.type = 'meeting')::int AS meetings,
                  count(DISTINCT a.lead_id)::int AS leads_touched
             FROM activities a JOIN users u ON u.id = a.user_id
            WHERE a.tenant_id = $1 AND a.type IN ${TOUCH_TYPES}
              AND a.created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND a.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)${own}
            GROUP BY a.user_id, u.name, u.email ORDER BY lower(u.name)`,
          params
        );
        return rows.map((r) => ({ clientId: t.id, clientName: t.name, userId: r.user_id as string, userName: r.name as string, calls: r.calls as number, connected: r.connected as number, whatsapp: r.whatsapp as number, sms: r.sms as number, emails: r.emails as number, instagram: r.instagram as number, meetings: r.meetings as number, leadsTouched: r.leads_touched as number }));
      });
    });
    const rows = parts.flat();
    const sum = (k: 'calls' | 'connected' | 'whatsapp' | 'sms' | 'emails' | 'instagram' | 'meetings') => rows.reduce((n, r) => n + r[k], 0);
    return {
      from,
      to,
      timeZone: tz,
      rows,
      totals: { calls: sum('calls'), connected: sum('connected'), whatsapp: sum('whatsapp'), sms: sum('sms'), emails: sum('emails'), instagram: sum('instagram'), meetings: sum('meetings') },
    };
  }

  // ── export ───────────────────────────────────────────────────────────────────────────────────────────

  async export(actor: Actor, f: AgencyLeadFilters, opts: { format: 'xlsx' | 'csv'; dataset: 'leads' | 'activities' }) {
    const ctx = await this.agency.context(actor);
    const targets = await this.targets(actor, ctx, 'leads:export', f.clientId);
    if (!targets.length) throw Errors.forbidden('You do not have export access in any client');
    const filters = this.filtersFor(ctx, f);
    const userTz = (await this.db.asUser(ctx.userId).query(`SELECT timezone FROM users WHERE id = $1`, [ctx.userId])).rows[0]?.timezone ?? 'Asia/Kolkata';
    const tz = typeof userTz === 'string' && userTz ? userTz : 'Asia/Kolkata';

    const leadRows: Cell[][] = [];
    // Custom fields: one column per field NAME across the clients in this file (clients differ; a client without the field leaves it blank).
    const customCells: Array<Map<number, Cell>> = [];
    const customCols: string[] = [];
    const colIndex = new Map<string, number>();
    const actRows: Cell[][] = [];
    const clientRows: Cell[][] = [];
    const teamAgg = new Map<string, { client: string; employee: string; email: string; calls: number; connected: number; whatsapp: number; sms: number; email_: number; instagram: number; meetings: number; notes: number; leads: Set<string> }>();
    const dt = (v: unknown) => (v ? new Date(v as string) : null);

    // Sequential: the caps are global, and each client's part is audited in that client's own trail.
    for (const t of targets) {
      const a = this.actorIn(ctx, actor, t);
      await this.db.withTenant(a, async (tx) => {
        const params: unknown[] = [t.id];
        const where = this.leads.whereFor(a, filters, params).join(' AND ');
        const room = MAX_EXPORT_LEADS - leadRows.length;
        params.push(room + 1);
        const leads = await tx.query(
          `SELECT l.id, l.created_at, l.closed_at, l.status, l.source, l.campaign, l.tags, l.lead_score, l.estimated_value::float8 AS estimated_value, l.currency,
                  l.budget_min::float8 AS budget_min, l.budget_max::float8 AS budget_max, l.locations, l.first_response_due_at, l.first_response_at, l.last_activity_at,
                  l.next_followup_at, l.loss_reason, l.source_details, l.custom_fields,
                  c.display_name AS contact_name, c.phone, c.email::text AS email, s.name AS stage_name, o.name AS owner_name, o.email::text AS owner_email
             FROM ${FROM} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length}`,
          params
        );
        if (leads.rows.length > room) throw Errors.unprocessable(`That is more than ${MAX_EXPORT_LEADS.toLocaleString('en-US')} leads. Narrow by client, date or status and download in parts.`);

        const defs = await loadFieldDefs(tx, t.id);
        const defByKey = new Map(defs.map((d) => [d.key, d]));
        for (const d of defs) {
          const lk = d.label.trim().toLowerCase();
          if (!colIndex.has(lk)) {
            colIndex.set(lk, customCols.length);
            customCols.push(d.label.trim());
          }
        }

        const ids = leads.rows.map((r) => r.id as string);
        const acts = ids.length
          ? await tx.query(
              `SELECT a.lead_id, a.created_at, CASE WHEN a.type = 'note' AND a.metadata ? 'event' THEN 'system' ELSE a.type::text END AS type, a.direction, a.outcome,
                      a.duration_minutes, a.description, u.id AS user_id, u.name AS user_name, u.email::text AS user_email
                 FROM activities a LEFT JOIN users u ON u.id = a.user_id
                WHERE a.tenant_id = $1 AND a.lead_id = ANY($2::uuid[]) ORDER BY a.created_at, a.id`,
              [t.id, ids]
            )
          : { rows: [] as any[] };
        if (actRows.length + acts.rows.length > MAX_EXPORT_ACTIVITIES) throw Errors.unprocessable(`That is more than ${MAX_EXPORT_ACTIVITIES.toLocaleString('en-US')} logged activities. Narrow by client or date and download in parts.`);

        const byLead = new Map<string, any[]>();
        const leadById = new Map(leads.rows.map((r) => [r.id as string, r]));
        for (const x of acts.rows) (byLead.get(x.lead_id) ?? byLead.set(x.lead_id, []).get(x.lead_id)!).push(x);

        for (const l of leads.rows) {
          const list = byLead.get(l.id) ?? [];
          const touches = list.filter((x) => ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'].includes(x.type));
          const last = touches[touches.length - 1];
          const count = (type: string) => list.filter((x) => x.type === type).length;
          const sd = (l.source_details ?? {}) as Record<string, any>;
          const tr = (sd.tracking ?? {}) as Record<string, string>;
          const answers = Array.isArray(sd.answers) ? (sd.answers as Array<{ label?: string; value?: string }>).map((x) => `${x.label ?? ''}: ${x.value ?? ''}`).join(' | ') : '';
          const resp = l.first_response_at ? Math.round(((new Date(l.first_response_at).getTime() - new Date(l.created_at).getTime()) / 60_000) * 10) / 10 : null;
          const sla = slaOf(l.first_response_due_at, l.first_response_at, l.closed_at !== null, l.created_at).state;
          const custom = new Map<number, Cell>();
          const other: Record<string, unknown> = {};
          for (const [k, v] of Object.entries((l.custom_fields ?? {}) as Record<string, unknown>)) {
            const d = defByKey.get(k);
            if (d) custom.set(colIndex.get(d.label.trim().toLowerCase())!, displayValue(d, v));
            else other[k] = v;
          }
          customCells.push(custom);
          leadRows.push([
            t.name, t.industry, l.id, dt(l.created_at), l.status, l.stage_name, l.contact_name, l.phone, l.email, l.owner_name, l.owner_email, String(l.source).replace(/_/g, ' '), l.campaign,
            (l.tags as string[]).join(', '), l.lead_score, l.estimated_value, l.currency, dt(l.first_response_due_at), dt(l.first_response_at), resp, sla, dt(l.last_activity_at), dt(l.next_followup_at),
            touches.length, count('call'), list.filter((x) => x.type === 'call' && x.outcome === 'connected').length, count('whatsapp'), count('sms'), count('email'), count('meeting'), count('note'),
            last?.type ?? null, last?.outcome ?? null, last ? dt(last.created_at) : null, last?.user_name ?? null, last?.description ? String(last.description).slice(0, 500) : null,
            l.loss_reason, dt(l.closed_at), sd.provider ?? null, sd.page ?? null, tr.utm_source ?? null, tr.utm_medium ?? null, tr.utm_campaign ?? null, tr.utm_term ?? null, tr.utm_content ?? null, tr.gclid ?? tr.fbclid ?? null,
            answers || null, Object.keys(other).length ? JSON.stringify(other) : null, l.budget_min, l.budget_max, (l.locations as string[]).join(', '), count('instagram'),
          ]);
        }
        for (const x of acts.rows) {
          const lead = leadById.get(x.lead_id)!;
          actRows.push([t.name, x.lead_id, lead.contact_name, lead.phone, dt(x.created_at), x.type, x.direction, x.outcome, x.duration_minutes, x.user_name, x.user_email, x.description]);
          if (x.user_id && ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting', 'note'].includes(x.type)) {
            const k = `${t.id}:${x.user_id}`;
            const g = teamAgg.get(k) ?? { client: t.name, employee: x.user_name ?? '', email: x.user_email ?? '', calls: 0, connected: 0, whatsapp: 0, sms: 0, email_: 0, instagram: 0, meetings: 0, notes: 0, leads: new Set<string>() };
            if (x.type === 'call') {
              g.calls++;
              if (x.outcome === 'connected') g.connected++;
            } else if (x.type === 'whatsapp') g.whatsapp++;
            else if (x.type === 'sms') g.sms++;
            else if (x.type === 'email') g.email_++;
            else if (x.type === 'instagram') g.instagram++;
            else if (x.type === 'meeting') g.meetings++;
            else g.notes++;
            g.leads.add(x.lead_id);
            teamAgg.set(k, g);
          }
        }
        clientRows.push([t.name, t.industry, leads.rows.length, leads.rows.filter((r) => r.closed_at === null).length, leads.rows.filter((r) => r.status === 'won').length, acts.rows.length]);
        await audit(tx, { action: 'lead.export', entityType: 'lead', entityId: t.id, after: { rows: leads.rows.length, activities: acts.rows.length, via: 'agency', format: opts.format, dataset: opts.dataset, filters: f } });
      });
    }

    const tzLabel = `(${tz})`;
    const leadHeader = [
      'Client', 'Industry', 'Lead ID', `Created ${tzLabel}`, 'Status', 'Stage', 'Contact name', 'Phone', 'Email', 'Assigned employee', 'Employee email', 'Source', 'Campaign', 'Tags', 'Lead score',
      'Estimated value', 'Currency', `First reply due ${tzLabel}`, `First reply sent ${tzLabel}`, 'First reply time (min)', 'Reply deadline', `Last activity ${tzLabel}`, `Next follow-up ${tzLabel}`,
      'Total touches', 'Calls', 'Calls connected', 'WhatsApp', 'SMS', 'E-mails', 'Meetings', 'Notes', 'Last touch type', 'Last touch outcome', `Last touch time ${tzLabel}`, 'Last touch by', 'Last touch note',
      'Lost / not-a-fit reason', `Closed ${tzLabel}`, 'Lead source provider', 'Landing page', 'UTM source', 'UTM medium', 'UTM campaign', 'UTM term', 'UTM content', 'Ad click ID',
      'Form answers', 'Other custom data (JSON)', 'Budget min', 'Budget max', 'Locations', 'Instagram',
      ...customCols.map((c) => `Custom: ${c}`),
    ];
    leadRows.forEach((r, i) => r.push(...customCols.map((_, c) => customCells[i]!.get(c) ?? null)));
    const actHeader = ['Client', 'Lead ID', 'Contact', 'Contact phone', `When ${tzLabel}`, 'Type', 'Direction', 'Outcome', 'Duration (min)', 'Employee', 'Employee email', 'Notes'];

    const csvCellValue = (v: Cell) => (v instanceof Date ? localDateTime(v, tz) : v);
    const day = new Date().toISOString().slice(0, 10);
    const scope = f.clientId ? targets[0]!.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'client' : 'all-clients';

    if (opts.format === 'csv') {
      const header = opts.dataset === 'activities' ? actHeader : leadHeader;
      const rows = (opts.dataset === 'activities' ? actRows : leadRows).map((r) => r.map(csvCellValue));
      return { body: Buffer.from(toCsv(header, rows), 'utf8'), filename: `${opts.dataset === 'activities' ? 'activity-log' : 'leads'}-${scope}-${day}.csv`, rows: rows.length };
    }
    const sheets: Sheet[] = [
      { name: 'Leads', header: leadHeader, rows: leadRows, moneyColumns: [15, 48, 49], wrapColumns: [35, 46, 47], widths: [24, 16, 38, 17] },
      { name: 'Activity log', header: actHeader, rows: actRows, wrapColumns: [11], widths: [24, 38, 22, 16, 17, 12, 10, 18, 9, 22, 28, 60] },
      {
        name: 'Team activity',
        header: ['Client', 'Employee', 'Email', 'Leads touched', 'Calls', 'Calls connected', 'WhatsApp', 'SMS', 'E-mails', 'Meetings', 'Notes', 'Instagram'],
        rows: [...teamAgg.values()].sort((x, y) => x.client.localeCompare(y.client) || x.employee.localeCompare(y.employee)).map((g) => [g.client, g.employee, g.email, g.leads.size, g.calls, g.connected, g.whatsapp, g.sms, g.email_, g.meetings, g.notes, g.instagram]),
      },
      { name: 'Clients', header: ['Client', 'Industry', 'Leads in this download', 'Open', 'Won', 'Activities'], rows: clientRows },
    ];
    return { body: buildXlsx(sheets, { timeZone: tz }), filename: `leads-${scope}-${day}.xlsx`, rows: leadRows.length };
  }
}
