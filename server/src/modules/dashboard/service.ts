import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { leadVisibility } from '../leads/pipelines.service';
import { reasonLabel } from '../leads/reason-codes';

/**
 * Dashboard numbers, computed from LIVE records only and scoped to what the caller may see.
 *
 * Definitions (so a number can always be reproduced from the lists):
 *  - a lead counts when it is not archived and, unless `includeTest` is set, is not tagged `test`
 *    ("Send test lead" deliveries are tagged `test`; they are kept out of business numbers by default)
 *  - status buckets partition the total: open + contacted + qualified + viewingScheduled + negotiation + converted(won) + lost + disqualified = total
 *  - pipeline value = estimated value of OPEN leads only (open … negotiation), not won/lost/disqualified ones
 *  - sales agents (own scope) see only their own leads, their own tasks and the viewings they run or that belong to their leads
 * Everything runs inside a read-only tenant transaction, so row-level security applies as well.
 */
export interface OutcomeReason {
  code: string;
  label: string;
  count: number;
}
export interface DashboardOptions {
  includeTest: boolean;
}

const OPEN_STATUSES = ['open', 'contacted', 'qualified', 'viewing_scheduled', 'negotiation'];
const QUALIFIED_OR_FURTHER = ['qualified', 'viewing_scheduled', 'negotiation', 'won'];
const n = (v: unknown) => Number(v) || 0;

/** Live-lead predicate pieces for alias `l`. Returns null when the caller may not read leads at all. */
function leadPredicate(actor: Actor, params: unknown[], o: DashboardOptions): string | null {
  const vis = leadVisibility(actor, 'l', params);
  if (vis === false) return null;
  const parts = ['l.tenant_id = $1', 'l.deleted_at IS NULL', vis];
  if (!o.includeTest) parts.push(`NOT ('test' = ANY(l.tags))`);
  return parts.join(' AND ');
}

export class DashboardService {
  constructor(private db: Database) {}

  async metrics(actor: Actor, o: DashboardOptions) {
    assertCan(actor, 'dashboard:read');
    return this.db.readTenant(actor, async (tx) => {
      const lp: unknown[] = [actor.tenantId];
      const leadWhere = leadPredicate(actor, lp, o);

      let leads = { total: 0, new: 0, contacted: 0, qualified: 0, viewingScheduled: 0, negotiation: 0, converted: 0, lost: 0, disqualified: 0, totalPipelineValue: 0, wonValue: 0, wonDealValue: 0, wonWithoutDealValue: 0, conversionRate: '0.0%', unassigned: 0 };
      let stages: Array<{ id: string; name: string; stageKey: string | null; color: string; leadCount: number; stageValue: number }> = [];
      let recentLeads: Array<Record<string, unknown>> = [];
      let outcomeReasons: { lost: OutcomeReason[]; notAFit: OutcomeReason[] } = { lost: [], notAFit: [] };
      if (leadWhere) {
        const byStatus = (await tx.query(`SELECT l.status::text AS s, count(*)::int AS c, COALESCE(sum(l.estimated_value), 0)::float8 AS v FROM leads l WHERE ${leadWhere} GROUP BY 1`, lp)).rows;
        const c = (s: string) => n(byStatus.find((r) => r.s === s)?.c);
        const total = byStatus.reduce((a, r) => a + n(r.c), 0);
        // D3: the revenue figure is the recorded sale of a unit (a completed deal), never an estimate typed on the lead
        const sold = (await tx.query(`SELECT COALESCE(sum(r.deal_value), 0)::float8 AS v FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id WHERE r.status = 'completed' AND l.status = 'won' AND ${leadWhere}`, lp)).rows[0];
        const unrecorded = (await tx.query(`SELECT count(*)::int AS c FROM leads l WHERE ${leadWhere} AND l.status = 'won' AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.lead_id = l.id AND r.tenant_id = l.tenant_id AND r.status = 'completed')`, lp)).rows[0];
        const unassigned = n((await tx.query(`SELECT count(*)::int AS c FROM leads l WHERE ${leadWhere} AND l.owner_id IS NULL`, lp)).rows[0].c);
        leads = {
          total, new: c('open'), contacted: c('contacted'), qualified: c('qualified'), viewingScheduled: c('viewing_scheduled'), negotiation: c('negotiation'), converted: c('won'), lost: c('lost'), disqualified: c('disqualified'),
          totalPipelineValue: byStatus.filter((r) => OPEN_STATUSES.includes(r.s)).reduce((a, r) => a + n(r.v), 0),
          wonValue: n(byStatus.find((r) => r.s === 'won')?.v),
          wonDealValue: n(sold.v),
          wonWithoutDealValue: n(unrecorded.c),
          conversionRate: `${total > 0 ? ((c('won') / total) * 100).toFixed(1) : '0.0'}%`,
          unassigned,
        };
        const sp: unknown[] = [actor.tenantId];
        const joinPred = leadPredicate(actor, sp, o)!;
        stages = (
          await tx.query(
            `SELECT ps.id, ps.name, ps.stage_key AS "stageKey", ps.color, count(l.id)::int AS "leadCount", COALESCE(sum(l.estimated_value), 0)::float8 AS "stageValue"
               FROM pipeline_stages ps JOIN pipelines p ON p.id = ps.pipeline_id AND p.tenant_id = $1 AND p.is_default AND p.archived_at IS NULL
               LEFT JOIN leads l ON l.stage_id = ps.id AND ${joinPred}
              WHERE ps.tenant_id = $1 AND ps.archived_at IS NULL
              GROUP BY ps.id, ps.name, ps.stage_key, ps.color, ps.order_index ORDER BY ps.order_index`,
            sp
          )
        ).rows;
        // Why leads were lost / were not a fit. Old leads closed before reason codes existed are grouped as "No reason recorded", never guessed.
        const why = (await tx.query(`SELECT l.status::text AS s, l.loss_reason_code AS code, count(*)::int AS c FROM leads l WHERE ${leadWhere} AND l.status IN ('lost','disqualified') GROUP BY 1, 2 ORDER BY 3 DESC, 2 NULLS LAST`, lp)).rows;
        const asReasons = (status: string): OutcomeReason[] => why.filter((r) => r.s === status).map((r) => ({ code: r.code ?? 'unspecified', label: reasonLabel(r.code), count: n(r.c) }));
        outcomeReasons = { lost: asReasons('lost'), notAFit: asReasons('disqualified') };
        recentLeads = (
          await tx.query(
            `SELECT l.id, l.status::text AS stage, l.source::text AS lead_source, l.created_at, c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email::text AS contact_email, c.phone AS contact_phone
               FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE ${leadWhere} ORDER BY l.created_at DESC, l.id DESC LIMIT 10`,
            lp
          )
        ).rows;
      }

      const viewings = await this.viewingCounts(tx, actor);
      const tasks = await this.taskCounts(tx, actor);
      const properties = await this.propertyCounts(tx, actor);
      return { leads, stages, viewings, tasks, properties, recentLeads, outcomeReasons, includesTestLeads: o.includeTest };
    });
  }

  private async viewingCounts(tx: pg.PoolClient, actor: Actor) {
    const scope = scopeIfAllowed(actor, 'viewings:read');
    if (!scope) return { total: 0, scheduled: 0, completed: 0, cancelled: 0 };
    const params: unknown[] = [actor.tenantId];
    let own = '';
    if (scope === 'own') {
      params.push(actor.userId);
      own = ` AND (v.agent_id = $2 OR l.owner_id = $2)`;
    }
    const r = (
      await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE v.status IN ('scheduled','confirmed'))::int AS scheduled, count(*) FILTER (WHERE v.status = 'completed')::int AS completed, count(*) FILTER (WHERE v.status = 'cancelled')::int AS cancelled
           FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id WHERE v.tenant_id = $1${own}`,
        params
      )
    ).rows[0];
    return { total: n(r.total), scheduled: n(r.scheduled), completed: n(r.completed), cancelled: n(r.cancelled) };
  }

  private async taskCounts(tx: pg.PoolClient, actor: Actor) {
    const scope = scopeIfAllowed(actor, 'tasks:read');
    if (!scope) return { total: 0, pending: 0, completed: 0, overdue: 0 };
    const params: unknown[] = [actor.tenantId];
    let own = '';
    if (scope === 'own') {
      params.push(actor.userId);
      own = ` AND t.assigned_to = $2`;
    }
    const r = (
      await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE t.status IN ('pending','in_progress'))::int AS pending, count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
                count(*) FILTER (WHERE t.status IN ('pending','in_progress') AND t.due_date < now())::int AS overdue
           FROM tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL${own}`,
        params
      )
    ).rows[0];
    return { total: n(r.total), pending: n(r.pending), completed: n(r.completed), overdue: n(r.overdue) };
  }

  private async propertyCounts(tx: pg.PoolClient, actor: Actor) {
    if (!scopeIfAllowed(actor, 'properties:read')) return { total: 0, available: 0, underOffer: 0, reserved: 0, sold: 0, rented: 0 };
    const r = (
      await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'available')::int AS available, count(*) FILTER (WHERE status = 'under_offer')::int AS under_offer,
                count(*) FILTER (WHERE status = 'reserved')::int AS reserved, count(*) FILTER (WHERE status = 'sold')::int AS sold, count(*) FILTER (WHERE status = 'rented')::int AS rented
           FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [actor.tenantId]
      )
    ).rows[0];
    return { total: n(r.total), available: n(r.available), underOffer: n(r.under_offer), reserved: n(r.reserved), sold: n(r.sold), rented: n(r.rented) };
  }

  /**
   * Where leads came from. `source` is the lead's recorded source; "other" means no source was recorded and is reported as UNTRACKED,
   * not as an attributed channel. Campaign rows come only from campaign names that were actually recorded on leads.
   */
  async attribution(actor: Actor, o: DashboardOptions) {
    assertCan(actor, 'attribution:read');
    return this.db.readTenant(actor, async (tx) => {
      const p: unknown[] = [actor.tenantId];
      const where = leadPredicate(actor, p, o);
      if (!where) return { total_leads: 0, total_attributed: 0, untracked_leads: 0, includes_test_leads: o.includeTest, source_breakdown: [], campaign_performance: [], stage_by_source: [] };
      const [src, camp, stage] = await Promise.all([
        tx.query(
          `SELECT l.source::text AS source, count(*)::int AS lead_count,
                  count(*) FILTER (WHERE l.status::text = ANY($${p.length + 1}::text[]))::int AS qualified_count, count(*) FILTER (WHERE l.status = 'won')::int AS won_count
             FROM leads l WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`,
          [...p, QUALIFIED_OR_FURTHER]
        ),
        tx.query(
          `SELECT btrim(l.campaign) AS campaign_name, l.source::text AS source, count(*)::int AS lead_count, count(*) FILTER (WHERE l.status = 'won')::int AS won_count
             FROM leads l WHERE ${where} AND l.campaign IS NOT NULL AND btrim(l.campaign) <> '' GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 50`,
          p
        ),
        tx.query(`SELECT l.source::text AS source, l.status::text AS stage, count(*)::int AS count FROM leads l WHERE ${where} GROUP BY 1, 2 ORDER BY 3 DESC`, p),
      ]);
      const total = src.rows.reduce((a, r) => a + n(r.lead_count), 0);
      const untracked = n(src.rows.find((r) => r.source === 'other')?.lead_count);
      return {
        total_leads: total,
        total_attributed: total - untracked,
        untracked_leads: untracked,
        includes_test_leads: o.includeTest,
        source_breakdown: src.rows,
        campaign_performance: camp.rows,
        stage_by_source: stage.rows,
      };
    });
  }
}
