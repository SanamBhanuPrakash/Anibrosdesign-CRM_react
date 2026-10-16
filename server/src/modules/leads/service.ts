import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, assertCanActOn, canActOn, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { notify } from '../../platform/notifications';
import { emit } from '../../platform/events';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { ContactsService } from '../contacts/service';
import { escapeLike, normalizeTags } from '../contacts/normalize';
import { computeLeadScore, type ScoringConfig } from './scoring';
import { GATE_FIELDS, isClosedStatus, leadVisibility, type GateField, type LeadStatus } from './pipelines.service';
import { toCsv } from './csv';
import { setLeadFollowup } from '../tasks/service';
import { findReason, reasonKindOf, type ReasonKind } from './reason-codes';
import { completeDealInTx, hasCompletedDeal, reverseDealsInTx, type DealInput } from '../deals/ledger';
import { recordFirstTouch, touchFrom } from '../analytics/touches';
import { loadFieldDefs } from '../custom-fields/service';
import { validateCustomFields } from '../custom-fields/validate';
import { channelOf, describeChannels } from './channels';

export const LEAD_SOURCES = ['website', 'referral', 'portal', 'direct', 'meta_ads', 'google_ads', 'walk_in', 'other'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** A routing rule names one source, or `all`: "every lead goes to these people", whatever the source (a specific source rule still wins). */
export const ROUTING_SOURCES = [...LEAD_SOURCES, 'all'] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];
export const ACTIVITY_TYPES = ['note', 'call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_DIRECTIONS = ['outbound', 'inbound'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];
/** What happened when an employee reached out. Stable codes (stored, exported, counted); labels are for screens. */
export const ACTIVITY_OUTCOMES = [
  { code: 'connected', label: 'Spoke to them', forTypes: ['call', 'meeting'] },
  { code: 'no_answer', label: 'No answer', forTypes: ['call'] },
  { code: 'busy', label: 'Busy / call back', forTypes: ['call'] },
  { code: 'voicemail', label: 'Left a voicemail', forTypes: ['call'] },
  { code: 'wrong_number', label: 'Wrong number', forTypes: ['call', 'whatsapp', 'sms'] },
  { code: 'interested', label: 'Interested', forTypes: ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'] },
  { code: 'not_interested', label: 'Not interested', forTypes: ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'] },
  { code: 'appointment_booked', label: 'Appointment / visit booked', forTypes: ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'] },
  { code: 'sent', label: 'Message sent', forTypes: ['whatsapp', 'sms', 'email', 'instagram'] },
  { code: 'replied', label: 'They replied', forTypes: ['whatsapp', 'sms', 'email', 'instagram'] },
] as const;
export const ACTIVITY_OUTCOME_CODES = ACTIVITY_OUTCOMES.map((o) => o.code) as unknown as [string, ...string[]];

export type SlaState = 'none' | 'met' | 'ok' | 'at_risk' | 'breached';

export interface NextStep {
  kind: 'reply' | 'reply_overdue' | 'record_visit' | 'visit' | 'task' | 'plan';
  title: string;
  detail: string;
  dueAt: string | null;
  urgent: boolean;
  viewingId?: string;
  taskId?: string;
}

export interface LeadDto {
  id: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pipelineId: string;
  stageId: string;
  stageName: string;
  stageKey: string | null;
  stageColor: string;
  stageProbability: number;
  status: LeadStatus;
  ownerId: string | null;
  source: LeadSource;
  leadScore: number;
  scoreBreakdown: Array<{ factor: string; points: number; note: string }>;
  estimatedValue: number | null;
  currency: string;
  budgetMin: number | null;
  budgetMax: number | null;
  bedroomsMin: number | null;
  locations: string[];
  propertyTypes: string[];
  listingType: string | null;
  tags: string[];
  campaign: string | null;
  customFields: Record<string, unknown>;
  lossReason: string | null;
  lossReasonCode: string | null;
  closedAt: string | null;
  assignedAt: string | null;
  nextFollowupAt: string | null;
  lastActivityAt: string | null;
  sla: { state: SlaState; dueAt: string | null };
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadInput {
  contactId?: string;
  contact?: { firstName: string; lastName?: string | null; email?: string | null; phone?: string | null };
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  source?: LeadSource;
  estimatedValue?: number | null;
  currency?: string;
  budgetMin?: number | null;
  budgetMax?: number | null;
  bedroomsMin?: number | null;
  locations?: string[];
  propertyTypes?: string[];
  listingType?: string | null;
  tags?: string[];
  campaign?: string | null;
  customFields?: Record<string, unknown>;
  /** Provenance written by intake channels (provider, campaign/ad/form ids, click ids, form answers). Not user-editable. */
  sourceDetails?: Record<string, unknown>;
  nextFollowupAt?: string | null;
  allowDuplicate?: boolean;
}
export type LeadPatch = Partial<Omit<LeadInput, 'contactId' | 'contact' | 'pipelineId' | 'stageId' | 'ownerId' | 'allowDuplicate'>>;

export type LeadSort = 'created' | 'updated' | 'score' | 'value' | 'followup';
export interface LeadFilters {
  q?: string;
  pipelineId?: string;
  stageId?: string;
  status?: LeadStatus[];
  state?: 'open' | 'closed';
  ownerId?: string; // uuid | 'unassigned'
  source?: LeadSource;
  tag?: string;
  scoreMin?: number;
  createdFrom?: string;
  createdTo?: string;
  /** `exclude` leaves out leads tagged test (decision D8): the Dashboard and reports do this by default, so their links pass it. */
  test?: 'exclude';
  contactId?: string;
  sla?: 'breached' | 'at_risk';
  followup?: 'overdue' | 'today';
  /** A custom field of the client (its key) and the value to match: equals for single values, contains for multi-select. */
  field?: string;
  fieldValue?: string;
  /** The pool: open leads nobody owns yet, shown to anyone who may claim leads (callers cannot otherwise see leads that are not theirs). */
  pool?: boolean;
}
export interface LeadListQuery extends LeadFilters {
  limit: number;
  cursor?: string;
  sort: LeadSort;
  order: 'asc' | 'desc';
}

/** "Leads from this source go to these people": the person with the fewest open leads among them gets each new one. */
export interface RoutingRule {
  source: RoutingSource;
  userIds: string[];
}
export interface TenantLeadSettings {
  assignmentMode: 'creator' | 'balanced' | 'unassigned';
  firstResponseMinutes: number;
  scoring: ScoringConfig;
  routing: RoutingRule[];
}

const SORT_KEY: Record<LeadSort, { sql: string; text: string; cast: string; field: string }> = {
  created: { sql: 'l.created_at', text: 'l.created_at::text', cast: '::timestamptz', field: '_k_created' },
  updated: { sql: 'l.updated_at', text: 'l.updated_at::text', cast: '::timestamptz', field: '_k_updated' },
  score: { sql: 'l.lead_score', text: 'l.lead_score::text', cast: '::int', field: '_k_score' },
  value: { sql: "COALESCE(l.estimated_value, 0)", text: "COALESCE(l.estimated_value, 0)::text", cast: '::numeric', field: '_k_value' },
  followup: { sql: "COALESCE(l.next_followup_at, 'infinity'::timestamptz)", text: "COALESCE(l.next_followup_at, 'infinity'::timestamptz)::text", cast: '::timestamptz', field: '_k_followup' },
};

const COLUMNS = `
  l.id, l.contact_id AS "contactId", c.display_name AS "contactName", c.email::text AS "contactEmail", c.phone AS "contactPhone",
  l.pipeline_id AS "pipelineId", l.stage_id AS "stageId", s.name AS "stageName", s.stage_key AS "stageKey", s.color AS "stageColor", s.probability AS "stageProbability",
  l.status, l.owner_id AS "ownerId", l.source, l.lead_score AS "leadScore", l.score_breakdown AS "scoreBreakdown",
  l.estimated_value::float8 AS "estimatedValue", l.currency, l.budget_min::float8 AS "budgetMin", l.budget_max::float8 AS "budgetMax",
  l.bedrooms_min AS "bedroomsMin", l.locations, l.property_types::text[] AS "propertyTypes", l.listing_type::text AS "listingType",
  l.tags, l.campaign, l.custom_fields AS "customFields", l.loss_reason AS "lossReason", l.loss_reason_code AS "lossReasonCode", l.closed_at AS "closedAt", l.assigned_at AS "assignedAt",
  l.next_followup_at AS "nextFollowupAt", l.last_activity_at AS "lastActivityAt", l.first_response_due_at AS "_due", l.first_response_at AS "_resp",
  l.version, l.created_at AS "createdAt", l.updated_at AS "updatedAt",
  l.created_at::text AS _k_created, l.updated_at::text AS _k_updated, l.lead_score::text AS _k_score,
  COALESCE(l.estimated_value, 0)::text AS _k_value, COALESCE(l.next_followup_at, 'infinity'::timestamptz)::text AS _k_followup`;
const FROM = `leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));

export function slaOf(due: Date | string | null, responded: Date | string | null, closed: boolean, createdAt: Date | string, now = new Date()): { state: SlaState; dueAt: string | null } {
  if (responded) return { state: 'met', dueAt: iso(due) };
  if (!due || closed) return { state: 'none', dueAt: iso(due) };
  const dueMs = new Date(due).getTime();
  const total = Math.max(60_000, dueMs - new Date(createdAt).getTime());
  const left = dueMs - now.getTime();
  const state: SlaState = left < 0 ? 'breached' : left < Math.min(total * 0.25, 10 * 60_000) ? 'at_risk' : 'ok';
  return { state, dueAt: iso(due) };
}

function toDto(row: any): LeadDto {
  const { _due, _resp, _k_created, _k_updated, _k_score, _k_value, _k_followup, ...rest } = row;
  return { ...rest, sla: slaOf(_due, _resp, rest.closedAt !== null, rest.createdAt) } as LeadDto;
}

/** Routing rules are stored in the workspace settings; anything that does not look right is ignored rather than trusted. */
export function parseRouting(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) return [];
  const out: RoutingRule[] = [];
  for (const r of raw.slice(0, 16)) {
    if (!r || typeof r !== 'object') continue;
    const source = (r as any).source;
    const ids = (r as any).userIds;
    if (!(ROUTING_SOURCES as readonly string[]).includes(source) || !Array.isArray(ids) || out.some((x) => x.source === source)) continue;
    const userIds = ids.filter((x: unknown): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
    if (userIds.length) out.push({ source, userIds });
  }
  return out;
}

export class LeadsService {
  constructor(
    private db: Database,
    private contacts: ContactsService
  ) {}

  // ── settings ────────────────────────────────────────────────────────────────────────────────────────

  async settings(tx: pg.PoolClient, tenantId: string): Promise<TenantLeadSettings> {
    const r = await tx.query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
    const s = (r.rows[0]?.settings ?? {}) as Record<string, any>;
    const mode = s.leadAssignment;
    const mins = Number(s.sla?.firstResponseMinutes);
    return {
      assignmentMode: mode === 'balanced' || mode === 'unassigned' ? mode : 'creator',
      firstResponseMinutes: Number.isFinite(mins) && mins >= 0 && mins <= 10_080 ? mins : 30,
      scoring: { sourceWeights: s.scoring?.sourceWeights && typeof s.scoring.sourceWeights === 'object' ? s.scoring.sourceWeights : undefined },
      routing: parseRouting(s.routing),
    };
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────

  /** The one place list/export/agency-wide filters become SQL. `params[0]` must be the tenant id; visibility (own/all) is applied here. */
  whereFor(actor: Actor, f: LeadFilters, params: unknown[]): string[] {
    // The pool replaces "only my leads" with "only leads nobody has taken", so a caller never sees someone else's lead through it.
    const pool = f.pool === true && actor.kind === 'user' && scopeIfAllowed(actor, 'leads:claim') !== undefined;
    const vis = pool ? 'l.owner_id IS NULL AND l.closed_at IS NULL' : leadVisibility(actor, 'l', params);
    if (vis === false) throw Errors.forbidden();
    const where = ['l.tenant_id = $1', 'l.deleted_at IS NULL', vis];
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    if (f.pipelineId) where.push(`l.pipeline_id = ${push(f.pipelineId)}`);
    if (f.stageId) where.push(`l.stage_id = ${push(f.stageId)}`);
    if (f.status?.length) where.push(`l.status = ANY(${push(f.status)}::lead_status[])`);
    if (f.state === 'open') where.push('l.closed_at IS NULL');
    if (f.state === 'closed') where.push('l.closed_at IS NOT NULL');
    if (f.ownerId === 'unassigned') where.push('l.owner_id IS NULL');
    else if (f.ownerId) where.push(`l.owner_id = ${push(f.ownerId)}`);
    if (f.source) where.push(`l.source = ${push(f.source)}::lead_source`);
    if (f.tag) where.push(`l.tags @> ${push(normalizeTags([f.tag]))}::text[]`);
    if (f.scoreMin !== undefined) where.push(`l.lead_score >= ${push(f.scoreMin)}`);
    // A date without a time means whole days in the WORKSPACE time zone (createdTo inclusive); a full timestamp is taken as given.
    const tzOf = '(SELECT timezone FROM tenants WHERE id = $1)';
    const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (f.createdFrom) where.push(isDay(f.createdFrom) ? `l.created_at >= (${push(f.createdFrom)}::date)::timestamp AT TIME ZONE ${tzOf}` : `l.created_at >= ${push(f.createdFrom)}::timestamptz`);
    if (f.createdTo) where.push(isDay(f.createdTo) ? `l.created_at < ((${push(f.createdTo)}::date + 1)::timestamp AT TIME ZONE ${tzOf})` : `l.created_at < ${push(f.createdTo)}::timestamptz`);
    if (f.test === 'exclude') where.push(`NOT ('test' = ANY(l.tags))`);
    if (f.field && f.fieldValue !== undefined) {
      const k = `${push(f.field)}::text`;
      const v = `${push(f.fieldValue)}::text`;
      where.push(`(l.custom_fields ->> ${k} = ${v} OR (jsonb_typeof(l.custom_fields -> ${k}) = 'array' AND l.custom_fields -> ${k} ? ${v}))`);
    }
    if (f.contactId) where.push(`l.contact_id = ${push(f.contactId)}`);
    if (f.sla === 'breached') where.push('l.first_response_at IS NULL AND l.closed_at IS NULL AND l.first_response_due_at < now()');
    if (f.sla === 'at_risk') where.push(`l.first_response_at IS NULL AND l.closed_at IS NULL AND l.first_response_due_at >= now() AND l.first_response_due_at - now() < LEAST((l.first_response_due_at - l.created_at) * 0.25, interval '10 minutes')`);
    if (f.followup === 'overdue') where.push('l.next_followup_at < now() AND l.closed_at IS NULL');
    if (f.followup === 'today') where.push(`l.next_followup_at >= date_trunc('day', now()) AND l.next_followup_at < date_trunc('day', now()) + interval '1 day' AND l.closed_at IS NULL`);
    if (f.q?.trim()) {
      const term = f.q.trim().slice(0, 100);
      const like = push(`%${escapeLike(term)}%`);
      const parts = [
        `c.display_name ILIKE ${like}`,
        `l.campaign ILIKE ${like}`,
        `EXISTS (SELECT 1 FROM contact_identifiers i WHERE i.contact_id = l.contact_id AND i.released_at IS NULL AND i.value ILIKE ${like})`,
      ];
      const digits = term.replace(/\D/g, '');
      if (digits.length >= 3) parts.push(`EXISTS (SELECT 1 FROM contact_identifiers i WHERE i.contact_id = l.contact_id AND i.kind = 'phone' AND i.released_at IS NULL AND i.value LIKE ${push(`%${digits}%`)})`);
      where.push(`(${parts.join(' OR ')})`);
    }
    return where;
  }

  async list(actor: Actor, q: LeadListQuery): Promise<{ items: LeadDto[]; page: PageInfo }> {
    assertCan(actor, 'leads:read');
    const sig = `leads:${q.sort}:${q.order}`;
    const cursor = decodeCursor(q.cursor, sig);
    const params: unknown[] = [actor.tenantId];
    const where = this.whereFor(actor, q, params);
    const key = SORT_KEY[q.sort];
    const pred = cursorPredicate(cursor, params, key.sql, 'l.id', q.order, key.cast);
    if (pred) where.push(pred);
    params.push(q.limit + 1);
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${key.sql} ${q.order}, l.id ${q.order} LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r[key.field] as string);
      return { items: items.map(toDto), page };
    });
  }

  async get(actor: Actor, id: string) {
    assertCan(actor, 'leads:read');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId, id];
      const vis = leadVisibility(actor, 'l', params);
      if (vis === false) throw Errors.forbidden();
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, params);
      if (!rows[0]) throw Errors.notFound('Lead');
      const lead = toDto(rows[0]);
      const history = await this.history(tx, actor, id);
      const transitions = await this.allowedTransitions(tx, actor, lead);
      const nextStep = await this.nextStep(tx, actor, lead, rows[0]._due, rows[0]._resp);
      const handlers = await this.handlersIn(tx, actor.tenantId, id);
      return { ...lead, history, transitions, nextStep, handlers };
    });
  }

  /**
   * The ONE thing to do next for this lead, derived from its own data (never typed in): reply, record a visit that has happened, the coming
   * visit, the most urgent open task, or "plan something". The client turns `dueAt` into "in 12 min" / "3 h overdue" so the text never goes stale.
   */
  private async nextStep(tx: pg.PoolClient, actor: Actor, lead: LeadDto, due: Date | string | null, responded: Date | string | null): Promise<NextStep | null> {
    if (lead.closedAt) return null;
    const iso = (d: Date | string) => new Date(d).toISOString();
    if (!responded && due) {
      const late = new Date(due).getTime() < Date.now();
      return { kind: late ? 'reply_overdue' : 'reply', title: late ? 'Reply to this lead: the first reply is overdue' : 'Reply to this lead', detail: 'The first reply stops the response clock. A call, e-mail or meeting logged on the lead counts.', dueAt: iso(due), urgent: late };
    }
    const visit = (
      await tx.query(
        `SELECT v.id, v.scheduled_at, v.duration_minutes, p.title FROM viewings v JOIN properties p ON p.id = v.property_id AND p.tenant_id = v.tenant_id
          WHERE v.tenant_id = $1 AND v.lead_id = $2 AND v.status IN ('scheduled','confirmed') ORDER BY v.scheduled_at LIMIT 1`,
        [actor.tenantId, lead.id]
      )
    ).rows[0];
    if (visit) {
      const ended = new Date(visit.scheduled_at).getTime() + visit.duration_minutes * 60_000 < Date.now();
      return ended
        ? { kind: 'record_visit', title: 'Record how the site visit went', detail: `Visit at ${visit.title}. Say what came of it and plan the follow-up.`, dueAt: iso(visit.scheduled_at), urgent: true, viewingId: visit.id }
        : { kind: 'visit', title: 'Site visit coming up', detail: `At ${visit.title}.`, dueAt: iso(visit.scheduled_at), urgent: false, viewingId: visit.id };
    }
    const task = (
      await tx.query(
        `SELECT k.id, k.title, k.due_date FROM tasks k
          WHERE k.tenant_id = $1 AND k.lead_id = $2 AND k.deleted_at IS NULL AND k.status IN ('pending','in_progress')
            AND NOT EXISTS (SELECT 1 FROM viewings v WHERE v.reminder_task_id = k.id)
          ORDER BY k.due_date NULLS LAST, k.created_at LIMIT 1`,
        [actor.tenantId, lead.id]
      )
    ).rows[0];
    if (task) {
      const overdue = task.due_date && new Date(task.due_date).getTime() < Date.now();
      return { kind: 'task', title: task.title, detail: overdue ? 'This task is overdue.' : 'Your next task for this lead.', dueAt: task.due_date ? iso(task.due_date) : null, urgent: Boolean(overdue), taskId: task.id };
    }
    return { kind: 'plan', title: 'Plan the next step', detail: 'Nothing is planned for this lead yet. Add a follow-up or book a visit so it does not go quiet.', dueAt: null, urgent: false };
  }

  private async history(tx: pg.PoolClient, actor: Actor, leadId: string) {
    const { rows } = await tx.query(
      `SELECT h.id, h.created_at AS "at", h.reason, h.reason_code AS "reasonCode", COALESCE(h.from_stage_name, fs.name) AS "fromStage", COALESCE(h.to_stage_name, ts.name) AS "toStage", u.name AS "changedBy"
         FROM lead_stage_history h LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id JOIN pipeline_stages ts ON ts.id = h.to_stage_id LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.lead_id = $1 AND h.tenant_id = $2 ORDER BY h.created_at DESC, h.id DESC LIMIT 50`,
      [leadId, actor.tenantId]
    );
    return rows as Array<{ id: string; at: string; reason: string | null; reasonCode: string | null; fromStage: string | null; toStage: string; changedBy: string | null }>;
  }

  /** Stages this lead may move to right now (transition matrix applied), with what each move will demand. */
  private async allowedTransitions(tx: pg.PoolClient, actor: Actor, lead: LeadDto) {
    const { rows } = await tx.query(
      `SELECT s.id AS "stageId", s.name, s.color, s.maps_to_status AS status, s.probability,
              COALESCE(t.required_fields, '{}') AS "requiredFields"
         FROM pipeline_stages s
         LEFT JOIN pipeline_stage_transitions t ON t.pipeline_id = s.pipeline_id AND t.is_allowed AND t.to_stage_id = s.id AND t.from_stage_id = $3
        WHERE s.pipeline_id = $1 AND s.tenant_id = $2 AND s.archived_at IS NULL AND s.id <> $3
          AND (NOT EXISTS (SELECT 1 FROM pipeline_stage_transitions x WHERE x.pipeline_id = s.pipeline_id AND x.is_allowed) OR t.id IS NOT NULL
               OR ($4::boolean AND s.maps_to_status NOT IN ('won','lost','disqualified')))
        ORDER BY s.order_index`,
      [lead.pipelineId, actor.tenantId, lead.stageId, lead.closedAt !== null]
    );
    const codesRequired = Boolean((await tx.query(`SELECT reason_codes_required FROM pipelines WHERE id = $1 AND tenant_id = $2`, [lead.pipelineId, actor.tenantId])).rows[0]?.reason_codes_required);
    return rows.map((r) => ({ ...r, requiresReason: r.status === 'lost' || r.status === 'disqualified', reasonKind: reasonKindOf(r.status), reasonCodeRequired: codesRequired && reasonKindOf(r.status) !== null, closes: isClosedStatus(r.status) })) as Array<{
      stageId: string;
      name: string;
      color: string;
      status: LeadStatus;
      probability: number;
      requiredFields: GateField[];
      requiresReason: boolean;
      reasonKind: ReasonKind | null;
      reasonCodeRequired: boolean;
      closes: boolean;
    }>;
  }

  // ── create ──────────────────────────────────────────────────────────────────────────────────────────

  async create(actor: Actor, input: LeadInput): Promise<LeadDto> {
    assertCan(actor, 'leads:create');
    // People (and API keys) saving a lead must fill the client's required fields; intake that has no form to ask them
    // (ad forms, CSV imports, automation) goes through createInTx directly and is not held to it.
    return this.db.withTenant(actor, (tx) => this.createInTx(tx, actor, input, { enforceRequired: actor.kind !== 'system' }));
  }

  /** Lead creation inside the caller's transaction (API, import batches, future webhook/automation intake). */
  async createInTx(tx: pg.PoolClient, actor: Actor, input: LeadInput, opts: { enforceRequired?: boolean } = {}): Promise<LeadDto> {
    assertCan(actor, 'leads:create');
    if (!input.contactId && !input.contact) throw Errors.validation([{ path: 'body.contact', message: 'Provide contactId or a contact (name plus email or phone)' }]);
    {
      const st = await this.settings(tx, actor.tenantId);
      const fields = validateCustomFields(await loadFieldDefs(tx, actor.tenantId), input.customFields, { mode: 'create', enforceRequired: opts.enforceRequired ?? false });
      if (fields.problems.length) throw Errors.validation(fields.problems);
      const now = new Date();

      // contact
      let contactId = input.contactId ?? null;
      if (contactId) {
        const c = await tx.query(`SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [contactId, actor.tenantId]);
        if (!c.rowCount) throw Errors.validation([{ path: 'body.contactId', message: 'Contact not found' }]);
      } else {
        assertCan(actor, 'contacts:create');
        const c = input.contact!;
        if (!c.email && !c.phone) throw Errors.validation([{ path: 'body.contact', message: 'A contact needs an email address or a phone number' }]);
        contactId = (await this.contacts.findOrCreateInTx(tx, { tenantId: actor.tenantId, userId: actor.userId }, c)).id;
      }

      // pipeline / stage
      const pipeline = await tx.query(
        input.pipelineId
          ? `SELECT id FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`
          : `SELECT id FROM pipelines WHERE tenant_id = $2 AND is_default AND archived_at IS NULL AND $1::uuid IS NULL`,
        [input.pipelineId ?? null, actor.tenantId]
      );
      if (!pipeline.rows[0]) throw input.pipelineId ? Errors.validation([{ path: 'body.pipelineId', message: 'Pipeline not found' }]) : Errors.conflict('This workspace has no default pipeline yet');
      const pipelineId = pipeline.rows[0].id as string;
      const stage = await tx.query(
        input.stageId
          ? `SELECT id, probability, maps_to_status AS status FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2 AND tenant_id = $3 AND archived_at IS NULL`
          : `SELECT id, probability, maps_to_status AS status FROM pipeline_stages WHERE $1::uuid IS NULL AND pipeline_id = $2 AND tenant_id = $3 AND archived_at IS NULL ORDER BY order_index LIMIT 1`,
        [input.stageId ?? null, pipelineId, actor.tenantId]
      );
      if (!stage.rows[0]) throw Errors.validation([{ path: 'body.stageId', message: 'Stage not found in this pipeline' }]);
      if (isClosedStatus(stage.rows[0].status)) throw Errors.validation([{ path: 'body.stageId', message: 'A new lead cannot start in a closing stage' }]);

      // duplicates: the same person should not have two open leads in one pipeline
      if (!input.allowDuplicate) {
        const dup = await tx.query(`SELECT id FROM leads WHERE tenant_id = $1 AND contact_id = $2 AND pipeline_id = $3 AND closed_at IS NULL AND deleted_at IS NULL LIMIT 1`, [actor.tenantId, contactId, pipelineId]);
        if (dup.rows[0]) throw Errors.conflict('This contact already has an open lead in this pipeline', { extensions: { reason: 'duplicate_lead', leadId: dup.rows[0].id } });
      }

      const ownerId = await this.resolveOwner(tx, actor, input.ownerId, st, input.source ?? 'other');
      const contactRow = (await tx.query(`SELECT phone, email FROM contacts WHERE id = $1 AND tenant_id = $2`, [contactId, actor.tenantId])).rows[0];
      const source = input.source ?? 'other';
      const { score, factors } = computeLeadScore(
        {
          status: stage.rows[0].status,
          stageProbability: stage.rows[0].probability,
          source,
          hasPhone: Boolean(contactRow?.phone),
          hasEmail: Boolean(contactRow?.email),
          estimatedValue: input.estimatedValue ?? null,
          budgetMax: input.budgetMax ?? null,
          hasRequirements: Boolean(input.locations?.length || input.propertyTypes?.length || input.bedroomsMin),
          lastActivityAt: null,
          createdAt: now,
        },
        st.scoring,
        now
      );

      const ins = await tx.query(
        `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, owner_id, source, estimated_value, currency, budget_min, budget_max, bedrooms_min,
                            locations, property_types, listing_type, tags, campaign, custom_fields, created_by, assigned_at, lead_score, score_breakdown,
                            first_response_due_at, next_followup_at, source_details)
         VALUES ($1,$2,$3,$4,$5,$6::lead_source,$7,$8,$9,$10,$11,$12::text[],$13::property_type_enum[],$14::listing_type_enum,$15::text[],$16,$17::jsonb,$18,
                 CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END,$19,$20::jsonb,
                 CASE WHEN $21::int > 0 THEN now() + make_interval(mins => $21::int) END,$22,$23::jsonb)
         RETURNING id`,
        [
          actor.tenantId, contactId, pipelineId, stage.rows[0].id, ownerId, source, input.estimatedValue ?? null, (input.currency ?? 'INR').toUpperCase(), input.budgetMin ?? null,
          input.budgetMax ?? null, input.bedroomsMin ?? null, (input.locations ?? []).map((l) => l.trim()).filter(Boolean), input.propertyTypes ?? [], input.listingType ?? null,
          normalizeTags(input.tags), input.campaign?.trim() || null, JSON.stringify(fields.set), actor.userId, score, JSON.stringify(factors), st.firstResponseMinutes,
          input.nextFollowupAt ?? null, JSON.stringify(input.sourceDetails ?? {}),
        ]
      );
      const id = ins.rows[0].id as string;
      // where this lead came from, as it was at the time; never edited afterwards (database trigger)
      await recordFirstTouch(tx, actor.tenantId, id, touchFrom({ source, campaign: input.campaign, sourceDetails: input.sourceDetails }));
      await tx.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, changed_by, reason) VALUES ($1,$2,NULL,$3,$4,'Lead created')`, [id, actor.tenantId, stage.rows[0].id, actor.userId]);
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata) VALUES ($1,$2,$3,'note','Lead created',$4::jsonb)`, [actor.tenantId, id, actor.userId, JSON.stringify({ event: 'created', source })]);
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'lead.create', entityType: 'lead', entityId: id, after: { contactId, stageId: dto.stageId, ownerId, source } });
      await emit(tx, { type: 'lead.created', aggregateId: id, payload: { stageId: dto.stageId, ownerId, source, ownerRequested: input.ownerId !== undefined } });
      // Nobody owns it yet: tell the people who can take it, so a lead in the pool does not sit there unseen.
      if (!ownerId) await this.notifyPool(tx, actor, id, dto.contactName);
      return dto;
    }
  }

  /** A new lead has no owner: one notification each for the callers, team leads and admins of this client (not the person who added it). */
  private async notifyPool(tx: pg.PoolClient, actor: Actor, leadId: string, contactName: string | null) {
    const { rows } = await tx.query(
      `SELECT tm.user_id AS id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id AND u.is_active
        WHERE tm.tenant_id = $1 AND tm.status = 'active' AND tm.is_active AND tm.role IN ('sales_agent', 'sales_manager', 'tenant_admin', 'tenant_owner') AND tm.user_id <> $2
        LIMIT 50`,
      [actor.tenantId, actor.userId]
    );
    for (const r of rows) {
      await notify(tx, { userId: r.id, title: 'New lead waiting for an owner', message: contactName ?? 'A new lead', type: 'lead_pool', link: '/leads?owner=unassigned', entityType: 'lead', entityId: leadId, dedupeKey: `pool:${leadId}:${r.id}` });
    }
  }
  /**
   * Managers may assign anyone; agents own what they create. Machine actors follow the workspace assignment mode.
   * A routing rule for the lead's source ("Instagram leads go to Divya and Arjun") comes first for everything except a person adding a
   * lead by hand in "whoever adds it" mode.
   */
  private async resolveOwner(tx: pg.PoolClient, actor: Actor, requested: string | null | undefined, st: TenantLeadSettings, source: string): Promise<string | null> {
    const manager = actor.kind === 'system' || scopeIfAllowed(actor, 'leads:assign') === 'all';
    let owner: string | null;
    if (requested !== undefined) {
      if (!manager && requested !== actor.userId) throw Errors.forbidden('Only managers can assign a lead to someone else');
      owner = requested;
    } else {
      // "whoever adds it" keeps a hand-added lead with its creator, except when the workspace sends EVERYTHING to chosen people
      const routed = await this.routedOwner(tx, actor.tenantId, st, source, { catchAllOnly: actor.kind === 'user' && st.assignmentMode === 'creator' });
      if (routed) owner = routed;
      else if (actor.kind === 'user' && st.assignmentMode === 'creator') owner = actor.userId;
      else if (st.assignmentMode === 'unassigned') owner = null;
      else owner = actor.kind === 'user' && st.assignmentMode !== 'balanced' ? actor.userId : await this.pickBalancedOwner(tx, actor.tenantId);
    }
    if (!owner) return null;
    await this.assertAssignable(tx, actor.tenantId, owner);
    return owner;
  }

  private async assertAssignable(tx: pg.PoolClient, tenantId: string, userId: string) {
    const m = await tx.query(`SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND tm.is_active AND u.is_active`, [tenantId, userId]);
    if (!m.rowCount) throw Errors.validation([{ path: 'body.ownerId', message: 'Owner must be an active member of this workspace' }]);
  }

  /** Least-loaded sales person (open leads), ties broken by who was assigned least recently. Serialised per workspace. */
  async pickBalancedOwner(tx: pg.PoolClient, tenantId: string): Promise<string | null> {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('lead-assign:' || $1, 0))`, [tenantId]);
    for (const roles of [['sales_agent'], ['sales_manager'], ['tenant_admin', 'tenant_owner']]) {
      const { rows } = await tx.query(
        `SELECT tm.user_id AS id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id AND u.is_active
          WHERE tm.tenant_id = $1 AND tm.status = 'active' AND tm.is_active AND tm.role = ANY($2::tenant_role[])
          ORDER BY (SELECT count(*) FROM leads l WHERE l.tenant_id = tm.tenant_id AND l.owner_id = tm.user_id AND l.closed_at IS NULL AND l.deleted_at IS NULL) ASC,
                   (SELECT max(l.assigned_at) FROM leads l WHERE l.tenant_id = tm.tenant_id AND l.owner_id = tm.user_id) ASC NULLS FIRST, tm.created_at LIMIT 1`,
        [tenantId, roles]
      );
      if (rows[0]) return rows[0].id as string;
    }
    return null;
  }

  /**
   * The routing rule for this source, if there is one: the least-busy person among the people it names (only those still active in this
   * client). Null when there is no rule, or nobody on it is available, so the normal assignment mode takes over.
   */
  async routedOwner(tx: pg.PoolClient, tenantId: string, st: TenantLeadSettings, source: string, opts: { catchAllOnly?: boolean } = {}): Promise<string | null> {
    const rule = (opts.catchAllOnly ? undefined : st.routing.find((r) => r.source === source)) ?? st.routing.find((r) => r.source === 'all');
    if (!rule) return null;
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('lead-assign:' || $1, 0))`, [tenantId]);
    const { rows } = await tx.query(
      `SELECT tm.user_id AS id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id AND u.is_active
        WHERE tm.tenant_id = $1 AND tm.status = 'active' AND tm.is_active AND tm.user_id = ANY($2::uuid[]) AND tm.role IN ('sales_agent', 'sales_manager', 'tenant_admin', 'tenant_owner')
        ORDER BY (SELECT count(*) FROM leads l WHERE l.tenant_id = tm.tenant_id AND l.owner_id = tm.user_id AND l.closed_at IS NULL AND l.deleted_at IS NULL) ASC,
                 (SELECT max(l.assigned_at) FROM leads l WHERE l.tenant_id = tm.tenant_id AND l.owner_id = tm.user_id) ASC NULLS FIRST, tm.created_at LIMIT 1`,
      [tenantId, rule.userIds]
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }
  // ── update / move / assign / archive ────────────────────────────────────────────────────────────────

  /** `allowHandler`: someone added to the lead as a handler may act on it too (used for logging work, never for editing, moving or reassigning). */
  private async lockLead(tx: pg.PoolClient, actor: Actor, id: string, permission: 'leads:update' | 'leads:assign' | 'leads:delete', opts: { includeDeleted?: boolean; allowHandler?: boolean } = {}) {
    const { rows } = await tx.query(`SELECT id, owner_id, version, stage_id, pipeline_id, closed_at, deleted_at, contact_id FROM leads WHERE id = $1 AND tenant_id = $2 ${opts.includeDeleted ? '' : 'AND deleted_at IS NULL'} FOR UPDATE`, [id, actor.tenantId]);
    const row = rows[0];
    if (!row) throw Errors.notFound('Lead');
    if (opts.allowHandler && actor.kind === 'user' && !canActOn(actor, permission, row.owner_id)) {
      const h = await tx.query(`SELECT 1 FROM lead_handlers WHERE tenant_id = $1 AND lead_id = $2 AND user_id = $3`, [actor.tenantId, id, actor.userId]);
      if (!h.rowCount) assertCanActOn(actor, permission, row.owner_id);
    } else assertCanActOn(actor, permission, row.owner_id);
    return row as { id: string; owner_id: string | null; version: number; stage_id: string; pipeline_id: string; closed_at: Date | null; deleted_at: Date | null; contact_id: string | null };
  }

  async update(actor: Actor, id: string, patch: LeadPatch, expectedVersion?: number): Promise<LeadDto> {
    assertCan(actor, 'leads:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lockLead(tx, actor, id, 'leads:update');
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Errors.preconditionFailed();
      const before = (await this.fetch(tx, actor.tenantId, id))!;
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, value: unknown, cast = '') => (params.push(value), sets.push(`${col} = $${params.length}${cast}`));
      if (patch.source !== undefined) set('source', patch.source, '::lead_source');
      if (patch.estimatedValue !== undefined) set('estimated_value', patch.estimatedValue);
      if (patch.currency !== undefined) set('currency', patch.currency.toUpperCase());
      if (patch.budgetMin !== undefined) set('budget_min', patch.budgetMin);
      if (patch.budgetMax !== undefined) set('budget_max', patch.budgetMax);
      if (patch.bedroomsMin !== undefined) set('bedrooms_min', patch.bedroomsMin);
      if (patch.locations !== undefined) set('locations', patch.locations.map((l) => l.trim()).filter(Boolean), '::text[]');
      if (patch.propertyTypes !== undefined) set('property_types', patch.propertyTypes, '::property_type_enum[]');
      if (patch.listingType !== undefined) set('listing_type', patch.listingType, '::listing_type_enum');
      if (patch.tags !== undefined) set('tags', normalizeTags(patch.tags), '::text[]');
      if (patch.campaign !== undefined) set('campaign', patch.campaign?.trim() || null);
      if (patch.customFields !== undefined) {
        // The client's own field definitions decide what is valid. Keys not mentioned are left alone (a merge, not a replace), so two
        // people editing different fields of one lead never overwrite each other.
        const v = validateCustomFields(await loadFieldDefs(tx, actor.tenantId), patch.customFields, { mode: 'patch', enforceRequired: actor.kind !== 'system' });
        if (v.problems.length) throw Errors.validation(v.problems);
        params.push(JSON.stringify(v.set), v.clear);
        sets.push(`custom_fields = (custom_fields - $${params.length}::text[]) || $${params.length - 1}::jsonb`);
      }
      if (sets.length) await tx.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      // The follow-up date is a task, not a column: one source of truth that also gets reminders.
      if (patch.nextFollowupAt !== undefined) await setLeadFollowup(tx, actor, id, patch.nextFollowupAt);
      await this.rescore(tx, actor, id);
      const after = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'lead.update', entityType: 'lead', entityId: id, before, after });
      await emit(tx, { type: 'lead.updated', aggregateId: id, payload: { version: after.version } });
      return after;
    });
  }

  async move(actor: Actor, id: string, input: { stageId: string; reason?: string | null; lossReason?: string | null; reasonCode?: string | null; deal?: DealInput }, expectedVersion?: number): Promise<LeadDto> {
    assertCan(actor, 'leads:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lockLead(tx, actor, id, 'leads:update');
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Errors.preconditionFailed();
      await this.moveInTx(tx, actor, row, input);
      return (await this.fetch(tx, actor.tenantId, id))!;
    });
  }

  /** The single place stage changes happen (API, bulk, import, automation): rules, history, activity, audit, event, score. */
  async moveInTx(tx: pg.PoolClient, actor: Actor, row: { id: string; stage_id: string; pipeline_id: string; closed_at: Date | null; owner_id: string | null; contact_id: string | null }, input: { stageId: string; reason?: string | null; lossReason?: string | null; reasonCode?: string | null; deal?: DealInput }) {
    if (input.stageId === row.stage_id) return;
    const to = await tx.query(`SELECT id, name, stage_key, maps_to_status AS status FROM pipeline_stages WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [input.stageId, actor.tenantId]);
    const target = to.rows[0];
    if (!target) throw Errors.validation([{ path: 'body.stageId', message: 'Stage not found' }]);
    const pipelineId = (await tx.query(`SELECT pipeline_id FROM pipeline_stages WHERE id = $1`, [input.stageId])).rows[0].pipeline_id;
    if (pipelineId !== row.pipeline_id) throw Errors.validation([{ path: 'body.stageId', message: 'That stage belongs to a different pipeline' }]);
    const from = (await tx.query(`SELECT id, name, order_index, maps_to_status AS status FROM pipeline_stages WHERE id = $1 AND tenant_id = $2`, [row.stage_id, actor.tenantId])).rows[0];

    // Transition rules describe forward progress. Reopening a closed lead (to any open stage) is always allowed — closing by
    // mistake must never be a dead end — but required-field gates of a matching rule still apply.
    const reopening = row.closed_at !== null && !isClosedStatus(target.status);
    const rules = await tx.query(`SELECT from_stage_id, to_stage_id, required_fields FROM pipeline_stage_transitions WHERE pipeline_id = $1 AND tenant_id = $2 AND is_allowed`, [row.pipeline_id, actor.tenantId]);
    let required: GateField[] = [];
    if (rules.rowCount) {
      const rule = rules.rows.find((r) => r.from_stage_id === row.stage_id && r.to_stage_id === input.stageId);
      if (!rule && !reopening) throw Errors.invalidTransition(`This pipeline does not allow moving a lead from “${from.name}” to “${target.name}”`);
      required = (rule?.required_fields ?? []).filter((f: string): f is GateField => (GATE_FIELDS as readonly string[]).includes(f));
    }
    if (required.length) await this.assertGate(tx, actor, row, required, target.name);

    const closing = target.status === 'lost' || target.status === 'disqualified';
    const kind = reasonKindOf(target.status);
    const word = target.status === 'lost' ? 'lost' : 'not a fit';
    const note = input.lossReason?.trim() || null;
    const codeIn = input.reasonCode?.trim() || null;
    const codesRequired = Boolean((await tx.query(`SELECT reason_codes_required FROM pipelines WHERE id = $1 AND tenant_id = $2`, [row.pipeline_id, actor.tenantId])).rows[0]?.reason_codes_required);
    if (codeIn && !kind) throw Errors.validation([{ path: 'body.reasonCode', message: 'A reason code only applies when moving a lead to Lost or Not a fit' }]);
    const picked = codeIn && kind ? findReason(kind, codeIn) : undefined;
    if (codeIn && kind && !picked) throw Errors.validation([{ path: 'body.reasonCode', message: 'Choose one of the listed reasons' }]);
    if (closing && codesRequired && !picked) throw Errors.validation([{ path: 'body.reasonCode', message: `Choose why this lead is ${word}` }]);
    // "Other" and pipelines without codes need words; a chosen code stands on its own (its label is kept as the written reason)
    if (closing && ((!picked && (!note || note.length < 2)) || (picked?.code === 'other' && (!note || note.length < 2)))) {
      throw Errors.validation([{ path: 'body.lossReason', message: picked ? 'Explain the reason in a few words' : `Say why this lead is ${word}` }]);
    }
    const lossReason = closing ? note || picked?.label || null : null;
    const reasonCode = closing ? picked?.code ?? null : null;

    // Decision D3: a completed sale is Won AND a recorded deal value tied to a unit. Pipelines that require it refuse Won without one.
    const winning = target.status === 'won';
    if (winning && !input.deal) {
      const needs = Boolean((await tx.query(`SELECT deal_value_required FROM pipelines WHERE id = $1 AND tenant_id = $2`, [row.pipeline_id, actor.tenantId])).rows[0]?.deal_value_required);
      if (needs) {
        throw Errors.unprocessable('Record the deal value and the unit that was sold before marking this lead as won', { extensions: { reason: 'deal_value_required' } });
      }
    }
    // A recorded sale is taken back when its lead is reopened (the unit is released), which only people who manage inventory may do.
    const leavingWon = from.status === 'won' && target.status !== 'won';
    if (leavingWon && (await hasCompletedDeal(tx, actor.tenantId, row.id))) {
      const mayRelease = actor.kind === 'system' || (scopeIfAllowed(actor, 'reservations:update') === 'all' && scopeIfAllowed(actor, 'properties:update') === 'all');
      if (!mayRelease) throw Errors.forbidden('This lead has a recorded sale. A manager has to reopen it, because the unit becomes available again.');
    }
    if (winning && input.deal) await completeDealInTx(tx, actor, row, input.deal);
    if (leavingWon) await reverseDealsInTx(tx, actor, row.id, input.reason?.trim() || input.lossReason?.trim() || (closing ? 'Lead closed another way' : 'Lead reopened'));

    const first = (await tx.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY order_index LIMIT 1`, [row.pipeline_id, actor.tenantId])).rows[0];
    await tx.query(
      `UPDATE leads SET stage_id = $3, loss_reason = $4, loss_reason_code = $6, first_response_at = CASE WHEN first_response_at IS NULL AND $5::boolean THEN now() ELSE first_response_at END
        WHERE id = $1 AND tenant_id = $2`,
      [row.id, actor.tenantId, input.stageId, lossReason, first?.id === row.stage_id, reasonCode]
    );
    const reason = input.reason?.trim() || (reopening ? 'Reopened' : closing ? lossReason : null);
    // clock_timestamp(), not now(): now() is the transaction START, and a move that waited for the row lock would sort before
    // the move it actually followed.
    await tx.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, changed_by, reason, reason_code, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`, [row.id, actor.tenantId, row.stage_id, input.stageId, actor.userId, reason, reasonCode]);
    await tx.query(
      `INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,$3,'stage_change',$4,$5::jsonb,clock_timestamp())`,
      [actor.tenantId, row.id, actor.userId, `Moved from ${from.name} to ${target.name}`, JSON.stringify({ fromStageId: row.stage_id, toStageId: input.stageId, reason, lossReason: closing ? lossReason : undefined, reasonCode: reasonCode ?? undefined })]
    );
    await this.rescore(tx, actor, row.id);
    await audit(tx, { action: 'lead.stage_change', entityType: 'lead', entityId: row.id, before: { stageId: row.stage_id }, after: { stageId: input.stageId, status: target.status, reason, reasonCode } });
    await emit(tx, { type: 'lead.stage_changed', aggregateId: row.id, payload: { fromStageId: row.stage_id, toStageId: input.stageId, status: target.status } });
  }

  private async assertGate(tx: pg.PoolClient, actor: Actor, row: { id: string; contact_id: string | null }, fields: GateField[], stageName: string) {
    const { rows } = await tx.query(
      `SELECT l.owner_id, l.estimated_value, l.budget_max, l.next_followup_at, c.phone, c.email::text AS email FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE l.id = $1 AND l.tenant_id = $2`,
      [row.id, actor.tenantId]
    );
    const r = rows[0];
    const have: Record<GateField, boolean> = { ownerId: Boolean(r.owner_id), estimatedValue: r.estimated_value !== null, budgetMax: r.budget_max !== null, phone: Boolean(r.phone), email: Boolean(r.email), nextFollowupAt: Boolean(r.next_followup_at) };
    const label: Record<GateField, string> = { ownerId: 'an owner', estimatedValue: 'an estimated value', budgetMax: 'a maximum budget', phone: 'a phone number', email: 'an email address', nextFollowupAt: 'a next follow-up date' };
    const missing = fields.filter((f) => !have[f]);
    if (missing.length) {
      throw Errors.unprocessable(`Before moving to “${stageName}” this lead needs ${missing.map((m) => label[m]).join(', ')}`, { extensions: { reason: 'missing_required_fields', missing } });
    }
  }

  async assign(actor: Actor, id: string, ownerId: string | null): Promise<LeadDto> {
    assertCan(actor, 'leads:assign');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lockLead(tx, actor, id, 'leads:assign');
      await this.assignInTx(tx, actor, row, ownerId);
      return (await this.fetch(tx, actor.tenantId, id))!;
    });
  }

  /**
   * Take a lead nobody owns yet (the pool). Anyone who may claim can do it, and two people clicking at once is safe: the lead is locked and
   * only one of them finds it still unowned; the other is told so instead of silently taking it over.
   */
  async claim(actor: Actor, id: string): Promise<LeadDto> {
    assertCan(actor, 'leads:claim');
    return this.db.withTenant(actor, async (tx) => {
      const { rows } = await tx.query(`SELECT id, owner_id, closed_at FROM leads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      const row = rows[0] as { id: string; owner_id: string | null; closed_at: Date | null } | undefined;
      if (!row) throw Errors.notFound('Lead');
      if (row.owner_id === actor.userId) return (await this.fetch(tx, actor.tenantId, id))!;
      if (row.closed_at) throw Errors.conflict('This lead is closed');
      if (row.owner_id) throw Errors.conflict('Someone else has already taken this lead', { extensions: { reason: 'already_claimed' } });
      await this.assignInTx(tx, actor, row, actor.userId, 'claimed');
      return (await this.fetch(tx, actor.tenantId, id))!;
    });
  }

  async assignInTx(tx: pg.PoolClient, actor: Actor, row: { id: string; owner_id: string | null }, ownerId: string | null, how: 'assigned' | 'claimed' = 'assigned') {
    if (ownerId === row.owner_id) return;
    if (ownerId) await this.assertAssignable(tx, actor.tenantId, ownerId);
    await tx.query(`UPDATE leads SET owner_id = $3, assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END WHERE id = $1 AND tenant_id = $2`, [row.id, actor.tenantId, ownerId]);
    const text = how === 'claimed' ? 'Lead claimed' : ownerId ? 'Lead reassigned' : 'Lead unassigned';
    await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata) VALUES ($1,$2,$3,'note',$4,$5::jsonb)`, [actor.tenantId, row.id, actor.userId, text, JSON.stringify({ event: 'assigned', how, from: row.owner_id, to: ownerId })]);
    await audit(tx, { action: how === 'claimed' ? 'lead.claim' : 'lead.assign', entityType: 'lead', entityId: row.id, before: { ownerId: row.owner_id }, after: { ownerId } });
    await emit(tx, { type: 'lead.assigned', aggregateId: row.id, payload: { from: row.owner_id, to: ownerId } });
  }

  // ── specialists and handlers ──────────────────────────────────────────────────────────────────────

  /** What kinds of work this person may log in this client (null = everything). */
  async workChannelsOf(tx: pg.PoolClient, tenantId: string, userId: string | null): Promise<string[] | null> {
    if (!userId) return null;
    const r = await tx.query(`SELECT work_channels FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND is_active`, [tenantId, userId]);
    return (r.rows[0]?.work_channels as string[] | null | undefined) ?? null;
  }

  /** A person who handles WhatsApp only cannot log a phone call: the record of who did what must be true. Notes are always fine. */
  private async assertMayLog(tx: pg.PoolClient, actor: Actor, type: string) {
    const channel = channelOf(type);
    if (!channel || actor.kind !== 'user') return;
    const allowed = await this.workChannelsOf(tx, actor.tenantId, actor.userId);
    if (allowed && !allowed.includes(channel)) throw Errors.forbidden(`You handle ${describeChannels(allowed)} for this client, so you can’t log ${channel === 'call' ? 'a phone call' : channel === 'meeting' ? 'a visit or meeting' : channel === 'sms' ? 'a text message' : channel === 'email' ? 'an e-mail' : `${channel === 'instagram' ? 'an Instagram' : 'a WhatsApp'} message`}`);
  }

  async handlers(actor: Actor, leadId: string) {
    assertCan(actor, 'leads:read');
    const params: unknown[] = [actor.tenantId, leadId];
    const vis = leadVisibility(actor, 'l', params);
    if (vis === false) throw Errors.forbidden();
    return this.db.readTenant(actor, async (tx) => {
      const ok = await tx.query(`SELECT 1 FROM leads l WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, params);
      if (!ok.rowCount) throw Errors.notFound('Lead');
      return this.handlersIn(tx, actor.tenantId, leadId);
    });
  }

  private async handlersIn(tx: pg.PoolClient, tenantId: string, leadId: string) {
    const { rows } = await tx.query(
      `SELECT h.user_id AS "userId", u.name, tm.work_channels AS "workChannels", h.created_at AS "addedAt"
         FROM lead_handlers h JOIN users u ON u.id = h.user_id LEFT JOIN tenant_memberships tm ON tm.tenant_id = h.tenant_id AND tm.user_id = h.user_id
        WHERE h.tenant_id = $1 AND h.lead_id = $2 ORDER BY h.created_at`,
      [tenantId, leadId]
    );
    return rows as Array<{ userId: string; name: string; workChannels: string[] | null; addedAt: string }>;
  }

  /** The owner stays accountable; a handler is somebody else who works the lead (the caller, the WhatsApp person, the one who does the visit). */
  async addHandler(actor: Actor, leadId: string, userId: string) {
    assertCan(actor, 'leads:assign');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lockLead(tx, actor, leadId, 'leads:assign');
      if (row.owner_id === userId) throw Errors.conflict('This person already owns the lead');
      const m = await tx.query(
        `SELECT tm.role, u.name FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id AND u.is_active WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND tm.is_active`,
        [actor.tenantId, userId]
      );
      if (!m.rows[0] || !['sales_agent', 'sales_manager', 'tenant_admin', 'tenant_owner'].includes(m.rows[0].role)) throw Errors.validation([{ path: 'body.userId', message: 'Choose someone who works leads in this client' }]);
      const ins = await tx.query(`INSERT INTO lead_handlers (tenant_id, lead_id, user_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`, [actor.tenantId, leadId, userId, actor.userId]);
      if (ins.rowCount) {
        await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata) VALUES ($1,$2,$3,'note',$4,$5::jsonb)`, [actor.tenantId, leadId, actor.userId, `${m.rows[0].name} was added to work on this lead`, JSON.stringify({ event: 'assigned', how: 'handler', to: userId })]);
        await audit(tx, { action: 'lead.handler_add', entityType: 'lead', entityId: leadId, after: { userId } });
        if (userId !== actor.userId) await notify(tx, { userId, title: 'You were added to a lead', message: 'You can log your calls and messages on it.', type: 'lead_assigned', link: `/leads/${leadId}`, entityType: 'lead', entityId: leadId, dedupeKey: `handler:${leadId}:${userId}` });
      }
      return this.handlersIn(tx, actor.tenantId, leadId);
    });
  }

  async removeHandler(actor: Actor, leadId: string, userId: string) {
    assertCan(actor, 'leads:assign');
    return this.db.withTenant(actor, async (tx) => {
      await this.lockLead(tx, actor, leadId, 'leads:assign');
      const del = await tx.query(`DELETE FROM lead_handlers WHERE tenant_id = $1 AND lead_id = $2 AND user_id = $3 RETURNING user_id`, [actor.tenantId, leadId, userId]);
      if (del.rowCount) await audit(tx, { action: 'lead.handler_remove', entityType: 'lead', entityId: leadId, before: { userId } });
      return this.handlersIn(tx, actor.tenantId, leadId);
    });
  }

  async archive(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'leads:delete');
    await this.db.withTenant(actor, async (tx) => {
      const row = await this.lockLead(tx, actor, id, 'leads:delete');
      await tx.query(`UPDATE leads SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      await audit(tx, { action: 'lead.delete', entityType: 'lead', entityId: id, before: { stageId: row.stage_id, ownerId: row.owner_id } });
      await emit(tx, { type: 'lead.deleted', aggregateId: id });
    });
  }

  async restore(actor: Actor, id: string): Promise<LeadDto> {
    assertCan(actor, 'leads:delete');
    return this.db.withTenant(actor, async (tx) => {
      await this.lockLead(tx, actor, id, 'leads:delete', { includeDeleted: true });
      const r = await tx.query(`UPDATE leads SET deleted_at = NULL WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL RETURNING id`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Archived lead');
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'lead.restore', entityType: 'lead', entityId: id });
      await emit(tx, { type: 'lead.updated', aggregateId: id, payload: { restored: true } });
      return dto;
    });
  }

  // ── bulk ────────────────────────────────────────────────────────────────────────────────────────────

  async bulk(
    actor: Actor,
    input: { ids: string[]; action: 'assign' | 'move_stage' | 'add_tags' | 'remove_tags' | 'archive'; ownerId?: string | null; stageId?: string; lossReason?: string; reasonCode?: string; tags?: string[] }
  ): Promise<{ updated: number; skipped: Array<{ id: string; reason: string }> }> {
    assertCan(actor, 'leads:bulk');
    const ids = [...new Set(input.ids)];
    return this.db.withTenant(actor, async (tx) => {
      const skipped: Array<{ id: string; reason: string }> = [];
      let updated = 0;
      for (const id of ids) {
        await tx.query('SAVEPOINT bulk_item');
        try {
          const perm = input.action === 'assign' ? 'leads:assign' : input.action === 'archive' ? 'leads:delete' : 'leads:update';
          const row = await this.lockLead(tx, actor, id, perm);
          if (input.action === 'assign') await this.assignInTx(tx, actor, row, input.ownerId ?? null);
          else if (input.action === 'move_stage') await this.moveInTx(tx, actor, row, { stageId: input.stageId!, lossReason: input.lossReason, reasonCode: input.reasonCode });
          else if (input.action === 'archive') {
            await tx.query(`UPDATE leads SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
            await audit(tx, { action: 'lead.delete', entityType: 'lead', entityId: id, after: { bulk: true } });
            await emit(tx, { type: 'lead.deleted', aggregateId: id });
          } else {
            const tags = normalizeTags(input.tags);
            await tx.query(
              input.action === 'add_tags'
                ? `UPDATE leads SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || $3::text[]) t) WHERE id = $1 AND tenant_id = $2 AND cardinality((SELECT array_agg(DISTINCT t) FROM unnest(tags || $3::text[]) t)) <= 30`
                : `UPDATE leads SET tags = COALESCE((SELECT array_agg(t) FROM unnest(tags) t WHERE NOT t = ANY($3::text[])), '{}') WHERE id = $1 AND tenant_id = $2`,
              [id, actor.tenantId, tags]
            );
            await audit(tx, { action: `lead.${input.action}`, entityType: 'lead', entityId: id, after: { tags } });
            await emit(tx, { type: 'lead.updated', aggregateId: id, payload: { tags: true } });
          }
          await tx.query('RELEASE SAVEPOINT bulk_item');
          updated++;
        } catch (e: any) {
          await tx.query('ROLLBACK TO SAVEPOINT bulk_item');
          // Programmer/DB errors must not be swallowed as "skipped".
          if (!e?.status || e.status >= 500) throw e;
          skipped.push({ id, reason: e.errors?.[0]?.message ?? e.detail ?? e.message });
        }
      }
      await audit(tx, { action: 'lead.bulk', entityType: 'lead', entityId: ids[0] ?? actor.tenantId, after: { action: input.action, requested: ids.length, updated, skipped: skipped.length } });
      return { updated, skipped };
    });
  }

  // ── activities ──────────────────────────────────────────────────────────────────────────────────────

  async activities(actor: Actor, leadId: string, q: { limit: number; cursor?: string }) {
    assertCan(actor, 'activities:read');
    const sig = 'activities:occurred:desc';
    const cursor = decodeCursor(q.cursor, sig);
    const leadParams: unknown[] = [actor.tenantId, leadId];
    const vis = leadVisibility(actor, 'l', leadParams);
    if (vis === false) throw Errors.forbidden();
    const params: unknown[] = [actor.tenantId, leadId];
    const pred = cursorPredicate(cursor, params, 'a.created_at', 'a.id', 'desc', '::timestamptz');
    params.push(q.limit + 1);
    return this.db.readTenant(actor, async (tx) => {
      const lead = await tx.query(`SELECT 1 FROM leads l WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, leadParams);
      if (!lead.rowCount) throw Errors.notFound('Lead');
      const { rows } = await tx.query(
        `SELECT a.id, a.type, a.description, a.metadata, a.direction, a.outcome, a.duration_minutes AS "durationMinutes", a.created_at AS "createdAt", a.created_at::text AS _k, u.name AS "userName", a.user_id AS "userId"
           FROM activities a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = $1 AND a.lead_id = $2 ${pred ? `AND ${pred}` : ''} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string; _k: string } & Record<string, unknown>>, q.limit, sig, (r) => r._k);
      return { items: items.map(({ _k, ...rest }) => rest), page };
    });
  }

  async logActivity(
    actor: Actor,
    leadId: string,
    input: { type: ActivityType; description: string; direction?: ActivityDirection; outcome?: string; occurredAt?: string; durationMinutes?: number; nextFollowupAt?: string | null },
    /** Used by sending (e-mail / WhatsApp): extra facts stored on the activity and a step that runs in the SAME transaction (so the record and its send job exist together or not at all). */
    opts: { metadata?: Record<string, unknown>; after?: (tx: pg.PoolClient, activity: { id: string }) => Promise<void> } = {}
  ) {
    assertCan(actor, 'activities:create');
    const problems: Array<{ path: string; message: string }> = [];
    const outcomeDef = input.outcome ? ACTIVITY_OUTCOMES.find((o) => o.code === input.outcome) : undefined;
    if (input.outcome && !outcomeDef) problems.push({ path: 'body.outcome', message: 'Choose one of the listed outcomes' });
    else if (outcomeDef && !(outcomeDef.forTypes as readonly string[]).includes(input.type)) problems.push({ path: 'body.outcome', message: `“${outcomeDef.label}” does not apply to a ${input.type}` });
    if (input.direction && (input.type === 'note' || input.type === 'meeting')) problems.push({ path: 'body.direction', message: `A ${input.type} has no direction` });
    if (input.durationMinutes !== undefined && input.type !== 'call' && input.type !== 'meeting') problems.push({ path: 'body.durationMinutes', message: 'Only calls and meetings have a duration' });
    if (problems.length) throw Errors.validation(problems);
    // Calls, messages and e-mails default to outbound (we reached out); a lead writing to us is logged as inbound.
    const direction = input.type === 'note' || input.type === 'meeting' ? null : (input.direction ?? 'outbound');

    return this.db.withTenant(actor, async (tx) => {
      await this.lockLead(tx, actor, leadId, 'leads:update', { allowHandler: true });
      await this.assertMayLog(tx, actor, input.type);
      const when = input.occurredAt ? new Date(input.occurredAt) : new Date();
      if (when.getTime() > Date.now() + 5 * 60_000) throw Errors.validation([{ path: 'body.occurredAt', message: 'Activities cannot be in the future' }]);
      const ins = await tx.query(
        `INSERT INTO activities (tenant_id, lead_id, user_id, type, description, direction, outcome, duration_minutes, metadata, created_at)
         VALUES ($1,$2,$3,$4::activity_type,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING id, type, description, direction, outcome, duration_minutes AS "durationMinutes", metadata, created_at AS "createdAt", user_id AS "userId"`,
        [actor.tenantId, leadId, actor.userId, input.type, input.description.trim(), direction, input.outcome ?? null, input.durationMinutes ?? null, JSON.stringify({ outcome: input.outcome, durationMinutes: input.durationMinutes, ...(opts.metadata ?? {}) }), when]
      );
      if (opts.after) await opts.after(tx, ins.rows[0]);
      // An outbound touch (not a plain note, not the lead writing to us) answers the lead: it stops the first-response clock.
      // Any touch counts as engagement for the score.
      await tx.query(
        `UPDATE leads SET last_activity_at = GREATEST(COALESCE(last_activity_at, $3), $3),
                first_response_at = CASE WHEN first_response_at IS NULL AND $4::boolean THEN $3 ELSE first_response_at END
          WHERE id = $1 AND tenant_id = $2`,
        [leadId, actor.tenantId, when, input.type !== 'note' && direction !== 'inbound']
      );
      if (input.nextFollowupAt !== undefined) await setLeadFollowup(tx, actor, leadId, input.nextFollowupAt);
      await this.rescore(tx, actor, leadId);
      await audit(tx, { action: 'activity.create', entityType: 'lead', entityId: leadId, after: { type: input.type, direction, outcome: input.outcome ?? null, activityId: ins.rows[0].id } });
      await emit(tx, { type: 'activity.created', aggregateId: ins.rows[0].id, payload: { leadId, type: input.type } });
      return ins.rows[0];
    });
  }

  // ── board & forecast ────────────────────────────────────────────────────────────────────────────────

  async board(actor: Actor, pipelineId: string, f: { ownerId?: string; q?: string; perStage: number }) {
    assertCan(actor, 'leads:read');
    assertCan(actor, 'pipeline:read');
    const params: unknown[] = [actor.tenantId];
    const where = this.whereFor(actor, { pipelineId, ownerId: f.ownerId, q: f.q }, params);
    params.push(f.perStage);
    return this.db.readTenant(actor, async (tx) => {
      const [cards, totals] = await Promise.all([
        tx.query(
          `SELECT * FROM (SELECT ${COLUMNS}, row_number() OVER (PARTITION BY l.stage_id ORDER BY l.updated_at DESC, l.id DESC) AS _rn FROM ${FROM} WHERE ${where.join(' AND ')}) r WHERE _rn <= $${params.length}`,
          params
        ),
        tx.query(`SELECT l.stage_id AS "stageId", count(*)::int AS count, COALESCE(sum(l.estimated_value), 0)::float8 AS value FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE ${where.join(' AND ')} GROUP BY l.stage_id`, params.slice(0, -1)),
      ]);
      const byStage = new Map<string, LeadDto[]>();
      for (const r of cards.rows) {
        const { _rn, ...row } = r;
        const list = byStage.get(r.stageId) ?? [];
        list.push(toDto(row));
        byStage.set(r.stageId, list);
      }
      const stages = await tx.query(`SELECT id, name, color, order_index AS "orderIndex", maps_to_status AS "mapsToStatus", probability FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY order_index`, [pipelineId, actor.tenantId]);
      if (!stages.rowCount) throw Errors.notFound('Pipeline');
      const tot = new Map(totals.rows.map((t) => [t.stageId as string, t]));
      return {
        stages: stages.rows.map((s) => ({ ...s, isClosed: isClosedStatus(s.mapsToStatus), count: tot.get(s.id)?.count ?? 0, value: tot.get(s.id)?.value ?? 0, leads: byStage.get(s.id) ?? [] })),
      };
    });
  }

  /** Weighted pipeline: open value × stage probability. Values are summed in the workspace currency as stored (no FX). */
  async forecast(actor: Actor, pipelineId: string) {
    assertCan(actor, 'leads:read');
    assertCan(actor, 'pipeline:read');
    const params: unknown[] = [actor.tenantId, pipelineId];
    const vis = leadVisibility(actor, 'l', params);
    if (vis === false) throw Errors.forbidden();
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT s.id AS "stageId", s.name, s.maps_to_status AS status, s.probability, s.order_index,
                count(l.id)::int AS count, COALESCE(sum(l.estimated_value), 0)::float8 AS value,
                COALESCE(sum(l.estimated_value * s.probability / 100.0), 0)::float8 AS weighted
           FROM pipeline_stages s LEFT JOIN leads l ON l.stage_id = s.id AND l.tenant_id = s.tenant_id AND l.deleted_at IS NULL AND ${vis}
          WHERE s.pipeline_id = $2 AND s.tenant_id = $1 AND s.archived_at IS NULL GROUP BY s.id ORDER BY s.order_index`,
        params
      );
      if (!rows.length) throw Errors.notFound('Pipeline');
      // D3: "won deal value" is the sum of recorded sales, never the estimate typed on the lead
      const deals = (
        await tx.query(
          `SELECT COALESCE(sum(r.deal_value), 0)::float8 AS v, count(DISTINCT l.id)::int AS n FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
            WHERE r.status = 'completed' AND r.tenant_id = $1 AND l.pipeline_id = $2 AND l.status = 'won' AND l.deleted_at IS NULL AND ${vis}`,
          params
        )
      ).rows[0];
      const open = rows.filter((r) => !isClosedStatus(r.status));
      const sum = (rs: typeof rows, k: 'count' | 'value' | 'weighted') => rs.reduce((a, r) => a + r[k], 0);
      return {
        stages: rows.map(({ order_index, ...r }) => ({ ...r, isClosed: isClosedStatus(r.status) })),
        open: { count: sum(open, 'count'), value: sum(open, 'value'), weighted: Math.round(sum(open, 'weighted') * 100) / 100 },
        won: (() => {
          const count = sum(rows.filter((r) => r.status === 'won'), 'count');
          return { count, value: sum(rows.filter((r) => r.status === 'won'), 'value'), dealValue: Number(deals.v), withoutDealValue: Math.max(0, count - Number(deals.n)) };
        })(),
      };
    });
  }

  // ── export ──────────────────────────────────────────────────────────────────────────────────────────

  async exportCsv(actor: Actor, f: LeadFilters): Promise<{ csv: string; rows: number }> {
    assertCan(actor, 'leads:export');
    const params: unknown[] = [actor.tenantId];
    const where = this.whereFor(actor, f, params);
    return this.db.withTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT l.id, l.created_at, c.display_name AS contact, c.email::text AS email, c.phone, s.name AS stage, l.status, o.name AS owner, l.source, l.lead_score,
                l.estimated_value, l.currency, l.budget_min, l.budget_max, l.locations, l.tags, l.campaign, l.next_followup_at, l.loss_reason
           FROM ${FROM} LEFT JOIN users o ON o.id = l.owner_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT 20001`,
        params
      );
      if (rows.length > 20000) throw Errors.unprocessable('That is more than 20,000 leads. Narrow the filters (for example by date) and export in parts.');
      await audit(tx, { action: 'lead.export', entityType: 'lead', entityId: actor.tenantId, after: { rows: rows.length, filters: f } });
      const header = ['Lead ID', 'Created', 'Contact', 'Email', 'Phone', 'Stage', 'Status', 'Owner', 'Source', 'Score', 'Estimated value', 'Currency', 'Budget min', 'Budget max', 'Locations', 'Tags', 'Campaign', 'Next follow-up', 'Loss reason'];
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return {
        rows: rows.length,
        csv: toCsv(header, rows.map((r) => [r.id, r.created_at, r.contact, r.email, r.phone, r.stage, r.status, r.owner, r.source, r.lead_score, num(r.estimated_value), r.currency, num(r.budget_min), num(r.budget_max), r.locations, r.tags, r.campaign, r.next_followup_at, r.loss_reason])),
      };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<LeadDto | undefined> {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE l.id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL`, [id, tenantId]);
    return rows[0] ? toDto(rows[0]) : undefined;
  }

  /** Recompute the explainable score from current data and store it (only when it changed, to keep rows quiet). */
  async rescore(tx: pg.PoolClient, actor: { tenantId: string }, leadId: string) {
    const { rows } = await tx.query(
      `SELECT l.status, s.probability, l.source, c.phone, c.email::text AS email, l.estimated_value::float8 AS ev, l.budget_max::float8 AS bmax,
              (cardinality(l.locations) > 0 OR cardinality(l.property_types) > 0 OR l.bedrooms_min IS NOT NULL) AS req,
              l.last_activity_at, l.created_at, l.lead_score
         FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
        WHERE l.id = $1 AND l.tenant_id = $2`,
      [leadId, actor.tenantId]
    );
    const r = rows[0];
    if (!r) return;
    const st = await this.settings(tx, actor.tenantId);
    const { score, factors } = computeLeadScore(
      { status: r.status, stageProbability: r.probability, source: r.source, hasPhone: Boolean(r.phone), hasEmail: Boolean(r.email), estimatedValue: r.ev, budgetMax: r.bmax, hasRequirements: Boolean(r.req), lastActivityAt: r.last_activity_at, createdAt: r.created_at },
      st.scoring
    );
    await tx.query(`UPDATE leads SET lead_score = $3, score_breakdown = $4::jsonb WHERE id = $1 AND tenant_id = $2 AND (lead_score <> $3 OR score_breakdown IS DISTINCT FROM $4::jsonb)`, [leadId, actor.tenantId, score, JSON.stringify(factors)]);
  }
}

