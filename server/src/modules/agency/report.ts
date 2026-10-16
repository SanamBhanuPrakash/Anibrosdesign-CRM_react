import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import { scopeOf } from '../../platform/authz/matrix';
import type { DashboardOverviewService } from '../dashboard/overview';
import type { ReportsService } from '../analytics/reports';
import type { AttributionService } from '../analytics/attribution';
import { mapLimit, type AgencyService } from './service';
import type { AgencyLeadsService } from './leads';

/**
 * Compare the clients you belong to, side by side, for one period.
 *
 * Nothing is recalculated here. For each client this calls the SAME services the client's own Reports page uses (dashboard overview,
 * reports overview, attribution), inside that client's own tenant transaction and with the caller's role in that client. So:
 *   - a client the caller does not belong to is never queried, and a client where their role has no report access is listed as left out;
 *   - an employee who only sees their own leads in a client gets that client's figures for their own leads, flagged as partial;
 *   - one definition per metric, the one the client's own report uses. "Won" is leads created in the period that are now won; "Deals" are
 *     recorded sales (a separate column, only where the role may read them);
 *   - each lead belongs to exactly one client and each spend entry to exactly one client, so summing the rows cannot count anything twice;
 *   - money is never added across currencies: totals carry one line per currency;
 *   - the period is the same two calendar dates for every client (each client reads them as whole days in its own time zone).
 */
export interface CompareQuery {
  from?: string;
  to?: string;
  includeTest: boolean;
  clientId?: string;
}

export interface CompareRow {
  client: { id: string; name: string; industry: string | null };
  /** `all`: every lead of the client; `own`: only this person's leads in it (the figures are partial). */
  scope: 'all' | 'own';
  currency: string;
  timezone: string;
  leads: { created: number; previousCreated: number; open: number; unassigned: number; waitingForReply: number; followupsOverdue: number; won: number; winRate: number | null };
  deals: { count: number; value: number } | null;
  firstReply: { medianMinutes: number | null; inTimeRate: number | null } | null;
  money: { spend: number; costPerLead: number | null; costPerSale: number | null } | null;
  trend: Array<{ label: string; leads: number }>;
}

const sum = (rows: CompareRow[], f: (r: CompareRow) => number) => rows.reduce((n, r) => n + f(r), 0);

export class AgencyReportService {
  constructor(
    private db: Database,
    private agency: AgencyService,
    private agencyLeads: AgencyLeadsService,
    private dashboard: DashboardOverviewService,
    private reports: ReportsService,
    private attribution: AttributionService
  ) {}

  async compare(actor: Actor, q: CompareQuery) {
    const ctx = await this.agency.context(actor);
    const targets = await this.agencyLeads.targets(actor, ctx, 'leads:read', q.clientId);

    // One calendar window for everyone. Without dates: the last 30 days up to today in the CALLER's time zone.
    const tz = String((await this.db.asUser(ctx.userId).query(`SELECT timezone FROM users WHERE id = $1`, [ctx.userId])).rows[0]?.timezone || 'Asia/Kolkata');
    const today = (await this.db.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d as string;
    const to = q.to ?? today;
    const from = q.from ?? ((await this.db.query(`SELECT to_char($1::date - 29, 'YYYY-MM-DD') AS d`, [to])).rows[0].d as string);
    const range = { from, to, includeTest: q.includeTest };

    const excluded: Array<{ clientId: string; clientName: string; reason: string }> = [];
    const parts = await mapLimit(targets, 4, async (t): Promise<(CompareRow & { bucket: string }) | null> => {
      const scope = scopeOf(t.role, 'dashboard:read');
      if (!scope) {
        excluded.push({ clientId: t.id, clientName: t.name, reason: 'Your role in this client has no access to its reports' });
        return null;
      }
      const a = this.agencyLeads.actorIn(ctx, actor, t);
      const o = await this.dashboard.overview(a, range);
      const rep = scopeOf(t.role, 'reports:read') ? await this.reports.overview(a, range) : null;
      const money = scopeOf(t.role, 'attribution:read') ? (await this.attribution.report(a, { ...range, model: 'first' })).money : null;
      const l = o.leads;
      return {
        client: { id: t.id, name: t.name, industry: t.industry },
        scope,
        currency: o.currency,
        timezone: o.range.timezone,
        leads: {
          created: l?.created ?? 0,
          previousCreated: l?.previousCreated ?? 0,
          open: l?.open ?? 0,
          unassigned: l?.unassigned ?? 0,
          waitingForReply: l?.lateFirstReplies ?? 0,
          followupsOverdue: l?.followupsOverdue ?? 0,
          won: l?.wonOfCreated ?? 0,
          winRate: l?.conversionRate ?? null,
        },
        deals: o.sales ? { count: o.sales.count, value: o.sales.dealValue } : null,
        firstReply: rep?.engagement.firstReply ? { medianMinutes: rep.engagement.firstReply.medianMinutes, inTimeRate: rep.engagement.firstReply.inTimeRate } : null,
        money: money ? { spend: money.spend, costPerLead: money.costPerLead, costPerSale: money.costPerSale } : null,
        trend: o.trend.map((p) => ({ label: p.label, leads: p.leads })),
        bucket: o.bucket,
      };
    });
    const rows = parts.filter((p): p is CompareRow & { bucket: string } => p !== null).sort((x, y) => y.leads.created - x.leads.created || x.client.name.localeCompare(y.client.name));

    // The combined trend is only drawn when every client cut the period the same way (it is, for the same dates, unless a client is in an odd zone).
    const buckets = new Set(rows.map((r) => r.bucket));
    const trend = new Map<string, number>();
    if (buckets.size <= 1) for (const r of rows) for (const p of r.trend) trend.set(p.label, (trend.get(p.label) ?? 0) + p.leads);

    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const created = sum(rows, (r) => r.leads.created);
    const won = sum(rows, (r) => r.leads.won);
    return {
      range: { from, to },
      includesTestLeads: q.includeTest,
      bucket: buckets.size === 1 ? [...buckets][0]! : null,
      partial: rows.some((r) => r.scope === 'own'),
      excluded: excluded.sort((x, y) => x.clientName.localeCompare(y.clientName)),
      rows: rows.map(({ bucket: _b, ...r }) => r),
      totals: {
        clients: rows.length,
        leads: {
          created,
          previousCreated: sum(rows, (r) => r.leads.previousCreated),
          open: sum(rows, (r) => r.leads.open),
          unassigned: sum(rows, (r) => r.leads.unassigned),
          waitingForReply: sum(rows, (r) => r.leads.waitingForReply),
          followupsOverdue: sum(rows, (r) => r.leads.followupsOverdue),
          won,
          winRate: created > 0 ? Math.round((won / created) * 10000) / 10000 : null,
        },
        dealCount: sum(rows, (r) => r.deals?.count ?? 0),
        byCurrency: currencies.map((c) => ({
          currency: c,
          dealValue: Math.round(rows.filter((r) => r.currency === c).reduce((n, r) => n + (r.deals?.value ?? 0), 0) * 100) / 100,
          spend: Math.round(rows.filter((r) => r.currency === c).reduce((n, r) => n + (r.money?.spend ?? 0), 0) * 100) / 100,
          clientsWithSpend: rows.filter((r) => r.currency === c && r.money && r.money.spend > 0).length,
        })),
      },
      trend: [...trend.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([label, leads]) => ({ label, leads })),
    };
  }
}