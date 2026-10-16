import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { toCsv } from '../leads/csv';
import { reasonLabel } from '../leads/reason-codes';
import { leadVisibility } from '../leads/pipelines.service';
import { sourceLabel } from './channels';
import { STEP_COLUMN, cohortSql, n, ratio, resolveRange, type Range, type RangeQuery, type StepKey } from './cohort';
import type { DrillRow } from './attribution';

/**
 * Reports: business performance, grouped by the question being asked. Every count is over the SAME cohort definition as the Attribution page
 * and the Dashboard (live leads created in the range, workspace time zone, test leads left out unless asked, only what the caller may see),
 * so a figure and the list behind it always agree, and the funnel steps are nested (each one a subset of the one before it).
 * Estimates and completed sales are never mixed: pipeline value is an estimate typed on leads; revenue is the sum of recorded sales.
 */
export interface ReportQuery extends RangeQuery {
  includeTest: boolean;
}
export const FUNNEL = [
  { key: 'leads', label: 'Leads created', help: 'Leads created in the period (live, not archived).' },
  { key: 'qualified', label: 'Qualified or further', help: 'Leads that ever reached Qualified, a site visit, a booking or a sale. A lead that was qualified and then lost still counts.' },
  { key: 'visits', label: 'Reached a site visit', help: 'Leads with a completed site visit, or that went on to a booking or a sale.' },
  { key: 'booked', label: 'Reached a booking', help: 'Leads that had a property reserved, or went on to a sale. Booking is a milestone, not revenue.' },
  { key: 'won', label: 'Won', help: 'Leads currently in a Won stage.' },
] as const satisfies ReadonlyArray<{ key: StepKey; label: string; help: string }>;

/** Where a lead is now, in five plain groups (the pipeline's own stages vary by industry; their meaning does not). */
export const FLOW_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'talking', label: 'In conversation' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'booked', label: 'Booked or negotiating' },
  { key: 'won', label: 'Won' },
  { key: 'closed', label: 'Lost or not a fit' },
] as const;
/** First-reply speed buckets: `under` is the exclusive upper bound in minutes. */
export const REPLY_BUCKETS = [
  { key: 'm5', label: 'Under 5 min', under: 5 },
  { key: 'm15', label: '5–15 min', under: 15 },
  { key: 'm30', label: '15–30 min', under: 30 },
  { key: 'h1', label: '30–60 min', under: 60 },
  { key: 'h4', label: '1–4 hours', under: 240 },
  { key: 'h24', label: '4–24 hours', under: 1440 },
  { key: 'late', label: 'Over a day', under: Infinity },
] as const;
const emptyGrid = () => Array.from({ length: 7 }, () => Array<number>(24).fill(0));

export class ReportsService {
  constructor(private db: Database) {}

  async overview(actor: Actor, q: ReportQuery) {
    assertCan(actor, 'reports:read');
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const base = { range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone }, includesTestLeads: q.includeTest, currency: range.currency };
      const params: unknown[] = [actor.tenantId];
      const cte = cohortSql(actor, params, range, { model: 'first', includeTest: q.includeTest });
      const [cohort, pipeline, engagement, inventory, team] = await Promise.all([
        cte ? this.cohort(tx, cte, params) : null,
        cte ? this.pipeline(tx, actor, range, q.includeTest) : null,
        this.engagement(tx, actor, range, cte, params),
        this.inventory(tx, actor, range),
        cte ? this.team(tx, actor, cte, params) : null,
      ]);
      return { ...base, funnel: cohort?.funnel ?? null, conversion: cohort?.conversion ?? null, pipeline, engagement, inventory, team };
    });
  }

  /**
   * The shape of the period at a glance, for the infographic views: where leads came from and where they are now (source → stage group),
   * the hour-of-week they arrive, how fast the first reply was, and a daily series. Same cohort as every other report (live leads created
   * in the range, workspace time zone, only what the caller may see), so each figure agrees with the list behind it.
   */
  async flow(actor: Actor, q: ReportQuery) {
    assertCan(actor, 'reports:read');
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const base = { range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone }, includesTestLeads: q.includeTest };
      const params: unknown[] = [actor.tenantId];
      const cte = cohortSql(actor, params, range, { model: 'first', includeTest: q.includeTest });
      if (!cte) {
        return { ...base, total: 0, sources: [], stages: FLOW_STAGES.map((s) => ({ ...s, total: 0 })), links: [], arrivals: { grid: emptyGrid(), total: 0, peak: null }, replyTimes: { buckets: REPLY_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: 0 })), unanswered: 0, median: null, answered: 0 }, daily: [] };
      }
      const noTz = [...params];
      const tzIdx = params.push(range.timezone);
      const group = `CASE status WHEN 'open' THEN 'new' WHEN 'contacted' THEN 'talking' WHEN 'qualified' THEN 'qualified' WHEN 'viewing_scheduled' THEN 'booked' WHEN 'negotiation' THEN 'booked' WHEN 'won' THEN 'won' ELSE 'closed' END`;
      const last = REPLY_BUCKETS[REPLY_BUCKETS.length - 1]!;
      const bucketCase = `CASE WHEN first_response_at IS NULL THEN 'none' ${REPLY_BUCKETS.slice(0, -1).map((b) => `WHEN mins < ${b.under} THEN '${b.key}'`).join(' ')} ELSE '${last.key}' END`;
      const [links, arrivals, reply, daily] = await Promise.all([
        tx.query(`WITH ${cte} SELECT source, ${group} AS stage, count(*)::int AS c FROM final GROUP BY 1, 2`, noTz),
        tx.query(`WITH ${cte} SELECT (extract(isodow FROM created_at AT TIME ZONE $${tzIdx})::int - 1) AS dow, extract(hour FROM created_at AT TIME ZONE $${tzIdx})::int AS hr, count(*)::int AS c FROM final GROUP BY 1, 2`, params),
        tx.query(
          `WITH ${cte}, m AS (SELECT *, greatest(0, extract(epoch FROM (first_response_at - created_at)) / 60) AS mins FROM final)
           SELECT ${bucketCase} AS bucket, count(*)::int AS c, percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) FILTER (WHERE first_response_at IS NOT NULL)::float8 AS median
             FROM m GROUP BY 1`,
          noTz
        ),
        tx.query(`WITH ${cte} SELECT to_char(created_at AT TIME ZONE $${tzIdx}, 'YYYY-MM-DD') AS day, count(*)::int AS leads, count(*) FILTER (WHERE status = 'won')::int AS won FROM final GROUP BY 1 ORDER BY 1`, params),
      ]);

      const bySource = new Map<string, number>();
      const byStage = new Map<string, number>();
      for (const r of links.rows as Array<{ source: string; stage: string; c: number }>) {
        bySource.set(r.source, (bySource.get(r.source) ?? 0) + n(r.c));
        byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + n(r.c));
      }
      const grid = emptyGrid();
      let peak: { day: number; hour: number; count: number } | null = null;
      let arrTotal = 0;
      for (const r of arrivals.rows as Array<{ dow: number; hr: number; c: number }>) {
        grid[r.dow]![r.hr] = n(r.c);
        arrTotal += n(r.c);
        if (!peak || n(r.c) > peak.count) peak = { day: r.dow, hour: r.hr, count: n(r.c) };
      }
      const counts = new Map((reply.rows as Array<{ bucket: string; c: number }>).map((r) => [r.bucket, n(r.c)]));
      const median = (reply.rows as Array<{ median: number | null }>).map((r) => r.median).find((m) => m !== null && m !== undefined) ?? null;
      const answered = REPLY_BUCKETS.reduce((s, b) => s + (counts.get(b.key) ?? 0), 0);
      // Every day of the range appears, so a quiet day is a visible gap rather than a missing point.
      const dailyMap = new Map((daily.rows as Array<{ day: string; leads: number; won: number }>).map((d) => [d.day, d]));
      const series: Array<{ day: string; leads: number; won: number }> = [];
      for (let i = 0; i < range.days; i++) {
        const d = new Date(`${range.from}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        const key = d.toISOString().slice(0, 10);
        series.push({ day: key, leads: n(dailyMap.get(key)?.leads), won: n(dailyMap.get(key)?.won) });
      }
      return {
        ...base,
        total: [...byStage.values()].reduce((s, v) => s + v, 0),
        sources: [...bySource.entries()].map(([source, total]) => ({ source, label: sourceLabel(source), total })).sort((a, b) => b.total - a.total),
        stages: FLOW_STAGES.map((s) => ({ ...s, total: byStage.get(s.key) ?? 0 })),
        links: (links.rows as Array<{ source: string; stage: string; c: number }>).map((r) => ({ source: r.source, label: sourceLabel(r.source), stage: r.stage, count: n(r.c) })).filter((l) => l.count > 0),
        arrivals: { grid, total: arrTotal, peak },
        replyTimes: { buckets: REPLY_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts.get(b.key) ?? 0 })), unanswered: counts.get('none') ?? 0, median: median === null ? null : Math.round(median * 10) / 10, answered },
        daily: series,
      };
    });
  }

  private async cohort(tx: pg.PoolClient, cte: string, params: unknown[]) {
    const r = (
      await tx.query(
        `WITH ${cte}
         SELECT count(*)::int AS leads, count(*) FILTER (WHERE qualified)::int AS qualified, count(*) FILTER (WHERE visit_done)::int AS visits, count(*) FILTER (WHERE booked)::int AS booked, count(*) FILTER (WHERE won)::int AS won,
                COALESCE(sum(revenue), 0)::float8 AS revenue, count(*) FILTER (WHERE won AND revenue = 0)::int AS won_without_value,
                count(*) FILTER (WHERE status = 'lost')::int AS lost, count(*) FILTER (WHERE status = 'disqualified')::int AS not_fit,
                count(*) FILTER (WHERE closed_at IS NULL)::int AS still_open,
                avg(extract(epoch FROM (closed_at - created_at)) / 86400.0) FILTER (WHERE won)::float8 AS days_to_win,
                count(*) FILTER (WHERE revenue > 0)::int AS sales
           FROM final`,
        params
      )
    ).rows[0];
    const counts: Record<StepKey, number> = { leads: n(r.leads), qualified: n(r.qualified), visits: n(r.visits), booked: n(r.booked), won: n(r.won) };
    const steps = FUNNEL.map((s, i) => ({
      key: s.key,
      label: s.label,
      help: s.help,
      count: counts[s.key],
      /** Share of the previous step; null (shown as "—") when the previous step is empty. */
      ofPrevious: i === 0 ? null : ratio(counts[s.key], counts[FUNNEL[i - 1]!.key]),
      ofLeads: i === 0 ? null : ratio(counts[s.key], counts.leads),
    }));
    const why = (
      await tx.query(`WITH ${cte} SELECT status, loss_reason_code AS code, count(*)::int AS c FROM final WHERE status IN ('lost', 'disqualified') GROUP BY 1, 2 ORDER BY 3 DESC, 2 NULLS LAST`, params)
    ).rows as Array<{ status: string; code: string | null; c: number }>;
    const reasons = (status: string) => why.filter((w) => w.status === status).map((w) => ({ code: w.code ?? 'unspecified', label: reasonLabel(w.code), count: n(w.c) }));
    return {
      funnel: {
        steps,
        /** Recorded sales (completed deals) among these leads: the only revenue figure. */
        revenue: n(r.revenue),
        sales: n(r.sales),
        averageDealValue: n(r.sales) > 0 ? Math.round(n(r.revenue) / n(r.sales)) : null,
        wonWithoutDealValue: n(r.won_without_value),
        averageDaysToWin: r.days_to_win === null ? null : Math.round(n(r.days_to_win) * 10) / 10,
      },
      conversion: {
        winRate: ratio(counts.won, counts.leads),
        won: counts.won,
        lost: n(r.lost),
        notAFit: n(r.not_fit),
        stillOpen: n(r.still_open),
        lostReasons: reasons('lost'),
        notAFitReasons: reasons('disqualified'),
      },
    };
  }

  /** Right now (not period-bound): where open leads are, and how long leads typically stay in each stage. */
  private async pipeline(tx: pg.PoolClient, actor: Actor, range: Range, includeTest: boolean) {
    const p: unknown[] = [actor.tenantId];
    const vis = leadVisibility(actor, 'l', p);
    if (vis === false) return null;
    const base = `l.tenant_id = $1 AND l.deleted_at IS NULL AND ${vis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`}`;
    const stages = (
      await tx.query(
        `SELECT s.id, s.name, s.color, s.probability, s.maps_to_status AS status, count(l.id)::int AS count, COALESCE(sum(l.estimated_value), 0)::float8 AS value
           FROM pipelines pl JOIN pipeline_stages s ON s.pipeline_id = pl.id AND s.tenant_id = pl.tenant_id AND s.archived_at IS NULL
           LEFT JOIN leads l ON l.stage_id = s.id AND ${base}
          WHERE pl.tenant_id = $1 AND pl.is_default AND pl.archived_at IS NULL GROUP BY s.id ORDER BY s.order_index`,
        p
      )
    ).rows;
    const other = (await tx.query(`SELECT count(*)::int AS c, COALESCE(sum(l.estimated_value), 0)::float8 AS v FROM leads l WHERE ${base} AND l.closed_at IS NULL AND l.pipeline_id NOT IN (SELECT id FROM pipelines WHERE tenant_id = $1 AND is_default AND archived_at IS NULL)`, p)).rows[0];
    // time in stage: for every stage a lead LEFT during the period, how long it had been there (from the history, using the name as it was then)
    const dp: unknown[] = [actor.tenantId];
    const dvis = leadVisibility(actor, 'l', dp) as string;
    dp.push(range.start, range.end);
    const durations = (
      await tx.query(
        `WITH moves AS (
           SELECT h.lead_id, h.to_stage_id, h.created_at AS entered, lead(h.created_at) OVER (PARTITION BY h.lead_id ORDER BY h.created_at, h.id) AS left_at
             FROM lead_stage_history h WHERE h.tenant_id = $1
         )
         SELECT m.to_stage_id AS id, count(*)::int AS observations,
                avg(extract(epoch FROM (m.left_at - m.entered)) / 86400.0)::float8 AS avg_days,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (m.left_at - m.entered)) / 86400.0)::float8 AS median_days
           FROM moves m JOIN leads l ON l.id = m.lead_id AND l.tenant_id = $1
          WHERE m.left_at IS NOT NULL AND m.left_at >= $${dp.length - 1} AND m.left_at < $${dp.length} AND l.deleted_at IS NULL AND ${dvis}${includeTest ? '' : ` AND NOT ('test' = ANY(l.tags))`}
          GROUP BY 1`,
        dp
      )
    ).rows as Array<{ id: string; observations: number; avg_days: number; median_days: number }>;
    const d = new Map(durations.map((x) => [x.id, x]));
    const rows = stages.map((s) => ({
      id: s.id as string,
      name: s.name as string,
      color: s.color as string,
      probability: n(s.probability),
      isClosed: ['won', 'lost', 'disqualified'].includes(s.status as string),
      count: n(s.count),
      value: n(s.value),
      observations: n(d.get(s.id as string)?.observations),
      averageDays: d.get(s.id as string) ? Math.round(n(d.get(s.id as string)!.avg_days) * 10) / 10 : null,
      medianDays: d.get(s.id as string) ? Math.round(n(d.get(s.id as string)!.median_days) * 10) / 10 : null,
    }));
    const open = rows.filter((r) => !r.isClosed);
    const weighted = open.reduce((a, r) => a + (r.value * r.probability) / 100, 0);
    return {
      openLeads: open.reduce((a, r) => a + r.count, 0) + n(other.c),
      openValue: open.reduce((a, r) => a + r.value, 0) + n(other.v),
      weightedValue: Math.round(weighted * 100) / 100,
      stages: rows,
      otherPipelines: { count: n(other.c), value: n(other.v) },
    };
  }

  private async engagement(tx: pg.PoolClient, actor: Actor, range: Range, cte: string | null, cohortParams: unknown[]) {
    const reply = cte
      ? (
          await tx.query(
            `WITH ${cte}
             SELECT count(*)::int AS total, count(*) FILTER (WHERE first_response_at IS NOT NULL)::int AS replied,
                    count(*) FILTER (WHERE first_response_at IS NOT NULL AND first_response_due_at IS NOT NULL AND first_response_at <= first_response_due_at)::int AS in_time,
                    count(*) FILTER (WHERE first_response_due_at IS NOT NULL)::int AS with_deadline,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_response_at - created_at)) / 60.0) FILTER (WHERE first_response_at IS NOT NULL)::float8 AS median_minutes
               FROM final`,
            cohortParams
          )
        ).rows[0]
      : null;
    let visits = null;
    const vScope = scopeIfAllowed(actor, 'viewings:read');
    if (vScope) {
      const vp: unknown[] = [actor.tenantId, range.start, range.end];
      let own = '';
      if (vScope === 'own') {
        vp.push(actor.userId);
        own = ` AND (v.agent_id = $4 OR l.owner_id = $4)`;
      }
      const x = (
        await tx.query(
          `SELECT count(*) FILTER (WHERE v.status = 'completed' AND v.scheduled_at >= $2 AND v.scheduled_at < $3)::int AS held,
                  count(*) FILTER (WHERE v.status = 'cancelled' AND v.scheduled_at >= $2 AND v.scheduled_at < $3)::int AS cancelled,
                  count(*) FILTER (WHERE v.status = 'no_show' AND v.scheduled_at >= $2 AND v.scheduled_at < $3)::int AS no_show,
                  count(*) FILTER (WHERE v.status IN ('scheduled','confirmed') AND v.scheduled_at >= now())::int AS upcoming,
                  count(*) FILTER (WHERE v.status IN ('scheduled','confirmed') AND v.scheduled_at + (v.duration_minutes || ' minutes')::interval < now())::int AS unrecorded
             FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id WHERE v.tenant_id = $1 AND l.deleted_at IS NULL${own}`,
          vp
        )
      ).rows[0];
      visits = { held: n(x.held), cancelled: n(x.cancelled), noShow: n(x.no_show), upcoming: n(x.upcoming), unrecorded: n(x.unrecorded) };
    }
    let follow = null;
    const lp: unknown[] = [actor.tenantId];
    const lvis = leadVisibility(actor, 'l', lp);
    const tScope = scopeIfAllowed(actor, 'tasks:read');
    if (lvis !== false) {
      const f = (await tx.query(`SELECT count(*) FILTER (WHERE l.closed_at IS NULL AND l.next_followup_at < now())::int AS overdue, count(*) FILTER (WHERE l.closed_at IS NULL AND l.next_followup_at IS NULL)::int AS none_planned FROM leads l WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${lvis}`, lp)).rows[0];
      let tasksOverdue: number | null = null;
      if (tScope) {
        const tp: unknown[] = [actor.tenantId];
        let own = '';
        if (tScope === 'own') {
          tp.push(actor.userId);
          own = ' AND t.assigned_to = $2';
        }
        tasksOverdue = n((await tx.query(`SELECT count(*)::int AS c FROM tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.status IN ('pending','in_progress') AND t.due_date < now()${own}`, tp)).rows[0].c);
      }
      follow = { leadsOverdue: n(f.overdue), leadsWithNoFollowUp: n(f.none_planned), tasksOverdue };
    }
    return {
      visits,
      followUps: follow,
      firstReply: reply
        ? {
            leads: n(reply.total),
            replied: n(reply.replied),
            /** Of the leads that had a deadline, the share replied to in time; null when none had one. */
            inTimeRate: ratio(n(reply.in_time), n(reply.with_deadline)),
            medianMinutes: reply.median_minutes === null ? null : Math.round(n(reply.median_minutes)),
          }
        : null,
    };
  }

  private async inventory(tx: pg.PoolClient, actor: Actor, range: Range) {
    if (!scopeIfAllowed(actor, 'properties:read')) return null;
    const s = (
      await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'available')::int AS available, count(*) FILTER (WHERE status = 'under_offer')::int AS under_offer, count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
                count(*) FILTER (WHERE status = 'sold')::int AS sold, count(*) FILTER (WHERE status = 'rented')::int AS rented, count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
                COALESCE(sum(price) FILTER (WHERE status = 'available'), 0)::float8 AS available_value
           FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [actor.tenantId]
      )
    ).rows[0];
    return {
      total: n(s.total),
      byStatus: { available: n(s.available), under_offer: n(s.under_offer), reserved: n(s.reserved), sold: n(s.sold), rented: n(s.rented), inactive: n(s.inactive) },
      availableValue: n(s.available_value),
    };
  }

  /** Managers only: the same funnel, by lead owner. */
  private async team(tx: pg.PoolClient, actor: Actor, cte: string, params: unknown[]) {
    if (actor.kind !== 'system' && (scopeIfAllowed(actor, 'leads:read') !== 'all' || scopeIfAllowed(actor, 'leads:assign') !== 'all')) return null;
    const rows = (
      await tx.query(
        `WITH ${cte}
         SELECT f.owner_id AS id, count(*)::int AS leads, count(*) FILTER (WHERE qualified)::int AS qualified, count(*) FILTER (WHERE visit_done)::int AS visits, count(*) FILTER (WHERE booked)::int AS booked,
                count(*) FILTER (WHERE won)::int AS won, COALESCE(sum(revenue), 0)::float8 AS revenue,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_response_at - created_at)) / 60.0) FILTER (WHERE first_response_at IS NOT NULL)::float8 AS median_minutes
           FROM final f GROUP BY 1`,
        params
      )
    ).rows as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.id as string | null).filter((x): x is string => Boolean(x));
    const names = ids.length ? new Map(((await tx.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows as Array<{ id: string; name: string }>).map((u) => [u.id, u.name])) : new Map<string, string>();
    return rows
      .map((r) => ({
        userId: (r.id as string | null) ?? null,
        name: r.id ? (names.get(r.id as string) ?? 'Former member') : 'Unassigned',
        leads: n(r.leads), qualified: n(r.qualified), visits: n(r.visits), booked: n(r.booked), won: n(r.won), revenue: n(r.revenue),
        winRate: ratio(n(r.won), n(r.leads)),
        medianFirstReplyMinutes: r.median_minutes === null ? null : Math.round(n(r.median_minutes)),
      }))
      .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads || a.name.localeCompare(b.name));
  }

  /** The leads behind one funnel figure (optionally one owner): same cohort SQL, so the list reproduces the count. */
  async leads(actor: Actor, q: ReportQuery & { metric: StepKey; owner?: string; limit: number; cursor?: string }): Promise<{ items: DrillRow[]; page: PageInfo; total: number }> {
    assertCan(actor, 'reports:read');
    const sig = `reports-drill:${q.metric}`;
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const params: unknown[] = [actor.tenantId];
      const cte = cohortSql(actor, params, range, { model: 'first', includeTest: q.includeTest, owner: q.owner });
      if (!cte) return { items: [], page: { hasMore: false, next: null } as PageInfo, total: 0 };
      const filter = q.metric === 'leads' ? 'true' : `f.${STEP_COLUMN[q.metric]}`;
      const total = n((await tx.query(`WITH ${cte} SELECT count(*)::int AS c FROM final f WHERE ${filter}`, params)).rows[0].c);
      const pred = cursorPredicate(cursor, params, 'f.created_at', 'f.id', 'desc', '::timestamptz');
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `WITH ${cte}
         SELECT f.id, f.created_at AS "createdAt", f.created_at::text AS _k, f.status, f.source, f.campaign, f.revenue, f.reconstructed, s.name AS "stageName", c.first_name AS _f, c.last_name AS _l, u.name AS "ownerName"
           FROM final f JOIN leads l ON l.id = f.id AND l.tenant_id = $1 JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id
           LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id LEFT JOIN users u ON u.id = f.owner_id
          WHERE ${filter}${pred ? ` AND ${pred}` : ''} ORDER BY f.created_at DESC, f.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return {
        items: items.map((r) => ({ id: r.id, name: [r._f, r._l].filter(Boolean).join(' ').trim() || 'Unnamed lead', createdAt: r.createdAt, stageName: r.stageName, status: r.status, source: r.source, sourceLabel: sourceLabel(r.source), campaign: r.campaign, ownerName: r.ownerName, revenue: n(r.revenue), reconstructed: r.reconstructed })),
        page,
        total,
      };
    });
  }

  /** The report as a spreadsheet: a summary, the funnel, the pipeline, the closed-lead reasons and the team. Cells that could be read as formulas are neutralised. */
  async exportCsv(actor: Actor, q: ReportQuery): Promise<{ csv: string; rows: number }> {
    assertCan(actor, 'reports:export');
    const o = await this.overview(actor, q);
    const rows: unknown[][] = [];
    const add = (...r: unknown[]) => rows.push(r);
    add('Section', 'Item', 'Value', 'Note');
    add('Report', 'Period', `${o.range.from} to ${o.range.to}`, o.range.timezone);
    add('Report', 'Test leads', o.includesTestLeads ? 'included' : 'left out', '');
    if (o.funnel) {
      for (const s of o.funnel.steps) add('Funnel', s.label, s.count, s.ofPrevious === null ? '' : `${Math.round(s.ofPrevious * 1000) / 10}% of the previous step`);
      add('Sales', 'Recorded sales', o.funnel.sales, 'completed deals among these leads');
      add('Sales', `Won deal value (${o.currency})`, o.funnel.revenue, 'sum of recorded sales, not estimates');
      add('Sales', 'Won leads without a recorded sale', o.funnel.wonWithoutDealValue, 'counted as won, no value invented');
    }
    if (o.conversion) {
      add('Conversion', 'Win rate', o.conversion.winRate === null ? '' : `${Math.round(o.conversion.winRate * 1000) / 10}%`, 'won ÷ leads created in the period');
      for (const r of o.conversion.lostReasons) add('Lost reasons', r.label, r.count, '');
      for (const r of o.conversion.notAFitReasons) add('Not a fit reasons', r.label, r.count, '');
    }
    if (o.pipeline) {
      for (const s of o.pipeline.stages) add('Pipeline (now)', s.name, s.count, `estimated value ${s.value}${s.medianDays !== null ? `; median ${s.medianDays} days in stage` : ''}`);
      add('Pipeline (now)', 'Open value (estimate)', o.pipeline.openValue, 'typed on leads; not revenue');
    }
    if (o.team) for (const t of o.team) add('Team', t.name, t.revenue, `${t.leads} leads, ${t.qualified} qualified, ${t.visits} reached a visit, ${t.booked} booked, ${t.won} won`);
    return { csv: toCsv(['Section', 'Item', 'Value', 'Note'], rows.slice(1)), rows: rows.length - 1 };
  }
}

