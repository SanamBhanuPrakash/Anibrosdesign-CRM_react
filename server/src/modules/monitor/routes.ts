import { z } from 'zod';
import { defineRoute, paged, RawReply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import type { MonitorService } from './service';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const checkStatus = z.enum(['ok', 'warn', 'fail']);

const OverviewSchema = z.object({
  generatedAt: z.string(),
  status: z.enum(['healthy', 'attention', 'problem']),
  summary: z.string(),
  checks: z.array(z.object({ id: z.enum(['database', 'worker', 'queue', 'intake', 'errors']), label: z.string(), status: checkStatus, detail: z.string() })),
  queue: z.object({ queued: z.number().int(), running: z.number().int(), deadLast7d: z.number().int(), oldestWaitingSeconds: z.number().int() }),
  intake: z.object({
    activeSources: z.number().int(), pausedSources: z.number().int(), deliveries24h: z.record(z.string(), z.number().int()),
    quietSources: z.array(z.object({ id: uuid, name: z.string(), lastReceivedAt: z.string() })),
  }),
  leads: z.object({ created24h: z.number().int(), created7d: z.number().int(), bySource7d: z.array(z.object({ source: z.string(), n: z.number().int() })), firstReplyOverdue: z.number().int(), tasksOverdue: z.number().int() }).nullable()
    .describe('Counts only. null for roles that cannot see leads'),
  events: z.object({ errors24h: z.number().int(), security24h: z.number().int(), warnings24h: z.number().int() }),
  audit: z.object({ actions24h: z.number().int() }),
  recent: z.array(z.object({ id: uuid, at: z.string(), severity: z.string(), component: z.string(), message: z.string() })),
});
const EventSchema = z.object({ id: uuid, at: z.string(), severity: z.enum(['info', 'warn', 'error', 'fatal']), component: z.string(), message: z.string(), requestId: z.string().nullable(), userName: z.string().nullable(), context: z.record(z.string(), z.unknown()) });
const AuditSchema = z.object({ id: uuid, at: z.string(), action: z.string(), entityType: z.string(), entityId: uuid, actorId: uuid.nullable(), actorName: z.string().nullable(), ip: z.string().nullable(), requestId: z.string().nullable() });
const auditFilters = z.object({
  action: z.string().trim().min(1).max(80).optional().describe('Exact action (lead.create) or a family (lead)'),
  entityType: z.string().trim().min(1).max(60).optional(),
  actorId: uuid.optional(),
  entityId: uuid.optional(),
  from: iso.optional(),
  to: iso.optional(),
});

export function createMonitorRoutes(svc: MonitorService): RouteSpec[] {
  return [
    defineRoute({ method: 'get', path: '/overview', summary: 'Workspace health snapshot', description: 'Is everything running, what is waiting, what needs attention. Computed live from this workspace’s own data plus the worker heartbeat. Lead counts are omitted for roles that cannot see leads.', tags: ['Monitor'], permission: 'operations:read', response: OverviewSchema, handler: async ({ actor }) => svc.overview(actor) }),
    defineRoute({
      method: 'get',
      path: '/events',
      summary: 'Activity log',
      description: 'Notable events for this workspace: server errors, permission denials, rate limits, slow requests, failed background jobs and rejected lead deliveries. Kept for 30 days. Quote `requestId` to support to trace one request end to end.',
      tags: ['Monitor'],
      permission: 'operations:read',
      query: pageQuery.extend({ severity: z.enum(['info', 'warn', 'error']).optional().describe('Minimum severity'), component: z.string().max(40).optional(), q: z.string().trim().max(100).optional(), from: iso.optional(), to: iso.optional() }),
      response: EventSchema,
      paginated: true,
      handler: async ({ query, actor }) => { const r = await svc.events(actor, query); return paged(r.items, r.page); },
    }),
    defineRoute({
      method: 'get',
      path: '/audit',
      summary: 'Audit trail',
      description: 'Who did what, and when, newest first. Append-only: the application cannot edit or delete entries.',
      tags: ['Monitor'],
      permission: 'audit:read',
      query: pageQuery.merge(auditFilters),
      response: AuditSchema,
      paginated: true,
      handler: async ({ query, actor }) => { const r = await svc.audit(actor, query); return paged(r.items, r.page); },
    }),
    defineRoute({ method: 'get', path: '/audit/facets', summary: 'Audit filter choices', description: 'Actions, record types and people that appear in the last 90 days.', tags: ['Monitor'], permission: 'audit:read', response: z.object({ actions: z.array(z.string()), entityTypes: z.array(z.string()), people: z.array(z.object({ id: uuid, name: z.string() })) }), handler: async ({ actor }) => svc.auditFacets(actor) }),
    defineRoute({
      method: 'get',
      path: '/audit/export',
      summary: 'Export the audit trail as CSV',
      description: 'Same filters as the list, up to 10,000 rows. The export itself is recorded in the trail.',
      tags: ['Monitor'],
      permission: 'audit:read',
      query: auditFilters,
      responseContentType: 'text/csv',
      handler: async ({ query, actor }) => {
        const { csv, rows } = await svc.auditCsv(actor, query);
        return new RawReply(csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`, 'X-Row-Count': String(rows), 'Cache-Control': 'no-store' });
      },
    }),
    defineRoute({ method: 'get', path: '/audit/:id', summary: 'One audit entry with before and after', description: 'Sensitive values are redacted.', tags: ['Monitor'], permission: 'audit:read', params: z.object({ id: uuid }), response: AuditSchema.extend({ before: z.unknown().nullable(), after: z.unknown().nullable() }), handler: async ({ params, actor }) => svc.auditDetail(actor, params.id) }),
  ];
}
