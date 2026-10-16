import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, assertCanActOn, scopeFor, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { notify } from '../../platform/notifications';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { leadVisibility } from '../leads/pipelines.service';
import type { LeadsService } from '../leads/service';
import { CLOSE_REASONS, closeReasonLabel, type ReservationStatus } from './catalog';
import { activity, completeDealInTx, lockProperty, setPropertyStatus } from './ledger';

export interface ReservationDto {
  id: string;
  leadId: string;
  propertyId: string;
  status: ReservationStatus;
  offerPrice: number | null;
  agreedPrice: number | null;
  tokenAmount: number | null;
  /** Set only on a completed deal: the final value of the sale. The only figure reports count as won deal value. */
  dealValue: number | null;
  currency: string;
  holdUntil: string | null;
  /** The hold date has passed and the unit is still held. Nothing is released automatically: a person decides. */
  holdOverdue: boolean;
  note: string | null;
  closedReason: { code: string; label: string } | null;
  closedNote: string | null;
  offeredAt: string;
  reservedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
  lead: { id: string; name: string; ownerId: string | null; ownerName: string | null };
  property: { id: string; title: string; status: string; price: number; listingType: string };
  /** What the caller can do with it now. */
  allowed: Array<'reserve' | 'complete' | 'close' | 'edit' | 'reverse'>;
}

/** What happened to the lead's stage as a consequence (never silent: the screen can say it). */
export interface LeadStageEffect {
  moved: boolean;
  stageName: string | null;
  note: string | null;
}
export interface ReservationResult {
  reservation: ReservationDto;
  leadStage: LeadStageEffect;
}

export interface ReservationListQuery {
  leadId?: string;
  propertyId?: string;
  status?: ReservationStatus[];
  /** Whole local days in the workspace time zone (YYYY-MM-DD, `completedTo` inclusive): only sales recorded in this window. */
  completedFrom?: string;
  completedTo?: string;
  test?: 'exclude';
  limit: number;
  cursor?: string;
}

const COLUMNS = `
  r.id, r.lead_id AS "leadId", r.property_id AS "propertyId", r.status, r.offer_price::float8 AS "offerPrice", r.agreed_price::float8 AS "agreedPrice", r.token_amount::float8 AS "tokenAmount",
  r.deal_value::float8 AS "dealValue", r.currency, r.hold_until AS "holdUntil", r.note, r.closed_reason AS "closedReason", r.closed_note AS "closedNote", r.offered_at AS "offeredAt",
  r.reserved_at AS "reservedAt", r.completed_at AS "completedAt", r.closed_at AS "closedAt", r.version, r.created_at AS "createdAt", r.created_at::text AS _k,
  l.owner_id AS _owner_id, ou.name AS _owner_name, c.first_name AS _c_first, c.last_name AS _c_last,
  p.title AS _p_title, p.status AS _p_status, p.price::float8 AS _p_price, p.listing_type AS _p_listing`;
const FROM = `reservations r
  JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
  JOIN properties p ON p.id = r.property_id AND p.tenant_id = r.tenant_id
  LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
  LEFT JOIN users ou ON ou.id = l.owner_id`;

function toDto(r: any, actor: Actor): ReservationDto {
  const open = r.status === 'offered' || r.status === 'reserved';
  const all = actor.kind === 'system' || scopeIfAllowed(actor, 'reservations:update') === 'all';
  const canWrite = actor.kind === 'system' || Boolean(scopeIfAllowed(actor, 'reservations:update'));
  const allowed: ReservationDto['allowed'] = [];
  // an offer on a unit that another buyer holds can only be edited or closed: reserving or selling it would be refused
  const blocked = r.status === 'offered' && r._p_status === 'reserved';
  if (canWrite && r.status === 'offered' && !blocked) allowed.push('reserve');
  if (canWrite && open && !blocked) allowed.push('complete');
  if (canWrite && open) allowed.push('close', 'edit');
  if (all && r.status === 'completed') allowed.push('reverse');
  return {
    id: r.id, leadId: r.leadId, propertyId: r.propertyId, status: r.status, offerPrice: r.offerPrice, agreedPrice: r.agreedPrice, tokenAmount: r.tokenAmount, dealValue: r.dealValue, currency: r.currency,
    holdUntil: r.holdUntil, holdOverdue: r.status === 'reserved' && Boolean(r.holdUntil) && new Date(r.holdUntil).getTime() < Date.now(), note: r.note,
    closedReason: r.closedReason ? { code: r.closedReason, label: closeReasonLabel(r.closedReason) ?? r.closedReason } : null, closedNote: r.closedNote,
    offeredAt: r.offeredAt, reservedAt: r.reservedAt, completedAt: r.completedAt, closedAt: r.closedAt, version: r.version, createdAt: r.createdAt,
    lead: { id: r.leadId, name: [r._c_first, r._c_last].filter(Boolean).join(' ').trim() || 'Unnamed buyer', ownerId: r._owner_id, ownerName: r._owner_name },
    property: { id: r.propertyId, title: r._p_title, status: r._p_status, price: r._p_price, listingType: r._p_listing },
    allowed,
  };
}

interface LeadRow {
  id: string;
  owner_id: string | null;
  stage_id: string;
  pipeline_id: string;
  closed_at: Date | null;
  deleted_at: Date | null;
  contact_id: string | null;
  status: string;
}
interface ResRow {
  id: string;
  lead_id: string;
  property_id: string;
  status: ReservationStatus;
  version: number;
  currency: string;
  offer_price: number | null;
}

const NO_EFFECT: LeadStageEffect = { moved: false, stageName: null, note: null };
const pgCode = (e: unknown) => (e as { code?: string })?.code;

export class DealsService {
  constructor(
    private db: Database,
    private leads: LeadsService
  ) {}

  // ── reading ───────────────────────────────────────────────────────────────────────────────────

  async list(actor: Actor, q: ReservationListQuery): Promise<{ items: ReservationDto[]; page: PageInfo }> {
    const scope = scopeFor(actor, 'reservations:read');
    const sig = 'reservations:created:desc';
    const cursor = decodeCursor(q.cursor, sig);
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['r.tenant_id = $1', 'l.deleted_at IS NULL'];
      const push = (v: unknown) => (params.push(v), `$${params.length}`);
      if (scope === 'own') where.push(`l.owner_id = ${push(actor.userId)}`);
      if (q.leadId) where.push(`r.lead_id = ${push(q.leadId)}`);
      if (q.propertyId) where.push(`r.property_id = ${push(q.propertyId)}`);
      if (q.status?.length) where.push(`r.status = ANY(${push(q.status)}::text[])`);
      const tzOf = '(SELECT timezone FROM tenants WHERE id = $1)';
      if (q.completedFrom) where.push(`r.status = 'completed' AND r.completed_at >= (${push(q.completedFrom)}::date)::timestamp AT TIME ZONE ${tzOf}`);
      if (q.completedTo) where.push(`r.status = 'completed' AND r.completed_at < ((${push(q.completedTo)}::date + 1)::timestamp AT TIME ZONE ${tzOf})`);
      if (q.test === 'exclude') where.push(`NOT ('test' = ANY(l.tags))`);
      const pred = cursorPredicate(cursor, params, 'r.created_at', 'r.id', 'desc', '::timestamptz');
      if (pred) where.push(pred);
      params.push(q.limit + 1);
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r._k as string);
      return { items: items.map((r) => toDto(r, actor)), page };
    });
  }

  async get(actor: Actor, id: string): Promise<ReservationDto> {
    const scope = scopeFor(actor, 'reservations:read');
    return this.db.readTenant(actor, async (tx) => this.fetch(tx, actor, id, scope === 'own'));
  }

  /**
   * "Who holds this unit?" for the unit page. Anyone who may read inventory sees THAT it is held, since which agent holds it matters to
   * their own work; the buyer's name and the money are only for people who may see that buyer.
   */
  async holder(actor: Actor, propertyId: string) {
    assertCan(actor, 'properties:read');
    return this.db.readTenant(actor, async (tx) => {
      const prop = (await tx.query(`SELECT status FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [propertyId, actor.tenantId])).rows[0];
      if (!prop) throw Errors.notFound('Property');
      const params: unknown[] = [actor.tenantId, propertyId];
      const vis = leadVisibility(actor, 'l', params);
      const res = (
        await tx.query(
          `SELECT r.id, r.reserved_at AS "reservedAt", r.hold_until AS "holdUntil", r.token_amount::float8 AS "tokenAmount", r.agreed_price::float8 AS "agreedPrice", r.currency, r.lead_id AS "leadId",
                  ${vis === false ? 'false' : `(${vis})`} AS visible, ou.name AS agent, c.first_name AS f, c.last_name AS s
             FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id LEFT JOIN users ou ON ou.id = l.owner_id LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
            WHERE r.tenant_id = $1 AND r.property_id = $2 AND r.status = 'reserved'`,
          params
        )
      ).rows[0];
      const offers = Number((await tx.query(`SELECT count(*)::int AS n FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status = 'offered'`, [actor.tenantId, propertyId])).rows[0].n);
      return {
        propertyId,
        status: prop.status as string,
        openOffers: offers,
        holder: res
          ? {
              reservationId: res.visible ? (res.id as string) : null,
              leadId: res.visible ? (res.leadId as string) : null,
              buyer: res.visible ? [res.f, res.s].filter(Boolean).join(' ').trim() || 'Unnamed buyer' : null,
              agent: (res.agent as string | null) ?? null,
              reservedAt: res.reservedAt as string | null,
              holdUntil: res.holdUntil as string | null,
              holdOverdue: Boolean(res.holdUntil) && new Date(res.holdUntil).getTime() < Date.now(),
              tokenAmount: res.visible ? (res.tokenAmount as number | null) : null,
              agreedPrice: res.visible ? (res.agreedPrice as number | null) : null,
              currency: res.currency as string,
              visible: Boolean(res.visible),
            }
          : null,
      };
    });
  }

  // ── offer → reserve → complete / close ─────────────────────────────────────────────────────────

  /** A buyer makes an offer on a unit. The unit shows "under offer"; several buyers may offer, one may reserve. */
  async offer(actor: Actor, input: { leadId: string; propertyId: string; offerPrice?: number | null; holdUntil?: string | null; note?: string | null }): Promise<ReservationResult> {
    assertCan(actor, 'reservations:create');
    return this.db.withTenant(actor, async (tx) => {
      const lead = await this.lockLead(tx, actor, input.leadId, 'reservations:create');
      if (lead.closed_at) throw Errors.unprocessable('This lead is closed. Reopen it before recording an offer.', { extensions: { reason: 'lead_closed' } });
      const prop = await lockProperty(tx, actor, input.propertyId);
      if (prop.status === 'reserved') throw Errors.conflict('This unit is reserved for a buyer. It can take offers again if that reservation is released.', { extensions: { reason: 'already_reserved' } });
      if (!['available', 'under_offer'].includes(prop.status)) throw Errors.unprocessable(`This unit is ${prop.status.replace('_', ' ')}, so it cannot take an offer`, { extensions: { reason: 'unit_unavailable' } });
      let id: string;
      try {
        const ins = await tx.query(
          `INSERT INTO reservations (tenant_id, lead_id, property_id, status, offer_price, currency, hold_until, note, created_by)
           VALUES ($1,$2,$3,'offered',$4,$5,$6,$7,$8) RETURNING id`,
          [actor.tenantId, lead.id, prop.id, input.offerPrice ?? null, prop.currency, input.holdUntil ?? null, input.note?.trim() || null, actor.userId]
        );
        id = ins.rows[0].id as string;
      } catch (e) {
        if (pgCode(e) === '23505') throw Errors.conflict('This buyer already has an open offer or reservation on this unit', { extensions: { reason: 'already_open' } });
        throw e;
      }
      if (prop.status === 'available') await setPropertyStatus(tx, actor, prop.id, 'under_offer', 'Offer received');
      await tx.query(`INSERT INTO lead_properties (tenant_id, lead_id, property_id, status, source, created_by) VALUES ($1,$2,$3,'interested','offer',$4) ON CONFLICT (tenant_id, lead_id, property_id) DO UPDATE SET status = 'interested'`, [actor.tenantId, lead.id, prop.id, actor.userId]);
      await activity(tx, actor, lead.id, `Offer recorded: ${prop.title}`, { reservationId: id, propertyId: prop.id, offerPrice: input.offerPrice ?? null });
      await audit(tx, { action: 'reservation.offer', entityType: 'reservation', entityId: id, after: { leadId: lead.id, propertyId: prop.id, offerPrice: input.offerPrice ?? null } });
      await emit(tx, { type: 'reservation.created', aggregateId: id, payload: { leadId: lead.id, propertyId: prop.id } });
      const leadStage = await this.advanceLead(tx, actor, lead, 'negotiation', 'Offer recorded');
      return { reservation: await this.fetch(tx, actor, id), leadStage };
    });
  }

  /** Token received: the unit is held for this buyer and nobody else can reserve it (database-enforced). Booking is a milestone, not a sale. */
  async reserve(actor: Actor, id: string, input: { tokenAmount: number; agreedPrice: number; holdUntil?: string | null; note?: string | null }, expectedVersion?: number): Promise<ReservationResult> {
    assertCan(actor, 'reservations:update');
    return this.db.withTenant(actor, async (tx) => {
      const { res, lead } = await this.lockAll(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== res.version) throw Errors.preconditionFailed();
      if (res.status !== 'offered') throw Errors.invalidTransition(res.status === 'reserved' ? 'This unit is already reserved for this buyer' : `A ${res.status} deal cannot be reserved`);
      if (lead.closed_at) throw Errors.unprocessable('This lead is closed. Reopen it before reserving a unit.', { extensions: { reason: 'lead_closed' } });
      const prop = await lockProperty(tx, actor, res.property_id);
      await this.assertNotHeldByOther(tx, actor, prop, id);
      if (!['available', 'under_offer', 'reserved'].includes(prop.status)) throw Errors.unprocessable(`This unit is ${prop.status.replace('_', ' ')}, so it cannot be reserved`, { extensions: { reason: 'unit_unavailable' } });
      try {
        await tx.query(
          `UPDATE reservations SET status = 'reserved', token_amount = $3, agreed_price = $4, hold_until = $5, note = COALESCE($6, note), reserved_at = now(), reserved_by = $7, version = version + 1 WHERE id = $1 AND tenant_id = $2`,
          [id, actor.tenantId, input.tokenAmount, input.agreedPrice, input.holdUntil ?? null, input.note?.trim() || null, actor.userId]
        );
      } catch (e) {
        // the unique index is the last line of defence; the lock above means it should not be reached
        if (pgCode(e) === '23505') throw Errors.conflict('This unit has just been reserved for another buyer', { extensions: { reason: 'already_reserved' } });
        throw e;
      }
      if (prop.status !== 'reserved') await setPropertyStatus(tx, actor, prop.id, 'reserved', 'Reserved');
      await this.notifyOtherOffers(tx, actor, prop.id, prop.title, id);
      await activity(tx, actor, lead.id, `Unit reserved: ${prop.title}`, { reservationId: id, propertyId: prop.id, tokenAmount: input.tokenAmount, agreedPrice: input.agreedPrice });
      await audit(tx, { action: 'reservation.reserve', entityType: 'reservation', entityId: id, after: { leadId: lead.id, propertyId: prop.id, tokenAmount: input.tokenAmount, agreedPrice: input.agreedPrice } });
      await emit(tx, { type: 'reservation.updated', aggregateId: id, payload: { leadId: lead.id, propertyId: prop.id, change: 'reserved' } });
      const leadStage = await this.advanceLead(tx, actor, lead, 'booking_reserved', 'Unit reserved');
      return { reservation: await this.fetch(tx, actor, id), leadStage };
    });
  }

  /** The sale: records the final deal value, marks the unit sold or rented and moves the lead to Won, all in one transaction. */
  async complete(actor: Actor, id: string, input: { dealValue: number }, expectedVersion?: number): Promise<ReservationResult> {
    assertCan(actor, 'reservations:update');
    return this.db.withTenant(actor, async (tx) => {
      const { res, lead } = await this.lockAll(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== res.version) throw Errors.preconditionFailed();
      if (res.status === 'completed') throw Errors.invalidTransition('This sale is already recorded');
      if (res.status === 'closed') throw Errors.invalidTransition('This deal was closed. Make a new offer to continue.');
      let leadStage = NO_EFFECT;
      if (lead.status === 'won') {
        // already marked Won before deal values were recorded: attach the sale without moving anything
        await completeDealInTx(tx, actor, lead, { reservationId: id, dealValue: input.dealValue });
      } else {
        const won = (await tx.query(`SELECT id, name FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND maps_to_status = 'won' AND archived_at IS NULL ORDER BY order_index LIMIT 1`, [lead.pipeline_id, actor.tenantId])).rows[0];
        if (!won) throw Errors.unprocessable('This lead’s pipeline has no Won step. Add one in the pipeline settings first.', { extensions: { reason: 'no_won_stage' } });
        if (res.status === 'reserved') await this.advanceLead(tx, actor, lead, 'booking_reserved', 'Unit reserved'); // a lead moved back since reserving still counts as booked
        await this.leads.moveInTx(tx, actor, await this.freshLead(tx, actor, lead.id), { stageId: won.id, deal: { reservationId: id, dealValue: input.dealValue } });
        leadStage = { moved: true, stageName: won.name as string, note: 'Marked as won' };
      }
      return { reservation: await this.fetch(tx, actor, id), leadStage };
    });
  }

  /** Ends an offer or reservation without a sale. The unit goes back on the market (or stays under offer if other buyers have offers open). */
  async close(actor: Actor, id: string, input: { reason: string; note?: string | null }, expectedVersion?: number): Promise<ReservationResult> {
    assertCan(actor, 'reservations:update');
    const reason = CLOSE_REASONS.find((r) => r.code === input.reason);
    if (!reason) throw Errors.validation([{ path: 'body.reason', message: 'Choose one of the listed reasons' }]);
    const note = input.note?.trim() || null;
    if (reason.code === 'other' && (!note || note.length < 2)) throw Errors.validation([{ path: 'body.note', message: 'Say why in a few words' }]);
    return this.db.withTenant(actor, async (tx) => {
      const { res, lead } = await this.lockAll(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== res.version) throw Errors.preconditionFailed();
      if (res.status !== 'offered' && res.status !== 'reserved') throw Errors.invalidTransition(res.status === 'completed' ? 'A recorded sale cannot be closed here. Reverse it by reopening the lead.' : 'This deal is already closed');
      const prop = await lockProperty(tx, actor, res.property_id);
      await tx.query(`UPDATE reservations SET status = 'closed', closed_reason = $3, closed_note = $4, closed_at = now(), closed_by = $5, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, reason.code, note, actor.userId]);
      const stillOpen = Number((await tx.query(`SELECT count(*)::int AS n FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status IN ('offered','reserved')`, [actor.tenantId, prop.id])).rows[0].n);
      const stillReserved = Number((await tx.query(`SELECT count(*)::int AS n FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status = 'reserved'`, [actor.tenantId, prop.id])).rows[0].n);
      if (prop.status === 'reserved' && !stillReserved) await setPropertyStatus(tx, actor, prop.id, stillOpen ? 'under_offer' : 'available', 'Reservation released');
      else if (prop.status === 'under_offer' && !stillOpen) await setPropertyStatus(tx, actor, prop.id, 'available', 'No open offers');
      await activity(tx, actor, lead.id, `${res.status === 'reserved' ? 'Reservation released' : 'Offer closed'}: ${prop.title} (${reason.label})`, { reservationId: id, propertyId: prop.id, reason: reason.code, note });
      await audit(tx, { action: 'reservation.close', entityType: 'reservation', entityId: id, after: { leadId: lead.id, propertyId: prop.id, reason: reason.code, wasReserved: res.status === 'reserved' } });
      await emit(tx, { type: 'reservation.closed', aggregateId: id, payload: { leadId: lead.id, propertyId: prop.id, reason: reason.code } });
      return { reservation: await this.fetch(tx, actor, id), leadStage: { moved: false, stageName: null, note: 'The lead stays where it is. Move it yourself if the deal is over.' } };
    });
  }

  /** Change the figures of an offer or reservation that is still open. */
  async update(actor: Actor, id: string, patch: { offerPrice?: number | null; agreedPrice?: number | null; holdUntil?: string | null; note?: string | null }, expectedVersion?: number): Promise<ReservationDto> {
    assertCan(actor, 'reservations:update');
    return this.db.withTenant(actor, async (tx) => {
      const { res } = await this.lockAll(tx, actor, id);
      if (expectedVersion !== undefined && expectedVersion !== res.version) throw Errors.preconditionFailed();
      if (res.status !== 'offered' && res.status !== 'reserved') throw Errors.conflict('Only an open offer or reservation can be edited');
      if (patch.agreedPrice !== undefined && res.status !== 'reserved') throw Errors.validation([{ path: 'body.agreedPrice', message: 'The agreed price is set when the unit is reserved' }]);
      const set: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const add = (col: string, v: unknown) => set.push(`${col} = $${params.push(v)}`);
      if (patch.offerPrice !== undefined) add('offer_price', patch.offerPrice);
      if (patch.agreedPrice !== undefined) {
        if (patch.agreedPrice === null) throw Errors.validation([{ path: 'body.agreedPrice', message: 'A reservation needs an agreed price' }]);
        add('agreed_price', patch.agreedPrice);
      }
      if (patch.holdUntil !== undefined) add('hold_until', patch.holdUntil);
      if (patch.note !== undefined) add('note', patch.note?.trim() || null);
      if (!set.length) return this.fetch(tx, actor, id);
      await tx.query(`UPDATE reservations SET ${set.join(', ')}, version = version + 1 WHERE id = $1 AND tenant_id = $2`, params);
      await audit(tx, { action: 'reservation.update', entityType: 'reservation', entityId: id, before: { status: res.status }, after: patch });
      await emit(tx, { type: 'reservation.updated', aggregateId: id, payload: { leadId: res.lead_id, change: 'edited' } });
      return this.fetch(tx, actor, id);
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────

  private async fetch(tx: pg.PoolClient, actor: Actor, id: string, ownOnly = false): Promise<ReservationDto> {
    const params: unknown[] = [actor.tenantId, id];
    if (ownOnly) params.push(actor.userId);
    const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.tenant_id = $1 AND r.id = $2${ownOnly ? ' AND l.owner_id = $3' : ''}`, params);
    if (!r.rows[0]) throw Errors.notFound('Reservation');
    return toDto(r.rows[0], actor);
  }

  private async lockLead(tx: pg.PoolClient, actor: Actor, leadId: string, permission: 'reservations:create' | 'reservations:update'): Promise<LeadRow> {
    const r = (
      await tx.query(
        `SELECT l.id, l.owner_id, l.stage_id, l.pipeline_id, l.closed_at, l.deleted_at, l.contact_id, l.status::text AS status FROM leads l WHERE l.id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL FOR UPDATE`,
        [leadId, actor.tenantId]
      )
    ).rows[0] as LeadRow | undefined;
    if (!r) throw Errors.notFound('Lead');
    assertCanActOn(actor, permission, r.owner_id);
    return r;
  }

  private async freshLead(tx: pg.PoolClient, actor: Actor, leadId: string) {
    return (await tx.query(`SELECT id, stage_id, pipeline_id, closed_at, owner_id, contact_id FROM leads WHERE id = $1 AND tenant_id = $2`, [leadId, actor.tenantId])).rows[0] as {
      id: string; stage_id: string; pipeline_id: string; closed_at: Date | null; owner_id: string | null; contact_id: string | null;
    };
  }

  /**
   * Lock order everywhere: lead → property → reservation. Two people working on the same unit queue on the property instead of
   * deadlocking on each other's reservations. The reservation is re-read under the lock.
   */
  private async lockAll(tx: pg.PoolClient, actor: Actor, id: string): Promise<{ res: ResRow; lead: LeadRow }> {
    const peek = (await tx.query(`SELECT lead_id, property_id FROM reservations WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId])).rows[0];
    if (!peek) throw Errors.notFound('Reservation');
    const lead = await this.lockLead(tx, actor, peek.lead_id, 'reservations:update');
    await tx.query(`SELECT 1 FROM properties WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [peek.property_id, actor.tenantId]);
    const res = (
      await tx.query(`SELECT id, lead_id, property_id, status, version, currency, offer_price::float8 AS offer_price FROM reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, actor.tenantId])
    ).rows[0] as ResRow | undefined;
    if (!res) throw Errors.notFound('Reservation');
    return { res, lead };
  }

  private async assertNotHeldByOther(tx: pg.PoolClient, actor: Actor, prop: { id: string; status: string }, thisId: string) {
    const other = await tx.query(`SELECT 1 FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status = 'reserved' AND id <> $3`, [actor.tenantId, prop.id, thisId]);
    if (other.rowCount) throw Errors.conflict('This unit is already reserved for another buyer', { extensions: { reason: 'already_reserved' } });
  }

  private async notifyOtherOffers(tx: pg.PoolClient, actor: Actor, propertyId: string, title: string, exceptId: string) {
    const others = await tx.query(`SELECT r.id, l.owner_id FROM reservations r JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id WHERE r.tenant_id = $1 AND r.property_id = $2 AND r.status = 'offered' AND r.id <> $3`, [actor.tenantId, propertyId, exceptId]);
    for (const o of others.rows) {
      if (o.owner_id && o.owner_id !== actor.userId) {
        await notify(tx, { userId: o.owner_id, title: 'A unit with your offer was reserved', message: `${title} is now reserved for another buyer.`, type: 'reservation_held', link: '/deals', entityType: 'reservation', entityId: o.id, dedupeKey: `reservation-held:${exceptId}:${o.id}` });
      }
    }
  }

  /**
   * Moves the lead forward to the pipeline step with this key, if it has one and the lead is behind it. Never backwards, never on a
   * closed lead, and a pipeline rule that refuses the move does not fail the deal: the answer says what happened.
   */
  private async advanceLead(tx: pg.PoolClient, actor: Actor, lead: LeadRow, key: 'negotiation' | 'booking_reserved', reason: string): Promise<LeadStageEffect> {
    const cur = (await tx.query(`SELECT l.stage_id, l.closed_at, s.order_index FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id WHERE l.id = $1 AND l.tenant_id = $2`, [lead.id, actor.tenantId])).rows[0];
    if (!cur || cur.closed_at) return NO_EFFECT;
    const target = (await tx.query(`SELECT id, name, order_index FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND stage_key = $3 AND archived_at IS NULL`, [lead.pipeline_id, actor.tenantId, key])).rows[0];
    if (!target) return { moved: false, stageName: null, note: 'This pipeline has no matching step, so the lead was not moved.' };
    if (target.order_index <= cur.order_index) return NO_EFFECT;
    await tx.query('SAVEPOINT advance_lead');
    try {
      await this.leads.moveInTx(tx, actor, await this.freshLead(tx, actor, lead.id), { stageId: target.id as string, reason });
      await tx.query('RELEASE SAVEPOINT advance_lead');
      return { moved: true, stageName: target.name as string, note: reason };
    } catch (e: any) {
      await tx.query('ROLLBACK TO SAVEPOINT advance_lead');
      if (!e?.status || e.status >= 500) throw e;
      return { moved: false, stageName: null, note: `The lead was not moved to “${target.name}”: ${e.detail ?? e.message}` };
    }
  }
}
