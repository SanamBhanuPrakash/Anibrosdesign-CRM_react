import { z } from 'zod';
import { defineRoute, noContent, Reply, type RouteSpec } from '../../platform/http/route';
import type { MessagingService } from './service';

const uuid = z.string().uuid();
const AccountSchema = z.object({
  connected: z.boolean(),
  phoneNumberId: z.string().nullable(),
  displayPhone: z.string().nullable(),
  tokenHint: z.string().nullable().describe('Last four characters of the access token; the token itself is never returned'),
  status: z.enum(['active', 'paused']).nullable(),
  lastError: z.string().nullable(),
  lastSentAt: z.string().nullable(),
});

export function createMessagingRoutes(svc: MessagingService): RouteSpec[] {
  return [
    defineRoute({
      method: 'post',
      path: '/send',
      summary: 'Send an e-mail or WhatsApp message to a lead',
      description:
        'Logs the message on the lead’s timeline and queues the delivery. The address or number is always the lead’s own contact detail. ' +
        'E-mail goes out under the client’s name with the sender as reply-to. WhatsApp needs the client’s WhatsApp Business number to be connected; use `template` to start a conversation outside WhatsApp’s 24-hour window. ' +
        'Needs permission to log that kind of work for this client (a WhatsApp-only specialist cannot send e-mail).',
      tags: ['Messaging'],
      permission: 'activities:create',
      idempotent: true,
      body: z.object({
        leadId: uuid,
        channel: z.enum(['email', 'whatsapp']),
        subject: z.string().trim().max(200).optional(),
        body: z.string().max(4000).default(''),
        template: z.object({ name: z.string().trim().min(1).max(100), language: z.string().trim().min(2).max(10), params: z.array(z.string().max(300)).max(10).optional() }).optional(),
      }),
      successStatus: 202,
      response: z.object({ activityId: uuid, delivery: z.literal('queued') }),
      handler: async ({ body, actor }) => new Reply(await svc.send(actor, body.leadId, { channel: body.channel, subject: body.subject, body: body.body, template: body.template }), 202),
    }),
    defineRoute({ method: 'get', path: '/whatsapp', summary: 'This client’s WhatsApp number', tags: ['Messaging'], permission: 'integrations:read', response: AccountSchema, handler: async ({ actor }) => svc.whatsapp(actor) }),
    defineRoute({
      method: 'put',
      path: '/whatsapp',
      summary: 'Connect this client’s WhatsApp Business number',
      description: 'Send the WhatsApp Business phone number id and a permanent access token from Meta’s WhatsApp setup. Both are checked with Meta before they are saved. The token is stored encrypted and never returned.',
      tags: ['Messaging'],
      permission: 'integrations:manage',
      body: z.object({ phoneNumberId: z.string().trim().min(5).max(40).regex(/^\d+$/, 'The phone number id is digits only'), accessToken: z.string().trim().min(20).max(1000) }),
      response: AccountSchema,
      handler: async ({ body, actor }) => svc.connectWhatsapp(actor, body),
    }),
    defineRoute({ method: 'delete', path: '/whatsapp', summary: 'Disconnect WhatsApp', tags: ['Messaging'], permission: 'integrations:delete', successStatus: 204, handler: async ({ actor }) => { await svc.disconnectWhatsapp(actor); return noContent(); } }),
  ];
}
