import type pg from 'pg';
import type { Database } from '../../platform/db';
import { scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { leadVisibility } from '../leads/pipelines.service';

/**
 * Home: "what needs me today". Every number here is a count of the same rows its list shows, scoped to what the caller may see.
 *
 *   myDay       MY work: tasks assigned to me, visits I run or that belong to my leads, my leads still waiting for a first reply.
 *               Everyone has one (managers too); it needs the matching read permission, otherwise that part is absent.
 *   team        managers only (assign-all): unassigned leads, first replies already late, overdue tasks across the team
 *   pipeline    open leads and their estimated value by stage for the leads the caller may see (test leads left out, as in reports)
 *   attention   operators only: lead deliveries that need a human, automation runs that failed
 *   getStarted  owners and admins: the short setup checklist, until it is done
 * "Today" and "this week" follow the WORKSPACE time zone, including daylight-saving days.
 */
const LIMIT = 10;
/** A visit's reminder task is the visit itself, shown once as a visit, never again as a task. */
const NOT_REMINDER = "AND NOT EXISTS (SELECT 1 FROM viewings rv WHERE rv.reminder_task_id = k.id AND rv.tenant_id = k.tenant_id)";

export type DayBounds = { start_today: Date; start_tomorrow: Date; start_in_8: Date; local_date: string };

/** The workspace's calendar day around `at` (default: now), as instants. A daylight-saving day is 23 or 25 hours long, not 24. */
export async function dayBounds(tx: pg.PoolClient, tz: string, at?: Date): Promise<DayBounds> {
  const r = await tx.query(
    `SELECT (date_trunc('day', ts AT TIME ZONE $1) AT TIME ZONE $1) AS start_today,
            ((date_trunc('day', ts AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) AS start_tomorrow,
            ((date_trunc('day', ts AT TIME ZONE $1) + interval '8 day') AT TIME ZONE $1) AS start_in_8,
            to_char(ts AT TIME ZONE $1, 'YYYY-MM-DD') AS local_date
       FROM (SELECT COALESCE($2::timestamptz, now()) AS ts) x`,
    [tz, at ?? null]
  );
  return r.rows[0] as DayBounds;
}

export class HomeService {
  constructor(private db: Database) {}

  async home(actor: Actor) {
    return this.db.readTenant(actor, async (tx) => {
      const t = actor.tenantId;
      const me = actor.userId;
      const tz = ((await tx.query(`SELECT timezone FROM tenants WHERE id = $1`, [t])).rows[0]?.timezone as string | undefined) || 'UTC';
      const day = await dayBounds(tx, tz);

      const myDay = await this.myDay(tx, actor, me, day);
      const team = await this.team(tx, actor);
      const pipeline = await this.pipeline(tx, actor);
      const attention = await this.attention(tx, actor);
      const getStarted = await this.getStarted(tx, actor);
      return { today: day.local_date as string, timezone: tz, myDay, team, pipeline, attention, getStarted };
    });
  }

  private async myDay(tx: pg.PoolClient, actor: Actor, me: string | null, day: DayBounds) {
    const t = actor.tenantId;
    const out: {
      tasks: null | { overdue: { count: number; items: TaskItem[] }; today: { count: number; items: TaskItem[] } };
      viewings: null | { today: { count: number; items: VisitItem[] }; next7Days: number };
      waitingForReply: null | { count: number; items: ReplyItem[] };
    } = { tasks: null, viewings: null, waitingForReply: null };
    if (!me) return out;

    if (scopeIfAllowed(actor, 'tasks:read')) {
      const base = `FROM tasks k LEFT JOIN leads l ON l.id = k.lead_id AND l.tenant_id = k.tenant_id LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
                     WHERE k.tenant_id = $1 AND k.deleted_at IS NULL AND k.assigned_to = $2 AND k.status IN ('pending','in_progress')
                     ${NOT_REMINDER}`;
      const item = `SELECT k.id, k.title, k.kind, k.priority::text AS priority, k.due_date AS "dueDate", k.lead_id AS "leadId", c.display_name AS "leadName"`;
      const overdue = await tx.query(`${item} ${base} AND k.due_date < now() ORDER BY k.due_date, k.id LIMIT ${LIMIT}`, [t, me]);
      const overdueCount = (await tx.query(`SELECT count(*)::int AS n ${base} AND k.due_date < now()`, [t, me])).rows[0].n as number;
      const today = await tx.query(`${item} ${base} AND k.due_date >= now() AND k.due_date < $3 ORDER BY k.due_date, k.id LIMIT ${LIMIT}`, [t, me, day.start_tomorrow]);
      const todayCount = (await tx.query(`SELECT count(*)::int AS n ${base} AND k.due_date >= now() AND k.due_date < $3`, [t, me, day.start_tomorrow])).rows[0].n as number;
      out.tasks = { overdue: { count: overdueCount, items: overdue.rows as TaskItem[] }, today: { count: todayCount, items: today.rows as TaskItem[] } };
    }

    if (scopeIfAllowed(actor, 'viewings:read')) {
      const base = `FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id JOIN properties p ON p.id = v.property_id AND p.tenant_id = v.tenant_id
                     LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
                     WHERE v.tenant_id = $1 AND l.deleted_at IS NULL AND v.status IN ('scheduled','confirmed') AND (v.agent_id = $2 OR l.owner_id = $2)`;
      const today = await tx.query(
        `SELECT v.id, v.scheduled_at AS "scheduledAt", v.duration_minutes AS "durationMinutes", v.lead_id AS "leadId", c.display_name AS "leadName", p.title AS "propertyTitle",
                (v.scheduled_at + (v.duration_minutes || ' minutes')::interval < now()) AS "needsOutcome"
           ${base} AND v.scheduled_at >= $3 AND v.scheduled_at < $4 ORDER BY v.scheduled_at, v.id LIMIT ${LIMIT}`,
        [t, me, day.start_today, day.start_tomorrow]
      );
      const todayCount = (await tx.query(`SELECT count(*)::int AS n ${base} AND v.scheduled_at >= $3 AND v.scheduled_at < $4`, [t, me, day.start_today, day.start_tomorrow])).rows[0].n as number;
      const next7 = (await tx.query(`SELECT count(*)::int AS n ${base} AND v.scheduled_at >= $3 AND v.scheduled_at < $4`, [t, me, day.start_tomorrow, day.start_in_8])).rows[0].n as number;
      out.viewings = { today: { count: todayCount, items: today.rows as VisitItem[] }, next7Days: next7 };
    }

    if (scopeIfAllowed(actor, 'leads:read')) {
      const base = `FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
                     WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND l.owner_id = $2 AND l.closed_at IS NULL AND l.first_response_at IS NULL AND l.first_response_due_at IS NOT NULL AND NOT ('test' = ANY(l.tags))`;
      const rows = await tx.query(`SELECT l.id AS "leadId", c.display_name AS "leadName", l.first_response_due_at AS "dueAt", (l.first_response_due_at < now()) AS overdue ${base} ORDER BY l.first_response_due_at, l.id LIMIT ${LIMIT}`, [t, me]);
      const count = (await tx.query(`SELECT count(*)::int AS n ${base}`, [t, me])).rows[0].n as number;
      out.waitingForReply = { count, items: rows.rows as ReplyItem[] };
    }
    return out;
  }

  /** Managers (those who may assign leads to anyone) see the team's problems; nobody else gets this section. */
  private async team(tx: pg.PoolClient, actor: Actor) {
    if (scopeIfAllowed(actor, 'leads:assign') !== 'all' || scopeIfAllowed(actor, 'leads:read') !== 'all') return null;
    const t = actor.tenantId;
    const live = `l.tenant_id = $1 AND l.deleted_at IS NULL AND l.closed_at IS NULL AND NOT ('test' = ANY(l.tags))`;
    const unassigned = await tx.query(
      `SELECT l.id AS "leadId", c.display_name AS "leadName", l.created_at AS "createdAt" FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
        WHERE ${live} AND l.owner_id IS NULL ORDER BY l.created_at DESC, l.id LIMIT 5`,
      [t]
    );
    const unassignedCount = (await tx.query(`SELECT count(*)::int AS n FROM leads l WHERE ${live} AND l.owner_id IS NULL`, [t])).rows[0].n as number;
    const lateReplies = (await tx.query(`SELECT count(*)::int AS n FROM leads l WHERE ${live} AND l.first_response_at IS NULL AND l.first_response_due_at < now()`, [t])).rows[0].n as number;
    const overdueTasks = scopeIfAllowed(actor, 'tasks:read') === 'all' ? ((await tx.query(`SELECT count(*)::int AS n FROM tasks k WHERE k.tenant_id = $1 AND k.deleted_at IS NULL AND k.status IN ('pending','in_progress') AND k.due_date < now() ${NOT_REMINDER}`, [t])).rows[0].n as number) : null;
    // visits that have ended and were never recorded: the manager's version of an overdue visit reminder
    const unrecordedVisits = (await tx.query(`SELECT count(*)::int AS n FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id WHERE v.tenant_id = $1 AND l.deleted_at IS NULL AND v.status IN ('scheduled','confirmed') AND v.scheduled_at + (v.duration_minutes || ' minutes')::interval < now()`, [t])).rows[0].n as number;
    return { unassignedLeads: { count: unassignedCount, items: unassigned.rows as Array<{ leadId: string; leadName: string | null; createdAt: string }> }, lateFirstReplies: lateReplies, overdueTasks, unrecordedVisits };
  }

  private async pipeline(tx: pg.PoolClient, actor: Actor) {
    const params: unknown[] = [actor.tenantId];
    const vis = leadVisibility(actor, 'l', params);
    if (vis === false) return null;
    const p = (await tx.query(`SELECT id, name FROM pipelines WHERE tenant_id = $1 AND is_default AND archived_at IS NULL`, [actor.tenantId])).rows[0];
    if (!p) return null;
    params.push(p.id);
    const { rows } = await tx.query(
      `SELECT s.id, s.name, s.color, s.probability, count(l.id)::int AS count, COALESCE(sum(l.estimated_value), 0)::float8 AS value
         FROM pipeline_stages s LEFT JOIN leads l ON l.stage_id = s.id AND l.tenant_id = s.tenant_id AND l.deleted_at IS NULL AND ${vis} AND NOT ('test' = ANY(l.tags))
        WHERE s.tenant_id = $1 AND s.pipeline_id = $${params.length} AND s.archived_at IS NULL AND s.maps_to_status NOT IN ('won','lost','disqualified')
        GROUP BY s.id, s.name, s.color, s.probability, s.order_index ORDER BY s.order_index`,
      params
    );
    const stages = rows as Array<{ id: string; name: string; color: string; probability: number; count: number; value: number }>;
    return {
      pipelineId: p.id as string,
      name: p.name as string,
      stages,
      openLeads: stages.reduce((a, s) => a + s.count, 0),
      openValue: stages.reduce((a, s) => a + s.value, 0),
      /** Estimated value x each stage's chance. The chances are the workspace's own estimates, not measured results. */
      weightedValue: stages.reduce((a, s) => a + (s.value * s.probability) / 100, 0),
    };
  }

  private async attention(tx: pg.PoolClient, actor: Actor) {
    if (!scopeIfAllowed(actor, 'operations:read')) return null;
    const t = actor.tenantId;
    const deliveries = (await tx.query(`SELECT count(*)::int AS n FROM inbound_events WHERE tenant_id = $1 AND status IN ('needs_review','failed') AND received_at > now() - interval '7 days'`, [t])).rows[0].n as number;
    const failedRuns = (await tx.query(`SELECT count(*)::int AS n FROM automation_executions WHERE tenant_id = $1 AND status = 'failed'`, [t])).rows[0].n as number;
    return { deliveriesNeedingReview: deliveries, failedAutomationRuns: failedRuns };
  }

  private async getStarted(tx: pg.PoolClient, actor: Actor) {
    if (!scopeIfAllowed(actor, 'tenant:update')) return null;
    const t = actor.tenantId;
    const n = async (sql: string) => ((await tx.query(sql, [t])).rows[0].n as number) > 0;
    const items = [
      { key: 'add_lead', label: 'Add your first lead', href: '/leads', done: await n(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL`) },
      { key: 'invite_team', label: 'Invite your team', href: '/settings/team', done: (await tx.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active'`, [t])).rows[0].n > 1 },
      { key: 'add_property', label: 'Add a property', href: '/properties', done: await n(`SELECT count(*)::int AS n FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL`) },
      { key: 'connect_source', label: 'Connect a lead source (Meta, Google or your website)', href: '/integrations/lead-sources', done: await n(`SELECT count(*)::int AS n FROM inbound_endpoints WHERE tenant_id = $1 AND deleted_at IS NULL`) },
      { key: 'turn_on_automation', label: 'Turn on the follow-up automation', href: '/settings/automation', done: await n(`SELECT count(*)::int AS n FROM automation_rules WHERE tenant_id = $1 AND template IS NOT NULL AND status = 'active'`) },
      { key: 'book_visit', label: 'Book a site visit', href: '/tasks?view=calendar', done: await n(`SELECT count(*)::int AS n FROM viewings WHERE tenant_id = $1`) },
    ];
    return { items, complete: items.every((i) => i.done) };
  }
}

export interface TaskItem {
  id: string;
  title: string;
  kind: string;
  priority: string;
  dueDate: string | null;
  leadId: string | null;
  leadName: string | null;
}
export interface VisitItem {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  leadId: string;
  leadName: string | null;
  propertyTitle: string;
  needsOutcome: boolean;
}
export interface ReplyItem {
  leadId: string;
  leadName: string | null;
  dueAt: string;
  overdue: boolean;
}
