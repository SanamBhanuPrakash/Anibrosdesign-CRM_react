import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { leadVisibility } from '../leads/pipelines.service';
import { CHANNELS, DEFAULT_CHANNEL, LEAD_SOURCE_KEYS, channelLabel, sourceLabel, type ChannelKey, type SourceKey } from './channels';
import { STEP_COLUMN, cohortSql, n, per, ratio, resolveRange, type Model, type Range, type RangeQuery, type StepKey } from './cohort';

/**
 * Where leads came from, and what became of them. Counts are leads created in the range (workspace time zone) and credited to ONE
 * touch each (first touch by default, last touch on request), so source rows add up to the total and to the lead list for the same range.
 * "This shows where buyers came from. It does not prove which ad caused a sale."
 */
export interface AttributionQuery extends RangeQuery {
  model: Model;
  includeTest: boolean;
}

export interface StepCounts {
  leads: number;
  qualified: number;
  visits: number;
  booked: number;
  won: number;
  /** Recorded deal value of the sales among these leads (decision D3). */
  revenue: number;
}
export interface MoneyFigures {
  spend: number;
  costPerLead: number | null;
  costPerQualified: number | null;
  costPerVisit: number | null;
  costPerBooking: number | null;
  costPerSale: number | null;
  /** (revenue − spend) / spend, or null when there is no spend. */
  roi: number | null;
}
export interface SourceRow extends StepCounts {
  source: string;
  label: string;
  channel: ChannelKey;
  channelLabel: string;
  spend: MoneyFigures | null;
}
export interface CampaignRow extends StepCounts {
  source: string;
  sourceLabel: string;
  campaign: string;
  spend: MoneyFigures | null;
}

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

export function moneyFor(spend: number, c: StepCounts): MoneyFigures {
  return {
    spend: Math.round(spend * 100) / 100,
    costPerLead: per(spend, c.leads),
    costPerQualified: per(spend, c.qualified),
    costPerVisit: per(spend, c.visits),
    costPerBooking: per(spend, c.booked),
    costPerSale: per(spend, c.won),
    roi: spend > 0 ? Math.round(((c.revenue - spend) / spend) * 10000) / 10000 : null,
  };
}

export class AttributionService {
  constructor(private db: Database) {}

  async mappings(actor: Actor) {
    assertCan(actor, 'attribution:read');
    return this.db.readTenant(actor, async (tx) => {
      const rows = (await tx.query(`SELECT source::text AS source, channel FROM channel_mappings WHERE tenant_id = $1`, [actor.tenantId])).rows as Array<{ source: SourceKey; channel: ChannelKey }>;
      return LEAD_SOURCE_KEYS.map((s) => {
        const o = rows.find((r) => r.source === s);
        return { source: s, label: sourceLabel(s), channel: o?.channel ?? DEFAULT_CHANNEL[s], channelLabel: channelLabel(o?.channel ?? DEFAULT_CHANNEL[s]), isDefault: !o || o.channel === DEFAULT_CHANNEL[s] };
      });
    });
  }

  /** Re-maps a source to another channel for this workspace. Mapping back to the default removes the override. Past counts re-group at once; nothing is stored per lead. */
  async setMapping(actor: Actor, source: SourceKey, channel: ChannelKey) {
    assertCan(actor, 'attribution:manage');
    await this.db.withTenant(actor, async (tx) => {
      if (channel === DEFAULT_CHANNEL[source]) await tx.query(`DELETE FROM channel_mappings WHERE tenant_id = $1 AND source = $2::lead_source`, [actor.tenantId, source]);
      else
        await tx.query(
          `INSERT INTO channel_mappings (tenant_id, source, channel, updated_by) VALUES ($1,$2::lead_source,$3,$4)
           ON CONFLICT (tenant_id, source) DO UPDATE SET channel = EXCLUDED.channel, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [actor.tenantId, source, channel, actor.userId]
        );
      await audit(tx, { action: 'attribution.channel_mapping', entityType: 'tenant', entityId: actor.tenantId, after: { source, channel } });
    });
    return this.mappings(actor);
  }

  async report(actor: Actor, q: AttributionQuery) {
    assertCan(actor, 'attribution:read');
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const params: unknown[] = [actor.tenantId];
      const cte = cohortSql(actor, params, range, q);
      const empty = { range: pub(range), model: q.model, includesTestLeads: q.includeTest, currency: range.currency, totals: zero(), tracking: { tracked: 0, untracked: 0, direct: 0, withCampaign: 0, reconstructed: 0, sharePercent: null as number | null }, sources: [], channels: [], campaigns: [], money: null, lastLeadAt: null };
      if (!cte) return empty;

      const agg = `count(*)::int AS leads, count(*) FILTER (WHERE qualified)::int AS qualified, count(*) FILTER (WHERE visit_done)::int AS visits, count(*) FILTER (WHERE booked)::int AS booked,
                   count(*) FILTER (WHERE won)::int AS won, COALESCE(sum(revenue), 0)::float8 AS revenue`;
      // "last lead received" ignores the date range but respects what the caller may see
      const lp: unknown[] = [actor.tenantId];
      const lvis = leadVisibility(actor, 'l', lp);
      const [src, camp, last, spend, mapRows] = await Promise.all([
        tx.query(`WITH ${cte} SELECT source, ${agg}, count(*) FILTER (WHERE campaign IS NOT NULL)::int AS with_campaign, count(*) FILTER (WHERE reconstructed)::int AS reconstructed FROM final GROUP BY source`, params),
        tx.query(`WITH ${cte} SELECT source, min(campaign) AS campaign, ${agg} FROM final WHERE campaign IS NOT NULL GROUP BY source, lower(campaign) ORDER BY count(*) DESC, 1, 2 LIMIT 200`, params),
        lvis === false ? Promise.resolve({ rows: [{ at: null }] }) : tx.query(`SELECT max(l.created_at) AS at FROM leads l WHERE l.tenant_id = $1 AND l.deleted_at IS NULL AND ${lvis}`, lp),
        tx.query(
          `SELECT s.source::text AS source, lower(coalesce(s.campaign, '')) AS campaign_key, s.campaign,
                  s.amount::float8 * ((LEAST(s.period_end, $3::date) - GREATEST(s.period_start, $2::date) + 1)::float8 / (s.period_end - s.period_start + 1)) AS allocated
             FROM marketing_spend s WHERE s.tenant_id = $1 AND s.period_start <= $3::date AND s.period_end >= $2::date`,
          [actor.tenantId, range.from, range.to]
        ),
        tx.query(`SELECT source::text AS source, channel FROM channel_mappings WHERE tenant_id = $1`, [actor.tenantId]),
      ]);
      const override = new Map<string, ChannelKey>((mapRows.rows as Array<{ source: string; channel: ChannelKey }>).map((r) => [r.source, r.channel]));
      const channelOf = (s: string): ChannelKey => override.get(s) ?? DEFAULT_CHANNEL[s as SourceKey] ?? 'untracked';

      const spendBySource = new Map<string, number>();
      const spendByCampaign = new Map<string, number>();
      let totalSpend = 0;
      for (const r of spend.rows as Array<{ source: string; campaign_key: string; allocated: number }>) {
        totalSpend += r.allocated;
        spendBySource.set(r.source, (spendBySource.get(r.source) ?? 0) + r.allocated);
        if (r.campaign_key) spendByCampaign.set(`${r.source}\u0000${r.campaign_key}`, (spendByCampaign.get(`${r.source}\u0000${r.campaign_key}`) ?? 0) + r.allocated);
      }

      const counts = (r: Record<string, unknown>): StepCounts => ({ leads: n(r.leads), qualified: n(r.qualified), visits: n(r.visits), booked: n(r.booked), won: n(r.won), revenue: n(r.revenue) });
      const bySource = new Map<string, StepCounts & { withCampaign: number; reconstructed: number }>();
      for (const r of src.rows) bySource.set(r.source as string, { ...counts(r), withCampaign: n(r.with_campaign), reconstructed: n(r.reconstructed) });
      // a source with spend but no leads in the range still gets a row, so spend adds up and a wasteful source is not invisible
      for (const s of spendBySource.keys()) if (!bySource.has(s)) bySource.set(s, { ...zero(), withCampaign: 0, reconstructed: 0 });

      const sources: SourceRow[] = [...bySource.entries()]
        .map(([source, c]) => {
          const ch = channelOf(source);
          const sp = spendBySource.get(source);
          return { source, label: sourceLabel(source), channel: ch, channelLabel: channelLabel(ch), ...pickCounts(c), spend: sp !== undefined && sp > 0 ? moneyFor(sp, c) : null };
        })
        .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

      const campaigns: CampaignRow[] = camp.rows.map((r) => {
        const c = counts(r);
        const sp = spendByCampaign.get(`${r.source}\u0000${String(r.campaign).toLowerCase()}`);
        return { source: r.source as string, sourceLabel: sourceLabel(r.source as string), campaign: r.campaign as string, ...c, spend: sp !== undefined && sp > 0 ? moneyFor(sp, c) : null };
      });

      const channels = CHANNELS.map((ch) => {
        const rows = sources.filter((s) => s.channel === ch.key);
        const c: StepCounts = { leads: sum(rows, (r) => r.leads), qualified: sum(rows, (r) => r.qualified), visits: sum(rows, (r) => r.visits), booked: sum(rows, (r) => r.booked), won: sum(rows, (r) => r.won), revenue: sum(rows, (r) => r.revenue) };
        const sp = sum(rows, (r) => r.spend?.spend ?? 0);
        return { channel: ch.key, label: ch.label, ...c, spend: sp > 0 ? moneyFor(sp, c) : null };
      }).filter((c) => c.leads > 0 || c.spend);

      const totals: StepCounts = { leads: sum(sources, (r) => r.leads), qualified: sum(sources, (r) => r.qualified), visits: sum(sources, (r) => r.visits), booked: sum(sources, (r) => r.booked), won: sum(sources, (r) => r.won), revenue: sum(sources, (r) => r.revenue) };
      const wonWithoutSale = ((await tx.query(`WITH ${cte} SELECT count(*)::int AS c FROM final WHERE won AND revenue = 0`, params)).rows[0].c as number) ?? 0;
      const untracked = n(bySource.get('other')?.leads);
      const tracking = {
        tracked: totals.leads - untracked,
        untracked,
        direct: n(bySource.get('direct')?.leads),
        withCampaign: sum([...bySource.values()], (c) => c.withCampaign),
        reconstructed: sum([...bySource.values()], (c) => c.reconstructed),
        /** Share of leads that carry a recorded source (everything except "Not recorded"). */
        sharePercent: ratio(totals.leads - untracked, totals.leads),
      };
      return {
        range: pub(range),
        model: q.model,
        includesTestLeads: q.includeTest,
        currency: range.currency,
        totals: { ...totals, wonWithoutDealValue: wonWithoutSale },
        tracking,
        sources,
        channels,
        campaigns,
        money: totalSpend > 0 ? moneyFor(totalSpend, totals) : null,
        lastLeadAt: (last.rows[0]?.at as string | null) ?? null,
      };
    });
  }

  /** The leads behind one number: same cohort SQL as `report`, so the list reproduces the count. */
  async drill(actor: Actor, q: AttributionQuery & { metric: StepKey; source?: string; campaign?: string; noCampaign?: boolean; limit: number; cursor?: string }): Promise<{ items: DrillRow[]; page: PageInfo; total: number }> {
    assertCan(actor, 'attribution:read');
    const sig = `attribution-drill:${q.metric}:${q.model}`;
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const range = await resolveRange(tx, actor.tenantId, q);
      const params: unknown[] = [actor.tenantId];
      const cte = cohortSql(actor, params, range, q);
      if (!cte) return { items: [], page: { hasMore: false, next: null } as PageInfo, total: 0 };
      const where: string[] = [q.metric === 'leads' ? 'true' : `f.${STEP_COLUMN[q.metric]}`];
      if (q.source) where.push(`f.source = $${params.push(q.source)}`);
      if (q.campaign !== undefined && q.campaign !== '') where.push(`lower(f.campaign) = lower($${params.push(q.campaign)})`);
      if (q.noCampaign) where.push(`f.campaign IS NULL`);
      const base = where.join(' AND ');
      const total = n((await tx.query(`WITH ${cte} SELECT count(*)::int AS c FROM final f WHERE ${base}`, params)).rows[0].c);
      const pred = cursorPredicate(cursor, params, 'f.created_at', 'f.id', 'desc', '::timestamptz');
      params.push(q.limit + 1);
      const { rows } = await tx.query(
        `WITH ${cte}
         SELECT f.id, f.created_at AS "createdAt", f.created_at::text AS _k, f.status, f.source, f.campaign, f.revenue, f.reconstructed, s.name AS "stageName",
                c.first_name AS _f, c.last_name AS _l, u.name AS "ownerName"
           FROM final f JOIN leads l ON l.id = f.id AND l.tenant_id = $1 JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id
           LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id LEFT JOIN users u ON u.id = f.owner_id
          WHERE ${base}${pred ? ` AND ${pred}` : ''} ORDER BY f.created_at DESC, f.id DESC LIMIT $${params.length}`,
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
}

export interface DrillRow {
  id: string;
  name: string;
  createdAt: string;
  stageName: string;
  status: string;
  source: string;
  sourceLabel: string;
  campaign: string | null;
  ownerName: string | null;
  revenue: number;
  reconstructed: boolean;
}

function zero(): StepCounts {
  return { leads: 0, qualified: 0, visits: 0, booked: 0, won: 0, revenue: 0 };
}
const pickCounts = (c: StepCounts): StepCounts => ({ leads: c.leads, qualified: c.qualified, visits: c.visits, booked: c.booked, won: c.won, revenue: c.revenue });
const pub = (r: Range) => ({ from: r.from, to: r.to, timezone: r.timezone, days: r.days });

export function assertModel(m: string | undefined): Model {
  if (m === undefined || m === 'first') return 'first';
  if (m === 'last') return 'last';
  throw Errors.validation([{ path: 'query.model', message: 'Use first or last' }]);
}
