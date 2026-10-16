import { z } from 'zod';
import { ifMatchVersion, makeEtag, defineRoute, created, noContent, paged, Reply, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { Errors } from '../../platform/errors';
import { TASK_KINDS, TASK_PRIORITIES, type TaskDto, type TasksService } from './service';
import type { NotificationsService } from './notifications';

const uuid = z.string().uuid();
const id = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max);

export const TaskSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string().nullable(),
  kind: z.enum(TASK_KINDS),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  dueDate: z.string().nullable(),
  remindBeforeMinutes: z.number().int().nullable(),
  recurrence: z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int() }).nullable(),
  assignedTo: uuid.nullable(),
  assigneeName: z.string().nullable(),
  createdBy: uuid.nullable(),
  leadId: uuid.nullable(),
  leadName: z.string().nullable(),
  contactId: uuid.nullable(),
  contactName: z.string().nullable(),
  completedAt: z.string().nullable(),
  isOverdue: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const recurrence = z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(30) });
const fields = {
  title: text(200).min(1, 'Give the task a title'),
  description: text(4000).nullish(),
  kind: z.enum(TASK_KINDS).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: z.string().datetime({ offset: true }).nullish().describe('ISO timestamp with offset'),
  remindBeforeMinutes: z.number().int().min(0).max(43_200).nullish().describe('Minutes before the due date to notify the assignee (needs a due date)'),
  recurrence: recurrence.nullish().describe('Repeats when completed: the next occurrence is created for the next slot in the future, in the workspace time zone'),
  assignedTo: uuid.nullish().describe('Defaults to you. Only managers can assign someone else.'),
  leadId: uuid.nullish(),
  contactId: uuid.nullish(),
};

const listQuery = pageQuery.extend({
  q: text(100).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.literal('any'), uuid]).optional(),
  status: z.enum(['open', 'done', 'all']).default('open'),
  priority: z.enum(TASK_PRIORITIES).optional(),
  kind: z.enum(TASK_KINDS).optional(),
  leadId: uuid.optional(),
  contactId: uuid.optional(),
  due: z.enum(['overdue', 'today', 'week', 'none']).optional(),
  dueFrom: z.string().datetime({ offset: true }).optional().describe('Only tasks due at or after this time (calendar views)'),
  dueTo: z.string().datetime({ offset: true }).optional().describe('Only tasks due before this time'),
  sort: z.enum(['due', 'created', 'priority']).default('due'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

const etag = (t: TaskDto) => makeEtag(t.version, t.isOverdue);

export function createTaskRoutes(svc: TasksService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List tasks',
      description: 'Sales agents see tasks assigned to them or created by them; managers see the workspace. Soonest due first by default; undated tasks come last.',
      tags: ['Tasks'],
      permission: 'tasks:read',
      query: listQuery,
      response: TaskSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.list(actor, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/summary',
      summary: 'Task counters (my day, and the team for managers)',
      description: '“Today” and “upcoming” use the workspace time zone.',
      tags: ['Tasks'],
      permission: 'tasks:read',
      handler: async ({ actor }) => svc.summary(actor),
    }),
    defineRoute({
      method: 'post',
      path: '/bulk',
      summary: 'Complete, cancel or reassign many tasks',
      description: 'Up to 100 tasks. Each is handled on its own; ones you cannot change are returned in `skipped` with the reason.',
      tags: ['Tasks'],
      permission: 'tasks:update',
      body: z.object({ ids: z.array(uuid).min(1).max(100), action: z.enum(['complete', 'cancel', 'reassign']), assignedTo: uuid.nullish() }),
      successStatus: 200,
      handler: async ({ body, actor }) => svc.bulk(actor, body),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create a task',
      tags: ['Tasks'],
      permission: 'tasks:create',
      idempotent: true,
      body: z.object(fields),
      response: TaskSchema,
      handler: async ({ body, actor }) => {
        const t = await svc.create(actor, body);
        return created(t, etag(t));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'Get a task',
      tags: ['Tasks'],
      permission: 'tasks:read',
      params: id,
      response: TaskSchema,
      handler: async ({ params, actor }) => {
        const t = await svc.get(actor, params.id);
        return new Reply(t, 200, undefined, etag(t));
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update an open task',
      description: 'Changing the due date or reminder re-arms the reminder. Send `If-Match` to avoid overwriting a colleague’s edit.',
      tags: ['Tasks'],
      permission: 'tasks:update',
      params: id,
      body: z.object({ ...fields, title: fields.title.optional(), status: z.enum(['pending', 'in_progress']).optional() }),
      response: TaskSchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => {
        const t = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match')));
        return new Reply(t, 200, undefined, etag(t));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/complete',
      summary: 'Mark a task done',
      description: 'A recurring task creates its next occurrence (returned as `next`). Completing logs an entry on the linked lead’s timeline.',
      tags: ['Tasks'],
      permission: 'tasks:update',
      params: id,
      successStatus: 200,
      ifMatch: true,
      handler: async ({ params, actor, req }) => svc.complete(actor, params.id, ifMatchVersion(req.get('if-match'))),
    }),
    defineRoute({ method: 'post', path: '/:id/reopen', summary: 'Reopen a finished task', tags: ['Tasks'], permission: 'tasks:update', params: id, successStatus: 200, response: TaskSchema, handler: async ({ params, actor }) => svc.reopen(actor, params.id) }),
    defineRoute({ method: 'post', path: '/:id/cancel', summary: 'Cancel a task', tags: ['Tasks'], permission: 'tasks:update', params: id, successStatus: 200, response: TaskSchema, handler: async ({ params, actor }) => svc.cancel(actor, params.id) }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Delete a task',
      description: 'Soft delete, recorded in the audit trail. Agents cancel their tasks instead; managers delete.',
      tags: ['Tasks'],
      permission: 'tasks:delete',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
  ];
}

export function createNotificationRoutes(svc: NotificationsService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'My notifications',
      description: 'Newest first. Notifications are personal; nobody else can read yours.',
      tags: ['Notifications'],
      permission: 'notifications:read',
      query: pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }),
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.list(actor, { limit: query.limit, cursor: query.cursor, unreadOnly: query.unread === 'true' });
        return paged(r.items, r.page);
      },
    }),
    defineRoute({ method: 'get', path: '/unread-count', summary: 'Unread notification count', tags: ['Notifications'], permission: 'notifications:read', handler: async ({ actor }) => ({ count: await svc.unreadCount(actor) }) }),
    defineRoute({
      method: 'post',
      path: '/read',
      summary: 'Mark notifications as read',
      description: 'Pass `ids`, or `all: true` for everything.',
      tags: ['Notifications'],
      permission: 'notifications:read',
      body: z.union([z.object({ ids: z.array(uuid).min(1).max(200) }), z.object({ all: z.literal(true) })]),
      successStatus: 200,
      handler: async ({ body, actor }) => ({ updated: await svc.markRead(actor, 'all' in body ? 'all' : body.ids) }),
    }),
  ];
}
