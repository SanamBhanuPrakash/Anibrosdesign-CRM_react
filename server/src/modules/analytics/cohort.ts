import type { Actor } from '../../platform/authz/actor';
import { leadVisibility } from '../leads/pipelines.service';

/**
 * The shared definition of "which leads count" for Attribution and Reports, so a number and the list behind it come from the same SQL.
 *
 * A lead is in the cohort when it
 *   - is live (not archived),
 *   - was created inside the date range, with the range read as whole days in the WORKSPACE time zone (a daylight-saving day is 23 or 25 hours),
 *   - is visible to the caller (salespeople would see only their own),
 *   - is not a test lead, unless the caller switched "include test leads" on (decision D8: excluded by default, and the switch is visible).
 * Funnel steps are about what the lead EVER reached, taken from its history, so a lead that was qualified and then lost still counts as qualified.
 */
export { resolveRange, type Range, type RangeQuery } from './range';
import { type Range } from './range';

export type Model = 'first' | 'last';

/**
 * `WITH`-clause pieces: `cohort` (the leads and the touch that credits them) and `steps` (what each one ever reached).
 * Returns null when the caller may not read leads at all. $1 is always the tenant id.
 */
export function cohortSql(actor: Actor, params: unknown[], range: Range, o: { model: Model; includeTest: boolean; owner?: string }): string | null {
  const vis = leadVisibility(actor, 'l', params);
  if (vis === false) return null;
  params.push(range.start);
  const sIdx = params.length;
  params.push(range.end);
  const eIdx = params.length;
  const touchFilter = o.model === 'first' ? `AND a.touch_type = 'first_touch'` : '';
  const test = o.includeTest ? '' : `AND NOT ('test' = ANY(l.tags))`;
  let ownerSql = '';
  if (o.owner === 'unassigned') ownerSql = 'AND l.owner_id IS NULL';
  else if (o.owner) {
    params.push(o.owner);
    ownerSql = `AND l.owner_id = $${params.length}`;
  }
  return `
    cohort AS (
      SELECT l.id, l.created_at, l.status::text AS status, l.owner_id, l.stage_id, l.closed_at, l.first_response_at, l.first_response_due_at, l.loss_reason_code, l.estimated_value::float8 AS estimated_value,
             COALESCE(t.source, l.source::text) AS source,
             NULLIF(btrim(COALESCE(t.campaign, l.campaign, '')), '') AS campaign,
             COALESCE(t.backfilled, false) AS reconstructed
        FROM leads l
        LEFT JOIN LATERAL (
          SELECT a.source, a.campaign, a.backfilled FROM marketing_attribution a
           WHERE a.tenant_id = l.tenant_id AND a.lead_id = l.id ${touchFilter}
           ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1
        ) t ON true
       WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${vis} AND l.created_at >= $${sIdx} AND l.created_at < $${eIdx} ${test} ${ownerSql}
    ),
    steps AS (
      SELECT c.*,
             (EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id = $1 AND h.lead_id = c.id AND h.to_status IN ('qualified', 'viewing_scheduled', 'negotiation', 'won'))
              OR c.status IN ('qualified', 'viewing_scheduled', 'negotiation', 'won')) AS qualified_hist,
             (EXISTS (SELECT 1 FROM viewings v WHERE v.tenant_id = $1 AND v.lead_id = c.id AND v.status = 'completed')
              OR EXISTS (SELECT 1 FROM lead_stage_history h JOIN pipeline_stages s ON s.id = h.to_stage_id AND s.tenant_id = h.tenant_id
                          WHERE h.tenant_id = $1 AND h.lead_id = c.id AND s.stage_key = 'viewing_completed')) AS visit_raw,
             (EXISTS (SELECT 1 FROM reservations r WHERE r.tenant_id = $1 AND r.lead_id = c.id AND r.reserved_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM lead_stage_history h JOIN pipeline_stages s ON s.id = h.to_stage_id AND s.tenant_id = h.tenant_id
                          WHERE h.tenant_id = $1 AND h.lead_id = c.id AND s.stage_key = 'booking_reserved')) AS booked_raw,
             (c.status = 'won') AS won,
             COALESCE((SELECT sum(r.deal_value) FROM reservations r WHERE r.tenant_id = $1 AND r.lead_id = c.id AND r.status = 'completed'), 0)::float8 AS revenue
        FROM cohort c
    ),
    final AS (
      -- A funnel counts "reached this step or later", so every step is a subset of the one before it: won ⊆ booked ⊆ visit ⊆ qualified ⊆ leads.
      SELECT s.*,
             (s.qualified_hist OR s.visit_raw OR s.booked_raw OR s.won) AS qualified,
             (s.visit_raw OR s.booked_raw OR s.won) AS visit_done,
             (s.booked_raw OR s.won) AS booked
        FROM steps s
    )`;
}

export const STEP_COLUMN = { leads: 'true', qualified: 'qualified', visits: 'visit_done', booked: 'booked', won: 'won' } as const;
export type StepKey = keyof typeof STEP_COLUMN;
export const STEP_KEYS = Object.keys(STEP_COLUMN) as [StepKey, ...StepKey[]];

export const n = (v: unknown) => Number(v) || 0;
/** A ratio, or null (shown as "—") when the denominator is zero. Never NaN, never Infinity. */
export const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);
export const per = (amount: number, count: number): number | null => (count > 0 ? Math.round((amount / count) * 100) / 100 : null);
