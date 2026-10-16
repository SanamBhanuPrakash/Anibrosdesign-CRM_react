import { z } from 'zod';
import { created, defineRoute, noContent, RawReply, type RouteSpec } from '../../platform/http/route';
import { ROLES } from '../../platform/authz/matrix';
import { INDUSTRIES, INDUSTRY_CODES } from './industries';
import { CLIENT_ROLES, type AgencyService } from './service';
import { SORTS, type AgencyLeadsService } from './leads';
import type { AgencyReportService } from './report';
import { WORK_CHANNELS } from '../leads/channels';
import { XLSX_CONTENT_TYPE } from './xlsx';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullish();
const dateish = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Use an ISO date, e.g. 2026-10-14' });
const STATUSES = ['open', 'contacted', 'qualified', 'viewing_scheduled', 'negotiation', 'won', 'lost', 'disqualified'] as const;
const SOURCES = ['website', 'referral', 'portal', 'direct', 'meta_ads', 'google_ads', 'walk_in', 'other'] as const;

const clientFields = {
  industry: z.enum(INDUSTRY_CODES).optional().describe('Drives the wording of the client’s pipeline and which modules it shows'),
  website: optText(300),
  contactName: optText(150).describe('The person at the client the agency deals with'),
  contactEmail: z.union([z.literal(''), text(254).email()]).nullish(),
  contactPhone: optText(40),
  notes: optText(4000),
  timezone: text(64).min(3).optional().describe('IANA time zone, e.g. Asia/Kolkata. Defaults to the agency’s'),
  currency: text(3).regex(/^[A-Za-z]{3}$/, 'Use a 3-letter currency code such as INR').optional(),
};
const clientBody = z.object({
  name: text(120).min(1, 'Give the client a name'),
  ...clientFields,
  staff: z.array(z.object({ userId: uuid, role: z.enum(CLIENT_ROLES) })).max(100).optional().describe('Employees to assign straight away'),
});
const clientPatch = z.object({ name: text(120).min(1).optional(), ...clientFields }).strict();

const StatsSchema = z.object({
  totalLeads: z.number().int(),
  openLeads: z.number().int(),
  newLast7Days: z.number().int(),
  unassigned: z.number().int(),
  slaBreached: z.number().int(),
  won: z.number().int(),
  lastLeadAt: z.string().nullable(),
  spendThisMonth: z.number().nullable().describe('Recorded marketing spend for periods starting this month, in the client currency. null when the caller may not see spend'),
  currency: z.string(),
  leadSources: z.object({ active: z.number().int(), lastReceivedAt: z.string().nullable() }).nullable().describe('Whether lead capture is wired up. null when the caller may not see integrations'),
  apiKeys: z.number().int().nullable().describe('Live API keys of this client. null unless the caller manages keys'),
});
export const ClientSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  industry: z.enum(INDUSTRY_CODES).nullable(),
  website: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  myRole: z.enum(ROLES).nullable(),
  assignedStaff: z.number().int(),
  stats: StatsSchema.nullable(),
});

const leadFilters = {
  clientId: uuid.optional().describe('Only this client. Omit for every client you can see'),
  q: text(100).optional().describe('Contact name, e-mail, phone digits or campaign'),
  status: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
      const bad = parts.find((p) => !(STATUSES as readonly string[]).includes(p));
      if (bad) ctx.addIssue({ code: 'custom', message: `Unknown status “${bad}”` });
      return parts as Array<(typeof STATUSES)[number]>;
    })
    .describe('Comma-separated lifecycle statuses'),
  state: z.enum(['open', 'closed']).optional(),
  ownerId: z.union([uuid, z.literal('unassigned'), z.literal('me')]).optional().describe('An employee, `unassigned`, or `me`'),
  source: z.enum(SOURCES).optional(),
  tag: text(40).optional(),
  scoreMin: z.coerce.number().int().min(0).max(100).optional(),
  createdFrom: dateish.optional(),
  createdTo: dateish.optional().describe('A date without a time includes that whole day'),
  test: z.enum(['exclude']).optional(),
  sla: z.enum(['breached', 'at_risk']).optional(),
  followup: z.enum(['overdue', 'today']).optional(),
  field: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use the field key, e.g. treatment').optional().describe('A custom field key. Clients that do not have such a field simply match nothing. Use with `fieldValue`'),
  fieldValue: text(200).optional(),
  pool: z.enum(['true']).optional().transform((v) => (v === 'true' ? true : undefined)).describe('`true`: only open leads nobody owns yet (the pool you can claim from)'),
};
const listQuery = z.object({
  ...leadFilters,
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(SORTS).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const exportQuery = z.object({
  ...leadFilters,
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  dataset: z.enum(['leads', 'activities']).default('leads').describe('CSV only: the lead list or the activity log. Excel always contains both, plus team and client summaries'),
});

const clientId = z.object({ id: uuid });

export function createAgencyRoutes(agency: AgencyService, leads: AgencyLeadsService, report: AgencyReportService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/overview',
      summary: 'Agency home: how many clients, staff and leads',
      description: 'Totals across the clients the caller can see. Agency admins see every client; employees see the clients they are assigned to.',
      tags: ['Agency'],
      handler: async ({ actor }) => agency.overview(actor),
    }),
    defineRoute({
      method: 'get',
      path: '/options',
      summary: 'Industries and the roles an employee can hold inside a client',
      tags: ['Agency'],
      handler: async () => ({ industries: INDUSTRIES.map((i) => ({ code: i.code, label: i.label, appointment: i.appointment, realEstateModules: i.realEstateModules })), clientRoles: CLIENT_ROLES }),
    }),

    // ── clients ──
    defineRoute({
      method: 'get',
      path: '/clients',
      summary: 'List clients with lead numbers',
      description: 'Each client’s numbers are computed inside that client’s own isolated workspace with the caller’s role there (an employee limited to their own leads sees only their own count).',
      tags: ['Agency'],
      query: z.object({ status: z.enum(['active', 'archived', 'all']).default('active'), stats: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') }),
      response: z.array(ClientSchema),
      handler: async ({ query, actor }) => agency.listClients(actor, { status: query.status, withStats: query.stats }),
    }),
    defineRoute({
      method: 'post',
      path: '/clients',
      summary: 'Add a client (creates its own isolated workspace)',
      description:
        'Creates a new workspace for the client: its own leads, pipeline (stage names follow the industry), lead sources, spend, API keys and webhooks, completely separate from every other client. Every agency admin is added to it; any employees you list are assigned with the given role. New leads are handed to the least-busy assigned employee automatically. Agency admins only.',
      tags: ['Agency'],
      body: clientBody,
      response: ClientSchema,
      handler: async ({ body, actor }) => created(await agency.createClient(actor, body)),
    }),
    defineRoute({ method: 'get', path: '/clients/:id', summary: 'Get a client', tags: ['Agency'], params: clientId, response: ClientSchema, handler: async ({ params, actor }) => agency.getClient(actor, params.id) }),
    defineRoute({
      method: 'patch',
      path: '/clients/:id',
      summary: 'Edit a client’s details',
      description: 'Changing the industry does not rename existing pipeline stages. Agency admins only.',
      tags: ['Agency'],
      params: clientId,
      body: clientPatch,
      response: ClientSchema,
      handler: async ({ params, body, actor }) => agency.updateClient(actor, params.id, body),
    }),
    defineRoute({
      method: 'post',
      path: '/clients/:id/archive',
      summary: 'Archive a client',
      description: 'Everyone loses access to the client at once and its API keys stop working. Nothing is deleted; it can be restored. Agency admins only.',
      tags: ['Agency'],
      params: clientId,
      successStatus: 200,
      response: ClientSchema,
      handler: async ({ params, actor }) => agency.setArchived(actor, params.id, true),
    }),
    defineRoute({ method: 'post', path: '/clients/:id/restore', summary: 'Restore an archived client', tags: ['Agency'], params: clientId, successStatus: 200, response: ClientSchema, handler: async ({ params, actor }) => agency.setArchived(actor, params.id, false) }),

    defineRoute({
      method: 'post',
      path: '/clients/:id/custom-fields/copy',
      summary: 'Copy another client’s custom lead fields into this client',
      description: 'Copies the field definitions only (never any lead data). Fields this client already has, by key or name, are skipped and nothing is changed. Agency admins only.',
      tags: ['Agency'],
      params: clientId,
      body: z.object({ fromClientId: uuid }),
      successStatus: 200,
      handler: async ({ params, body, actor }) => agency.copyCustomFields(actor, params.id, body.fromClientId),
    }),

    // ── a client's team ──
    defineRoute({ method: 'get', path: '/clients/:id/team', summary: 'Who works on this client', description: 'Agency admins only.', tags: ['Agency'], params: clientId, handler: async ({ params, actor }) => agency.team(actor, params.id) }),
    defineRoute({
      method: 'put',
      path: '/clients/:id/team/:userId',
      summary: 'Assign an employee to a client (or change their role there)',
      description:
        '`sales_agent` sees and works only the leads assigned to them. `sales_manager` sees and works all of this client’s leads and can assign them. Only agency employees can be assigned; agency admins are already in every client.',
      tags: ['Agency'],
      params: z.object({ id: uuid, userId: uuid }),
      body: z.object({ role: z.enum(CLIENT_ROLES), channels: z.array(z.enum(WORK_CHANNELS)).max(6).nullable().optional().describe('What this person may log in this client: call, whatsapp, sms, email, instagram, meeting. null or empty = everything; leave out to keep what they have') }),
      handler: async ({ params, body, actor }) => agency.assign(actor, params.id, params.userId, body.role, body.channels),
    }),
    defineRoute({
      method: 'delete',
      path: '/clients/:id/team/:userId',
      summary: 'Take an employee off a client',
      description: 'Their access to the client ends now and their open leads there become unassigned so nothing is stranded.',
      tags: ['Agency'],
      params: z.object({ id: uuid, userId: uuid }),
      handler: async ({ params, actor }) => agency.unassign(actor, params.id, params.userId),
    }),

    // ── employees ──
    defineRoute({ method: 'get', path: '/staff', summary: 'Employees and which clients each works on', description: 'Includes pending invitations. Agency admins only.', tags: ['Agency'], handler: async ({ actor }) => agency.staff(actor) }),
    defineRoute({
      method: 'post',
      path: '/staff/invitations',
      summary: 'Invite an employee to the agency',
      description: 'Sends an invitation e-mail. Once they accept they can be assigned to clients. Agency admins only.',
      tags: ['Agency'],
      body: z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
      handler: async ({ body, actor }) => created(await agency.inviteStaff(actor, body.email)),
    }),
    defineRoute({
      method: 'patch',
      path: '/staff/:userId',
      summary: 'Make an employee an agency admin, or a normal employee again',
      description: 'Admins are in every client with full control. Only the agency owner can do this.',
      tags: ['Agency'],
      params: z.object({ userId: uuid }),
      body: z.object({ agencyRole: z.enum(['admin', 'staff']) }),
      handler: async ({ params, body, actor }) => agency.setStaffRole(actor, params.userId, body.agencyRole),
    }),
    defineRoute({
      method: 'delete',
      path: '/staff/:userId',
      summary: 'Remove an employee from the agency',
      description: 'Ends their access to the agency and every client; their open leads become unassigned. What they logged stays.',
      tags: ['Agency'],
      params: z.object({ userId: uuid }),
      handler: async ({ params, actor }) => agency.removeStaff(actor, params.userId),
    }),

    // ── leads across clients ──
    defineRoute({
      method: 'get',
      path: '/leads',
      summary: 'All leads across clients (filter by client)',
      description:
        'The same filters as a client’s own lead list, applied to each client the caller can see, then merged. Employees get only what their role allows in each client. Pages are numbered; the first 5,000 leads can be paged, beyond that narrow the filters or download.',
      tags: ['Agency'],
      query: listQuery,
      handler: async ({ query, actor }) => leads.list(actor, query),
    }),
    defineRoute({
      method: 'get',
      path: '/activity',
      summary: 'What each employee did: calls, messages, e-mails, meetings per client',
      description: 'Counts of logged work per employee per client for a period (default today, in the caller’s time zone; `from`/`to` are dates and `to` is included). Agency admins and team leads see everyone in a client; other employees see only their own numbers.',
      tags: ['Agency'],
      query: z.object({ clientId: uuid.optional(), from: dateish.optional(), to: dateish.optional() }),
      handler: async ({ query, actor }) => leads.activity(actor, query),
    }),
    defineRoute({
      method: 'get',
      path: '/unread',
      summary: 'My unread notifications per client',
      description: 'Notifications live inside each client. This counts the caller’s unread ones in every client they belong to, so the client tabs can show a badge.',
      tags: ['Agency'],
      handler: async ({ actor }) => leads.unreadByClient(actor),
    }),
    defineRoute({
      method: 'get',
      path: '/report',
      summary: 'Compare my clients side by side for one period',
      description: 'One row per client the caller belongs to and may see reports for, computed by the same services as each client’s own Reports page, inside that client’s own authorization. The period is the same two calendar dates for every client (whole days in each client’s time zone; default the last 30 days). An employee who sees only their own leads in a client gets those figures, flagged partial. Totals are sums of the rows; money is never added across currencies. Clients the caller cannot report on are listed in excluded.',
      tags: ['Agency'],
      query: z.object({ from: dateish.optional(), to: dateish.optional(), clientId: uuid.optional(), includeTest: z.enum(['true', 'false']).default('false') }),
      handler: async ({ query, actor }) => report.compare(actor, { from: query.from, to: query.to, clientId: query.clientId, includeTest: query.includeTest === 'true' }),
    }),
    defineRoute({
      method: 'get',
      path: '/tasks',
      summary: 'My tasks across all my clients: overdue or due today',
      description: 'The caller’s own open tasks that are overdue or due today in each client (day in that client’s time zone), soonest first. Each row says which client it belongs to.',
      tags: ['Agency'],
      handler: async ({ actor }) => leads.myTasks(actor),
    }),
    defineRoute({
      method: 'get',
      path: '/leads/export',
      summary: 'Download leads (Excel or CSV), fully detailed',
      description:
        'Excel (default): sheets Leads, Activity log, Team activity and Clients. CSV: one file, `dataset=leads` or `activities`. Same filters as the list. Dates are in the downloader’s time zone. Each client’s part is written to that client’s audit trail.',
      tags: ['Agency'],
      query: exportQuery,
      responseContentType: XLSX_CONTENT_TYPE,
      handler: async ({ query, actor }) => {
        const { format, dataset, ...filters } = query;
        const r = await leads.export(actor, filters, { format, dataset });
        return new RawReply(r.body, format === 'xlsx' ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8', {
          'Content-Disposition': `attachment; filename="${r.filename}"`,
          'X-Row-Count': String(r.rows),
          'Cache-Control': 'no-store',
        });
      },
    }),
  ];
}

export { noContent };
