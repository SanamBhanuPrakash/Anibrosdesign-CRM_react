import { z } from 'zod';
import { defineRoute, type RouteSpec } from '../../platform/http/route';
import type { HomeService } from './service';

const Task = z.object({ id: z.string().uuid(), title: z.string(), kind: z.string(), priority: z.string(), dueDate: z.string().nullable(), leadId: z.string().uuid().nullable(), leadName: z.string().nullable() });
const Visit = z.object({ id: z.string().uuid(), scheduledAt: z.string(), durationMinutes: z.number().int(), leadId: z.string().uuid(), leadName: z.string().nullable(), propertyTitle: z.string(), needsOutcome: z.boolean() });
const Reply = z.object({ leadId: z.string().uuid(), leadName: z.string().nullable(), dueAt: z.string(), overdue: z.boolean() });
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ count: z.number().int(), items: z.array(item) });

export function createHomeRoutes(svc: HomeService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Home: what needs me today',
      description:
        'Everything is limited to what the caller may see, and a part the caller has no permission for is `null`. ' +
        '`myDay` is the caller’s own work (tasks assigned to them, visits they run or that belong to their leads, their leads waiting for a first reply). ' +
        '`team` is for managers and admins. `pipeline` counts open leads by stage (test leads left out). `attention` is for operators. `getStarted` is the setup checklist for owners and admins. ' +
        '“Today” follows the workspace time zone. Each count equals the length of the list it summarises, never a separate estimate.',
      tags: ['Home'],
      response: z.object({
        today: z.string().describe('The workspace-local date, YYYY-MM-DD'),
        timezone: z.string(),
        myDay: z.object({
          tasks: z.object({ overdue: list(Task), today: list(Task) }).nullable(),
          viewings: z.object({ today: list(Visit), next7Days: z.number().int() }).nullable(),
          waitingForReply: list(Reply).nullable(),
        }),
        team: z.object({ unassignedLeads: list(z.object({ leadId: z.string().uuid(), leadName: z.string().nullable(), createdAt: z.string() })), lateFirstReplies: z.number().int(), overdueTasks: z.number().int().nullable(), unrecordedVisits: z.number().int().describe('Visits that ended and were never recorded') }).nullable(),
        pipeline: z.object({ pipelineId: z.string().uuid(), name: z.string(), stages: z.array(z.object({ id: z.string().uuid(), name: z.string(), color: z.string(), probability: z.number().int(), count: z.number().int(), value: z.number() })), openLeads: z.number().int(), openValue: z.number(), weightedValue: z.number() }).nullable(),
        attention: z.object({ deliveriesNeedingReview: z.number().int(), failedAutomationRuns: z.number().int() }).nullable(),
        getStarted: z.object({ items: z.array(z.object({ key: z.string(), label: z.string(), href: z.string(), done: z.boolean() })), complete: z.boolean() }).nullable(),
      }),
      handler: async ({ actor }) => svc.home(actor),
    }),
  ];
}
