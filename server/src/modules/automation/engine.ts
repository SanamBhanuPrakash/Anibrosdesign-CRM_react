import type pg from 'pg';
import { enqueue, PermanentJobError, type JobContext, type JobHandler, type JobRecord } from '../../platform/jobs';
import type { DomainEventRow, EventConsumer } from '../../platform/events';
import { emit } from '../../platform/events';
import { audit } from '../../platform/audit';
import { notify } from '../../platform/notifications';
import { fromUnknown } from '../../platform/errors';
import { recordEvent } from '../../platform/observability/event-log';
import { automationRuns } from '../../platform/observability/metrics';
import type { Actor } from '../../platform/authz/actor';
import type { LeadsService } from '../leads/service';
import type { TasksService } from '../tasks/service';
import { isTemplateKey, type TemplateKey } from './templates';

/**
 * Automation engine.
 *
 *   lead.created ──► event consumer "automation" (worker, cursor-based, replay-safe)
 *                     └─ enqueues ONE job per event (dedupe key = event id). No rule is read here: rules are tenant data.
 *                    job "automation.dispatch" (tenant context, row-level security applies)
 *                     └─ for each ACTIVE rule of that workspace: one execution, run in ONE database transaction:
 *                          claim the execution row (UNIQUE rule+event: the database guarantees at most one run per event)
 *                          → keep or assign the owner → create the follow-up task (UNIQUE dedupe key) → notify → record the result
 *
 * Why one transaction: every step is an internal database write, so the whole run commits or none of it does. A crash,
 * a restart or a lost lease leaves nothing half-done, and a retry cannot duplicate anything. (Steps that call out to a
 * provider, such as e-mail or WhatsApp, cannot work this way and will need an at-least-once design with idempotency keys.)
 *
 * The run acts as a SYSTEM actor limited to what the template's steps do; it never inherits the privileges of whoever
 * turned the rule on.
 */

export interface EngineDeps {
  leads: LeadsService;
  tasks: TasksService;
}

export interface StepRecord {
  step: 'owner' | 'task' | 'notify';
  status: 'done' | 'kept' | 'skipped';
  detail: string;
  at: string;
}

type RuleRow = { id: string; status: string; version: number; template: string | null };
type EventLike = Pick<DomainEventRow, 'id' | 'aggregateId'> & { type: string; payload: Record<string, unknown>; occurredAt?: Date };
export type RunOutcome = { outcome: 'completed' | 'skipped' | 'duplicate' | 'ignored'; executionId?: string; summary?: string };

const systemActor = (tenantId: string): Actor => ({ tenantId, userId: null, role: 'tenant_owner', kind: 'system' });
const DEFAULT_FIRST_REPLY_MINUTES = 30;

// ── event consumer ───────────────────────────────────────────────────────────────────────────────────────────

export const automationConsumer: EventConsumer = {
  name: 'automation',
  async handle(events, tx) {
    for (const e of events) {
      if (e.type !== 'lead.created') continue;
      await enqueue(tx, { type: 'automation.dispatch', tenantId: e.tenantId, payload: { eventId: e.id }, dedupeKey: `evt:${e.id}`, maxAttempts: 6 });
    }
  },
};

// ── job handlers ─────────────────────────────────────────────────────────────────────────────────────────────

async function loadEvent(tx: pg.PoolClient, eventId: string): Promise<EventLike | undefined> {
  const r = await tx.query(`SELECT id::text, type, aggregate_id AS "aggregateId", payload, occurred_at AS "occurredAt" FROM domain_events WHERE id = $1::bigint AND tenant_id = app.current_tenant_id()`, [eventId]);
  return r.rows[0] as EventLike | undefined;
}

export function createAutomationHandlers(deps: EngineDeps): { dispatch: JobHandler; retry: JobHandler } {
  const dispatch: JobHandler = async (job, ctx) => {
    const eventId = String(job.payload.eventId ?? '');
    if (!/^\d+$/.test(eventId)) throw new PermanentJobError('automation.dispatch needs a numeric eventId');
    const ev = await ctx.withTenant((tx) => loadEvent(tx, eventId));
    if (!ev) return { ignored: 'event no longer available' };
    if (ev.type !== 'lead.created') return { ignored: `no automation listens to ${ev.type}` };
    const rules = await ctx.withTenant(async (tx) => (await tx.query(`SELECT id FROM automation_rules WHERE tenant_id = app.current_tenant_id() AND status = 'active' AND template IS NOT NULL AND trigger_type = 'lead_created' AND active_since <= $1::timestamptz ORDER BY created_at, id`, [ev.occurredAt])).rows as Array<{ id: string }>);
    const results: RunOutcome[] = [];
    let transient: unknown;
    for (const rule of rules) {
      try {
        results.push(await runRule(deps, ctx, job, rule.id, ev));
      } catch (e) {
        transient = e; // keep going: one rule's temporary problem must not block the others; the job retries afterwards
      }
    }
    if (transient) throw transient;
    return { rules: rules.length, results: results.map((r) => r.outcome) };
  };

  const retry: JobHandler = async (job, ctx) => {
    const executionId = String(job.payload.executionId ?? '');
    const ex = await ctx.withTenant(async (tx) => (await tx.query(`SELECT id, rule_id AS "ruleId", trigger_event_id::text AS "eventId", trigger_entity_id AS "entityId", status FROM automation_executions WHERE id = $1 AND tenant_id = app.current_tenant_id()`, [executionId])).rows[0]);
    if (!ex) throw new PermanentJobError('Execution not found');
    if (!['pending', 'failed'].includes(ex.status)) return { ignored: `execution is ${ex.status}` };
    const found = ex.eventId ? await ctx.withTenant((tx) => loadEvent(tx, ex.eventId)) : undefined;
    const ev: EventLike = found ?? { id: ex.eventId ?? '0', type: 'lead.created', aggregateId: ex.entityId, payload: {} };
    return runRule(deps, ctx, job, ex.ruleId, ev);
  };

  return { dispatch, retry };
}

/** Permanent = retrying cannot help (validation, missing record, constraint). Everything else (connections, deadlocks, timeouts) is transient. */
export function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentJobError) return true;
  // a deadlock or serialization failure is reported to API callers as a 409, but for a background job it simply means "try again"
  const pgCode = (err as { code?: string } | null)?.code;
  if (pgCode === '40001' || pgCode === '40P01') return false;
  const mapped = fromUnknown(err);
  return Boolean(mapped && mapped.status >= 400 && mapped.status < 500);
}

async function runRule(deps: EngineDeps, ctx: JobContext, job: JobRecord, ruleId: string, ev: EventLike): Promise<RunOutcome> {
  const tenantId = job.tenantId as string;
  try {
    const out = await ctx.withTenant((tx) => executeInTx(tx, deps, tenantId, ruleId, ev));
    if (out.outcome !== 'duplicate' && out.outcome !== 'ignored') automationRuns.inc({ template: 'new_lead_follow_up', outcome: out.outcome });
    return out;
  } catch (err) {
    const permanent = isPermanent(err);
    const final = permanent || job.attempts >= job.maxAttempts;
    const message = userFacingError(err);
    await ctx.withTenant((tx) => recordFailure(tx, tenantId, ruleId, ev, message, final, job.attempts));
    automationRuns.inc({ template: 'new_lead_follow_up', outcome: final ? 'failed' : 'retrying' });
    if (final) {
      recordEvent({ tenantId, component: 'worker', severity: 'error', message: 'An automation run failed', context: { ruleId, eventId: ev.id, leadId: ev.aggregateId, reason: message, attempts: job.attempts }, throttleKey: `automation:${ruleId}` });
      if (permanent) return { outcome: 'ignored' }; // recorded as a failed execution the user can retry; the job itself is complete
    }
    throw err;
  }
}

/** "14 Oct, 16:38 (Asia/Kolkata)": run histories are read by people in the workspace's own time zone, not UTC. */
export function formatInZone(d: Date, zone: string): string {
  try {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)} (${zone})`;
  } catch {
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function userFacingError(err: unknown): string {
  const mapped = fromUnknown(err);
  const text = mapped ? mapped.detail ?? mapped.title : err instanceof Error ? err.message : String(err);
  return String(text).slice(0, 300);
}

// ── one execution, atomically ─────────────────────────────────────────────────────────────────────────────

export async function executeInTx(tx: pg.PoolClient, deps: EngineDeps, tenantId: string, ruleId: string, ev: EventLike): Promise<RunOutcome> {
  // FOR SHARE: a concurrent "pause" waits until this run commits, so a run that has started always finishes consistently.
  // Runs only ever SHARE the rule row and never update it (counts are derived from the history), so concurrent runs cannot block or deadlock each other.
  const rule = (await tx.query(`SELECT id, status, version, template FROM automation_rules WHERE id = $1 AND tenant_id = $2 FOR SHARE`, [ruleId, tenantId])).rows[0] as RuleRow | undefined;
  if (!rule || !rule.template || !isTemplateKey(rule.template)) return { outcome: 'ignored' };

  // Claim: at most one execution per (rule, event). A concurrent worker blocks here until this transaction ends, then finds the row taken.
  const claim = await tx.query(
    `INSERT INTO automation_executions (tenant_id, rule_id, rule_version, trigger_entity_type, trigger_entity_id, trigger_event_id, status, attempts, started_at)
     VALUES ($1, $2, $3, 'lead', $4, $5::bigint, 'running', 1, now())
     ON CONFLICT (rule_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL
     DO UPDATE SET status = 'running', attempts = automation_executions.attempts + 1, started_at = now(), error_message = NULL, rule_version = EXCLUDED.rule_version
       WHERE automation_executions.status IN ('pending', 'failed')
     RETURNING id`,
    [tenantId, ruleId, rule.version, ev.aggregateId, ev.id]
  );
  if (!claim.rows[0]) return { outcome: 'duplicate' };
  const executionId = claim.rows[0].id as string;

  const finish = async (status: 'completed' | 'skipped', summary: string, steps: StepRecord[]): Promise<RunOutcome> => {
    await tx.query(`UPDATE automation_executions SET status = $2, summary = $3, execution_log = $4::jsonb, actions_run = $5, completed_at = now(), error_message = NULL WHERE id = $1`, [executionId, status, summary.slice(0, 600), JSON.stringify(steps), steps.filter((s) => s.status === 'done').length]);
    await audit(tx, { action: `automation.${status === 'completed' ? 'run' : 'skip'}`, entityType: 'automation_execution', entityId: executionId, after: { ruleId, template: rule.template, leadId: ev.aggregateId, summary } });
    await emit(tx, { type: 'automation.updated', aggregateId: executionId, payload: { ruleId, status } });
    return { outcome: status, executionId, summary };
  };

  if (rule.status !== 'active') return finish('skipped', 'The automation was paused before this ran, so nothing was done.', []);

  const template = rule.template as TemplateKey;
  if (template === 'new_lead_follow_up') {
    const r = await newLeadFollowUp(tx, deps, tenantId, ruleId, ev);
    return finish(r.skipped ? 'skipped' : 'completed', r.summary, r.steps);
  }
  throw new PermanentJobError(`No implementation for template ${template}`);
}

// ── template: follow up every new lead ───────────────────────────────────────────────────────────────────────

async function newLeadFollowUp(tx: pg.PoolClient, deps: EngineDeps, tenantId: string, ruleId: string, ev: EventLike): Promise<{ summary: string; steps: StepRecord[]; skipped?: boolean }> {
  const actor = systemActor(tenantId);
  const steps: StepRecord[] = [];
  const log = (step: StepRecord['step'], status: StepRecord['status'], detail: string) => steps.push({ step, status, detail, at: new Date().toISOString() });

  const lead = (
    await tx.query(
      `SELECT l.id, l.owner_id AS "ownerId", l.created_by AS "createdBy", l.created_at AS "createdAt", l.source::text AS source, l.deleted_at AS "deletedAt", l.contact_id AS "contactId", c.display_name AS "contactName"
         FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
        WHERE l.id = $1 AND l.tenant_id = $2 FOR UPDATE OF l`,
      [ev.aggregateId, tenantId]
    )
  ).rows[0] as { id: string; ownerId: string | null; createdBy: string | null; createdAt: Date; source: string; deletedAt: Date | null; contactId: string | null; contactName: string | null } | undefined;
  if (!lead || lead.deletedAt) return { summary: 'The lead was archived or removed before this ran, so nothing was done.', steps, skipped: true };

  const settings = await deps.leads.settings(tx, tenantId);
  const nameOf = async (id: string) => ((await tx.query(`SELECT name FROM users WHERE id = $1`, [id])).rows[0]?.name as string | undefined) ?? 'a teammate';
  const person = lead.contactName?.trim() || 'the new lead';
  const zone = ((await tx.query(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.timezone as string | undefined) || 'UTC';

  // 1. owner: an explicit choice is never overridden; the workspace rule applies only when there is no owner and none was asked for
  let ownerId = lead.ownerId;
  if (ownerId) log('owner', 'kept', `Kept the owner: ${await nameOf(ownerId)}`);
  else if (ev.payload.ownerRequested === true) log('owner', 'kept', 'The lead was created without an owner on purpose, so it was left unassigned');
  else if (await deps.leads.routedOwner(tx, tenantId, settings, lead.source)) {
    const routed = (await deps.leads.routedOwner(tx, tenantId, settings, lead.source))!;
    await deps.leads.assignInTx(tx, actor, { id: lead.id, owner_id: null }, routed);
    ownerId = routed;
    log('owner', 'done', `Assigned to ${await nameOf(routed)} (your routing rule for ${lead.source.replace(/_/g, ' ')} leads)`);
  } else if (settings.assignmentMode === 'unassigned') log('owner', 'kept', 'Your assignment rule is “leave leads unassigned”, so it was left unassigned');
  else {
    const picked = await deps.leads.pickBalancedOwner(tx, tenantId);
    if (picked) {
      await deps.leads.assignInTx(tx, actor, { id: lead.id, owner_id: null }, picked);
      ownerId = picked;
      log('owner', 'done', `Assigned to ${await nameOf(picked)} (least busy salesperson)`);
    } else log('owner', 'skipped', 'No active salesperson was available, so the lead was left unassigned');
  }

  // 2. one call task, due within the workspace's first-reply time (never already overdue at birth)
  const minutes = settings.firstResponseMinutes > 0 ? settings.firstResponseMinutes : DEFAULT_FIRST_REPLY_MINUTES;
  const naturalDue = new Date(lead.createdAt).getTime() + minutes * 60_000;
  const dueNow = naturalDue <= Date.now();
  const due = new Date(dueNow ? Date.now() : naturalDue);
  const { task, created } = await deps.tasks.createInTx(
    tx,
    actor,
    { title: `Call ${person} (new lead)`.slice(0, 200), kind: 'call', priority: 'high', dueDate: due.toISOString(), remindBeforeMinutes: minutes >= 10 && !dueNow ? 5 : undefined, assignedTo: ownerId, leadId: lead.id, contactId: lead.contactId, description: `Created automatically for a new lead from ${lead.source.replace(/_/g, ' ')}.` },
    { dedupeKey: `automation:${ruleId}:${ev.id}:task`, silent: true }
  );
  log('task', created ? 'done' : 'kept', `${created ? 'Created' : 'Found'} the task “${task.title}”, due ${formatInZone(due, zone)}${ownerId ? '' : ' (no owner yet)'}`);

  // 3. tell the owner, once. Not about a lead they created themselves, and not twice when the lead source already did.
  if (!ownerId) log('notify', 'skipped', 'There is no owner to notify');
  else if (ownerId === lead.createdBy) log('notify', 'skipped', 'The owner created this lead, so no notification was needed');
  else {
    const already = (await tx.query(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND entity_type = 'lead' AND entity_id = $3 AND type = 'lead_assigned' LIMIT 1`, [tenantId, ownerId, lead.id])).rowCount;
    if (already) log('notify', 'skipped', 'The owner was already notified when the lead arrived');
    else {
      const id = await notify(tx, {
        userId: ownerId,
        title: `New lead: ${person}`,
        message: dueNow ? `Call as soon as possible (${lead.source.replace(/_/g, ' ')}).` : `Call within ${minutes} minutes (${lead.source.replace(/_/g, ' ')}).`,
        type: 'lead_assigned',
        link: `/leads/${lead.id}`,
        entityType: 'lead',
        entityId: lead.id,
        dedupeKey: `automation:${ruleId}:${ev.id}:notify`,
      });
      log('notify', id ? 'done' : 'kept', `${id ? 'Notified' : 'Had already notified'} ${await nameOf(ownerId)}`);
    }
  }

  return { summary: steps.map((s) => s.detail).join(' · '), steps };
}

async function recordFailure(tx: pg.PoolClient, tenantId: string, ruleId: string, ev: EventLike, message: string, final: boolean, attempts: number): Promise<void> {
  const rule = (await tx.query(`SELECT version FROM automation_rules WHERE id = $1 AND tenant_id = $2`, [ruleId, tenantId])).rows[0];
  await tx.query(
    `INSERT INTO automation_executions (tenant_id, rule_id, rule_version, trigger_entity_type, trigger_entity_id, trigger_event_id, status, attempts, error_message, started_at, completed_at)
     VALUES ($1, $2, $3, 'lead', $4, $5::bigint, $6, $7, $8, now(), CASE WHEN $6 = 'failed' THEN now() END)
     ON CONFLICT (rule_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status, attempts = GREATEST(automation_executions.attempts, EXCLUDED.attempts), error_message = EXCLUDED.error_message, completed_at = EXCLUDED.completed_at
       WHERE automation_executions.status IN ('pending', 'failed', 'running')`,
    [tenantId, ruleId, rule?.version ?? 1, ev.aggregateId, ev.id, final ? 'failed' : 'pending', Math.max(1, attempts), message]
  );
  await emit(tx, { type: 'automation.updated', aggregateId: ruleId, payload: { ruleId, status: final ? 'failed' : 'pending' } });
}

