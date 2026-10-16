import { z } from 'zod';
import { ifMatchVersion, makeEtag, defineRoute, created, noContent, paged, RawReply, Reply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { Errors } from '../../platform/errors';
import type { LeadsService, LeadDto } from './service';
import { ACTIVITY_DIRECTIONS, ACTIVITY_OUTCOMES, ACTIVITY_OUTCOME_CODES, ACTIVITY_TYPES, LEAD_SOURCES } from './service';
import { GATE_FIELDS, type PipelinesService } from './pipelines.service';
import type { SavedViewsService } from './saved-views';
import { IMPORT_FIELDS, type ImportService } from './import';
import { REASON_CODES } from './reason-codes';

const uuid = z.string().uuid();
const id = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max);
const money = z.number().min(0).max(1e13);
const STATUSES = ['open', 'contacted', 'qualified', 'viewing_scheduled', 'negotiation', 'won', 'lost', 'disqualified'] as const;
const PROPERTY_TYPES = ['apartment', 'villa', 'townhouse', 'penthouse', 'office', 'retail', 'plot', 'other'] as const;
const dateish = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Use an ISO date, e.g. 2026-10-14 or 2026-10-14T09:30:00Z' });

export const LeadSchema = z.object({
  id: uuid,
  contactId: uuid.nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  pipelineId: uuid,
  stageId: uuid,
  stageName: z.string(),
  stageKey: z.string().nullable(),
  stageColor: z.string(),
  stageProbability: z.number().int(),
  status: z.enum(STATUSES),
  ownerId: uuid.nullable(),
  source: z.enum(LEAD_SOURCES),
  leadScore: z.number().int().min(0).max(100),
  scoreBreakdown: z.array(z.object({ factor: z.string(), points: z.number(), note: z.string() })),
  estimatedValue: z.number().nullable(),
  currency: z.string(),
  budgetMin: z.number().nullable(),
  budgetMax: z.number().nullable(),
  bedroomsMin: z.number().int().nullable(),
  locations: z.array(z.string()),
  propertyTypes: z.array(z.string()),
  listingType: z.string().nullable(),
  tags: z.array(z.string()),
  campaign: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  lossReason: z.string().nullable(),
  lossReasonCode: z.string().nullable().describe('Why the lead was lost or was not a fit, as a code (see GET /pipelines/reason-codes)'),
  closedAt: z.string().nullable(),
  assignedAt: z.string().nullable(),
  nextFollowupAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  sla: z.object({ state: z.enum(['none', 'met', 'ok', 'at_risk', 'breached']), dueAt: z.string().nullable() }),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const requirement = {
  estimatedValue: money.nullish(),
  currency: z.string().trim().length(3).optional(),
  budgetMin: money.nullish(),
  budgetMax: money.nullish(),
  bedroomsMin: z.number().int().min(0).max(20).nullish(),
  locations: z.array(text(80).min(1)).max(10).optional(),
  propertyTypes: z.array(z.enum(PROPERTY_TYPES)).max(8).optional(),
  listingType: z.enum(['sale', 'rent', 'lease']).nullish(),
  tags: z.array(text(40)).max(30).optional(),
  campaign: text(150).nullish(),
  customFields: z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 12_000, { message: 'Custom fields are too large (12 kB maximum)' }).optional(),
  nextFollowupAt: z.string().datetime({ offset: true }).nullish(),
};

const createBody = z.object({
  contactId: uuid.optional().describe('An existing contact. Alternatively pass `contact` to create or match one by email/phone.'),
  contact: z.object({ firstName: text(100).min(1), lastName: text(100).nullish(), email: text(254).nullish(), phone: text(40).nullish() }).optional(),
  pipelineId: uuid.optional().describe('Defaults to the workspace’s default pipeline'),
  stageId: uuid.optional().describe('Defaults to the pipeline’s first stage'),
  ownerId: uuid.nullish().describe('Defaults per workspace assignment mode (creator, balanced or unassigned). Only managers can assign someone else.'),
  source: z.enum(LEAD_SOURCES).optional(),
  allowDuplicate: z.boolean().optional().describe('Create even if the contact already has an open lead in this pipeline'),
  ...requirement,
});
const patchBody = z.object({ source: z.enum(LEAD_SOURCES).optional(), ...requirement });

const filterShape = {
  q: text(100).optional().describe('Contact name, e-mail, phone digits or campaign'),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
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
  ownerId: z.union([uuid, z.literal('unassigned')]).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  tag: text(40).optional(),
  scoreMin: z.coerce.number().int().min(0).max(100).optional(),
  createdFrom: dateish.optional(),
  createdTo: dateish.optional().describe('A date without a time means whole days in the workspace time zone, and createdTo includes that day'),
  test: z.enum(['exclude']).optional().describe('`exclude` leaves out leads tagged test, as the Dashboard and reports do by default'),
  contactId: uuid.optional(),
  sla: z.enum(['breached', 'at_risk']).optional(),
  followup: z.enum(['overdue', 'today']).optional(),
  field: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use the field key, e.g. treatment').optional().describe('A custom field of this workspace (its key). Use together with `fieldValue`'),
  fieldValue: text(200).optional().describe('Match leads whose custom field equals this value (or, for a multi-select, contains it)'),
  pool: z.enum(['true']).optional().transform((v) => (v === 'true' ? true : undefined)).describe('`true` lists open leads nobody owns yet, including to callers who otherwise only see their own leads, so they can claim one'),
};
const listQuery = pageQuery.extend({
  ...filterShape,
  sort: z.enum(['created', 'updated', 'score', 'value', 'followup']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const exportQuery = z.object(filterShape);

const etag = (l: LeadDto) => makeEtag(l.version, l.leadScore, l.lastActivityAt, l.nextFollowupAt, l.sla.state);

export function createLeadRoutes(svc: LeadsService, imports: ImportService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List leads',
      description: 'Sales agents only see leads they own; managers and above see the whole workspace. Newest first by default.',
      tags: ['Leads'],
      permission: 'leads:read',
      query: listQuery,
      response: LeadSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.list(actor, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/export',
      summary: 'Export leads as CSV',
      description: 'Same filters as the list. Up to 20,000 rows. Cells that a spreadsheet could read as a formula are neutralised. The export is recorded in the audit trail.',
      tags: ['Leads'],
      permission: 'leads:export',
      query: exportQuery,
      responseContentType: 'text/csv',
      handler: async ({ query, actor }) => {
        const { csv, rows } = await svc.exportCsv(actor, query);
        return new RawReply(csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`, 'X-Row-Count': String(rows), 'Cache-Control': 'no-store' });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/activity-options',
      summary: 'Activity types, directions and outcomes',
      description: 'The fixed vocabulary for logging calls and messages. Each outcome lists the activity types it applies to.',
      tags: ['Leads'],
      permission: 'activities:read',
      handler: async () => ({ types: ACTIVITY_TYPES, directions: ACTIVITY_DIRECTIONS, outcomes: ACTIVITY_OUTCOMES.map((o) => ({ code: o.code, label: o.label, forTypes: o.forTypes })) }),
    }),
    defineRoute({
      method: 'get',
      path: '/imports',
      summary: 'Recent CSV imports',
      tags: ['Lead imports'],
      permission: 'leads:import',
      handler: async ({ actor }) => imports.list(actor),
    }),
    defineRoute({
      method: 'post',
      path: '/imports',
      summary: 'Import leads from CSV',
      description:
        'Send the CSV text in `csv` (max 5 MB, ~40,000 rows). Columns are recognised by their header (name, email, phone, source, budget, location, tags, campaign, owner email, stage, notes …); pass `mapping` to override. Processing is asynchronous: poll `GET /leads/imports/{id}` for progress and per-row errors. People who already exist are matched by e-mail/phone instead of duplicated.',
      tags: ['Lead imports'],
      permission: 'leads:import',
      bodyLimit: '6mb',
      body: z.object({
        fileName: text(200).optional(),
        csv: z.string().min(1),
        mapping: z.record(z.string(), z.enum(IMPORT_FIELDS)).optional(),
        onDuplicate: z.enum(['skip', 'create']).optional().describe('What to do when the contact already has an open lead: skip the row (default) or create another lead'),
        defaultSource: z.enum(LEAD_SOURCES).optional(),
        ownerId: uuid.nullish().describe('Owner for every imported lead unless the row has an owner e-mail'),
      }),
      successStatus: 202,
      handler: async ({ body, actor }) => new Reply(await imports.create(actor, body), 202),
    }),
    defineRoute({
      method: 'get',
      path: '/imports/:id',
      summary: 'Import progress and row errors',
      tags: ['Lead imports'],
      permission: 'leads:import',
      params: id,
      handler: async ({ params, actor }) => imports.get(actor, params.id),
    }),
    defineRoute({
      method: 'post',
      path: '/bulk',
      summary: 'Act on many leads at once',
      description: 'Up to 200 leads. Each lead is handled on its own: ones you may not change, or that violate pipeline rules, are returned in `skipped` with the reason while the rest are applied.',
      tags: ['Leads'],
      permission: 'leads:bulk',
      body: z.discriminatedUnion('action', [
        z.object({ ids: z.array(uuid).min(1).max(200), action: z.literal('assign'), ownerId: uuid.nullable() }),
        z.object({ ids: z.array(uuid).min(1).max(200), action: z.literal('move_stage'), stageId: uuid, lossReason: text(300).optional(), reasonCode: z.string().max(40).optional() }),
        z.object({ ids: z.array(uuid).min(1).max(200), action: z.enum(['add_tags', 'remove_tags']), tags: z.array(text(40).min(1)).min(1).max(10) }),
        z.object({ ids: z.array(uuid).min(1).max(200), action: z.literal('archive') }),
      ]),
      successStatus: 200,
      handler: async ({ body, actor }) => svc.bulk(actor, body as Parameters<LeadsService['bulk']>[1]),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create a lead',
      description:
        'Provide `contactId`, or `contact` (name plus email or phone) to match/create the person. Starts in the first stage of the default pipeline unless told otherwise, gets an owner per the workspace assignment mode, an explainable score and a first-response deadline. Returns 409 (`reason: duplicate_lead`, with `leadId`) when that contact already has an open lead in the pipeline.',
      tags: ['Leads'],
      permission: 'leads:create',
      idempotent: true,
      body: createBody,
      response: LeadSchema,
      handler: async ({ body, actor }) => {
        const l = await svc.create(actor, body);
        return created(l, etag(l));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'Get a lead',
      description: 'Includes the stage history and the stages this lead can move to right now (with what each move requires).',
      tags: ['Leads'],
      permission: 'leads:read',
      params: id,
      handler: async ({ params, actor }) => {
        const l = await svc.get(actor, params.id);
        return new Reply(l, 200, undefined, etag(l));
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a lead',
      description: 'Stage and owner have their own endpoints because they carry rules. Send `If-Match` to avoid overwriting a colleague’s edit.',
      tags: ['Leads'],
      permission: 'leads:update',
      params: id,
      body: patchBody,
      response: LeadSchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => {
        const l = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(l, 200, undefined, etag(l));
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Archive a lead',
      description: 'Soft delete; can be restored.',
      tags: ['Leads'],
      permission: 'leads:delete',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.archive(actor, params.id);
        return noContent();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived lead',
      tags: ['Leads'],
      permission: 'leads:delete',
      params: id,
      successStatus: 200,
      response: LeadSchema,
      handler: async ({ params, actor }) => svc.restore(actor, params.id),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/stage',
      summary: 'Move a lead to another stage',
      description:
        'Enforces the pipeline’s transition rules (409 `INVALID_TRANSITION`), required fields for the move (422) and demands `lossReason` when the target stage means lost or disqualified. Moving a closed lead to an open stage reopens it. Stage, status, history, score and events stay consistent.',
      tags: ['Leads'],
      permission: 'leads:update',
      params: id,
      body: z.object({ stageId: uuid, reason: text(300).nullish(), lossReason: text(300).nullish(), reasonCode: z.string().max(40).nullish().describe('Required when the stage means Lost or Not a fit in a pipeline that requires reason codes'),
        deal: z.object({ reservationId: uuid.optional(), propertyId: uuid.optional(), dealValue: z.number().positive().max(1e13) }).optional().describe('The sale being recorded when the stage means Won: the final deal value and the unit (or the reservation being completed). Required in pipelines that require a deal value (422 `deal_value_required`).') }),
      successStatus: 200,
      response: LeadSchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => {
        const l = await svc.move(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(l, 200, undefined, etag(l));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/assign',
      summary: 'Assign a lead to a team member (or unassign)',
      tags: ['Leads'],
      permission: 'leads:assign',
      params: id,
      body: z.object({ ownerId: uuid.nullable() }),
      successStatus: 200,
      response: LeadSchema,
      handler: async ({ params, body, actor }) => svc.assign(actor, params.id, body.ownerId),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/handlers',
      summary: 'People working on a lead besides its owner',
      tags: ['Leads'],
      permission: 'leads:read',
      params: id,
      handler: async ({ params, actor }) => svc.handlers(actor, params.id),
    }),
    defineRoute({
      method: 'put',
      path: '/:id/handlers/:userId',
      summary: 'Add someone to work on a lead',
      description: 'The owner stays accountable. A handler sees the lead and can log the work their client role and channels allow (calls, WhatsApp, Instagram, visits…), but cannot edit, move or reassign it. Team leads and admins only.',
      tags: ['Leads'],
      permission: 'leads:assign',
      params: z.object({ id: uuid, userId: uuid }),
      successStatus: 200,
      handler: async ({ params, actor }) => svc.addHandler(actor, params.id, params.userId),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id/handlers/:userId',
      summary: 'Take someone off a lead',
      tags: ['Leads'],
      permission: 'leads:assign',
      params: z.object({ id: uuid, userId: uuid }),
      successStatus: 200,
      handler: async ({ params, actor }) => svc.removeHandler(actor, params.id, params.userId),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/claim',
      summary: 'Take an unowned lead for yourself',
      description: 'Works only while nobody owns the lead. If someone took it a moment earlier you get 409 (`reason: already_claimed`).',
      tags: ['Leads'],
      permission: 'leads:claim',
      params: id,
      successStatus: 200,
      response: LeadSchema,
      handler: async ({ params, actor }) => svc.claim(actor, params.id),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/activities',
      summary: 'Lead timeline',
      description: 'Notes, calls, e-mails, meetings and system events, newest first.',
      tags: ['Leads'],
      permission: 'activities:read',
      params: id,
      query: pageQuery,
      paginated: true,
      handler: async ({ params, query, actor }) => {
        const r = await svc.activities(actor, params.id, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/activities',
      summary: 'Log a call, WhatsApp, SMS, e-mail, meeting or note',
      description:
        'Records what an employee did. Calls, WhatsApp, SMS and e-mail default to `outbound`; log a message the lead sent as `inbound`. An outbound touch counts as the first response (stops the SLA clock); any touch counts as engagement for the score. `outcome` must be one of `GET /leads/activity-options` and must fit the type. `nextFollowupAt` sets (or, with null, clears) the lead’s next follow-up.',
      tags: ['Leads'],
      permission: 'activities:create',
      params: id,
      body: z.object({
        type: z.enum(ACTIVITY_TYPES),
        description: text(4000).min(1, 'Write something'),
        direction: z.enum(ACTIVITY_DIRECTIONS).optional(),
        outcome: z.enum(ACTIVITY_OUTCOME_CODES).optional(),
        occurredAt: z.string().datetime({ offset: true }).optional(),
        durationMinutes: z.number().int().min(0).max(1440).optional(),
        nextFollowupAt: z.string().datetime({ offset: true }).nullish(),
      }),
      handler: async ({ params, body, actor }) => created(await svc.logActivity(actor, params.id, body)),
    }),
  ];
}

export function createPipelineRoutes(pipelines: PipelinesService, leads: LeadsService): RouteSpec[] {
  const stageBody = z.object({
    name: text(60).min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #6B8F71').optional(),
    mapsToStatus: z.enum(STATUSES).optional().describe('The lifecycle status a lead has while in this stage'),
    probability: z.number().int().min(0).max(100).optional().describe('Chance (%) that a lead in this stage is won; drives the weighted forecast'),
  });
  const pid = z.object({ id: uuid });
  return [
    defineRoute({ method: 'get', path: '/', summary: 'List pipelines with their stages', description: 'Stage lead counts only include leads you are allowed to see.', tags: ['Pipelines'], permission: 'pipeline:read', handler: async ({ actor }) => pipelines.list(actor) }),
    defineRoute({
      method: 'get',
      path: '/reason-codes',
      summary: 'Reasons for closing a lead without a sale',
      description: 'The fixed lists a salesperson chooses from when a lead is lost or not a fit. Stable codes, plain labels. "other" always needs a written note.',
      tags: ['Pipelines'],
      permission: 'pipeline:read',
      response: z.object({
        lost: z.array(z.object({ code: z.string(), label: z.string() })),
        not_a_fit: z.array(z.object({ code: z.string(), label: z.string() })),
      }),
      handler: async () => REASON_CODES,
    }),
    defineRoute({
      method: 'post',
      path: '/apply-recommended',
      summary: 'Add the recommended pipeline to this workspace',
      description:
        'Adds the recommended beginner pipeline as a NEW pipeline. It never replaces or edits an existing pipeline and never moves a lead; existing leads stay where they are. ' +
        '`makeDefault` decides only where NEW leads start. Safe to repeat: a second call returns the pipeline already added (`created: false`). Audited.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      body: z.object({ makeDefault: z.boolean().optional() }),
      successStatus: 200,
      handler: async ({ body, actor }) => {
        const r = await pipelines.applyRecommended(actor, body);
        return new Reply(r, r.created ? 201 : 200);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create a pipeline',
      description: 'Starts from the standard six stages, a copy of another pipeline (`copyFromId`), or empty.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      body: z.object({ name: text(80).min(1), description: text(300).nullish(), copyFromId: uuid.optional(), empty: z.boolean().optional() }),
      handler: async ({ body, actor }) => created(await pipelines.create(actor, body)),
    }),
    defineRoute({ method: 'get', path: '/:id', summary: 'Get a pipeline', tags: ['Pipelines'], permission: 'pipeline:read', params: pid, handler: async ({ params, actor }) => pipelines.get(actor, params.id) }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Rename a pipeline or make it the default',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: pid,
      body: z.object({ name: text(80).min(1).optional(), description: text(300).nullish(), isDefault: z.boolean().optional(), reasonCodesRequired: z.boolean().optional().describe('Make a reason code mandatory when a lead is lost or not a fit'), dealValueRequired: z.boolean().optional().describe('Make a recorded deal value (and the unit sold) mandatory before a lead can be won') }),
      handler: async ({ params, body, actor }) => pipelines.update(actor, params.id, body),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Archive a pipeline',
      description: 'Refused for the default pipeline and while open leads remain in it.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: pid,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await pipelines.archive(actor, params.id);
        return noContent();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/stages',
      summary: 'Add a stage',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: pid,
      body: stageBody.extend({ afterStageId: uuid.nullish() }),
      handler: async ({ params, body, actor }) => created(await pipelines.addStage(actor, params.id, body)),
    }),
    defineRoute({
      method: 'patch',
      path: '/:id/stages/:stageId',
      summary: 'Edit a stage',
      description: 'Changing what a stage means (`mapsToStatus`) immediately updates the status of the leads in it.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: z.object({ id: uuid, stageId: uuid }),
      body: stageBody.partial(),
      handler: async ({ params, body, actor }) => pipelines.updateStage(actor, params.id, params.stageId, body),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id/stages/:stageId',
      summary: 'Remove a stage',
      description: 'If leads are in the stage, pass `moveLeadsTo` (a stage of the same pipeline); each moved lead gets a history entry.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: z.object({ id: uuid, stageId: uuid }),
      query: z.object({ moveLeadsTo: uuid.optional() }),
      successStatus: 200,
      handler: async ({ params, query, actor }) => pipelines.archiveStage(actor, params.id, params.stageId, query.moveLeadsTo),
    }),
    defineRoute({
      method: 'put',
      path: '/:id/stage-order',
      summary: 'Reorder stages',
      description: 'List every active stage exactly once, in the new order.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: pid,
      body: z.object({ stageIds: z.array(uuid).min(2).max(25) }),
      handler: async ({ params, body, actor }) => pipelines.reorder(actor, params.id, body.stageIds),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/transitions',
      summary: 'Allowed stage moves',
      description: '`restricted: false` means any stage may follow any other.',
      tags: ['Pipelines'],
      permission: 'pipeline:read',
      params: pid,
      handler: async ({ params, actor }) => pipelines.transitions(actor, params.id),
    }),
    defineRoute({
      method: 'put',
      path: '/:id/transitions',
      summary: 'Replace the allowed stage moves',
      description: 'Each move may require lead fields before the lead can enter the target stage.',
      tags: ['Pipelines'],
      permission: 'pipeline:manage',
      params: pid,
      body: z.object({
        restricted: z.boolean(),
        transitions: z.array(z.object({ fromStageId: uuid, toStageId: uuid, requiredFields: z.array(z.enum(GATE_FIELDS)).max(GATE_FIELDS.length).default([]) })).max(700),
      }),
      handler: async ({ params, body, actor }) => pipelines.setTransitions(actor, params.id, body),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/board',
      summary: 'Kanban board data',
      description: 'Every stage with its totals and the most recently updated leads (`perStage`, default 20). Use `GET /leads?stageId=` to page further into a stage.',
      tags: ['Pipelines'],
      permission: ['pipeline:read', 'leads:read'],
      params: pid,
      query: z.object({ ownerId: z.union([uuid, z.literal('unassigned')]).optional(), q: text(100).optional(), perStage: z.coerce.number().int().min(1).max(50).default(20) }),
      handler: async ({ params, query, actor }) => leads.board(actor, params.id, query),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/forecast',
      summary: 'Weighted pipeline forecast',
      description: 'Open deal value × stage probability, per stage and in total. Values are summed as stored (no currency conversion).',
      tags: ['Pipelines'],
      permission: ['pipeline:read', 'leads:read'],
      params: pid,
      handler: async ({ params, actor }) => leads.forecast(actor, params.id),
    }),
  ];
}

export function createSavedViewRoutes(svc: SavedViewsService): RouteSpec[] {
  const entity = z.enum(['lead', 'contact']);
  const filters = z.record(z.string().max(40), z.unknown()).refine((v) => JSON.stringify(v).length <= 6000, { message: 'Filters are too large' });
  return [
    defineRoute({ method: 'get', path: '/', summary: 'Saved views', description: 'Your own views and the ones shared with the workspace.', tags: ['Saved views'], permission: 'saved_views:manage', query: z.object({ entity }), handler: async ({ query, actor }) => svc.list(actor, query.entity) }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Save a view',
      tags: ['Saved views'],
      permission: 'saved_views:manage',
      body: z.object({ entity, name: text(80).min(1), filters, sort: text(40).nullish(), isShared: z.boolean().optional() }),
      handler: async ({ body, actor }) => created(await svc.create(actor, body)),
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Edit one of your views',
      tags: ['Saved views'],
      permission: 'saved_views:manage',
      params: id,
      body: z.object({ name: text(80).min(1).optional(), filters: filters.optional(), sort: text(40).nullish(), isShared: z.boolean().optional() }),
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Delete one of your views',
      tags: ['Saved views'],
      permission: 'saved_views:manage',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
  ];
}
