import { z } from 'zod';
import { defineRoute, created, noContent, paged, Reply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { OUTBOUND_EVENTS, OUTBOUND_EVENT_KEYS } from './catalog';
import type { OutboundService } from './service';

const uuid = z.string().uuid();
const id = z.object({ id: uuid });
const STATUSES = ['pending', 'delivered', 'failed', 'dead', 'skipped'] as const;
const events = z.array(z.enum(OUTBOUND_EVENT_KEYS)).min(1).max(20);

const WebhookSchema = z.object({
  id: uuid,
  name: z.string(),
  url: z.string(),
  events: z.array(z.enum(OUTBOUND_EVENT_KEYS)),
  status: z.enum(['active', 'paused', 'disabled']),
  disabledReason: z.string().nullable(),
  secretHint: z.string().nullable().describe('Last four characters of the signing secret'),
  lastDeliveryAt: z.string().nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  stats: z.object({ delivered: z.number().int(), failed: z.number().int(), pending: z.number().int() }).describe('Messages in the last 7 days'),
  createdAt: z.string(),
});
const DeliverySchema = z.object({
  id: uuid, endpointId: uuid, endpointName: z.string(), event: z.string(), isTest: z.boolean(), status: z.enum(STATUSES), attempts: z.number().int(),
  responseStatus: z.number().int().nullable(), responseMs: z.number().int().nullable(), error: z.string().nullable(), createdAt: z.string(), deliveredAt: z.string().nullable(),
});

export function createWebhookRoutes(svc: OutboundService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/events',
      summary: 'Events a webhook can listen to',
      tags: ['Webhooks'],
      permission: 'integrations:read',
      response: z.array(z.object({ event: z.string(), description: z.string() })),
      handler: async () => OUTBOUND_EVENT_KEYS.map((event) => ({ event, description: OUTBOUND_EVENTS[event] })),
    }),
    defineRoute({ method: 'get', path: '/', summary: 'List webhooks', description: 'Outgoing webhooks of this workspace with their last-7-day delivery counts.', tags: ['Webhooks'], permission: 'integrations:read', response: z.array(WebhookSchema), handler: async ({ actor }) => svc.list(actor) }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Add a webhook',
      description:
        'Gives the CRM an address to send signed JSON messages to. The address must be public (https in production); private and internal addresses are refused. The signing secret is returned **once** in `secret`. ' +
        'Every message carries `X-Anibros-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, `X-Anibros-Event` and `X-Anibros-Delivery` (the same on retries: use it to ignore duplicates).',
      tags: ['Webhooks'],
      permission: 'integrations:manage',
      idempotent: true,
      body: z.object({ name: z.string().trim().min(1).max(100), url: z.string().trim().min(8).max(2000), events }),
      response: z.object({ webhook: WebhookSchema, secret: z.string().describe('Shown once; store it now') }),
      handler: async ({ body, actor }) => created(await svc.create(actor, body)),
    }),
    defineRoute({ method: 'get', path: '/deliveries', summary: 'Delivery log', description: 'Every message sent (and every failed attempt’s outcome), newest first.', tags: ['Webhooks'], permission: 'integrations:manage', query: pageQuery.extend({ endpointId: uuid.optional(), status: z.enum(STATUSES).optional() }), response: DeliverySchema, paginated: true, handler: async ({ query, actor }) => { const r = await svc.deliveries(actor, query); return paged(r.items, r.page); } }),
    defineRoute({ method: 'post', path: '/deliveries/:id/retry', summary: 'Send a failed message again', tags: ['Webhooks'], permission: 'integrations:manage', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.retry(actor, params.id); return noContent(); } }),
    defineRoute({ method: 'get', path: '/:id', summary: 'Get a webhook', tags: ['Webhooks'], permission: 'integrations:read', params: id, response: WebhookSchema, handler: async ({ params, actor }) => svc.get(actor, params.id) }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a webhook',
      description: 'Rename, change the address or the events, pause or resume. Turning a switched-off webhook back on clears its failure count.',
      tags: ['Webhooks'],
      permission: 'integrations:manage',
      params: id,
      body: z.object({ name: z.string().trim().min(1).max(100).optional(), url: z.string().trim().min(8).max(2000).optional(), events: events.optional(), status: z.enum(['active', 'paused']).optional() }).strict(),
      response: WebhookSchema,
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body),
    }),
    defineRoute({ method: 'post', path: '/:id/rotate-secret', summary: 'Rotate the signing secret', description: 'The old secret stops working at once; the new one is returned once.', tags: ['Webhooks'], permission: 'integrations:manage', params: id, response: z.object({ webhook: WebhookSchema, secret: z.string() }), handler: async ({ params, actor }) => new Reply(await svc.rotateSecret(actor, params.id), 200) }),
    defineRoute({ method: 'post', path: '/:id/test', summary: 'Send a test message', description: 'Sends a “ping” right now and returns what the receiver answered.', tags: ['Webhooks'], permission: 'integrations:manage', params: id, successStatus: 200, response: z.object({ ok: z.boolean(), status: z.number().int().nullable(), ms: z.number().int().nullable(), error: z.string().nullable() }), handler: async ({ params, actor }) => svc.sendTest(actor, params.id) }),
    defineRoute({ method: 'delete', path: '/:id', summary: 'Delete a webhook', description: 'Stops sending at once. The delivery history stays for a while.', tags: ['Webhooks'], permission: 'integrations:delete', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.remove(actor, params.id); return noContent(); } }),
  ];
}
