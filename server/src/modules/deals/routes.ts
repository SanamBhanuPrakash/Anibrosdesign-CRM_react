import { z } from 'zod';
import { defineRoute, created, noContent, paged, Reply, ifMatchVersion, makeEtag, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { Errors } from '../../platform/errors';
import { CHOOSABLE_CLOSE_CODES, CLOSE_REASONS, INTEREST_SOURCES, INTEREST_STATUSES, RESERVATION_STATUSES, type ReservationStatus } from './catalog';
import type { DealsService, ReservationDto } from './service';
import type { ShortlistService } from './shortlist';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-14');
const money = z.number().min(0).max(1e13);
const idParam = z.object({ id: uuid });
const etag = (r: ReservationDto) => makeEtag(r.version);

const ReservationSchema = z.object({
  id: uuid,
  leadId: uuid,
  propertyId: uuid,
  status: z.enum(RESERVATION_STATUSES).describe('offered → reserved → completed (the sale), or closed. Only completed deals count as won deal value.'),
  offerPrice: z.number().nullable(),
  agreedPrice: z.number().nullable(),
  tokenAmount: z.number().nullable(),
  dealValue: z.number().nullable().describe('The recorded final value of a completed sale'),
  currency: z.string(),
  holdUntil: z.string().nullable(),
  holdOverdue: z.boolean().describe('The hold date has passed and the unit is still held. Nothing is released automatically.'),
  note: z.string().nullable(),
  closedReason: z.object({ code: z.string(), label: z.string() }).nullable(),
  closedNote: z.string().nullable(),
  offeredAt: z.string(),
  reservedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  lead: z.object({ id: uuid, name: z.string(), ownerId: uuid.nullable(), ownerName: z.string().nullable() }),
  property: z.object({ id: uuid, title: z.string(), status: z.string(), price: z.number(), listingType: z.string() }),
  allowed: z.array(z.enum(['reserve', 'complete', 'close', 'edit', 'reverse'])).describe('What the caller can do with it now'),
});
const ResultSchema = z.object({
  reservation: ReservationSchema,
  leadStage: z.object({ moved: z.boolean(), stageName: z.string().nullable(), note: z.string().nullable() }).describe('What happened to the lead’s stage as a consequence'),
});

const InterestSchema = z.object({
  id: uuid,
  leadId: uuid,
  propertyId: uuid,
  status: z.enum(INTEREST_STATUSES),
  source: z.enum(INTEREST_SOURCES),
  matchScore: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  property: z.object({ id: uuid, title: z.string(), status: z.string(), price: z.number(), currency: z.string(), location: z.string().nullable(), bedrooms: z.number().int().nullable(), propertyType: z.string(), archived: z.boolean() }),
  deal: z.object({ id: uuid, status: z.enum(['offered', 'reserved']) }).nullable().describe('The buyer’s open offer or reservation on this property'),
});

const HolderSchema = z.object({
  propertyId: uuid,
  status: z.string(),
  openOffers: z.number().int().describe('Buyers with an offer open on this unit'),
  holder: z
    .object({
      reservationId: uuid.nullable(),
      leadId: uuid.nullable(),
      buyer: z.string().nullable().describe('Null when the caller may not see that buyer'),
      agent: z.string().nullable(),
      reservedAt: z.string().nullable(),
      holdUntil: z.string().nullable(),
      holdOverdue: z.boolean(),
      tokenAmount: z.number().nullable(),
      agreedPrice: z.number().nullable(),
      currency: z.string(),
      visible: z.boolean(),
    })
    .nullable(),
});

export function createReservationRoutes(svc: DealsService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List offers, reservations and sales',
      description: 'Newest first. Sales agents see the deals of their own buyers; managers, admins, owners and read-only roles see all. Filter by buyer, unit or status (comma-separated, e.g. `offered,reserved` for everything still open).',
      tags: ['Deals'],
      permission: 'reservations:read',
      query: pageQuery.extend({ leadId: uuid.optional(), propertyId: uuid.optional(), status: z.string().max(80).optional(), completedFrom: day.optional().describe('Only sales recorded on or after this day (workspace time zone)'), completedTo: day.optional().describe('Only sales recorded on or before this day'), test: z.enum(['exclude']).optional().describe('Leave out deals of leads tagged test') }),
      response: ReservationSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const status = query.status ? query.status.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        if (status?.some((s) => !(RESERVATION_STATUSES as readonly string[]).includes(s))) throw Errors.validation([{ path: 'query.status', message: `Use any of: ${RESERVATION_STATUSES.join(', ')}` }]);
        const r = await svc.list(actor, { leadId: query.leadId, propertyId: query.propertyId, status: status as ReservationStatus[] | undefined, completedFrom: query.completedFrom, completedTo: query.completedTo, test: query.test, limit: query.limit, cursor: query.cursor });
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/close-reasons',
      summary: 'Why an offer or reservation can end',
      tags: ['Deals'],
      permission: 'reservations:read',
      response: z.array(z.object({ code: z.string(), label: z.string() })),
      handler: async () => CLOSE_REASONS.map((r) => ({ code: r.code, label: r.label })),
    }),
    defineRoute({
      method: 'get',
      path: '/by-property/:propertyId',
      summary: 'Who holds this unit?',
      description: 'The unit page’s answer: whether it is reserved, which agent holds it and how many offers are open. The buyer’s name and the amounts are included only when the caller may see that buyer.',
      tags: ['Deals'],
      permission: 'properties:read',
      params: z.object({ propertyId: uuid }),
      response: HolderSchema,
      handler: async ({ params, actor }) => svc.holder(actor, params.propertyId),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Record an offer',
      description:
        'A buyer makes an offer on a unit. The unit becomes under offer and the lead moves forward to the negotiation step if the pipeline has one (never backwards). Several buyers may have offers on one unit. Refused: the unit is reserved (409) or sold, rented, inactive or archived (422); the buyer already has an open deal on it (409); the lead is closed (422).',
      tags: ['Deals'],
      permission: 'reservations:create',
      idempotent: true,
      body: z.object({ leadId: uuid, propertyId: uuid, offerPrice: money.nullish(), holdUntil: iso.nullish(), note: z.string().trim().max(1000).nullish() }),
      response: ResultSchema,
      handler: async ({ body, actor }) => {
        const r = await svc.offer(actor, body);
        return created(r, etag(r.reservation));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'One offer, reservation or sale',
      tags: ['Deals'],
      permission: 'reservations:read',
      params: idParam,
      response: ReservationSchema,
      handler: async ({ params, actor }) => {
        const r = await svc.get(actor, params.id);
        return new Reply(r, 200, undefined, etag(r));
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Edit an open offer or reservation',
      description: 'Offer price, agreed price (reservations only), hold date and note. Send `If-Match` with the last `ETag` to refuse overwriting a colleague’s change (412).',
      tags: ['Deals'],
      permission: 'reservations:update',
      params: idParam,
      ifMatch: true,
      body: z.object({ offerPrice: money.nullable().optional(), agreedPrice: money.nullable().optional(), holdUntil: iso.nullable().optional(), note: z.string().trim().max(1000).nullable().optional() }).strict(),
      response: ReservationSchema,
      handler: async ({ params, body, actor, req }) => {
        const r = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(r, 200, undefined, etag(r));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/reserve',
      summary: 'Reserve the unit for this buyer',
      description:
        'Token received. The unit becomes reserved for this buyer and nobody else can reserve it: of two simultaneous attempts exactly one succeeds and the other gets 409 `already_reserved` (a database guarantee, not only a check). The lead moves forward to the booking step if the pipeline has one. Booking is a milestone, not a sale: it does not count as won deal value.',
      tags: ['Deals'],
      permission: 'reservations:update',
      params: idParam,
      ifMatch: true,
      body: z.object({ tokenAmount: money, agreedPrice: z.number().positive().max(1e13), holdUntil: iso.nullish(), note: z.string().trim().max(1000).nullish() }),
      successStatus: 200,
      response: ResultSchema,
      handler: async ({ params, body, actor, req }) => {
        const r = await svc.reserve(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(r, 200, undefined, etag(r.reservation));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/complete',
      summary: 'Record the sale',
      description:
        'Records the final deal value, marks the unit sold (sale) or rented (rent, lease), closes other buyers’ open offers on it and moves the lead to Won, in one transaction. This is the only way a deal becomes won deal value. If the pipeline does not allow the lead to go to Won from where it is, nothing changes (409).',
      tags: ['Deals'],
      permission: 'reservations:update',
      params: idParam,
      ifMatch: true,
      body: z.object({ dealValue: z.number().positive().max(1e13) }),
      successStatus: 200,
      response: ResultSchema,
      handler: async ({ params, body, actor, req }) => {
        const r = await svc.complete(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(r, 200, undefined, etag(r.reservation));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/close',
      summary: 'End an offer or reservation without a sale',
      description: 'Frees the unit (it returns to available, or stays under offer while other buyers have offers open). The lead is not moved: the person decides whether the buyer is lost. A recorded sale cannot be closed here (409); reopen the lead to reverse it.',
      tags: ['Deals'],
      permission: 'reservations:update',
      params: idParam,
      ifMatch: true,
      body: z.object({ reason: z.enum(CHOOSABLE_CLOSE_CODES), note: z.string().trim().max(500).nullish() }),
      successStatus: 200,
      response: ResultSchema,
      handler: async ({ params, body, actor, req }) => {
        const r = await svc.close(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(r, 200, undefined, etag(r.reservation));
      },
    }),
  ];
}

export function createShortlistRoutes(svc: ShortlistService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'A buyer’s shortlist',
      description: 'The properties a lead is considering, newest first, each with the buyer’s open offer or reservation on it if there is one.',
      tags: ['Shortlist'],
      permission: 'leads:read',
      query: z.object({ leadId: uuid }),
      response: z.array(InterestSchema),
      handler: async ({ query, actor }) => svc.list(actor, query.leadId),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Add a property to a buyer’s shortlist',
      description: 'Records interest only; it never reserves or changes the property. Adding the same property again returns the existing entry (200) and puts a rejected one back on the shortlist. `source: matching` records that it came from the Matching screen.',
      tags: ['Shortlist'],
      permission: 'leads:update',
      body: z.object({ leadId: uuid, propertyId: uuid, source: z.enum(INTEREST_SOURCES).default('manual'), matchScore: z.number().int().min(0).max(100).nullish(), note: z.string().trim().max(500).nullish() }),
      response: InterestSchema,
      handler: async ({ body, actor }) => {
        const r = await svc.add(actor, body);
        return r.created ? created(r.item) : new Reply(r.item, 200);
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Change the status or note of a shortlist entry',
      tags: ['Shortlist'],
      permission: 'leads:update',
      params: idParam,
      body: z.object({ status: z.enum(INTEREST_STATUSES).optional(), note: z.string().trim().max(500).nullable().optional() }).strict(),
      response: InterestSchema,
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Remove a property from a buyer’s shortlist',
      description: 'Refused (409) while the buyer has an open offer or reservation on that property.',
      tags: ['Shortlist'],
      permission: 'leads:update',
      params: idParam,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
  ];
}
