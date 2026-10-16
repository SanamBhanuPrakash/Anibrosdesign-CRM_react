import { z } from 'zod';
import { defineRoute, created, paged, Reply, RawReply, ifMatchVersion, makeEtag, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { VIEWING_OUTCOMES, VIEWING_STATUSES, type ViewingDto, type ViewingsService } from './service';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const OUTCOME_CODES = VIEWING_OUTCOMES.map((o) => o.code) as [string, ...string[]];

export const ViewingSchema = z.object({
  id: uuid,
  leadId: uuid,
  propertyId: uuid,
  agentId: uuid.nullable(),
  scheduledAt: z.string(),
  durationMinutes: z.number().int(),
  status: z.enum(VIEWING_STATUSES),
  notes: z.string().nullable(),
  version: z.number().int().describe('Send as If-Match when rescheduling to avoid overwriting a colleague’s change'),
  outcome: z.object({ code: z.string(), label: z.string() }).nullable().describe('What came of a completed visit'),
  outcomeNote: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  reminderTaskId: uuid.nullable().describe('The reminder task for this visit; calendars show the visit, not this task'),
  createdAt: z.string(),
  property: z.object({ id: uuid, title: z.string(), price: z.number(), location: z.string().nullable() }),
  leadContact: z.object({ firstName: z.string().nullable(), lastName: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  agent: z.object({ id: uuid, name: z.string() }).nullable(),
});

const id = z.object({ id: uuid });
const etag = (v: ViewingDto) => makeEtag(v.version);

export function createViewingRoutes(svc: ViewingsService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List viewings',
      description: 'Site visits in time order. Sales agents see the viewings they run or that belong to their own leads; managers, admins and owners see all. Filter by lead, property, status or a time range.',
      tags: ['Viewings'],
      permission: 'viewings:read',
      query: pageQuery.extend({ propertyId: uuid.optional(), leadId: uuid.optional(), status: z.enum(VIEWING_STATUSES).optional(), from: iso.optional(), to: iso.optional() }),
      response: ViewingSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.list(actor, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/outcomes',
      summary: 'What can come of a visit',
      description: 'The fixed list a person chooses from when recording a completed visit.',
      tags: ['Viewings'],
      permission: 'viewings:read',
      response: z.array(z.object({ code: z.string(), label: z.string() })),
      handler: async () => VIEWING_OUTCOMES.map((o) => ({ code: o.code, label: o.label })),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Book a viewing',
      description:
        'Books a site visit for a lead at a property. Refused (409) when the property or the agent already has an overlapping visit; refused (422) when the property is reserved, sold, rented, inactive or archived (available and under-offer properties can be viewed); 404 when the lead is archived or not visible to you. ' +
        'An explicit `agentId` must be an active member of this workspace and only managers may book someone else. Booking does not change the lead’s stage. A reminder task is created for the agent, so the visit appears in their day.',
      tags: ['Viewings'],
      permission: 'viewings:create',
      idempotent: true,
      body: z.object({
        leadId: uuid,
        propertyId: uuid,
        scheduledAt: iso.describe('ISO 8601 with a UTC offset, e.g. 2026-10-18T10:30:00+05:30'),
        durationMinutes: z.number().int().min(5).max(480).default(30),
        notes: z.string().trim().max(1000).nullable().optional(),
        agentId: uuid.nullable().optional(),
      }),
      response: ViewingSchema,
      handler: async ({ body, actor }) => {
        const v = await svc.schedule(actor, body);
        return created(v, etag(v));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'One viewing',
      tags: ['Viewings'],
      permission: 'viewings:read',
      params: id,
      response: ViewingSchema,
      handler: async ({ params, actor }) => {
        const v = await svc.get(actor, params.id);
        return new Reply(v, 200, undefined, etag(v));
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Reschedule a viewing',
      description:
        'Change the time, length, notes or agent of a visit that has not happened yet. Same rules as booking: the property must still be available or under offer (422), nobody may be double-booked (409). The agent’s reminder task moves with it. ' +
        'Send `If-Match` with the last `ETag` to refuse overwriting a colleague’s change (412). A finished visit cannot be changed (409).',
      tags: ['Viewings'],
      permission: 'viewings:update',
      params: id,
      ifMatch: true,
      body: z
        .object({
          scheduledAt: iso.optional(),
          durationMinutes: z.number().int().min(5).max(480).optional(),
          notes: z.string().trim().max(1000).nullable().optional(),
          agentId: uuid.nullable().optional(),
        })
        .strict(),
      response: ViewingSchema,
      handler: async ({ params, body, actor, req }) => {
        const v = await svc.reschedule(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(v, 200, undefined, etag(v));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/cancel',
      summary: 'Cancel a viewing',
      description: 'Frees the slot for the property and the agent and closes the reminder task. A finished visit cannot be cancelled (409).',
      tags: ['Viewings'],
      permission: 'viewings:update',
      params: id,
      body: z.object({ reason: z.string().trim().max(500).nullish() }),
      successStatus: 200,
      response: ViewingSchema,
      handler: async ({ params, body, actor }) => svc.cancel(actor, params.id, body.reason),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/no-show',
      summary: 'The buyer did not come',
      description: 'Only once the visit was due to start (409 before that). Closes the reminder task.',
      tags: ['Viewings'],
      permission: 'viewings:update',
      params: id,
      body: z.object({ note: z.string().trim().max(1000).nullish() }),
      successStatus: 200,
      response: ViewingSchema,
      handler: async ({ params, body, actor }) => svc.noShow(actor, params.id, body.note),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/complete',
      summary: 'Record a completed visit',
      description:
        'Records what came of the visit (a fixed list), closes the reminder, and optionally creates ONE follow-up task (`followUp.dueAt`). ' +
        'The response also offers `suggestedStage`: the next stage for the lead (for example “Site visit done”). It is only an offer; the lead is not moved. Possible from 15 minutes before the start; refused (409) before that.',
      tags: ['Viewings'],
      permission: 'viewings:update',
      params: id,
      body: z.object({
        outcome: z.enum(OUTCOME_CODES),
        note: z.string().trim().max(1000).nullish(),
        followUp: z.object({ dueAt: iso, title: z.string().trim().max(200).nullish() }).nullish(),
      }),
      successStatus: 200,
      response: z.object({
        viewing: ViewingSchema,
        followUp: z.object({ id: uuid, title: z.string(), dueDate: z.string().nullable() }).nullable(),
        suggestedStage: z.object({ stageId: uuid, name: z.string() }).nullable(),
      }),
      handler: async ({ params, body, actor }) => svc.complete(actor, params.id, body as Parameters<ViewingsService['complete']>[2]),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/ics',
      summary: 'Calendar file for a viewing',
      description: 'An iCalendar (.ics) file that Apple, Google and Outlook calendars open. It carries when, where, the property and the buyer’s name, never the buyer’s phone or e-mail.',
      tags: ['Viewings'],
      permission: 'viewings:read',
      params: id,
      responseContentType: 'text/calendar',
      handler: async ({ params, actor }) => {
        const f = await svc.ics(actor, params.id);
        return new RawReply(f.body, 'text/calendar; charset=utf-8', { 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store' });
      },
    }),
  ];
}
