import { z } from 'zod';
import { defineRoute, type RouteSpec } from '../../platform/http/route';
import type { DashboardService } from './service';
import type { DashboardOverviewService } from './overview';

const includeTest = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')
  .describe('Include leads tagged "test" (from “Send test lead”). Off by default so business numbers are not polluted');
const query = z.object({ includeTest });

const OutcomeReason = z.object({ code: z.string(), label: z.string(), count: z.number().int() });
const Metrics = z.object({
  leads: z.object({
    total: z.number().int(), new: z.number().int(), contacted: z.number().int(), qualified: z.number().int(), viewingScheduled: z.number().int(), negotiation: z.number().int(),
    converted: z.number().int(), lost: z.number().int(), disqualified: z.number().int(), totalPipelineValue: z.number(), wonValue: z.number().describe('Estimated value entered on won leads. NOT a recorded sale; see wonDealValue'), wonDealValue: z.number().describe('Won deal value: the sum of recorded sales (completed deals tied to a unit) of won leads'), wonWithoutDealValue: z.number().int().describe('Won leads with no recorded sale (won before deal values were recorded, or imported as won)'), conversionRate: z.string(), unassigned: z.number().int(),
  }).describe('The status buckets add up to total. Pipeline value counts open leads only'),
  stages: z.array(z.object({ id: z.string().uuid(), name: z.string(), stageKey: z.string().nullable(), color: z.string(), leadCount: z.number().int(), stageValue: z.number() })),
  viewings: z.object({ total: z.number().int(), scheduled: z.number().int(), completed: z.number().int(), cancelled: z.number().int() }),
  tasks: z.object({ total: z.number().int(), pending: z.number().int(), completed: z.number().int(), overdue: z.number().int() }),
  properties: z.object({ total: z.number().int(), available: z.number().int(), underOffer: z.number().int(), reserved: z.number().int(), sold: z.number().int(), rented: z.number().int() }),
  recentLeads: z.array(z.record(z.string(), z.unknown())),
  outcomeReasons: z
    .object({ lost: z.array(OutcomeReason), notAFit: z.array(OutcomeReason) })
    .describe('Why leads were lost, and why they were not a fit. Leads closed before reason codes existed are grouped as “No reason recorded”'),
  includesTestLeads: z.boolean(),
});

const Attribution = z.object({
  total_leads: z.number().int(),
  total_attributed: z.number().int().describe('Leads whose source is known (everything except "other")'),
  untracked_leads: z.number().int().describe('Leads with no recorded source ("other")'),
  includes_test_leads: z.boolean(),
  source_breakdown: z.array(z.object({ source: z.string(), lead_count: z.number().int(), qualified_count: z.number().int().describe('Leads currently qualified or further along (viewing, negotiation, won)'), won_count: z.number().int() })),
  campaign_performance: z.array(z.object({ campaign_name: z.string(), source: z.string(), lead_count: z.number().int(), won_count: z.number().int() })).describe('Only campaign names actually recorded on leads'),
  stage_by_source: z.array(z.object({ source: z.string(), stage: z.string(), count: z.number().int() })),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-14');
const overviewQuery = z.object({ from: day.optional().describe('First day (workspace time zone). Defaults to 29 days before `to`'), to: day.optional().describe('Last day, inclusive. Defaults to today in the workspace time zone'), includeTest });
const Overview = z.object({
  range: z.object({ from: z.string(), to: z.string(), days: z.number().int(), timezone: z.string() }),
  previous: z.object({ from: z.string(), to: z.string() }).describe('The window of the same length just before the range, used for comparison'),
  bucket: z.enum(['day', 'week', 'month']),
  includesTestLeads: z.boolean(),
  currency: z.string(),
  leads: z
    .object({
      total: z.number().int().describe('Live leads, all time'), open: z.number().int(), created: z.number().int().describe('Created in the range'), previousCreated: z.number().int(), wonOfCreated: z.number().int(),
      conversionRate: z.number().nullable().describe('Of leads created in the range, the share now won; null when none were created'), unassigned: z.number().int(), lateFirstReplies: z.number().int(), followupsOverdue: z.number().int(),
    })
    .nullable(),
  pipeline: z
    .object({
      openValue: z.number().describe('Estimated value of open leads (an estimate, not revenue)'), weightedValue: z.number(),
      stages: z.array(z.object({ id: z.string().uuid(), name: z.string(), color: z.string(), probability: z.number(), status: z.string(), isClosed: z.boolean(), count: z.number().int(), value: z.number() })),
      otherPipelines: z.object({ count: z.number().int(), value: z.number() }),
    })
    .nullable(),
  sources: z.array(z.object({ source: z.string(), label: z.string(), leads: z.number().int(), won: z.number().int() })).nullable(),
  sales: z
    .object({
      count: z.number().int(), dealValue: z.number().describe('Sum of RECORDED sales completed in the range (decision D3)'), averageDealValue: z.number().nullable(), previousCount: z.number().int(), previousDealValue: z.number(),
      reserved: z.number().int(), openOffers: z.number().int(), holdsOverdue: z.number().int(),
    })
    .nullable(),
  trend: z.array(z.object({ from: z.string(), to: z.string(), label: z.string(), leads: z.number().int(), sales: z.number().int(), dealValue: z.number() })),
  tasks: z.object({ scope: z.enum(['all', 'own']), open: z.number().int(), overdue: z.number().int(), dueToday: z.number().int(), unassigned: z.number().int() }).nullable(),
  viewings: z.object({ upcoming: z.number().int(), next7Days: z.number().int(), completed: z.number().int(), cancelled: z.number().int(), noShow: z.number().int(), unrecorded: z.number().int() }).nullable(),
  inventory: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()), availableValue: z.number() }).nullable(),
  team: z.array(z.object({ userId: z.string().uuid(), name: z.string(), openLeads: z.number().int(), leadsCreated: z.number().int(), sales: z.number().int(), dealValue: z.number(), overdueTasks: z.number().int() })).nullable(),
});

export function createDashboardRoutes(svc: DashboardService, overview: DashboardOverviewService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/overview',
      summary: 'Executive overview of the whole business',
      description:
        'One response for the Dashboard: leads, pipeline, recorded sales, tasks, visits, stock, sources, a trend over the range and (for managers) the team. Whole local days in the workspace time zone. ' +
        'Every figure counts the same rows as the list it links to (the tests compare them). Revenue is the sum of recorded sales, never an estimate. Test leads are excluded unless `includeTest=true`. ' +
        'A section is null when you may not see it; salespeople see only their own leads, tasks and visits.',
      tags: ['Dashboard'],
      permission: 'dashboard:read',
      query: overviewQuery,
      response: Overview,
      handler: async ({ query: q, actor }) => overview.overview(actor, q),
    }),
    defineRoute({
      method: 'get',
      path: '/metrics',
      summary: 'Dashboard numbers',
      description: 'Counts from live (non-archived) records, scoped to what you may see: sales agents see their own leads, tasks and viewings. Test leads are excluded unless `includeTest=true`.',
      tags: ['Dashboard'],
      permission: 'dashboard:read',
      query,
      response: Metrics,
      handler: async ({ query: q, actor }) => svc.metrics(actor, q),
    }),
    defineRoute({
      method: 'get',
      path: '/attribution',
      summary: 'Where leads came from',
      description: 'Source and campaign counts from live leads. “Other” (no recorded source) is reported as untracked, not as a channel. Cost, spend and ROI are not available yet.',
      tags: ['Dashboard'],
      permission: 'attribution:read',
      query,
      response: Attribution,
      handler: async ({ query: q, actor }) => svc.attribution(actor, q),
    }),
  ];
}
