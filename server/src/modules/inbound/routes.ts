import { z } from 'zod';
import { defineRoute, created, noContent, paged, Reply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { PROVIDERS, SELECTABLE_SOURCES } from './providers';
import type { InboundService } from './service';

const uuid = z.string().uuid();
const id = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max);
const STATUSES = ['received', 'created', 'duplicate', 'needs_review', 'ignored', 'failed'] as const;

const ConfigSchema = z
  .object({
    source: z.enum(SELECTABLE_SOURCES as [string, ...string[]]).optional().describe('Lead source label for generic and website channels (Meta and Google are fixed)'),
    campaign: text(150).optional(),
    tags: z.array(text(40).min(1)).max(10).optional(),
    pipelineId: uuid.optional(),
    stageId: uuid.optional(),
    ownerId: uuid.nullable().optional().describe('Fixed owner for every lead from this source. Omit to use the workspace assignment mode.'),
    allowedOrigins: z.array(z.string().max(200).refine((o) => { try { const u = new URL(o); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o.replace(/\/$/, ''); } catch { return false; } }, 'Use a site origin such as https://www.example.com (no path)')).max(10).optional().describe('Website channel: only these sites may post (e.g. https://www.example.com)'),
    fieldMap: z.record(z.string().max(60), z.string().max(60)).refine((m) => Object.keys(m).length <= 30, 'At most 30 mappings').optional().describe('Generic channel: rename your fields to ours (e.g. {"mobile_no":"phone"})'),
  })
  .strict();

const EndpointSchema = z.object({
  id: uuid,
  provider: z.enum(PROVIDERS),
  name: z.string(),
  status: z.enum(['active', 'paused']),
  secretHint: z.string().nullable().describe('Last four characters of the stored secret'),
  hasAccessToken: z.boolean(),
  verifyToken: z.string().nullable().describe('Meta only: paste this as the “Verify token” when subscribing the webhook'),
  url: z.string().describe('Where the provider must POST'),
  config: ConfigSchema,
  lastReceivedAt: z.string().nullable(),
  receivedCount: z.number().int(),
  stats: z.record(z.enum(STATUSES), z.number().int()).describe('Deliveries in the last 7 days by outcome'),
  createdAt: z.string(),
});
const EventSchema = z.object({
  id: uuid, endpointId: uuid, endpointName: z.string(), provider: z.enum(PROVIDERS), status: z.enum(STATUSES), isTest: z.boolean(), leadId: uuid.nullable(),
  who: z.string().describe('Short, PII-light label for the person (name only)'), reason: z.string().nullable(), attempts: z.number().int(), receivedAt: z.string(), processedAt: z.string().nullable(),
});

export function createLeadSourceRoutes(svc: InboundService): RouteSpec[] {
  return [
    defineRoute({ method: 'get', path: '/', summary: 'List lead sources', description: 'Meta, Google, website and generic inbound sources with their last-7-day delivery counts.', tags: ['Lead sources'], permission: 'integrations:read', response: z.array(EndpointSchema), handler: async ({ actor }) => svc.list(actor) }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Add a lead source',
      description:
        'Creates a private receiving address. For `meta` send your Meta `appSecret` (used to verify Meta’s signature) and optionally the page access token. For `google` and `generic` a secret is generated and returned **once** in `secret`. ' +
        'Website sources need no secret; restrict them with `config.allowedOrigins`.',
      tags: ['Lead sources'],
      permission: 'integrations:manage',
      idempotent: true,
      body: z.object({ provider: z.enum(PROVIDERS), name: text(120).min(1), appSecret: z.string().trim().min(8).max(200).optional(), pageAccessToken: z.string().trim().min(20).max(2000).optional(), config: ConfigSchema.optional() }),
      response: z.object({ endpoint: EndpointSchema, secret: z.string().nullable().describe('Shown once; store it now') }),
      handler: async ({ body, actor }) => created(await svc.create(actor, body as any)),
    }),
    defineRoute({ method: 'get', path: '/events', summary: 'Delivery log', description: 'Every delivery received, newest first, with its outcome and a plain-language reason when it needs attention.', tags: ['Lead sources'], permission: 'integrations:manage', query: pageQuery.extend({ endpointId: uuid.optional(), status: z.enum(STATUSES).optional() }), response: EventSchema, paginated: true, handler: async ({ query, actor }) => { const r = await svc.events(actor, query); return paged(r.items, r.page); } }),
    defineRoute({ method: 'post', path: '/events/:id/retry', summary: 'Retry a delivery', description: 'Only for deliveries that need review or failed.', tags: ['Lead sources'], permission: 'integrations:manage', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.retry(actor, params.id); return noContent(); } }),
    defineRoute({ method: 'post', path: '/events/:id/ignore', summary: 'Ignore a delivery', tags: ['Lead sources'], permission: 'integrations:manage', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.ignore(actor, params.id); return noContent(); } }),
    defineRoute({ method: 'get', path: '/:id', summary: 'Get a lead source', tags: ['Lead sources'], permission: 'integrations:read', params: id, response: EndpointSchema, handler: async ({ params, actor }) => svc.get(actor, params.id) }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a lead source',
      description: 'Rename, pause/resume, change routing, replace the Meta app secret or page access token (send `pageAccessToken: null` to remove it). A paused source answers providers with 503 so they retry later.',
      tags: ['Lead sources'],
      permission: 'integrations:manage',
      params: id,
      body: z.object({ name: text(120).min(1).optional(), status: z.enum(['active', 'paused']).optional(), config: ConfigSchema.optional(), appSecret: z.string().trim().min(8).max(200).optional(), pageAccessToken: z.string().trim().min(20).max(2000).nullable().optional() }).strict(),
      response: EndpointSchema,
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body as any),
    }),
    defineRoute({ method: 'post', path: '/:id/rotate-secret', summary: 'Rotate the secret', description: 'Google and generic sources. The old secret stops working immediately; the new one is returned once.', tags: ['Lead sources'], permission: 'integrations:manage', params: id, response: z.object({ endpoint: EndpointSchema, secret: z.string() }), handler: async ({ params, actor }) => new Reply(await svc.rotateSecret(actor, params.id), 200) }),
    defineRoute({ method: 'post', path: '/:id/test', summary: 'Send a test lead', description: 'Pushes a synthetic delivery through the real pipeline. The lead is tagged “test”.', tags: ['Lead sources'], permission: 'integrations:manage', params: id, successStatus: 202, response: z.object({ eventId: uuid }), handler: async ({ params, actor }) => new Reply(await svc.sendTest(actor, params.id), 202) }),
    defineRoute({ method: 'delete', path: '/:id', summary: 'Delete a lead source', description: 'Its address stops accepting deliveries at once. The delivery history stays.', tags: ['Lead sources'], permission: 'integrations:delete', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.remove(actor, params.id); return noContent(); } }),
  ];
}
