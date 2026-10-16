import { z } from 'zod';
import { defineRoute, created, noContent, Reply, RawReply, ifMatchVersion, makeEtag, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { CHANNEL_KEYS, LEAD_SOURCE_KEYS } from './channels';
import { STEP_KEYS } from './cohort';
import { assertModel, type AttributionService } from './attribution';
import type { ReportsService } from './reports';
import type { SpendService } from './spend';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-14');
const includeTest = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')
  .describe('Include leads tagged "test" (from “Send test lead”). Off by default so business numbers are not polluted');
const range = { from: day.optional().describe('First day (workspace time zone). Defaults to 29 days before `to`'), to: day.optional().describe('Last day, inclusive. Defaults to today in the workspace time zone'), includeTest };
const loose = z.record(z.string(), z.unknown());
const DrillRow = z.object({ id: uuid, name: z.string(), createdAt: z.string(), stageName: z.string(), status: z.string(), source: z.string(), sourceLabel: z.string(), campaign: z.string().nullable(), ownerName: z.string().nullable(), revenue: z.number(), reconstructed: z.boolean() });
const SpendSchema = z.object({ id: uuid, source: z.string(), sourceLabel: z.string(), campaign: z.string().nullable(), periodStart: z.string(), periodEnd: z.string(), amount: z.number(), currency: z.string(), note: z.string().nullable(), version: z.number().int(), enteredBy: z.string().nullable(), createdAt: z.string() });
const spendEtag = (s: { version: number }) => makeEtag(s.version);

export function createAttributionRoutes(svc: AttributionService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Where leads came from and what became of them',
      description:
        'Leads created in the range (whole days in the workspace time zone), each credited to ONE touch: the first touch (default) or the latest. Source rows add up to the total and to the drill-down lists. ' +
        'Funnel steps are nested (qualified ⊇ site visit ⊇ booked ⊇ won). Revenue is the sum of recorded sales. Spend, cost per lead and return appear only when spend was entered; rates are null (shown as "—") when the denominator is zero. ' +
        'This shows where buyers came from; it does not prove which ad caused a sale.',
      tags: ['Attribution'],
      permission: 'attribution:read',
      query: z.object({ ...range, model: z.enum(['first', 'last']).default('first').describe('Which touch gets the credit') }),
      response: loose,
      handler: async ({ query, actor }) => svc.report(actor, { from: query.from, to: query.to, includeTest: query.includeTest, model: assertModel(query.model) }),
    }),
    defineRoute({
      method: 'get',
      path: '/leads',
      summary: 'The leads behind one attribution figure',
      description: 'Same cohort as the report, so the list reproduces the number (`total`). Filter by source and/or campaign; `noCampaign` lists leads credited to no campaign.',
      tags: ['Attribution'],
      permission: 'attribution:read',
      query: pageQuery.extend({ ...range, model: z.enum(['first', 'last']).default('first'), metric: z.enum(STEP_KEYS), source: z.enum(LEAD_SOURCE_KEYS).optional(), campaign: z.string().trim().max(200).optional(), noCampaign: z.enum(['true']).optional() }),
      response: DrillRow,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.drill(actor, { from: query.from, to: query.to, includeTest: query.includeTest, model: assertModel(query.model), metric: query.metric, source: query.source, campaign: query.campaign, noCampaign: query.noCampaign === 'true', limit: query.limit, cursor: query.cursor });
        return new Reply(r.items, 200, r.page, { 'X-Total-Count': String(r.total) });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/channels',
      summary: 'Which channel each source belongs to',
      description: 'A visible table: every source with the channel it is grouped under (the default, or this workspace’s own choice).',
      tags: ['Attribution'],
      permission: 'attribution:read',
      response: z.array(z.object({ source: z.string(), label: z.string(), channel: z.string(), channelLabel: z.string(), isDefault: z.boolean() })),
      handler: async ({ actor }) => svc.mappings(actor),
    }),
    defineRoute({
      method: 'put',
      path: '/channels/:source',
      summary: 'Group a source under another channel',
      description: 'Changes how reports group this source from now on, for past leads too (nothing is stored per lead). Choosing the default removes the override. Audited.',
      tags: ['Attribution'],
      permission: 'attribution:manage',
      params: z.object({ source: z.enum(LEAD_SOURCE_KEYS) }),
      body: z.object({ channel: z.enum(CHANNEL_KEYS) }).strict(),
      response: z.array(z.object({ source: z.string(), label: z.string(), channel: z.string(), channelLabel: z.string(), isDefault: z.boolean() })),
      handler: async ({ params, body, actor }) => svc.setMapping(actor, params.source, body.channel),
    }),
  ];
}

export function createSpendRoutes(svc: SpendService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Marketing spend entries',
      description: 'Newest period first. One figure per source, campaign and exact period; periods for the same source and campaign never overlap. A row without a campaign is spend for the whole source.',
      tags: ['Spend'],
      permission: 'attribution:read',
      query: z.object({ from: day.optional(), to: day.optional() }),
      response: z.array(SpendSchema),
      handler: async ({ query, actor }) => svc.list(actor, query),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Enter marketing spend',
      description: 'Spend for a source (optionally one campaign) over a period of at most a year, in the workspace currency. Refused (409 `spend_overlaps`) when it overlaps an entry for the same source and campaign.',
      tags: ['Spend'],
      permission: 'attribution:manage',
      idempotent: true,
      body: z.object({ source: z.enum(LEAD_SOURCE_KEYS), campaign: z.string().trim().max(150).nullish(), periodStart: day, periodEnd: day, amount: z.number().min(0).max(999_999_999_999), note: z.string().trim().max(300).nullish() }),
      response: SpendSchema,
      handler: async ({ body, actor }) => {
        const s = await svc.create(actor, body);
        return created(s, spendEtag(s));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/import',
      summary: 'Import marketing spend from a CSV',
      description:
        'Send the CSV text in `csv` (max 1,000 rows). Columns by header: source, campaign (optional), from, to, amount, note (optional); dates are YYYY-MM-DD. The whole file is checked first and nothing is saved if any row is wrong (400 with the rows). A row that repeats a saved entry is skipped, so importing the same file twice changes nothing. `dryRun: true` previews.',
      tags: ['Spend'],
      permission: 'attribution:manage',
      bodyLimit: '1mb',
      body: z.object({ csv: z.string().min(1).max(900_000), dryRun: z.boolean().default(false) }),
      successStatus: 200,
      response: loose,
      handler: async ({ body, actor }) => svc.importCsv(actor, body),
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Change a spend entry',
      description: 'Amount, dates, campaign or note. The same overlap rule applies. Send `If-Match` with the last `ETag` to refuse overwriting a colleague’s change (412).',
      tags: ['Spend'],
      permission: 'attribution:manage',
      params: z.object({ id: uuid }),
      ifMatch: true,
      body: z.object({ campaign: z.string().trim().max(150).nullable().optional(), periodStart: day.optional(), periodEnd: day.optional(), amount: z.number().min(0).max(999_999_999_999).optional(), note: z.string().trim().max(300).nullable().optional() }).strict(),
      response: SpendSchema,
      handler: async ({ params, body, actor, req }) => {
        const s = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(s, 200, undefined, spendEtag(s));
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Delete a spend entry',
      tags: ['Spend'],
      permission: 'attribution:manage',
      params: z.object({ id: uuid }),
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
  ];
}

export function createReportRoutes(svc: ReportsService): RouteSpec[] {
  const q = z.object(range);
  return [
    defineRoute({
      method: 'get',
      path: '/overview',
      summary: 'Business performance report',
      description:
        'Grouped by question: the lead and sales funnel (nested steps), conversion and why leads were lost, the pipeline now with time spent in each stage, site visits and follow-ups, inventory, and (for managers) the team. ' +
        'Whole local days in the workspace time zone. Estimates (pipeline value) and recorded sales (revenue) are separate figures; rates are null when the denominator is zero. Sections you may not see are null.',
      tags: ['Reports'],
      permission: 'reports:read',
      query: q,
      response: loose,
      handler: async ({ query, actor }) => svc.overview(actor, query),
    }),
    defineRoute({
      method: 'get',
      path: '/flow',
      summary: 'Lead flow: sources to stages, arrival hours, reply speed, daily series',
      description:
        'The shape of the period for the visual report: how many leads each source brought and where they are now (plain stage groups), a 7 × 24 grid of when leads arrive (workspace time zone, Monday first), ' +
        'a histogram of first-reply speed, and one point per day. Same cohort and visibility rules as the overview, so every figure matches the leads behind it.',
      tags: ['Reports'],
      permission: 'reports:read',
      query: q,
      response: loose,
      handler: async ({ query, actor }) => svc.flow(actor, query),
    }),
    defineRoute({
      method: 'get',
      path: '/leads',
      summary: 'The leads behind one report figure',
      description: 'Same cohort as the funnel, so the list reproduces the count (`X-Total-Count`). Optionally for one owner (`owner` = a user id or `unassigned`).',
      tags: ['Reports'],
      permission: 'reports:read',
      query: pageQuery.extend({ ...range, metric: z.enum(STEP_KEYS), owner: z.union([uuid, z.literal('unassigned')]).optional() }),
      response: DrillRow,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.leads(actor, { from: query.from, to: query.to, includeTest: query.includeTest, metric: query.metric, owner: query.owner, limit: query.limit, cursor: query.cursor });
        return new Reply(r.items, 200, r.page, { 'X-Total-Count': String(r.total) });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/export',
      summary: 'Download the report as a CSV',
      description: 'The same figures as the overview for the same range, as a spreadsheet. Cells that a spreadsheet could read as formulas are neutralised.',
      tags: ['Reports'],
      permission: 'reports:export',
      query: q,
      responseContentType: 'text/csv',
      handler: async ({ query, actor }) => {
        const { csv, rows } = await svc.exportCsv(actor, query);
        return new RawReply(csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="report-${query.from ?? 'last-30-days'}${query.to ? `-to-${query.to}` : ''}.csv"`, 'X-Row-Count': String(rows), 'Cache-Control': 'no-store' });
      },
    }),
  ];
}

