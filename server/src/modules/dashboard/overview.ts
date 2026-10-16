import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { leadVisibility } from '../leads/pipelines.service';
import { dayBounds } from '../home/service';
import { resolveRange, type Range, type RangeQuery } from '../analytics/range';
import { SOURCE_LABEL } from '../analytics/channels';

/**
 * The executive overview: the whole business on one screen. Every number is a count or sum of live records the caller may see, over the
 * same definitions as the list a click leads to, so a figure and its list agree (the tests compare them).
 *
 *  - Leads count when they are live (not archived) and, unless `includeTest`, not tagged `test` (decision D8). "Open" means not closed.
 *  - The date range is whole local days in the workspace time zone and applies to what happened IN the period: leads created, sales recorded,
 *    visits held. Everything else (open pipeline, tasks, stock) is a snapshot of right now and says so.
 *  - Revenue is the sum of RECORDED sales (completed deals, decision D3), never the estimate typed on a lead.
 *  - Sections the caller has no permission for are null, not zero. Salespeople see only their own leads, tasks and visits.
 */
export interface OverviewQuery extends RangeQuery {
  includeTest: boolean;
}

const n = (v: unknown) => Number(v) || 0;
const OPEN_TASK = `('pending','in_progress')`;

type Unit = 'day' | 'week' | 'month';

export class DashboardOverviewService {
  constructor(private db: Database) {}

  async overview(actor: Actor, q: OverviewQuery) {
    assertCan(actor, 'dashboard:read');
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const prev = await resolveRange(tx, actor.tenantId, await previousWindow(tx, range));
      const unit: Unit = range.days <= 31 ? 'day' : range.days <= 140 ? 'week' : 'month';
      const [leadsPart, salesPart, tasks, viewings, inventory, team] = await Promise.all([
        this.leads(tx, actor, range, prev, q.includeTest, unit),
        this.sales(tx, actor, range, prev, q.includeTest, unit),
        this.tasks(tx, actor, range),
        this.viewings(tx, actor, range),
        this.inventory(tx, actor),
        this.team(tx, actor, range, q.includeTest),
      ]);
      const buckets = bucketStarts(range, unit);
      const trend = buckets.map((b) => {
        const l = leadsPart?.trendLeads.get(b.start);
        const s = salesPart?.trendSales.get(b.start);
        return { from: b.from, to: b.to, label: b.start, leads: l ?? 0, sales: s?.count ?? 0, dealValue: s?.value ?? 0 };
      });
      return {
        range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone },
        previous: { from: prev.from, to: prev.to },
        bucket: unit,
        includesTestLeads: q.includeTest,
        currency: range.currency,
        leads: leadsPart?.leads ?? null,
        pipeline: leadsPart?.pipeline ?? null,
        sources: leadsPart?.sources ?? null,
        sales: salesPart?.sales ?? null,
        trend: leadsPart || salesPart ? trend : [],
        tasks,
        viewings,
        inventory,
        team,
      };
    });
  }

  private async leads(tx: pg.PoolClient, actor: Actor, r: Range, p: Range, includeTest: boolean, unit: Unit) {
    if (leadVisibility(actor, 'l', []) === false) return null;
    const ctx = (windows: Date[]) => {
      const params: unknown[] = [actor.tenantId];
      const vis = leadVisibility(actor, 'l', params) as string;
      const base = `l.tenant_id = $1 AND l.deleted_at IS NULL AND ${vis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`}`;
      const at = windows.map((w) => (params.push(w), `$${params.length}`));
      return { params, base, at };
    };
    const A = ctx([r.start, r.end, p.start, p.end]);
    const [s, e, ps, pe] = A.at as [string, string, string, string];
    const { params, base } = A;
    const inRange = `l.created_at >= ${s} AND l.created_at < ${e}`;
    const B = ctx([r.start, r.end]);
    const inB = `l.created_at >= ${B.at[0]} AND l.created_at < ${B.at[1]}`;
    const totals = (
      await tx.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE l.closed_at IS NULL)::int AS open,
                count(*) FILTER (WHERE ${inRange})::int AS created,
                count(*) FILTER (WHERE l.created_at >= ${ps} AND l.created_at < ${pe})::int AS prev_created,
                count(*) FILTER (WHERE ${inRange} AND l.status = 'won')::int AS won_of_created,
                count(*) FILTER (WHERE l.closed_at IS NULL AND l.owner_id IS NULL)::int AS unassigned,
                count(*) FILTER (WHERE l.closed_at IS NULL AND l.first_response_at IS NULL AND l.first_response_due_at < now())::int AS late_replies,
                count(*) FILTER (WHERE l.closed_at IS NULL AND l.next_followup_at < now())::int AS followups_overdue,
                COALESCE(sum(l.estimated_value) FILTER (WHERE l.closed_at IS NULL), 0)::float8 AS open_value
           FROM leads l WHERE ${base}`,
        params
      )
    ).rows[0];
    const sp: unknown[] = [actor.tenantId];
    const svis = leadVisibility(actor, 'l', sp);
    const baseS = `l.tenant_id = $1 AND l.deleted_at IS NULL AND ${svis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`}`;
    const stages = (
      await tx.query(
        `SELECT s.id, s.name, s.color, s.probability, s.maps_to_status AS status, count(l.id)::int AS count, COALESCE(sum(l.estimated_value), 0)::float8 AS value
           FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id = p.id AND s.tenant_id = p.tenant_id AND s.archived_at IS NULL
           LEFT JOIN leads l ON l.stage_id = s.id AND ${baseS}
          WHERE p.tenant_id = $1 AND p.is_default AND p.archived_at IS NULL GROUP BY s.id ORDER BY s.order_index`,
        sp
      )
    ).rows;
    const weighted = (
      await tx.query(`SELECT COALESCE(sum(l.estimated_value * s.probability / 100.0), 0)::float8 AS v FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id WHERE ${baseS} AND l.closed_at IS NULL`, sp)
    ).rows[0].v as number;
    const other = (
      await tx.query(
        `SELECT count(*)::int AS c, COALESCE(sum(l.estimated_value), 0)::float8 AS v FROM leads l WHERE ${baseS} AND l.closed_at IS NULL
            AND l.pipeline_id NOT IN (SELECT id FROM pipelines WHERE tenant_id = $1 AND is_default AND archived_at IS NULL)`,
        sp
      )
    ).rows[0];
    const sources = (
      await tx.query(`SELECT l.source::text AS source, count(*)::int AS leads, count(*) FILTER (WHERE l.status = 'won')::int AS won FROM leads l WHERE ${B.base} AND ${inB} GROUP BY 1 ORDER BY 2 DESC, 1`, B.params)
    ).rows;
    const trend = (
      await tx.query(`SELECT to_char(date_trunc('${unit}', l.created_at AT TIME ZONE '${safeTz(r.timezone)}'), 'YYYY-MM-DD') AS b, count(*)::int AS c FROM leads l WHERE ${B.base} AND ${inB} GROUP BY 1`, B.params)
    ).rows;
    const stageRows = stages.map((x) => ({ id: x.id as string, name: x.name as string, color: x.color as string, probability: n(x.probability), status: x.status as string, isClosed: ['won', 'lost', 'disqualified'].includes(x.status as string), count: n(x.count), value: n(x.value) }));
    return {
      leads: {
        total: n(totals.total),
        open: n(totals.open),
        created: n(totals.created),
        previousCreated: n(totals.prev_created),
        wonOfCreated: n(totals.won_of_created),
        /** Of the leads created in the period, the share that is now won; null when none were created. */
        conversionRate: n(totals.created) > 0 ? Math.round((n(totals.won_of_created) / n(totals.created)) * 10000) / 10000 : null,
        unassigned: n(totals.unassigned),
        lateFirstReplies: n(totals.late_replies),
        followupsOverdue: n(totals.followups_overdue),
      },
      pipeline: { openValue: n(totals.open_value), weightedValue: Math.round(n(weighted) * 100) / 100, stages: stageRows, otherPipelines: { count: n(other.c), value: n(other.v) } },
      sources: sources.map((x) => ({ source: x.source as string, label: SOURCE_LABEL[x.source as keyof typeof SOURCE_LABEL] ?? (x.source as string), leads: n(x.leads), won: n(x.won) })),
      trendLeads: new Map<string, number>(trend.map((x) => [x.b as string, n(x.c)])),
    };
  }

  private async sales(tx: pg.PoolClient, actor: Actor, r: Range, p: Range, includeTest: boolean, unit: Unit) {
    const scope = scopeIfAllowed(actor, 'reservations:read');
    if (!scope) return null;
    const params: unknown[] = [actor.tenantId];
    const vis = leadVisibility(actor, 'l', params);
    if (vis === false) return null;
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    const [s, e, ps, pe] = [push(r.start), push(r.end), push(p.start), push(p.end)];
    const base = `r.tenant_id = $1 AND l.deleted_at IS NULL AND ${vis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`}`;
    const done = `r.status = 'completed' AND r.completed_at >= ${s} AND r.completed_at < ${e}`;
    const row = (
      await tx.query(
        `SELECT count(*) FILTER (WHERE ${done})::int AS sales, COALESCE(sum(r.deal_value) FILTER (WHERE ${done}), 0)::float8 AS value,
                count(*) FILTER (WHERE r.status = 'completed' AND r.completed_at >= ${ps} AND r.completed_at < ${pe})::int AS prev_sales,
                COALESCE(sum(r.deal_value) FILTER (WHERE r.status = 'completed' AND r.completed_at >= ${ps} AND r.completed_at < ${pe}), 0)::float8 AS prev_value,
                count(*) FILTER (WHERE r.status = 'reserved')::int AS reserved,
                count(*) FILTER (WHERE r.status = 'offered')::int AS offers,
                count(*) FILTER (WHERE r.status = 'reserved' AND r.hold_until < now())::int AS holds_overdue
           FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id WHERE ${base}`,
        params
      )
    ).rows[0];
    const tp: unknown[] = [actor.tenantId];
    const tvis = leadVisibility(actor, 'l', tp) as string;
    const [ts, te] = [(tp.push(r.start), `$${tp.length}`), (tp.push(r.end), `$${tp.length}`)];
    const trend = (
      await tx.query(
        `SELECT to_char(date_trunc('${unit}', r.completed_at AT TIME ZONE '${safeTz(r.timezone)}'), 'YYYY-MM-DD') AS b, count(*)::int AS c, COALESCE(sum(r.deal_value), 0)::float8 AS v
           FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND l.deleted_at IS NULL AND ${tvis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`} AND r.status = 'completed' AND r.completed_at >= ${ts} AND r.completed_at < ${te} GROUP BY 1`,
        tp
      )
    ).rows;
    return {
      sales: {
        count: n(row.sales),
        dealValue: n(row.value),
        averageDealValue: n(row.sales) > 0 ? Math.round(n(row.value) / n(row.sales)) : null,
        previousCount: n(row.prev_sales),
        previousDealValue: n(row.prev_value),
        reserved: n(row.reserved),
        openOffers: n(row.offers),
        holdsOverdue: n(row.holds_overdue),
      },
      trendSales: new Map<string, { count: number; value: number }>(trend.map((x) => [x.b as string, { count: n(x.c), value: n(x.v) }])),
    };
  }

  private async tasks(tx: pg.PoolClient, actor: Actor, r: Range) {
    const scope = scopeIfAllowed(actor, 'tasks:read');
    if (!scope) return null;
    const params: unknown[] = [actor.tenantId];
    let own = '';
    if (scope === 'own') {
      params.push(actor.userId);
      own = ` AND t.assigned_to = $2`;
    }
    const day = await dayBounds(tx, r.timezone);
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    const [a, b] = [push(day.start_today), push(day.start_tomorrow)];
    const x = (
      await tx.query(
        `SELECT count(*) FILTER (WHERE t.status IN ${OPEN_TASK})::int AS open,
                count(*) FILTER (WHERE t.status IN ${OPEN_TASK} AND t.due_date < now())::int AS overdue,
                count(*) FILTER (WHERE t.status IN ${OPEN_TASK} AND t.due_date >= ${a} AND t.due_date < ${b})::int AS today,
                count(*) FILTER (WHERE t.status IN ${OPEN_TASK} AND t.assigned_to IS NULL)::int AS unassigned
           FROM tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL${own}`,
        params
      )
    ).rows[0];
    return { scope, open: n(x.open), overdue: n(x.overdue), dueToday: n(x.today), unassigned: n(x.unassigned) };
  }

  private async viewings(tx: pg.PoolClient, actor: Actor, r: Range) {
    const scope = scopeIfAllowed(actor, 'viewings:read');
    if (!scope) return null;
    const params: unknown[] = [actor.tenantId];
    let own = '';
    if (scope === 'own') {
      params.push(actor.userId);
      own = ` AND (v.agent_id = $2 OR l.owner_id = $2)`;
    }
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    const [s, e] = [push(r.start), push(r.end)];
    const x = (
      await tx.query(
        `SELECT count(*) FILTER (WHERE v.status IN ('scheduled','confirmed') AND v.scheduled_at >= now())::int AS upcoming,
                count(*) FILTER (WHERE v.status IN ('scheduled','confirmed') AND v.scheduled_at >= now() AND v.scheduled_at < now() + interval '7 days')::int AS next7,
                count(*) FILTER (WHERE v.status = 'completed' AND v.scheduled_at >= ${s} AND v.scheduled_at < ${e})::int AS completed,
                count(*) FILTER (WHERE v.status = 'cancelled' AND v.scheduled_at >= ${s} AND v.scheduled_at < ${e})::int AS cancelled,
                count(*) FILTER (WHERE v.status = 'no_show' AND v.scheduled_at >= ${s} AND v.scheduled_at < ${e})::int AS no_show,
                count(*) FILTER (WHERE v.status IN ('scheduled','confirmed') AND v.scheduled_at + (v.duration_minutes || ' minutes')::interval < now())::int AS unrecorded
           FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id WHERE v.tenant_id = $1 AND l.deleted_at IS NULL${own}`,
        params
      )
    ).rows[0];
    return { upcoming: n(x.upcoming), next7Days: n(x.next7), completed: n(x.completed), cancelled: n(x.cancelled), noShow: n(x.no_show), unrecorded: n(x.unrecorded) };
  }

  private async inventory(tx: pg.PoolClient, actor: Actor) {
    if (!scopeIfAllowed(actor, 'properties:read')) return null;
    const x = (
      await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'available')::int AS available, count(*) FILTER (WHERE status = 'under_offer')::int AS under_offer,
                count(*) FILTER (WHERE status = 'reserved')::int AS reserved, count(*) FILTER (WHERE status = 'sold')::int AS sold, count(*) FILTER (WHERE status = 'rented')::int AS rented,
                count(*) FILTER (WHERE status = 'inactive')::int AS inactive, COALESCE(sum(price) FILTER (WHERE status = 'available'), 0)::float8 AS available_value
           FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [actor.tenantId]
      )
    ).rows[0];
    return {
      total: n(x.total),
      byStatus: { available: n(x.available), under_offer: n(x.under_offer), reserved: n(x.reserved), sold: n(x.sold), rented: n(x.rented), inactive: n(x.inactive) },
      availableValue: n(x.available_value),
    };
  }

  /** Managers only (they see every lead): one row per person who owns leads or has had a sale recorded in the period. */
  private async team(tx: pg.PoolClient, actor: Actor, r: Range, includeTest: boolean) {
    if (actor.kind !== 'system' && (scopeIfAllowed(actor, 'leads:read') !== 'all' || scopeIfAllowed(actor, 'leads:assign') !== 'all')) return null;
    const test = includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`;
    const leads = (
      await tx.query(
        `SELECT l.owner_id AS id, count(*) FILTER (WHERE l.closed_at IS NULL)::int AS open, count(*) FILTER (WHERE l.created_at >= $2 AND l.created_at < $3)::int AS created
           FROM leads l WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND l.owner_id IS NOT NULL${test} GROUP BY 1`,
        [actor.tenantId, r.start, r.end]
      )
    ).rows;
    const sales = scopeIfAllowed(actor, 'reservations:read')
      ? (
          await tx.query(
            `SELECT l.owner_id AS id, count(*)::int AS sales, COALESCE(sum(rv.deal_value), 0)::float8 AS value FROM reservations rv JOIN leads l ON l.id = rv.lead_id AND l.tenant_id = rv.tenant_id
              WHERE rv.tenant_id = $1 AND rv.status = 'completed' AND rv.completed_at >= $2 AND rv.completed_at < $3 AND l.deleted_at IS NULL AND l.owner_id IS NOT NULL${test} GROUP BY 1`,
            [actor.tenantId, r.start, r.end]
          )
        ).rows
      : [];
    const tasks = scopeIfAllowed(actor, 'tasks:read')
      ? (await tx.query(`SELECT t.assigned_to AS id, count(*)::int AS overdue FROM tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.status IN ${OPEN_TASK} AND t.due_date < now() AND t.assigned_to IS NOT NULL GROUP BY 1`, [actor.tenantId])).rows
      : [];
    const ids = [...new Set([...leads, ...sales, ...tasks].map((x) => x.id as string))];
    if (!ids.length) return [];
    const names = new Map(((await tx.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
    const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((x) => [x.id, x]));
    const L = by(leads as Array<{ id: string }>);
    const S = by(sales as Array<{ id: string }>);
    const T = by(tasks as Array<{ id: string }>);
    return ids
      .map((id) => ({
        userId: id,
        name: names.get(id) ?? 'Former member',
        openLeads: n((L.get(id) as Record<string, unknown> | undefined)?.open),
        leadsCreated: n((L.get(id) as Record<string, unknown> | undefined)?.created),
        sales: n((S.get(id) as Record<string, unknown> | undefined)?.sales),
        dealValue: n((S.get(id) as Record<string, unknown> | undefined)?.value),
        overdueTasks: n((T.get(id) as Record<string, unknown> | undefined)?.overdue),
      }))
      .sort((a, b) => b.dealValue - a.dealValue || b.openLeads - a.openLeads || a.name.localeCompare(b.name))
      .slice(0, 25);
  }
}

/** The window of the same length that ends the day before `range` starts. */
async function previousWindow(tx: pg.PoolClient, range: Range): Promise<RangeQuery> {
  const r = (await tx.query(`SELECT to_char($1::date - $2::int, 'YYYY-MM-DD') AS f, to_char($1::date - 1, 'YYYY-MM-DD') AS t`, [range.from, range.days])).rows[0];
  return { from: r.f as string, to: r.t as string };
}

// the zone name comes from the tenant row, but it is placed in SQL text for date_trunc, so allow only what a zone name can look like
function safeTz(tz: string): string {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) throw new Error('Unexpected time zone name');
  return tz;
}

/** Bucket boundaries as local dates: days, Monday-based weeks, or calendar months, clamped to the range so each bucket maps to a list filter. */
function bucketStarts(range: Range, unit: Unit): Array<{ start: string; from: string; to: string }> {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const add = (x: Date, days: number) => new Date(x.getTime() + days * 86_400_000);
  const first = d(range.from);
  const last = d(range.to);
  let cursor = first;
  if (unit === 'week') cursor = add(first, -((first.getUTCDay() + 6) % 7));
  if (unit === 'month') cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const out: Array<{ start: string; from: string; to: string }> = [];
  while (cursor <= last && out.length < 400) {
    const next = unit === 'day' ? add(cursor, 1) : unit === 'week' ? add(cursor, 7) : new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const from = cursor < first ? first : cursor;
    const toExclusive = next;
    const to = add(toExclusive, -1) > last ? last : add(toExclusive, -1);
    out.push({ start: iso(cursor), from: iso(from), to: iso(to) });
    cursor = next;
  }
  return out;
}
