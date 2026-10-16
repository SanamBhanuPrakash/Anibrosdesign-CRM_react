import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, assertCanActOn, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { leadVisibility } from '../leads/pipelines.service';
import type { InterestSource, InterestStatus } from './catalog';

/**
 * A buyer's shortlist: the properties a lead is considering. It records interest only: it never reserves, holds or changes a unit.
 * Reading follows the lead's visibility; changing it follows the right to update the lead (a salesperson shortlists for their own buyers).
 */
export interface InterestDto {
  id: string;
  leadId: string;
  propertyId: string;
  status: InterestStatus;
  source: InterestSource;
  matchScore: number | null;
  note: string | null;
  createdAt: string;
  property: { id: string; title: string; status: string; price: number; currency: string; location: string | null; bedrooms: number | null; propertyType: string; archived: boolean };
  /** The buyer's open offer or reservation on this unit, if any. */
  deal: { id: string; status: 'offered' | 'reserved' } | null;
}

const COLUMNS = `
  i.id, i.lead_id AS "leadId", i.property_id AS "propertyId", i.status, i.source, i.match_score AS "matchScore", i.note, i.created_at AS "createdAt",
  p.title AS _title, p.status AS _status, p.price::float8 AS _price, p.currency AS _currency, COALESCE(p.location, NULLIF(concat_ws(', ', p.locality, p.city), '')) AS _location,
  p.bedrooms AS _beds, p.property_type AS _type, (p.deleted_at IS NOT NULL) AS _archived,
  (SELECT r.id FROM reservations r WHERE r.tenant_id = i.tenant_id AND r.lead_id = i.lead_id AND r.property_id = i.property_id AND r.status IN ('offered','reserved')) AS _deal_id,
  (SELECT r.status FROM reservations r WHERE r.tenant_id = i.tenant_id AND r.lead_id = i.lead_id AND r.property_id = i.property_id AND r.status IN ('offered','reserved')) AS _deal_status`;
const FROM = `lead_properties i JOIN properties p ON p.id = i.property_id AND p.tenant_id = i.tenant_id`;

function toDto(r: any): InterestDto {
  return {
    id: r.id, leadId: r.leadId, propertyId: r.propertyId, status: r.status, source: r.source, matchScore: r.matchScore, note: r.note, createdAt: r.createdAt,
    property: { id: r.propertyId, title: r._title, status: r._status, price: r._price, currency: r._currency, location: r._location, bedrooms: r._beds, propertyType: r._type, archived: r._archived },
    deal: r._deal_id ? { id: r._deal_id, status: r._deal_status } : null,
  };
}

export class ShortlistService {
  constructor(private db: Database) {}

  async list(actor: Actor, leadId: string): Promise<InterestDto[]> {
    assertCan(actor, 'leads:read');
    assertCan(actor, 'properties:read');
    return this.db.readTenant(actor, async (tx) => {
      await this.visibleLead(tx, actor, leadId);
      const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE i.tenant_id = $1 AND i.lead_id = $2 ORDER BY i.created_at DESC, i.id DESC LIMIT 100`, [actor.tenantId, leadId]);
      return r.rows.map(toDto);
    });
  }

  /** Adds a property to a buyer's shortlist. Adding the same property again is not an error: it returns the existing entry (and un-rejects it). */
  async add(actor: Actor, input: { leadId: string; propertyId: string; source?: InterestSource; matchScore?: number | null; note?: string | null }): Promise<{ item: InterestDto; created: boolean }> {
    assertCan(actor, 'leads:update');
    assertCan(actor, 'properties:read');
    return this.db.withTenant(actor, async (tx) => {
      const lead = (await tx.query(`SELECT id, owner_id FROM leads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [input.leadId, actor.tenantId])).rows[0];
      if (!lead) throw Errors.notFound('Lead');
      assertCanActOn(actor, 'leads:update', lead.owner_id);
      const prop = (await tx.query(`SELECT 1 FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [input.propertyId, actor.tenantId])).rowCount;
      if (!prop) throw Errors.validation([{ path: 'body.propertyId', message: 'Property not found' }]);
      const r = await tx.query(
        `INSERT INTO lead_properties (tenant_id, lead_id, property_id, status, source, match_score, note, created_by)
         VALUES ($1,$2,$3,'shortlisted',$4,$5,$6,$7)
         ON CONFLICT (tenant_id, lead_id, property_id) DO UPDATE SET status = CASE WHEN lead_properties.status = 'rejected' THEN 'shortlisted' ELSE lead_properties.status END
         RETURNING id, (xmax = 0) AS created`,
        [actor.tenantId, input.leadId, input.propertyId, input.source ?? 'manual', input.matchScore ?? null, input.note?.trim() || null, actor.userId]
      );
      const id = r.rows[0].id as string;
      const created = Boolean(r.rows[0].created);
      if (created) {
        await audit(tx, { action: 'lead.shortlist_add', entityType: 'lead', entityId: input.leadId, after: { propertyId: input.propertyId, source: input.source ?? 'manual' } });
        await emit(tx, { type: 'shortlist.changed', aggregateId: input.leadId, payload: { propertyId: input.propertyId, change: 'added' } });
      }
      return { item: await this.fetch(tx, actor.tenantId, id), created };
    });
  }

  async update(actor: Actor, id: string, patch: { status?: InterestStatus; note?: string | null }): Promise<InterestDto> {
    assertCan(actor, 'leads:update');
    return this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      await tx.query(`UPDATE lead_properties SET status = COALESCE($3, status), note = CASE WHEN $4::boolean THEN $5 ELSE note END WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, patch.status ?? null, patch.note !== undefined, patch.note?.trim() || null]);
      await audit(tx, { action: 'lead.shortlist_update', entityType: 'lead', entityId: row.lead_id, after: { propertyId: row.property_id, ...patch } });
      await emit(tx, { type: 'shortlist.changed', aggregateId: row.lead_id, payload: { propertyId: row.property_id, change: 'updated' } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  /** Removing is refused while the buyer has an open offer or reservation on the property: end that first. */
  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'leads:update');
    await this.db.withTenant(actor, async (tx) => {
      const row = await this.lock(tx, actor, id);
      const open = await tx.query(`SELECT 1 FROM reservations WHERE tenant_id = $1 AND lead_id = $2 AND property_id = $3 AND status IN ('offered','reserved')`, [actor.tenantId, row.lead_id, row.property_id]);
      if (open.rowCount) throw Errors.conflict('This buyer has an open offer or reservation on this property. Close it first.', { extensions: { reason: 'open_deal' } });
      await tx.query(`DELETE FROM lead_properties WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      await audit(tx, { action: 'lead.shortlist_remove', entityType: 'lead', entityId: row.lead_id, before: { propertyId: row.property_id } });
      await emit(tx, { type: 'shortlist.changed', aggregateId: row.lead_id, payload: { propertyId: row.property_id, change: 'removed' } });
    });
  }

  private async visibleLead(tx: pg.PoolClient, actor: Actor, leadId: string) {
    const params: unknown[] = [actor.tenantId, leadId];
    const vis = leadVisibility(actor, 'l', params);
    if (vis === false) throw Errors.forbidden();
    const ok = await tx.query(`SELECT 1 FROM leads l WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL AND ${vis}`, params);
    if (!ok.rowCount) throw Errors.notFound('Lead');
  }

  private async lock(tx: pg.PoolClient, actor: Actor, id: string) {
    const row = (
      await tx.query(`SELECT i.id, i.lead_id, i.property_id, l.owner_id FROM lead_properties i JOIN leads l ON l.id = i.lead_id AND l.tenant_id = i.tenant_id WHERE i.id = $1 AND i.tenant_id = $2 AND l.deleted_at IS NULL FOR UPDATE OF i`, [id, actor.tenantId])
    ).rows[0] as { id: string; lead_id: string; property_id: string; owner_id: string | null } | undefined;
    if (!row) throw Errors.notFound('Shortlist entry');
    assertCanActOn(actor, 'leads:update', row.owner_id);
    return row;
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<InterestDto> {
    const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, id]);
    if (!r.rows[0]) throw Errors.notFound('Shortlist entry');
    return toDto(r.rows[0]);
  }
}
