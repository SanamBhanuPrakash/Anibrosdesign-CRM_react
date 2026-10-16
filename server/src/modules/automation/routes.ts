import { z } from 'zod';
import { defineRoute, paged, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { EXECUTION_STATUSES, type AutomationService } from './service';
import { TEMPLATE_KEYS } from './templates';

const uuid = z.string().uuid();
const key = z.object({ template: z.enum(TEMPLATE_KEYS) });

const RuleSchema = z.object({
  id: uuid,
  status: z.enum(['active', 'paused']),
  version: z.number().int(),
  runCount: z.number().int(),
  lastRunAt: z.string().nullable(),
  updatedAt: z.string(),
});
const TemplateSchema = z.object({
  key: z.enum(TEMPLATE_KEYS),
  name: z.string(),
  summary: z.string(),
  trigger: z.literal('lead_created'),
  triggerLabel: z.string(),
  steps: z.array(z.object({ id: z.enum(['owner', 'task', 'notify']), label: z.string() })),
  usesSettings: z.array(z.enum(['leadAssignment', 'firstResponseMinutes'])),
  rule: RuleSchema.nullable().describe('null until a workspace admin turns the automation on'),
  failedRuns: z.number().int(),
});
export const ExecutionSchema = z.object({
  id: uuid,
  ruleId: uuid,
  template: z.string().nullable(),
  status: z.enum(EXECUTION_STATUSES),
  leadId: uuid.nullable(),
  leadName: z.string().nullable(),
  summary: z.string().nullable().describe('What the run actually did, in plain words'),
  error: z.string().nullable(),
  attempts: z.number().int(),
  steps: z.array(z.object({ step: z.enum(['owner', 'task', 'notify']), status: z.enum(['done', 'kept', 'skipped']), detail: z.string(), at: z.string() })),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export function createAutomationRoutes(svc: AutomationService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Automations available to this workspace',
      description: 'The templates a workspace can turn on, each with its fixed steps, the workspace settings it reads, and the state of this workspace’s rule (if any). Templates are defined in code: only these steps exist, nothing is configurable beyond on/off.',
      tags: ['Automation'],
      permission: 'automation:read',
      response: z.array(TemplateSchema),
      handler: async ({ actor }) => svc.list(actor),
    }),
    defineRoute({
      method: 'post',
      path: '/:template/enable',
      summary: 'Turn an automation on',
      description: 'Starts acting on leads created from now on. Safe to repeat. It does not run on leads that already exist.',
      tags: ['Automation'],
      permission: 'automation:manage',
      params: key,
      successStatus: 200,
      response: TemplateSchema,
      handler: async ({ params, actor }) => svc.enable(actor, params.template),
    }),
    defineRoute({
      method: 'post',
      path: '/:template/pause',
      summary: 'Pause an automation',
      description: 'Stops it for new events. A run already in progress finishes; a run queued but not started is recorded as skipped. Safe to repeat.',
      tags: ['Automation'],
      permission: 'automation:manage',
      params: key,
      successStatus: 200,
      response: TemplateSchema,
      handler: async ({ params, actor }) => svc.pause(actor, params.template),
    }),
    defineRoute({
      method: 'get',
      path: '/executions',
      summary: 'Automation run history',
      description: 'Newest first. Each run says what it did to which lead, or why it failed.',
      tags: ['Automation'],
      permission: 'automation:read',
      query: pageQuery.extend({ status: z.enum(EXECUTION_STATUSES).optional(), leadId: uuid.optional() }),
      response: ExecutionSchema,
      paginated: true,
      handler: async ({ query, actor }) => {
        const r = await svc.executions(actor, query);
        return paged(r.items, r.page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/executions/:id',
      summary: 'One automation run, with its steps',
      tags: ['Automation'],
      permission: 'automation:read',
      params: z.object({ id: uuid }),
      response: ExecutionSchema,
      handler: async ({ params, actor }) => svc.execution(actor, params.id),
    }),
    defineRoute({
      method: 'post',
      path: '/executions/:id/retry',
      summary: 'Retry a failed run',
      description: 'Only a failed run can be retried (409 otherwise). The retry cannot duplicate anything the first attempt already did.',
      tags: ['Automation'],
      permission: 'automation:manage',
      params: z.object({ id: uuid }),
      successStatus: 202,
      response: ExecutionSchema,
      handler: async ({ params, actor }) => svc.retry(actor, params.id),
    }),
  ];
}
