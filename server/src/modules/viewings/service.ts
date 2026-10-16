import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeFor, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { leadVisibility } from '../leads/pipelines.service';
import { syncLeadFollowup, type TasksService } from '../tasks/service';
import { buildIcs } from './ics';

export const VIEWING_STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];
const OPEN: ViewingStatus[] = ['scheduled', 'confirmed'];

/** What happened at a completed visit. Stable codes (stored), plain labels (shown, may be reworded). */
export const VIEWING_OUTCOMES = [
  { code: 'interested', label: 'Interested and wants to go ahead' },
  { code: 'offer_expected', label: 'Likely to make an offer' },
  { code: 'considering', label: 'Needs time to think' },
  { code: 'wants_other_options', label: 'Wants to see other options' },
  { code: 'not_interested', label: 'Not interested' },
] as const;
export type ViewingOutcome = (typeof VIEWING_OUTCOMES)[number]['code'];
const outcomeLabel = (code: string | null) => VIEWING_OUTCOMES.find((o) => o.code === code)?.label ?? null;

export interface ViewingDto {
  id: string;
  leadId: string;
  propertyId: string;
  agentId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: ViewingStatus;
  notes: string | null;
  version: number;
  outcome: { code: string; label: string } | null;
  outcomeNote: string | null;
  closedAt: string | null;
  cancelReason: string | null;
  /** The task that reminds the agent about this visit (shown once, as the visit, in calendars). */
  reminderTaskId: string | null;
  createdAt: string;
  property: { id: string; title: string; price: number; location: string | null };
  leadContact: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  /** Name only: another person's e-mail address is not part of a calendar entry. */
  agent: { id: string; name: string } | null;
}

export interface ViewingListQuery {
  propertyId?: string;
  leadId?: string;
  status?: ViewingStatus;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}
export interface ScheduleInput {
  leadId: string;
  propertyId: string;
  scheduledAt: string;
  durationMinutes?: number;
  notes?: string | null;
  agentId?: string | null;
}
export interface ReschedulePatch {
  scheduledAt?: string;
  durationMinutes?: number;
  notes?: string | null;
  agentId?: string | null;
}
export interface CompleteInput {
  outcome: ViewingOutcome;
  note?: string | null;
  /** Creates one follow-up task for the lead's owner (or the agent) due at this time. */
  followUp?: { dueAt: string; title?: string | null } | null;
}

const COLUMNS = `
  v.id, v.lead_id AS "leadId", v.property_id AS "propertyId", v.agent_id AS "agentId", v.scheduled_at AS "scheduledAt", v.duration_minutes AS "durationMinutes",
  v.status, v.notes, v.version, v.outcome_code AS "outcomeCode", v.outcome_note AS "outcomeNote", v.closed_at AS "closedAt", v.cancel_reason AS "cancelReason", v.reminder_task_id AS "reminderTaskId",
  v.created_at AS "createdAt", v.updated_at AS "updatedAt", v.scheduled_at::text AS _k,
  p.title AS _p_title, p.price::float8 AS _p_price, COALESCE(p.location, NULLIF(concat_ws(', ', p.locality, p.city), '')) AS _p_location,
  c.first_name AS _c_first, c.last_name AS _c_last, c.email::text AS _c_email, c.phone AS _c_phone, u.name AS _a_name`;
const FROM = `viewings v
  JOIN properties p ON p.id = v.property_id AND p.tenant_id = v.tenant_id
  JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id
  LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
  LEFT JOIN users u ON u.id = v.agent_id`;

function toDto(r: any): ViewingDto {
  return {
    id: r.id, leadId: r.leadId, propertyId: r.propertyId, agentId: r.agentId, scheduledAt: r.scheduledAt, durationMinutes: r.durationMinutes, status: r.status, notes: r.notes, version: r.version,
    outcome: r.outcomeCode ? { code: r.outcomeCode, label: outcomeLabel(r.outcomeCode) ?? r.outcomeCode } : null, outcomeNote: r.outcomeNote, closedAt: r.closedAt, cancelReason: r.cancelReason, reminderTaskId: r.reminderTaskId, createdAt: r.createdAt,
    property: { id: r.propertyId, title: r._p_title, price: r._p_price, location: r._p_location },
    leadContact: { firstName: r._c_first, lastName: r._c_last, email: r._c_email, phone: r._c_phone },
    agent: r.agentId && r._a_name ? { id: r.agentId, name: r._a_name } : null,
  };
}

const buyerName = (r: any) => [r._c_first, r._c_last].filter(Boolean).join(' ').trim() || null;
const fmt = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

interface LockedViewing {
  id: string;
  lead_id: string;
  property_id: string;
  agent_id: string | null;
  scheduled_at: Date;
  duration_minutes: number;
  status: ViewingStatus;
  version: number;
  notes: string | null;
  reminder_task_id: string | null;
  owner_id: string | null;
  lead_deleted: boolean;
}

export class ViewingsService {
  constructor(
    private db: Database,
    private tasks: TasksService
  ) {}

  /** Own-scope roles (sales agents) see the viewings they run or that belong to their own leads; everyone else with access sees all. */
  async list(actor: Actor, q: ViewingListQuery): Promise<{ items: ViewingDto[]; page: PageInfo }> {
    const scope = scopeFor(actor, 'viewings:read');
    const sig = 'viewings:scheduled:asc';
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['v.tenant_id = $1'];
      const push = (v: unknown) => (params.push(v), `$${params.length}`);
      if (scope === 'own') where.push(`(v.agent_id = ${push(actor.userId)} OR l.owner_id = $${params.length})`);
      if (q.propertyId) where.push(`v.property_id = ${push(q.propertyId)}`);
      if (q.leadId) where.push(`v.lead_id = ${push(q.leadId)}`);
      if (q.status) where.push(`v.status = ${push(q.status)}::viewing_status`);
      if (q.from) where.push(`v.scheduled_at >= ${push(q.from)}::timestamptz`);
      if (q.to) where.push(`v.scheduled_at < ${push(q.to)}::timestamptz`);
      const pred = cursorPredicate(cursor, params, 'v.scheduled_at', 'v.id', 'asc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY v.scheduled_at ASC, v.id ASC LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return { items: items.map(toDto), page };
    });
  }

  async get(actor: Actor, id: string): Promise<ViewingDto> {
    const scope = scopeFor(actor, 'viewings:read');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId, id];
      const own = scope === 'own' ? ` AND (v.agent_id = $3 OR l.owner_id = $3)` : '';
      if (scope === 'own') params.push(actor.userId);
      const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.tenant_id = $1 AND v.id = $2${own}`, params);
      if (!r.rows[0]) throw Errors.notFound('Viewing');
      return toDto(r.rows[0]);
    });
  }

  async schedule(actor: Actor, input: ScheduleInput): Promise<ViewingDto> {
    assertCan(actor, 'viewings:create');
    // Only people who may assign work (managers, owners, admins) can book someone else's diary; everyone else books themselves.
    const mayAssign = actor.kind === 'system' || scopeIfAllowed(actor, 'leads:assign') === 'all';
    if (input.agentId && input.agentId !== actor.userId && !mayAssign) throw Errors.forbidden('Only managers can book a viewing for another agent');
    return this.db.withTenant(actor, async (tx) => {
      // The buyer must be one this person is allowed to see (an agent cannot book on a colleague's lead).
      const params: unknown[] = [actor.tenantId, input.leadId];
      const vis = leadVisibility(actor, 'l', params);
      if (vis === false) throw Errors.forbidden();
      const seen = await tx.query(`SELECT 1 FROM leads l WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, params);
      if (!seen.rowCount) throw Errors.notFound('Lead');
      const r = await tx.query(`SELECT app.schedule_viewing($1, $2, $3, $4, $5, $6) AS result`, [input.leadId, input.propertyId, input.scheduledAt, input.durationMinutes ?? 30, input.notes ?? null, input.agentId ?? null]);
      const id = r.rows[0].result.viewing_id as string;
      const dto = await this.fetch(tx, actor.tenantId, id);
      await this.createReminder(tx, actor, dto);
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  /** Move a visit, change its length, notes or agent. Same rules as booking: the unit must still be open to visits and nobody may be double-booked. */
  async reschedule(actor: Actor, id: string, patch: ReschedulePatch, expectedVersion?: number): Promise<ViewingDto> {
    assertCan(actor, 'viewings:update');
    const mayAssign = actor.kind === 'system' || scopeIfAllowed(actor, 'leads:assign') === 'all';
    if (patch.agentId && patch.agentId !== actor.userId && !mayAssign) throw Errors.forbidden('Only managers can hand a viewing to another agent');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await this.lock(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== cur.version) throw Errors.preconditionFailed();
      this.assertOpen(cur);
      if (cur.lead_deleted) throw Errors.conflict('This lead is archived. Restore it before changing its visits.');
      const start = patch.scheduledAt ? new Date(patch.scheduledAt) : cur.scheduled_at;
      const duration = patch.durationMinutes ?? cur.duration_minutes;
      const agentId = patch.agentId === undefined ? cur.agent_id : patch.agentId;
      const notes = patch.notes === undefined ? cur.notes : patch.notes?.trim() || null;
      if (duration < 5 || duration > 480) throw Errors.badRequest('Duration must be between 5 and 480 minutes');
      const end = new Date(start.getTime() + duration * 60_000);

      const prop = (await tx.query(`SELECT status FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [cur.property_id, actor.tenantId])).rows[0];
      if (!prop) throw Errors.notFound('Property');
      if (!['available', 'under_offer'].includes(prop.status)) throw Errors.unprocessable(`This property is ${String(prop.status).replace('_', ' ')}, so its visit cannot be moved. Only available or under-offer properties can be viewed.`);
      if (agentId) {
        const m = await tx.query(`SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.is_active AND u.is_active`, [actor.tenantId, agentId]);
        if (!m.rowCount) throw Errors.badRequest('The chosen agent is not an active member of this workspace');
      }
      const clash = await tx.query(
        `SELECT 1 FROM viewings WHERE tenant_id = $1 AND property_id = $2 AND id <> $3 AND status IN ('scheduled','confirmed') AND (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) OVERLAPS ($4::timestamptz, $5::timestamptz)`,
        [actor.tenantId, cur.property_id, id, start, end]
      );
      if (clash.rowCount) throw Errors.slotUnavailable('Property already has an overlapping appointment in this time window');
      if (agentId) {
        const busy = await tx.query(
          `SELECT 1 FROM viewings WHERE tenant_id = $1 AND agent_id = $2 AND id <> $3 AND status IN ('scheduled','confirmed') AND (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) OVERLAPS ($4::timestamptz, $5::timestamptz)`,
          [actor.tenantId, agentId, id, start, end]
        );
        if (busy.rowCount) throw Errors.slotUnavailable('That agent already has an overlapping viewing');
      }

      await tx.query(`UPDATE viewings SET scheduled_at = $3, duration_minutes = $4, agent_id = $5, notes = $6, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, start, duration, agentId, notes]);
      await this.logActivity(tx, actor, cur.lead_id, id, `Viewing rescheduled to ${fmt(start)}`);
      const dto = await this.fetch(tx, actor.tenantId, id);
      await this.syncReminder(tx, actor, cur, dto);
      await audit(tx, { action: 'viewing.reschedule', entityType: 'viewing', entityId: id, before: { scheduledAt: cur.scheduled_at, durationMinutes: cur.duration_minutes, agentId: cur.agent_id }, after: { scheduledAt: start, durationMinutes: duration, agentId } });
      await emit(tx, { type: 'viewing.updated', aggregateId: id, payload: { change: 'rescheduled', leadId: cur.lead_id } });
      return dto;
    });
  }

  async cancel(actor: Actor, id: string, reason?: string | null): Promise<ViewingDto> {
    assertCan(actor, 'viewings:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await this.lock(tx, actor, id);
      this.assertOpen(cur);
      await tx.query(`UPDATE viewings SET status = 'cancelled', closed_at = now(), cancel_reason = $3, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, reason?.trim() || null]);
      await this.logActivity(tx, actor, cur.lead_id, id, `Viewing cancelled${reason?.trim() ? `: ${reason.trim()}` : ''}`);
      await this.closeReminder(tx, actor, cur, 'cancelled');
      await audit(tx, { action: 'viewing.cancel', entityType: 'viewing', entityId: id, after: { reason: reason?.trim() || null } });
      await emit(tx, { type: 'viewing.updated', aggregateId: id, payload: { change: 'cancelled', leadId: cur.lead_id } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  /** The buyer did not come. Only after the visit was due to start. */
  async noShow(actor: Actor, id: string, note?: string | null): Promise<ViewingDto> {
    assertCan(actor, 'viewings:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await this.lock(tx, actor, id);
      this.assertOpen(cur);
      if (cur.scheduled_at.getTime() > Date.now()) throw Errors.conflict('This visit has not started yet, so it cannot be marked as a no-show');
      await tx.query(`UPDATE viewings SET status = 'no_show', closed_at = now(), outcome_note = $3, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, note?.trim() || null]);
      await this.logActivity(tx, actor, cur.lead_id, id, 'Buyer did not attend the viewing');
      await this.closeReminder(tx, actor, cur, 'cancelled');
      await audit(tx, { action: 'viewing.no_show', entityType: 'viewing', entityId: id });
      await emit(tx, { type: 'viewing.updated', aggregateId: id, payload: { change: 'no_show', leadId: cur.lead_id } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  /**
   * The visit happened. Records what came of it, closes the reminder, optionally creates ONE follow-up task, and suggests (does not make)
   * the next stage for the lead: the person decides, the system only offers.
   */
  async complete(actor: Actor, id: string, input: CompleteInput): Promise<{ viewing: ViewingDto; followUp: { id: string; title: string; dueDate: string | null } | null; suggestedStage: { stageId: string; name: string } | null }> {
    assertCan(actor, 'viewings:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await this.lock(tx, actor, id);
      this.assertOpen(cur);
      if (cur.lead_deleted) throw Errors.conflict('This lead is archived. Restore it before recording the visit.');
      if (cur.scheduled_at.getTime() - Date.now() > 15 * 60_000) throw Errors.conflict('This visit has not started yet. You can record it once it begins.');
      await tx.query(`UPDATE viewings SET status = 'completed', closed_at = now(), outcome_code = $3, outcome_note = $4, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, input.outcome, input.note?.trim() || null]);
      await this.logActivity(tx, actor, cur.lead_id, id, `Viewing completed: ${outcomeLabel(input.outcome)}${input.note?.trim() ? `. ${input.note.trim()}` : ''}`);
      await this.closeReminder(tx, actor, cur, 'completed');

      let followUp: { id: string; title: string; dueDate: string | null } | null = null;
      if (input.followUp) {
        const buyer = await tx.query(`SELECT c.display_name FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE l.id = $1 AND l.tenant_id = $2`, [cur.lead_id, actor.tenantId]);
        const r = await this.tasks.createInTx(
          tx,
          actor,
          { title: (input.followUp.title?.trim() || `Follow up after the visit: ${buyer.rows[0]?.display_name ?? 'buyer'}`).slice(0, 200), kind: 'follow_up', priority: 'high', dueDate: input.followUp.dueAt, assignedTo: scopeIfAllowed(actor, 'tasks:update') === 'all' ? (cur.owner_id ?? cur.agent_id ?? actor.userId) : actor.userId, leadId: cur.lead_id },
          { dedupeKey: `viewing:${id}:followup` }
        );
        followUp = { id: r.task.id, title: r.task.title, dueDate: r.task.dueDate };
      }
      const suggestedStage = await this.suggestStage(tx, actor, cur.lead_id);
      await audit(tx, { action: 'viewing.complete', entityType: 'viewing', entityId: id, after: { outcome: input.outcome, followUp: Boolean(followUp) } });
      await emit(tx, { type: 'viewing.updated', aggregateId: id, payload: { change: 'completed', leadId: cur.lead_id, outcome: input.outcome } });
      return { viewing: await this.fetch(tx, actor.tenantId, id), followUp, suggestedStage };
    });
  }

  /** Calendar file for one viewing. */
  async ics(actor: Actor, id: string): Promise<{ filename: string; body: string }> {
    const scope = scopeFor(actor, 'viewings:read');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId, id];
      const own = scope === 'own' ? ` AND (v.agent_id = $3 OR l.owner_id = $3)` : '';
      if (scope === 'own') params.push(actor.userId);
      const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.tenant_id = $1 AND v.id = $2${own}`, params);
      const row = r.rows[0];
      if (!row) throw Errors.notFound('Viewing');
      const body = buildIcs({ id: row.id, scheduledAt: row.scheduledAt, durationMinutes: row.durationMinutes, status: row.status, notes: row.notes, propertyTitle: row._p_title, propertyLocation: row._p_location, buyerName: buyerName(row), agentName: row._a_name, updatedAt: row.updatedAt, version: row.version });
      return { filename: `site-visit-${String(row.scheduledAt instanceof Date ? row.scheduledAt.toISOString() : row.scheduledAt).slice(0, 10)}.ics`, body };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────

  private assertOpen(v: { status: ViewingStatus }) {
    if (!OPEN.includes(v.status)) throw Errors.conflict(`This visit is already ${v.status === 'no_show' ? 'marked as a no-show' : v.status}`);
  }

  /** Row lock plus the same own-scope rule as reading: an agent only touches visits they run or that belong to their own leads (404 otherwise). */
  private async lock(tx: pg.PoolClient, actor: Actor, id: string): Promise<LockedViewing> {
    const scope = scopeFor(actor, 'viewings:update');
    const r = await tx.query(
      `SELECT v.id, v.lead_id, v.property_id, v.agent_id, v.scheduled_at, v.duration_minutes, v.status, v.version, v.notes, v.reminder_task_id, l.owner_id, (l.deleted_at IS NOT NULL) AS lead_deleted
         FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id
        WHERE v.id = $1 AND v.tenant_id = $2 FOR UPDATE OF v`,
      [id, actor.tenantId]
    );
    const row = r.rows[0] as LockedViewing | undefined;
    if (!row) throw Errors.notFound('Viewing');
    if (scope === 'own' && row.agent_id !== actor.userId && row.owner_id !== actor.userId) throw Errors.notFound('Viewing');
    return row;
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<ViewingDto> {
    const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.tenant_id = $1 AND v.id = $2`, [tenantId, id]);
    if (!r.rows[0]) throw Errors.notFound('Viewing');
    return toDto(r.rows[0]);
  }

  private async logActivity(tx: pg.PoolClient, actor: Actor, leadId: string, viewingId: string, description: string) {
    await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,$3,'viewing',$4,$5::jsonb,clock_timestamp())`, [actor.tenantId, leadId, actor.userId, description, JSON.stringify({ viewing_id: viewingId })]);
  }

  /** A real task, so the visit shows up in "my day", reminds the agent through the normal notification path and counts as the lead's next follow-up. */
  private async createReminder(tx: pg.PoolClient, actor: Actor, v: ViewingDto) {
    const lead = (await tx.query(`SELECT owner_id FROM leads WHERE id = $1 AND tenant_id = $2`, [v.leadId, actor.tenantId])).rows[0];
    const start = new Date(v.scheduledAt);
    const minutesAway = (start.getTime() - Date.now()) / 60_000;
    const buyer = [v.leadContact.firstName, v.leadContact.lastName].filter(Boolean).join(' ') || 'buyer';
    const { task } = await this.tasks.createInTx(
      tx,
      actor,
      { title: `Site visit: ${buyer} at ${v.property.title}`.slice(0, 200), description: v.notes ?? undefined, kind: 'meeting', priority: 'medium', dueDate: start.toISOString(), remindBeforeMinutes: minutesAway > 90 ? 60 : minutesAway > 30 ? 15 : undefined, assignedTo: v.agentId ?? lead?.owner_id ?? null, leadId: v.leadId },
      { dedupeKey: `viewing:${v.id}:reminder` }
    );
    await tx.query(`UPDATE viewings SET reminder_task_id = $3 WHERE id = $1 AND tenant_id = $2`, [v.id, actor.tenantId, task.id]);
  }

  private async syncReminder(tx: pg.PoolClient, actor: Actor, cur: LockedViewing, v: ViewingDto) {
    if (!cur.reminder_task_id) return;
    await tx.query(
      `UPDATE tasks SET due_date = $3, remind_at = CASE WHEN remind_before_minutes IS NULL THEN NULL ELSE $3::timestamptz - make_interval(mins => remind_before_minutes) END,
              reminder_sent_at = NULL, overdue_notified_at = NULL, assigned_to = COALESCE($4, assigned_to)
        WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','in_progress')`,
      [cur.reminder_task_id, actor.tenantId, new Date(v.scheduledAt), v.agentId]
    );
    await syncLeadFollowup(tx, actor.tenantId, cur.lead_id);
  }

  private async closeReminder(tx: pg.PoolClient, actor: Actor, cur: LockedViewing, as: 'completed' | 'cancelled') {
    if (!cur.reminder_task_id) return;
    if (as === 'completed') {
      await tx.query(`UPDATE tasks SET status = 'completed', completed_at = now(), completed_by = $3 WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','in_progress')`, [cur.reminder_task_id, actor.tenantId, actor.userId]);
    } else {
      await tx.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','in_progress')`, [cur.reminder_task_id, actor.tenantId]);
    }
    await syncLeadFollowup(tx, actor.tenantId, cur.lead_id);
  }

  /** "Site visit done" if the lead's pipeline has it and the lead has not reached it; otherwise nothing. Only an offer: the person moves the lead. */
  private async suggestStage(tx: pg.PoolClient, actor: Actor, leadId: string): Promise<{ stageId: string; name: string } | null> {
    const r = await tx.query(
      `SELECT s.id AS "stageId", s.name FROM leads l
         JOIN pipeline_stages cur ON cur.id = l.stage_id AND cur.tenant_id = l.tenant_id
         JOIN pipeline_stages s ON s.pipeline_id = l.pipeline_id AND s.tenant_id = l.tenant_id AND s.stage_key = 'viewing_completed' AND s.archived_at IS NULL
        WHERE l.id = $1 AND l.tenant_id = $2 AND l.closed_at IS NULL AND cur.order_index < s.order_index`,
      [leadId, actor.tenantId]
    );
    return (r.rows[0] as { stageId: string; name: string } | undefined) ?? null;
  }
}
