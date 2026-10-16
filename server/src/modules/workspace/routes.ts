import { z } from 'zod';
import { defineRoute, Reply, ifMatchVersion, makeEtag, type RouteSpec } from '../../platform/http/route';
import { ROUTING_SOURCES } from '../leads/service';
import { ASSIGNMENT_MODES, type WorkspaceDto, type WorkspaceService } from './service';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1F6F5C');
const RoutingSchema = z.array(z.object({ source: z.enum(ROUTING_SOURCES), userIds: z.array(z.string().uuid()).min(1).max(20) })).max(9);

export const WorkspaceSchema = z.object({
  name: z.string(),
  slug: z.string(),
  timezone: z.string().describe('IANA time zone. Reminders, recurring tasks and report days use it'),
  currency: z.string(),
  defaultCountry: z.string().nullable().describe('Two-letter country used to read phone numbers typed without a country code'),
  leadAssignment: z.enum(ASSIGNMENT_MODES).describe('creator = the person who adds the lead; balanced = least-busy salesperson; unassigned'),
  firstResponseMinutes: z.number().int().describe('Minutes allowed before a new lead is flagged as waiting for a first reply'),
  routing: RoutingSchema.describe('Leads from a source go to the named people, least busy first. Overrides the assignment mode for that source'),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
  version: z.number().int(),
});
const etag = (w: WorkspaceDto) => makeEtag(w.version);

export function createWorkspaceRoutes(svc: WorkspaceService): RouteSpec[] {
  return [
    defineRoute({ method: 'get', path: '/', summary: 'Get workspace settings', tags: ['Workspace'], permission: 'tenant:read', response: WorkspaceSchema, handler: async ({ actor }) => { const w = await svc.get(actor); return new Reply(w, 200, undefined, etag(w)); } }),
    defineRoute({
      method: 'patch',
      path: '/',
      summary: 'Update workspace settings',
      description:
        'Changes only the fields you send; every other setting is preserved. Unknown fields are rejected. Send `If-Match` with the last `ETag` to refuse overwriting someone else’s change (412). The time zone is validated and applied to reminders and recurring tasks.',
      tags: ['Workspace'],
      permission: 'tenant:update',
      ifMatch: true,
      body: z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          timezone: z.string().trim().min(3).max(64).optional(),
          currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter currency code such as INR').optional(),
          defaultCountry: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Use a 2-letter country code such as IN').nullable().optional(),
          leadAssignment: z.enum(ASSIGNMENT_MODES).optional(),
          firstResponseMinutes: z.number().int().min(0).max(10_080).optional(),
          routing: RoutingSchema.optional(),
          primaryColor: hex.nullable().optional(),
          accentColor: hex.nullable().optional(),
        })
        .strict(),
      response: WorkspaceSchema,
      handler: async ({ body, req, actor }) => {
        const w = await svc.update(actor, body, ifMatchVersion(req.get('if-match')));
        return new Reply(w, 200, undefined, etag(w));
      },
    }),
  ];
}
