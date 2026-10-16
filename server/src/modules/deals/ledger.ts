import type pg from 'pg';
import type { Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { notify } from '../../platform/notifications';

/**
 * The deal ledger: the only code that records a sale or takes it back. It works inside the caller's transaction and never moves the lead's
 * stage itself (the caller does, in the same transaction), so "Won" and "a recorded deal value tied to a unit" cannot drift apart.
 *
 * Lock order everywhere in the deals code is lead → property → reservation, so two people working on the same buyer and unit queue up
 * instead of deadlocking.
 */
export interface DealInput {
  /** The offer/reservation being completed. Optional: a sale can be recorded for a unit that never went through a reservation. */
  reservationId?: string;
  propertyId?: string;
  dealValue: number;
}

interface LeadRef {
  id: string;
  owner_id: string | null;
}

/** Property status changes made by the ledger carry a plain reason in the unit's own history (never a buyer's name). */
export async function setPropertyStatus(tx: pg.PoolClient, actor: Actor, propertyId: string, to: string, reason: string) {
  await tx.query(`SELECT set_config('app.status_reason', $1, true)`, [reason.slice(0, 300)]);
  await tx.query(`UPDATE properties SET status = $3::property_status_enum WHERE id = $1 AND tenant_id = $2`, [propertyId, actor.tenantId, to]);
  await tx.query(`SELECT set_config('app.status_reason', '', true)`);
  await emit(tx, { type: 'property.status_changed', aggregateId: propertyId, payload: { to, reason } });
}

export async function lockProperty(tx: pg.PoolClient, actor: Actor, propertyId: string) {
  const p = (
    await tx.query(`SELECT id, title, status, listing_type, currency, price::float8 AS price FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [propertyId, actor.tenantId])
  ).rows[0] as { id: string; title: string; status: string; listing_type: string; currency: string; price: number } | undefined;
  if (!p) throw Errors.validation([{ path: 'body.propertyId', message: 'Property not found' }]);
  return p;
}

export async function activity(tx: pg.PoolClient, actor: Actor, leadId: string, description: string, metadata: object) {
  await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata, created_at) VALUES ($1,$2,$3,'note',$4,$5::jsonb,clock_timestamp())`, [actor.tenantId, leadId, actor.userId, description, JSON.stringify(metadata)]);
}

/** Ends the other buyers' open offers on a unit that has just been sold, and tells their owners. */
async function closeCompetingOffers(tx: pg.PoolClient, actor: Actor, propertyId: string, exceptId: string, title: string) {
  const closed = await tx.query(
    `UPDATE reservations r SET status = 'closed', closed_reason = 'unit_taken', closed_at = now(), closed_by = $4, version = version + 1
       WHERE r.tenant_id = $1 AND r.property_id = $2 AND r.status = 'offered' AND r.id <> $3
       RETURNING r.id, r.lead_id`,
    [actor.tenantId, propertyId, exceptId, actor.userId]
  );
  for (const row of closed.rows) {
    await activity(tx, actor, row.lead_id, `Offer closed: ${title} went to another buyer`, { reservationId: row.id, propertyId });
    const owner = (await tx.query(`SELECT owner_id FROM leads WHERE id = $1 AND tenant_id = $2`, [row.lead_id, actor.tenantId])).rows[0]?.owner_id as string | null | undefined;
    if (owner && owner !== actor.userId) {
      await notify(tx, { userId: owner, title: 'An offer was closed', message: `${title} went to another buyer.`, type: 'reservation_closed', link: `/leads/${row.lead_id}`, entityType: 'reservation', entityId: row.id, dedupeKey: `reservation-closed:${row.id}` });
    }
    await emit(tx, { type: 'reservation.closed', aggregateId: row.id, payload: { leadId: row.lead_id, propertyId, reason: 'unit_taken' } });
  }
}

/**
 * Records the sale: reservation → completed with the deal value, the unit → sold/rented, competing offers closed.
 * Returns the reservation id. The lead must already be locked by the caller.
 */
export async function completeDealInTx(tx: pg.PoolClient, actor: Actor, lead: LeadRef, deal: DealInput): Promise<string> {
  if (!(deal.dealValue > 0) || !Number.isFinite(deal.dealValue)) throw Errors.validation([{ path: 'body.deal.dealValue', message: 'Enter the final deal value (more than zero)' }]);
  let propertyId = deal.propertyId;
  if (deal.reservationId) {
    const r = (await tx.query(`SELECT property_id, lead_id FROM reservations WHERE id = $1 AND tenant_id = $2`, [deal.reservationId, actor.tenantId])).rows[0];
    if (!r || r.lead_id !== lead.id) throw Errors.validation([{ path: 'body.deal.reservationId', message: 'That reservation does not belong to this lead' }]);
    if (propertyId && propertyId !== r.property_id) throw Errors.validation([{ path: 'body.deal.propertyId', message: 'That is not the unit of this reservation' }]);
    propertyId = r.property_id as string;
  }
  if (!propertyId) throw Errors.validation([{ path: 'body.deal.propertyId', message: 'Choose the unit that was sold' }]);

  const prop = await lockProperty(tx, actor, propertyId);
  const open = (
    await tx.query(`SELECT id, status FROM reservations WHERE tenant_id = $1 AND lead_id = $2 AND property_id = $3 AND status IN ('offered','reserved') FOR UPDATE`, [actor.tenantId, lead.id, propertyId])
  ).rows[0] as { id: string; status: 'offered' | 'reserved' } | undefined;
  if (deal.reservationId && (!open || open.id !== deal.reservationId)) throw Errors.conflict('That offer or reservation is no longer open', { extensions: { reason: 'reservation_not_open' } });

  if (open?.status === 'reserved') {
    if (prop.status !== 'reserved') throw Errors.conflict(`This unit is ${prop.status.replace('_', ' ')}, not reserved. Check the unit before recording the sale.`);
  } else {
    if (prop.status === 'reserved') {
      const holder = (await tx.query(`SELECT 1 FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status = 'reserved'`, [actor.tenantId, propertyId])).rowCount;
      if (holder) throw Errors.conflict('This unit is reserved for another buyer', { extensions: { reason: 'already_reserved' } });
      // reserved by hand, with no reservation on record: allowed, the person recording the sale is the one who knows
    } else if (!['available', 'under_offer'].includes(prop.status)) {
      throw Errors.unprocessable(`This unit is ${prop.status.replace('_', ' ')}, so a sale cannot be recorded against it`, { extensions: { reason: 'unit_unavailable' } });
    }
  }

  let id: string;
  if (open) {
    id = open.id;
    await tx.query(`UPDATE reservations SET status = 'completed', deal_value = $3, completed_at = now(), completed_by = $4, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, deal.dealValue, actor.userId]);
  } else {
    const ins = await tx.query(
      `INSERT INTO reservations (tenant_id, lead_id, property_id, status, deal_value, currency, completed_at, completed_by, created_by)
       VALUES ($1,$2,$3,'completed',$4,$5,now(),$6,$6) RETURNING id`,
      [actor.tenantId, lead.id, propertyId, deal.dealValue, prop.currency, actor.userId]
    );
    id = ins.rows[0].id as string;
  }
  const sale = prop.listing_type === 'sale';
  await setPropertyStatus(tx, actor, propertyId, sale ? 'sold' : 'rented', sale ? 'Sale recorded' : 'Rental recorded');
  await closeCompetingOffers(tx, actor, propertyId, id, prop.title);
  await tx.query(`INSERT INTO lead_properties (tenant_id, lead_id, property_id, status, source, created_by) VALUES ($1,$2,$3,'interested','offer',$4) ON CONFLICT (tenant_id, lead_id, property_id) DO UPDATE SET status = 'interested'`, [actor.tenantId, lead.id, propertyId, actor.userId]);
  await activity(tx, actor, lead.id, `${sale ? 'Sale' : 'Rental'} recorded: ${prop.title}`, { reservationId: id, propertyId, dealValue: deal.dealValue, currency: prop.currency });
  await audit(tx, { action: 'reservation.complete', entityType: 'reservation', entityId: id, after: { leadId: lead.id, propertyId, dealValue: deal.dealValue } });
  await emit(tx, { type: 'reservation.completed', aggregateId: id, payload: { leadId: lead.id, propertyId } });
  return id;
}

/** Takes a recorded sale back (the lead is being reopened): the deal stops counting and the unit is available again. */
export async function reverseDealsInTx(tx: pg.PoolClient, actor: Actor, leadId: string, reason: string): Promise<number> {
  const deals = (await tx.query(`SELECT id, property_id FROM reservations WHERE tenant_id = $1 AND lead_id = $2 AND status = 'completed' ORDER BY property_id, id FOR UPDATE`, [actor.tenantId, leadId])).rows as Array<{ id: string; property_id: string }>;
  for (const d of deals) {
    const prop = await lockProperty(tx, actor, d.property_id);
    if (prop.status === 'sold' || prop.status === 'rented') await setPropertyStatus(tx, actor, d.property_id, 'available', `Reversed: ${reason}`.slice(0, 300));
    await tx.query(`UPDATE reservations SET status = 'closed', closed_reason = 'deal_reversed', closed_note = $3, closed_at = now(), closed_by = $4, version = version + 1 WHERE id = $1 AND tenant_id = $2`, [d.id, actor.tenantId, reason.slice(0, 500), actor.userId]);
    await activity(tx, actor, leadId, `Recorded sale reversed: ${prop.title}`, { reservationId: d.id, propertyId: d.property_id, reason });
    await audit(tx, { action: 'reservation.reverse', entityType: 'reservation', entityId: d.id, after: { leadId, propertyId: d.property_id, reason } });
    await emit(tx, { type: 'reservation.closed', aggregateId: d.id, payload: { leadId, propertyId: d.property_id, reason: 'deal_reversed' } });
  }
  return deals.length;
}

/** Does this lead have a recorded sale? */
export async function hasCompletedDeal(tx: pg.PoolClient, tenantId: string, leadId: string): Promise<boolean> {
  return Boolean((await tx.query(`SELECT 1 FROM reservations WHERE tenant_id = $1 AND lead_id = $2 AND status = 'completed' LIMIT 1`, [tenantId, leadId])).rowCount);
}
