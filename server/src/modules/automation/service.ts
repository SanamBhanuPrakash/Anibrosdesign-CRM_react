import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { enqueue } from '../../platform/jobs';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { TEMPLATES, TEMPLATE_KEYS, isTemplateKey, type TemplateDefinition, type TemplateKey } from './templates';
import type { StepRecord } from './engine';

export const EXECUTION_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface RuleState {
  id: string;
  status: 'active' | 'paused';
  version: number;
  runCount: number;
  lastRunAt: string | null;
  updatedAt: string;
}
export interface TemplateView extends TemplateDefinition {
  rule: RuleState | null;
  /** Executions that failed and have not been retried successfully. */
  failedRuns: number;
}
export interface ExecutionDto {
  id: string;
  ruleId: string;
  template: string | null;
  status: ExecutionStatus;
  leadId: string | null;
  leadName: string | null;
  summary: string | null;
  error: string | null;
  attempts: number;
  steps: StepRecord[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));

const EXEC_SELECT = `e.id, e.rule_id AS "ruleId", r.template, e.status, e.trigger_entity_id AS "leadId", c.display_name AS "leadName", e.summary, e.error_message AS error, e.attempts,
  e.execution_log AS steps, e.started_at AS "startedAt", e.completed_at AS "completedAt", e.created_at AS "createdAt", e.created_at::text AS _k`;
const EXEC_FROM = `automation_executions e JOIN automation_rules r ON r.id = e.rule_id AND r.tenant_id = e.tenant_id
  LEFT JOIN leads l ON l.id = e.trigger_entity_id AND l.tenant_id = e.tenant_id LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id`;

function toExecution(r: any): ExecutionDto {
  return {
    id: r.id,
    ruleId: r.ruleId,
    template: r.template,
    status: r.status,
    leadId: r.leadId,
    leadName: r.leadName,
    summary: r.summary,
    error: r.error,
    attempts: r.attempts,
    steps: Array.isArray(r.steps) ? r.steps : [],
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    createdAt: iso(r.createdAt) as string,
  };
}

export class AutomationService {
  constructor(private db: Database) {}

  async list(actor: Actor): Promise<TemplateView[]> {
    assertCan(actor, 'automation:read');
    return this.db.readTenant(actor, async (tx) => {
      const rules = (await tx.query(`SELECT r.id, r.template, r.status, r.version, r.updated_at AS "updatedAt",
               (SELECT count(*)::int FROM automation_executions e WHERE e.rule_id = r.id AND e.status = 'completed') AS "runCount",
               (SELECT max(e.completed_at) FROM automation_executions e WHERE e.rule_id = r.id AND e.status = 'completed') AS "lastRunAt"
          FROM automation_rules r WHERE r.tenant_id = $1 AND r.template = ANY($2::text[]) AND r.status <> 'archived'`, [actor.tenantId, [...TEMPLATE_KEYS]])).rows;
      const failed = (await tx.query(`SELECT r.template, count(*)::int AS n FROM automation_executions e JOIN automation_rules r ON r.id = e.rule_id AND r.tenant_id = e.tenant_id WHERE e.tenant_id = $1 AND e.status = 'failed' GROUP BY 1`, [actor.tenantId])).rows;
      return TEMPLATE_KEYS.map((key) => {
        const r = rules.find((x) => x.template === key);
        return {
          ...TEMPLATES[key],
          rule: r ? { id: r.id, status: r.status, version: r.version, runCount: r.runCount, lastRunAt: iso(r.lastRunAt), updatedAt: iso(r.updatedAt) as string } : null,
          failedRuns: failed.find((f) => f.template === key)?.n ?? 0,
        };
      });
    });
  }

  /** Turn a template on for this workspace. Idempotent: turning on something already on changes nothing. */
  async enable(actor: Actor, key: string): Promise<TemplateView> {
    assertCan(actor, 'automation:manage');
    const t = this.template(key);
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(
        `INSERT INTO automation_rules (tenant_id, name, description, trigger_type, trigger_config, conditions, actions, status, template, params, created_by, updated_by, active_since)
         VALUES ($1, $2, $3, $4::automation_trigger, '{}'::jsonb, '[]'::jsonb, $5::jsonb, 'active', $6, '{}'::jsonb, $7, $7, now())
         ON CONFLICT (tenant_id, template) WHERE template IS NOT NULL AND status <> 'archived'
         DO UPDATE SET status = 'active', version = automation_rules.version + 1, updated_by = $7, active_since = now() WHERE automation_rules.status <> 'active'
         RETURNING id, version`,
        [actor.tenantId, t.name, t.summary, t.trigger, JSON.stringify(t.steps.map((s) => s.id)), t.key, actor.userId]
      );
      if (r.rows[0]) {
        await audit(tx, { action: 'automation.enable', entityType: 'automation_rule', entityId: r.rows[0].id, after: { template: t.key, version: r.rows[0].version } });
        await emit(tx, { type: 'automation.updated', aggregateId: r.rows[0].id, payload: { template: t.key, status: 'active' } });
      }
    });
    return this.one(actor, t.key);
  }

  /** Stop the automation for NEW events. A run that already started finishes; one that has not started is recorded as skipped. */
  async pause(actor: Actor, key: string): Promise<TemplateView> {
    assertCan(actor, 'automation:manage');
    const t = this.template(key);
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE automation_rules SET status = 'paused', version = version + 1, updated_by = $3 WHERE tenant_id = $1 AND template = $2 AND status = 'active' RETURNING id, version`, [actor.tenantId, t.key, actor.userId]);
      if (r.rows[0]) {
        await audit(tx, { action: 'automation.pause', entityType: 'automation_rule', entityId: r.rows[0].id, after: { template: t.key, version: r.rows[0].version } });
        await emit(tx, { type: 'automation.updated', aggregateId: r.rows[0].id, payload: { template: t.key, status: 'paused' } });
      } else {
        const exists = await tx.query(`SELECT 1 FROM automation_rules WHERE tenant_id = $1 AND template = $2 AND status <> 'archived'`, [actor.tenantId, t.key]);
        if (!exists.rowCount) throw Errors.notFound('Automation');
      }
    });
    return this.one(actor, t.key);
  }

  async executions(actor: Actor, q: { limit: number; cursor?: string; status?: ExecutionStatus; leadId?: string }): Promise<{ items: ExecutionDto[]; page: PageInfo }> {
    assertCan(actor, 'automation:read');
    const sig = 'automation:executions:created:desc';
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['e.tenant_id = $1'];
      const push = (v: unknown) => (params.push(v), `$${params.length}`);
      if (q.status) where.push(`e.status = ${push(q.status)}`);
      if (q.leadId) where.push(`e.trigger_entity_id = ${push(q.leadId)}`);
      const pred = cursorPredicate(cursor, params, 'e.created_at', 'e.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(`SELECT ${EXEC_SELECT} FROM ${EXEC_FROM} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return { items: items.map(toExecution), page };
    });
  }

  async execution(actor: Actor, id: string): Promise<ExecutionDto> {
    assertCan(actor, 'automation:read');
    return this.db.readTenant(actor, async (tx) => {
      const r = await tx.query(`SELECT ${EXEC_SELECT} FROM ${EXEC_FROM} WHERE e.tenant_id = $1 AND e.id = $2`, [actor.tenantId, id]);
      if (!r.rows[0]) throw Errors.notFound('Execution');
      return toExecution(r.rows[0]);
    });
  }

  /** Run a failed execution again. The retry goes through the same claim as the first run, so it can never duplicate its effects. */
  async retry(actor: Actor, id: string): Promise<ExecutionDto> {
    assertCan(actor, 'automation:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`SELECT id, status, attempts FROM automation_executions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [actor.tenantId, id]);
      const row = r.rows[0];
      if (!row) throw Errors.notFound('Execution');
      if (row.status !== 'failed') throw Errors.conflict('Only a failed run can be retried');
      await tx.query(`UPDATE automation_executions SET status = 'pending', error_message = NULL, completed_at = NULL WHERE id = $1`, [id]);
      await enqueue(tx, { type: 'automation.retry', payload: { executionId: id }, dedupeKey: `retry:${id}:${row.attempts}`, maxAttempts: 4 });
      await audit(tx, { action: 'automation.retry', entityType: 'automation_execution', entityId: id, after: { attempts: row.attempts } });
      await emit(tx, { type: 'automation.updated', aggregateId: id, payload: { status: 'pending' } });
    });
    return this.execution(actor, id);
  }

  private template(key: string): TemplateDefinition {
    if (!isTemplateKey(key)) throw Errors.notFound('Automation template');
    return TEMPLATES[key as TemplateKey];
  }
  private async one(actor: Actor, key: TemplateKey): Promise<TemplateView> {
    return (await this.list(actor)).find((t) => t.key === key)!;
  }
}
