import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { notify } from '../../platform/notifications';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { escapeLike } from '../contacts/normalize';
import { leadVisibility } from '../leads/pipelines.service';
import { addInZone, nextOccurrence, startOfDayInZone, type Recurrence } from './recurrence';

export const TASK_KINDS = ['todo', 'call', 'email', 'meeting', 'follow_up'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
const OPEN = ['pending', 'in_progress'];

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  remindBeforeMinutes: number | null;
  recurrence: Recurrence | null;
  assignedTo: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  leadId: string | null;
  leadName: string | null;
  contactId: string | null;
  contactName: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput {
  title: string;
  description?: string | null;
  kind?: TaskKind;
  priority?: TaskPriority;
  dueDate?: string | null;
  remindBeforeMinutes?: number | null;
  recurrence?: Recurrence | null;
  assignedTo?: string | null;
  leadId?: string | null;
  contactId?: string | null;
}
export type TaskPatch = Partial<TaskInput> & { status?: 'pending' | 'in_progress' };

export interface TaskListQuery {
  limit: number;
  cursor?: string;
  q?: string;
  assignee?: string; // 'me' | 'unassigned' | uuid | 'any'
  status: 'open' | 'done' | 'all';
  priority?: TaskPriority;
  kind?: TaskKind;
  leadId?: string;
  contactId?: string;
  due?: 'overdue' | 'today' | 'week' | 'none';
  dueFrom?: string;
  dueTo?: string;
  sort: 'due' | 'created' | 'priority';
  order: 'asc' | 'desc';
}

const PRIORITY_RANK = `(CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)`;
const SORTS = {
  due: { sql: `COALESCE(t.due_date, 'infinity'::timestamptz)`, text: `COALESCE(t.due_date, 'infinity'::timestamptz)::text`, cast: '::timestamptz', field: '_k_due' },
  created: { sql: 't.created_at', text: 't.created_at::text', cast: '::timestamptz', field: '_k_created' },
  priority: { sql: PRIORITY_RANK, text: `${PRIORITY_RANK}::text`, cast: '::int', field: '_k_priority' },
} as const;

const COLUMNS = `
  t.id, t.title, t.description, t.kind, t.priority, t.status, t.due_date AS "dueDate", t.remind_before_minutes AS "remindBeforeMinutes", t.recurrence,
  t.assigned_to AS "assignedTo", au.name AS "assigneeName", t.created_by AS "createdBy",
  t.lead_id AS "leadId", lc.display_name AS "leadName", t.contact_id AS "contactId", tc.display_name AS "contactName",
  t.completed_at AS "completedAt", (t.due_date < now() AND t.status IN ('pending','in_progress')) AS "isOverdue",
  t.version, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
  COALESCE(t.due_date, 'infinity'::timestamptz)::text AS _k_due, t.created_at::text AS _k_created, ${PRIORITY_RANK}::text AS _k_priority`;
const FROM = `tasks t
  LEFT JOIN users au ON au.id = t.assigned_to
  LEFT JOIN leads l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
  LEFT JOIN contacts lc ON lc.id = l.contact_id AND lc.tenant_id = l.tenant_id
  LEFT JOIN contacts tc ON tc.id = t.contact_id AND tc.tenant_id = t.tenant_id`;

function toDto(row: any): TaskDto {
  const { _k_due, _k_created, _k_priority, ...rest } = row;
  return rest as TaskDto;
}

/** Own-scope: tasks assigned to me or that I created (a task I made for someone else must not vanish from my view). */
function visibility(actor: Actor, alias: string, params: unknown[]): string | false {
  const scope = scopeIfAllowed(actor, 'tasks:read');
  if (!scope) return false;
  if (scope === 'all') return 'true';
  params.push(actor.userId);
  return `(${alias}.assigned_to = $${params.length} OR ${alias}.created_by = $${params.length})`;
}

export class TasksService {
  constructor(private db: Database) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────

  async list(actor: Actor, q: TaskListQuery): Promise<{ items: TaskDto[]; page: PageInfo }> {
    assertCan(actor, 'tasks:read');
    const sig = `tasks:${q.sort}:${q.order}`;
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const tz = await this.timezone(tx, actor.tenantId);
      const params: unknown[] = [actor.tenantId];
      const vis = visibility(actor, 't', params);
      if (vis === false) throw Errors.forbidden();
      const where = ['t.tenant_id = $1', 't.deleted_at IS NULL', vis];
      const push = (v: unknown) => (params.push(v), `$${params.length}`);

      if (q.status === 'open') where.push(`t.status IN ('pending','in_progress')`);
      else if (q.status === 'done') where.push(`t.status IN ('completed','cancelled')`);
      if (q.assignee === 'me') where.push(`t.assigned_to = ${push(actor.userId)}`);
      else if (q.assignee === 'unassigned') where.push('t.assigned_to IS NULL');
      else if (q.assignee && q.assignee !== 'any') where.push(`t.assigned_to = ${push(q.assignee)}`);
      if (q.priority) where.push(`t.priority = ${push(q.priority)}::task_priority`);
      if (q.kind) where.push(`t.kind = ${push(q.kind)}`);
      if (q.leadId) where.push(`t.lead_id = ${push(q.leadId)}`);
      if (q.contactId) where.push(`t.contact_id = ${push(q.contactId)}`);
      if (q.due) {
        const sod = startOfDayInZone(new Date(), tz);
        if (q.due === 'overdue') where.push(`t.due_date < now() AND t.status IN ('pending','in_progress')`);
        else if (q.due === 'none') where.push('t.due_date IS NULL');
        else where.push(`t.due_date >= ${push(sod)} AND t.due_date < ${push(q.due === 'today' ? addInZone(sod, tz, 'daily', 1) : addInZone(sod, tz, 'daily', 7))}`);
      }
      if (q.dueFrom) where.push(`t.due_date >= ${push(q.dueFrom)}::timestamptz`);
      if (q.dueTo) where.push(`t.due_date < ${push(q.dueTo)}::timestamptz`);
      if (q.q?.trim()) where.push(`(t.title ILIKE ${push(`%${escapeLike(q.q.trim().slice(0, 100))}%`)} OR lc.display_name ILIKE $${params.length})`);

      const key = SORTS[q.sort];
      const pred = cursorPredicate(cursor, params, key.sql, 't.id', q.order, key.cast);
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${key.sql} ${q.order}, t.id ${q.order} LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r[key.field] as string);
      return { items: items.map(toDto), page };
    });
  }

  async get(actor: Actor, id: string): Promise<TaskDto> {
    assertCan(actor, 'tasks:read');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId, id];
      const vis = visibility(actor, 't', params);
      if (vis === false) throw Errors.forbidden();
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL AND ${vis}`, params);
      if (!rows[0]) throw Errors.notFound('Task');
      return toDto(rows[0]);
    });
  }

  /** Badge numbers for "my day" and (for managers) the team: overdue, due today, next 7 days. */
  async summary(actor: Actor) {
    assertCan(actor, 'tasks:read');
    return this.db.readTenant(actor, async (tx) => {
      const tz = await this.timezone(tx, actor.tenantId);
      const sod = startOfDayInZone(new Date(), tz);
      const tomorrow = addInZone(sod, tz, 'daily', 1);
      const week = addInZone(sod, tz, 'daily', 7);
      const params: unknown[] = [actor.tenantId, actor.userId, tomorrow, week];
      const vis = visibility(actor, 't', params);
      if (vis === false) throw Errors.forbidden();
      const { rows } = await tx.query(
        `SELECT
           count(*) FILTER (WHERE t.assigned_to = $2 AND t.due_date < now())::int AS "mineOverdue",
           count(*) FILTER (WHERE t.assigned_to = $2 AND t.due_date >= now() AND t.due_date < $3)::int AS "mineToday",
           count(*) FILTER (WHERE t.assigned_to = $2 AND t.due_date >= $3 AND t.due_date < $4)::int AS "mineUpcoming",
           count(*) FILTER (WHERE t.assigned_to = $2)::int AS "mineOpen",
           count(*) FILTER (WHERE t.due_date < now())::int AS "teamOverdue",
           count(*) FILTER (WHERE t.assigned_to IS NULL)::int AS "unassigned",
           count(*)::int AS "teamOpen"
         FROM tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.status IN ('pending','in_progress') AND ${vis}`,
        params
      );
      const r = rows[0];
      return {
        mine: { overdue: r.mineOverdue, today: r.mineToday, upcoming: r.mineUpcoming, open: r.mineOpen },
        team: scopeIfAllowed(actor, 'tasks:read') === 'all' ? { overdue: r.teamOverdue, unassigned: r.unassigned, open: r.teamOpen } : null,
      };
    });
  }

  // ── writes ──────────────────────────────────────────────────────────────────────────────────────────

  async create(actor: Actor, input: TaskInput): Promise<TaskDto> {
    assertCan(actor, 'tasks:create');
    return this.db.withTenant(actor, async (tx) => (await this.createInTx(tx, actor, input)).task);
  }

  /**
   * Task creation inside the caller's transaction (the API, and the automation engine).
   * `dedupeKey` makes creation exactly-once: a second call with the same key returns the first task and creates nothing.
   * `silent` skips the "New task for you" notification when the caller sends its own, better-worded one.
   */
  async createInTx(tx: pg.PoolClient, actor: Actor, input: TaskInput, opts: { dedupeKey?: string; silent?: boolean } = {}): Promise<{ task: TaskDto; created: boolean }> {
    assertCan(actor, 'tasks:create');
    const assignee = await this.resolveAssignee(tx, actor, input.assignedTo, actor.userId);
    await this.assertLinks(tx, actor, input.leadId, input.contactId);
    const due = input.dueDate ? new Date(input.dueDate) : null;
    const remind = this.remindAt(due, input.remindBeforeMinutes);
    const ins = await tx.query(
      `INSERT INTO tasks (tenant_id, title, description, kind, priority, due_date, remind_before_minutes, remind_at, recurrence, assigned_to, lead_id, contact_id, created_by, dedupe_key)
       VALUES ($1,$2,$3,$4,$5::task_priority,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [actor.tenantId, input.title.trim(), input.description?.trim() || null, input.kind ?? 'todo', input.priority ?? 'medium', due, input.remindBeforeMinutes ?? null, remind, input.recurrence ? JSON.stringify(input.recurrence) : null, assignee, input.leadId ?? null, input.contactId ?? null, actor.userId, opts.dedupeKey ?? null]
    );
    if (!ins.rows[0]) {
      const existing = await tx.query(`SELECT id FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2`, [actor.tenantId, opts.dedupeKey]);
      return { task: (await this.fetch(tx, actor.tenantId, existing.rows[0].id))!, created: false };
    }
    const id = ins.rows[0].id as string;
    const dto = (await this.fetch(tx, actor.tenantId, id))!;
    if (dto.leadId) {
      await this.logLeadActivity(tx, actor, dto.leadId, 'task_created', `Task added: ${dto.title}`, { taskId: id });
      await syncLeadFollowup(tx, actor.tenantId, dto.leadId);
    }
    if (!opts.silent) await this.notifyAssignment(tx, actor, dto);
    await audit(tx, { action: 'task.create', entityType: 'task', entityId: id, after: { title: dto.title, assignedTo: dto.assignedTo, leadId: dto.leadId } });
    await emit(tx, { type: 'task.created', aggregateId: id, payload: { assignedTo: dto.assignedTo, leadId: dto.leadId } });
    return { task: dto, created: true };
  }

  async update(actor: Actor, id: string, patch: TaskPatch, expectedVersion?: number): Promise<TaskDto> {
    assertCan(actor, 'tasks:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Errors.preconditionFailed();
      if (!OPEN.includes(row.status)) throw Errors.conflict('This task is finished. Reopen it to change it.');
      const before = (await this.fetch(tx, actor.tenantId, id))!;
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => (params.push(v), sets.push(`${col} = $${params.length}${cast}`));

      if (patch.title !== undefined) set('title', patch.title.trim());
      if (patch.description !== undefined) set('description', patch.description?.trim() || null);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.priority !== undefined) set('priority', patch.priority, '::task_priority');
      if (patch.status !== undefined) set('status', patch.status, '::task_status');
      if (patch.recurrence !== undefined) set('recurrence', patch.recurrence ? JSON.stringify(patch.recurrence) : null, '::jsonb');
      if (patch.assignedTo !== undefined) set('assigned_to', await this.resolveAssignee(tx, actor, patch.assignedTo, null));
      if (patch.leadId !== undefined || patch.contactId !== undefined) {
        await this.assertLinks(tx, actor, patch.leadId, patch.contactId);
        if (patch.leadId !== undefined) set('lead_id', patch.leadId);
        if (patch.contactId !== undefined) set('contact_id', patch.contactId);
      }
      if (patch.dueDate !== undefined || patch.remindBeforeMinutes !== undefined) {
        const due = patch.dueDate !== undefined ? (patch.dueDate ? new Date(patch.dueDate) : null) : before.dueDate ? new Date(before.dueDate) : null;
        const mins = patch.remindBeforeMinutes !== undefined ? patch.remindBeforeMinutes : before.remindBeforeMinutes;
        set('due_date', due);
        set('remind_before_minutes', mins);
        set('remind_at', this.remindAt(due, mins));
        // a rescheduled task earns fresh reminders
        sets.push('reminder_sent_at = NULL');
        if (due && due.getTime() > Date.now()) sets.push('overdue_notified_at = NULL');
      }
      if (sets.length) await tx.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      const after = (await this.fetch(tx, actor.tenantId, id))!;
      for (const leadId of new Set([before.leadId, after.leadId].filter(Boolean) as string[])) await syncLeadFollowup(tx, actor.tenantId, leadId);
      if (after.assignedTo !== before.assignedTo) await this.notifyAssignment(tx, actor, after);
      await audit(tx, { action: 'task.update', entityType: 'task', entityId: id, before, after });
      await emit(tx, { type: 'task.updated', aggregateId: id, payload: { version: after.version } });
      return after;
    });
  }

  async complete(actor: Actor, id: string, expectedVersion?: number): Promise<{ task: TaskDto; next: TaskDto | null }> {
    assertCan(actor, 'tasks:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Errors.preconditionFailed();
      return this.completeInTx(tx, actor, id, row);
    });
  }

  private async completeInTx(tx: pg.PoolClient, actor: Actor, id: string, row: { status: string }) {
    if (!OPEN.includes(row.status)) throw Errors.conflict('This task is already finished');
    await tx.query(`UPDATE tasks SET status = 'completed', completed_at = now(), completed_by = $3 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, actor.userId]);
    const task = (await this.fetch(tx, actor.tenantId, id))!;
    let next: TaskDto | null = null;
    const rec = (await tx.query(`SELECT recurrence, recurrence_root_id, due_date, remind_before_minutes FROM tasks WHERE id = $1`, [id])).rows[0];
    if (rec.recurrence) {
      const tz = await this.timezone(tx, actor.tenantId);
      const due = nextOccurrence(rec.due_date ? new Date(rec.due_date) : new Date(), rec.recurrence as Recurrence, tz);
      const ins = await tx.query(
        `INSERT INTO tasks (tenant_id, title, description, kind, priority, due_date, remind_before_minutes, remind_at, recurrence, recurrence_root_id, assigned_to, lead_id, contact_id, created_by)
         SELECT tenant_id, title, description, kind, priority, $2, remind_before_minutes, $3, recurrence, COALESCE(recurrence_root_id, id), assigned_to, lead_id, contact_id, created_by FROM tasks WHERE id = $1 RETURNING id`,
        [id, due, this.remindAt(due, rec.remind_before_minutes)]
      );
      next = (await this.fetch(tx, actor.tenantId, ins.rows[0].id))!;
      await emit(tx, { type: 'task.created', aggregateId: next.id, payload: { recurringFrom: id } });
    }
    if (task.leadId) {
      await this.logLeadActivity(tx, actor, task.leadId, 'task_completed', `Task completed: ${task.title}`, { taskId: id });
      await syncLeadFollowup(tx, actor.tenantId, task.leadId);
    }
    await audit(tx, { action: 'task.complete', entityType: 'task', entityId: id, after: { nextId: next?.id } });
    await emit(tx, { type: 'task.completed', aggregateId: id, payload: { leadId: task.leadId } });
    return { task, next };
  }

  async reopen(actor: Actor, id: string): Promise<TaskDto> {
    assertCan(actor, 'tasks:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      if (OPEN.includes(row.status)) throw Errors.conflict('This task is already open');
      await tx.query(`UPDATE tasks SET status = 'pending', completed_at = NULL, completed_by = NULL, reminder_sent_at = NULL, overdue_notified_at = NULL WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      if (dto.leadId) await syncLeadFollowup(tx, actor.tenantId, dto.leadId);
      await audit(tx, { action: 'task.reopen', entityType: 'task', entityId: id });
      await emit(tx, { type: 'task.updated', aggregateId: id, payload: { reopened: true } });
      return dto;
    });
  }

  async cancel(actor: Actor, id: string): Promise<TaskDto> {
    assertCan(actor, 'tasks:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      if (!OPEN.includes(row.status)) throw Errors.conflict('This task is already finished');
      await tx.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      if (dto.leadId) await syncLeadFollowup(tx, actor.tenantId, dto.leadId);
      await audit(tx, { action: 'task.cancel', entityType: 'task', entityId: id });
      await emit(tx, { type: 'task.updated', aggregateId: id, payload: { cancelled: true } });
      return dto;
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'tasks:delete');
    await this.db.withTenant(actor, async (tx) => {
      const row = await tx.query(`SELECT lead_id, title FROM tasks WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!row.rows[0]) throw Errors.notFound('Task');
      await tx.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      if (row.rows[0].lead_id) await syncLeadFollowup(tx, actor.tenantId, row.rows[0].lead_id);
      await audit(tx, { action: 'task.delete', entityType: 'task', entityId: id, before: { title: row.rows[0].title } });
      await emit(tx, { type: 'task.deleted', aggregateId: id });
    });
  }

  async bulk(actor: Actor, input: { ids: string[]; action: 'complete' | 'cancel' | 'reassign'; assignedTo?: string | null }) {
    assertCan(actor, 'tasks:update');
    return this.db.withTenant(actor, async (tx) => {
      const skipped: Array<{ id: string; reason: string }> = [];
      let updated = 0;
      for (const id of [...new Set(input.ids)]) {
        await tx.query('SAVEPOINT bulk_task');
        try {
          const row = await this.lock(tx, actor, id);
          if (input.action === 'complete') await this.completeInTx(tx, actor, id, row);
          else {
            if (!OPEN.includes(row.status)) throw Errors.conflict('This task is already finished');
            if (input.action === 'cancel') await tx.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
            else {
              const to = await this.resolveAssignee(tx, actor, input.assignedTo ?? null, null);
              await tx.query(`UPDATE tasks SET assigned_to = $3 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, to]);
              await this.notifyAssignment(tx, actor, (await this.fetch(tx, actor.tenantId, id))!);
            }
            const lead = (await tx.query(`SELECT lead_id FROM tasks WHERE id = $1`, [id])).rows[0]?.lead_id;
            if (lead) await syncLeadFollowup(tx, actor.tenantId, lead);
            await audit(tx, { action: `task.${input.action}`, entityType: 'task', entityId: id, after: { bulk: true } });
            await emit(tx, { type: 'task.updated', aggregateId: id, payload: { bulk: input.action } });
          }
          await tx.query('RELEASE SAVEPOINT bulk_task');
          updated++;
        } catch (e: any) {
          await tx.query('ROLLBACK TO SAVEPOINT bulk_task');
          if (!e?.status || e.status >= 500) throw e;
          skipped.push({ id, reason: e.errors?.[0]?.message ?? e.detail ?? e.message });
        }
      }
      return { updated, skipped };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<TaskDto | undefined> {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1 AND t.tenant_id = $2 AND t.deleted_at IS NULL`, [id, tenantId]);
    return rows[0] ? toDto(rows[0]) : undefined;
  }

  private async lock(tx: pg.PoolClient, actor: Actor, id: string) {
    const { rows } = await tx.query(`SELECT id, status, version, assigned_to, created_by FROM tasks WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
    const row = rows[0];
    if (!row) throw Errors.notFound('Task');
    // Own-scope users act on tasks assigned to them or created by them; anything else does not exist for them.
    if (scopeIfAllowed(actor, 'tasks:update') === 'own' && row.assigned_to !== actor.userId && row.created_by !== actor.userId) throw Errors.notFound('Task');
    return row as { id: string; status: string; version: number; assigned_to: string | null; created_by: string | null };
  }

  private remindAt(due: Date | null, minutes: number | null | undefined): Date | null {
    if (minutes === null || minutes === undefined) return null;
    if (!due) throw Errors.validation([{ path: 'body.remindBeforeMinutes', message: 'Set a due date to get a reminder' }]);
    return new Date(due.getTime() - minutes * 60_000);
  }

  private async timezone(tx: pg.PoolClient, tenantId: string): Promise<string> {
    const r = await tx.query(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId]);
    return (r.rows[0]?.timezone as string) || 'Asia/Kolkata';
  }

  /** Managers may hand work to anyone; everyone else only keeps it for themselves. */
  private async resolveAssignee(tx: pg.PoolClient, actor: Actor, requested: string | null | undefined, fallback: string | null): Promise<string | null> {
    const manager = actor.kind === 'system' || scopeIfAllowed(actor, 'tasks:update') === 'all';
    let to: string | null;
    if (requested === undefined) to = fallback;
    else {
      if (!manager && requested !== actor.userId) throw Errors.forbidden('Only managers can assign a task to someone else');
      to = requested;
    }
    if (!to) return null;
    const m = await tx.query(`SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND tm.is_active AND u.is_active`, [actor.tenantId, to]);
    if (!m.rowCount) throw Errors.validation([{ path: 'body.assignedTo', message: 'Assignee must be an active member of this workspace' }]);
    return to;
  }

  private async assertLinks(tx: pg.PoolClient, actor: Actor, leadId: string | null | undefined, contactId: string | null | undefined) {
    if (leadId) {
      const params: unknown[] = [actor.tenantId, leadId];
      const vis = leadVisibility(actor, 'l', params);
      const ok = vis !== false && (await tx.query(`SELECT 1 FROM leads l WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, params)).rowCount;
      if (!ok) throw Errors.validation([{ path: 'body.leadId', message: 'Lead not found' }]);
    }
    if (contactId) {
      const ok = (await tx.query(`SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [actor.tenantId, contactId])).rowCount;
      if (!ok) throw Errors.validation([{ path: 'body.contactId', message: 'Contact not found' }]);
    }
  }

  private async notifyAssignment(tx: pg.PoolClient, actor: Actor, task: TaskDto) {
    if (!task.assignedTo || task.assignedTo === actor.userId) return;
    await notify(tx, {
      userId: task.assignedTo,
      title: 'New task for you',
      message: task.title,
      type: 'task_assigned',
      link: task.leadId ? `/leads/${task.leadId}` : '/tasks',
      entityType: 'task',
      entityId: task.id,
      dedupeKey: `task-assigned:${task.id}:${task.assignedTo}`,
    });
  }

  private async logLeadActivity(tx: pg.PoolClient, actor: Actor, leadId: string, type: 'task_created' | 'task_completed', description: string, metadata: object) {
    await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,$3,$4::activity_type,$5,$6::jsonb,clock_timestamp())`, [actor.tenantId, leadId, actor.userId, type, description, JSON.stringify(metadata)]);
  }
}

/** A lead's "next follow-up" is derived: the soonest due date among its open tasks (null when there is none). */
export async function syncLeadFollowup(tx: pg.PoolClient, tenantId: string, leadId: string): Promise<void> {
  await tx.query(
    `UPDATE leads SET next_followup_at = (SELECT min(t.due_date) FROM tasks t WHERE t.lead_id = leads.id AND t.tenant_id = leads.tenant_id AND t.deleted_at IS NULL AND t.status IN ('pending','in_progress') AND t.due_date IS NOT NULL)
      WHERE id = $1 AND tenant_id = $2`,
    [leadId, tenantId]
  );
}

/**
 * Lead edit form "next follow-up": kept as one open `follow_up` task so there is a single source of truth
 * (the date shows up in the task list, gets reminders, and drives the lead's follow-up filter).
 */
export async function setLeadFollowup(tx: pg.PoolClient, actor: Actor, leadId: string, dueIso: string | null): Promise<void> {
  const open = (await tx.query(`SELECT id FROM tasks WHERE tenant_id = $1 AND lead_id = $2 AND kind = 'follow_up' AND deleted_at IS NULL AND status IN ('pending','in_progress') ORDER BY created_at LIMIT 1 FOR UPDATE`, [actor.tenantId, leadId])).rows[0];
  if (!dueIso) {
    await tx.query(`UPDATE tasks SET status = 'cancelled' WHERE tenant_id = $1 AND lead_id = $2 AND kind = 'follow_up' AND deleted_at IS NULL AND status IN ('pending','in_progress')`, [actor.tenantId, leadId]);
  } else if (open) {
    await tx.query(`UPDATE tasks SET due_date = $3, remind_at = CASE WHEN remind_before_minutes IS NULL THEN NULL ELSE $3::timestamptz - make_interval(mins => remind_before_minutes) END, reminder_sent_at = NULL, overdue_notified_at = NULL WHERE id = $1 AND tenant_id = $2`, [open.id, actor.tenantId, dueIso]);
  } else {
    const lead = (await tx.query(`SELECT l.owner_id, c.display_name FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE l.id = $1 AND l.tenant_id = $2`, [leadId, actor.tenantId])).rows[0];
    await tx.query(
      `INSERT INTO tasks (tenant_id, title, kind, priority, due_date, remind_before_minutes, remind_at, assigned_to, lead_id, created_by)
       VALUES ($1,$2,'follow_up','medium',$3,15,$3::timestamptz - interval '15 minutes',$4,$5,$6)`,
      [actor.tenantId, `Follow up with ${lead?.display_name ?? 'lead'}`.slice(0, 200), dueIso, lead?.owner_id ?? actor.userId, leadId, actor.userId]
    );
  }
  await syncLeadFollowup(tx, actor.tenantId, leadId);
}
