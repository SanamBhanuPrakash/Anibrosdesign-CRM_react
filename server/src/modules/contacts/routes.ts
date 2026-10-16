import { z } from 'zod';
import { ifMatchVersion, makeEtag, defineRoute, created, noContent, paged, Reply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { Errors } from '../../platform/errors';
import type { ContactsService, ContactDto } from './service';

const id = z.object({ id: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);

export const ContactSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  displayName: z.string(),
  email: z.string().nullable().describe('Primary e-mail, lower-cased'),
  phone: z.string().nullable().describe('Primary phone in E.164 (+919876543210)'),
  alternateEmails: z.array(z.string()),
  alternatePhones: z.array(z.string()),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  city: z.string().nullable(),
  ownerId: z.string().uuid().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.string(), z.unknown()),
  leadCount: z.number().int(),
  version: z.number().int().describe('Increments on every change; also exposed as the ETag'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const customFields = z
  .record(z.string().max(64), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 12_000, { message: 'Custom fields are too large (12 kB maximum)' });

const contactBody = z.object({
  firstName: text(100).min(1, 'First name is required'),
  lastName: text(100).nullish(),
  email: text(254).nullish().describe('Validated and lower-cased. A workspace never holds two live contacts with the same e-mail.'),
  phone: text(40).nullish().describe('Any common format; stored as E.164. Numbers without a country code use the workspace default country (IN).'),
  alternateEmails: z.array(text(254)).max(5).optional(),
  alternatePhones: z.array(text(40)).max(5).optional(),
  company: text(150).nullish(),
  jobTitle: text(100).nullish(),
  city: text(100).nullish(),
  ownerId: z.string().uuid().nullish().describe('Defaults to you. Only managers can assign someone else.'),
  tags: z.array(text(40)).max(30).optional(),
  customFields: customFields.optional(),
});

const listQuery = pageQuery.extend({
  q: text(100).optional().describe('Matches name, company, e-mail or phone (digits are matched against E.164 numbers)'),
  ownerId: z.string().uuid().optional(),
  tag: text(40).optional(),
  sort: z.enum(['created', 'updated', 'name']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const consentBody = z.object({
  channel: z.enum(['email', 'sms', 'whatsapp', 'push', 'phone_call']),
  action: z.enum(['grant', 'revoke']),
  source: text(40).default('manual').describe('manual · form · api · import'),
  legalBasis: z.enum(['consent', 'legitimate_interest', 'contract']).optional(),
  proofUrl: z.string().url().max(500).nullish(),
  reason: text(300).nullish(),
  expiresAt: z.string().datetime().nullish(),
});

/** `If-Match: "3"` (or `W/"3"`) → 3. Anything else is a client error rather than silently ignored. */
const etag = (c: ContactDto) => makeEtag(c.version, c.leadCount);

export function createContactRoutes(svc: ContactsService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List contacts',
      description: 'Newest first by default. Archived (deleted) and merged-away contacts are not listed.',
      tags: ['Contacts'],
      permission: 'contacts:read',
      query: listQuery,
      response: ContactSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.list(actor, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/lookup',
      summary: 'Find contacts that already use an e-mail or phone number',
      description: 'Use before creating a contact (or from an integration) to upsert instead of duplicating. Inputs are normalised exactly as on create.',
      tags: ['Contacts'],
      permission: 'contacts:read',
      query: z.object({ email: text(254).optional(), phone: text(40).optional() }),
      response: z.array(z.object({ id: z.string().uuid(), displayName: z.string(), matchedOn: z.array(z.enum(['email', 'phone'])) })),
      handler: async ({ query, actor }) => svc.lookup(actor, query),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create a contact',
      description: 'Returns 409 with `duplicates` when the e-mail or phone number already belongs to a live contact (race-safe: enforced by a database constraint).',
      tags: ['Contacts'],
      permission: 'contacts:create',
      idempotent: true,
      body: contactBody,
      response: ContactSchema,
      handler: async ({ body, actor }) => {
        const c = await svc.create(actor, body);
        return created(c, etag(c));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'Get a contact',
      tags: ['Contacts'],
      permission: 'contacts:read',
      params: id,
      response: ContactSchema,
      handler: async ({ params, actor }) => {
        const c = await svc.get(actor, params.id);
        return new Reply(c, 200, undefined, etag(c));
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a contact',
      description: 'Only the fields you send change. Send `If-Match` with the last ETag to avoid overwriting a colleague’s edit (412 if it changed). Sending `null` clears an optional field.',
      tags: ['Contacts'],
      permission: 'contacts:update',
      params: id,
      body: contactBody.partial(),
      response: ContactSchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => {
        const c = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(c, 200, undefined, etag(c));
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Archive a contact',
      description: 'Soft delete: the contact disappears from lists and frees its e-mail/phone for reuse; it can be restored.',
      tags: ['Contacts'],
      permission: 'contacts:delete',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived contact',
      description: 'Fails with 409 if one of its e-mail/phone values has since been used by another contact.',
      tags: ['Contacts'],
      permission: 'contacts:delete',
      params: id,
      successStatus: 200,
      response: ContactSchema,
      handler: async ({ params, actor }) => svc.restore(actor, params.id),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/merge',
      summary: 'Merge duplicate contacts into this one',
      description:
        'This contact survives. Its blank fields are filled from the duplicates, tags are combined, and the duplicates’ e-mails, phones, leads and consent records move here. The duplicates are archived. Reversible for 30 days with the returned merge ids.',
      tags: ['Contacts'],
      permission: 'contacts:merge',
      params: id,
      body: z.object({ duplicateIds: z.array(z.string().uuid()).min(1).max(5) }),
      successStatus: 200,
      response: z.object({ contact: ContactSchema, merges: z.array(z.object({ id: z.string().uuid(), mergedId: z.string().uuid() })) }),
      handler: async ({ params, body, actor }) => svc.merge(actor, params.id, body.duplicateIds),
    }),
    defineRoute({
      method: 'post',
      path: '/merges/:id/undo',
      summary: 'Undo a merge',
      description: 'Restores the archived contact with the identifiers, leads and consents it brought. Fields filled into the survivor stay.',
      tags: ['Contacts'],
      permission: 'contacts:merge',
      params: id,
      successStatus: 200,
      response: z.object({ survivor: ContactSchema, restored: ContactSchema }),
      handler: async ({ params, actor }) => svc.undoMerge(actor, params.id),
    }),
    defineRoute({
      method: 'get',
      path: '/:id/consents',
      summary: 'Communication consent for a contact',
      description: 'Current state per channel plus the full history.',
      tags: ['Contacts'],
      permission: 'contacts:read',
      params: id,
      handler: async ({ params, actor }) => svc.consents(actor, params.id),
    }),
    defineRoute({
      method: 'post',
      path: '/:id/consents',
      summary: 'Record consent being granted or revoked',
      tags: ['Contacts'],
      permission: 'contacts:update',
      params: id,
      body: consentBody,
      successStatus: 200,
      handler: async ({ params, body, actor }) => svc.recordConsent(actor, params.id, body),
    }),
  ];
}
