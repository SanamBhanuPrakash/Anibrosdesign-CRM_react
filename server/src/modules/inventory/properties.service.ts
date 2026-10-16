import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { escapeLike, normalizeTags } from '../contacts/normalize';

export const PROPERTY_TYPES = ['apartment', 'villa', 'townhouse', 'penthouse', 'office', 'retail', 'plot', 'other'] as const;
export const LISTING_TYPES = ['sale', 'rent', 'lease'] as const;
export const PROPERTY_STATUSES = ['available', 'under_offer', 'reserved', 'sold', 'rented', 'inactive'] as const;
export const FURNISHINGS = ['unfurnished', 'semi_furnished', 'furnished'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/**
 * Availability state machine. Anything not listed is refused: a "sold" unit does not quietly become "reserved".
 * Leaving sold/rented (a deal fell through, a lease ended) is allowed back to available only, and needs a reason.
 */
export const STATUS_TRANSITIONS: Record<PropertyStatus, PropertyStatus[]> = {
  available: ['under_offer', 'reserved', 'sold', 'rented', 'inactive'],
  under_offer: ['available', 'reserved', 'sold', 'rented', 'inactive'],
  reserved: ['available', 'under_offer', 'sold', 'rented'],
  sold: ['available'],
  rented: ['available'],
  inactive: ['available'],
};

export interface PropertyDto {
  id: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  description: string | null;
  propertyType: (typeof PROPERTY_TYPES)[number];
  listingType: (typeof LISTING_TYPES)[number];
  status: PropertyStatus;
  price: number;
  currency: string;
  pricePerSqft: number | null;
  negotiable: boolean;
  bedrooms: number | null;
  bathrooms: number | null;
  areaSqft: number | null;
  carpetAreaSqft: number | null;
  unitNumber: string | null;
  tower: string | null;
  floor: number | null;
  facing: string | null;
  furnishing: string | null;
  address: string | null;
  city: string | null;
  locality: string | null;
  location: string | null;
  possessionDate: string | null;
  reraId: string | null;
  amenities: string[];
  tags: string[];
  ownerId: string | null;
  ownerName: string | null;
  coverFileId: string | null;
  imageCount: number;
  statusChangedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyInput {
  projectId?: string | null;
  title: string;
  description?: string | null;
  propertyType?: (typeof PROPERTY_TYPES)[number];
  listingType?: (typeof LISTING_TYPES)[number];
  price: number;
  currency?: string;
  negotiable?: boolean;
  bedrooms?: number | null;
  bathrooms?: number | null;
  areaSqft?: number | null;
  carpetAreaSqft?: number | null;
  unitNumber?: string | null;
  tower?: string | null;
  floor?: number | null;
  facing?: string | null;
  furnishing?: (typeof FURNISHINGS)[number] | null;
  address?: string | null;
  city?: string | null;
  locality?: string | null;
  possessionDate?: string | null;
  reraId?: string | null;
  amenities?: string[];
  tags?: string[];
  ownerId?: string | null;
}
export type PropertyPatch = Partial<PropertyInput>;

export interface PropertyListQuery {
  limit: number;
  cursor?: string;
  q?: string;
  projectId?: string;
  status?: PropertyStatus[];
  propertyType?: string;
  listingType?: string;
  bedroomsMin?: number;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  city?: string;
  locality?: string;
  ownerId?: string;
  tag?: string;
  sort: 'created' | 'updated' | 'price' | 'area';
  order: 'asc' | 'desc';
}

const SORTS = {
  created: { sql: 'p.created_at', text: 'p.created_at::text', cast: '::timestamptz', field: '_k_created' },
  updated: { sql: 'p.updated_at', text: 'p.updated_at::text', cast: '::timestamptz', field: '_k_updated' },
  price: { sql: 'p.price', text: 'p.price::text', cast: '::numeric', field: '_k_price' },
  area: { sql: 'COALESCE(p.area_sqft, 0)', text: 'COALESCE(p.area_sqft, 0)::text', cast: '::numeric', field: '_k_area' },
} as const;

const COLUMNS = `
  p.id, p.project_id AS "projectId", pr.name AS "projectName", p.title, p.description, p.property_type AS "propertyType", p.listing_type AS "listingType",
  p.status, p.price::float8 AS price, p.currency, p.price_per_sqft::float8 AS "pricePerSqft", p.negotiable, p.bedrooms, p.bathrooms,
  p.area_sqft::float8 AS "areaSqft", p.carpet_area_sqft::float8 AS "carpetAreaSqft", p.unit_number AS "unitNumber", p.tower, p.floor, p.facing, p.furnishing,
  p.address, p.city, p.locality, p.location, to_char(p.possession_date, 'YYYY-MM-DD') AS "possessionDate", p.rera_id AS "reraId", p.amenities, p.tags,
  p.owner_id AS "ownerId", u.name AS "ownerName", p.cover_file_id AS "coverFileId",
  (SELECT count(*)::int FROM files f WHERE f.entity_type = 'property' AND f.entity_id = p.id AND f.kind = 'image' AND f.deleted_at IS NULL) AS "imageCount",
  p.status_changed_at AS "statusChangedAt", p.version, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  p.created_at::text AS _k_created, p.updated_at::text AS _k_updated, p.price::text AS _k_price, COALESCE(p.area_sqft, 0)::text AS _k_area`;
const FROM = `properties p LEFT JOIN projects pr ON pr.id = p.project_id AND pr.tenant_id = p.tenant_id LEFT JOIN users u ON u.id = p.owner_id`;

function toDto(row: any): PropertyDto {
  const { _k_created, _k_updated, _k_price, _k_area, ...rest } = row;
  return rest as PropertyDto;
}
const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export class PropertiesService {
  constructor(private db: Database) {}

  async list(actor: Actor, q: PropertyListQuery): Promise<{ items: PropertyDto[]; page: PageInfo }> {
    assertCan(actor, 'properties:read');
    const sig = `properties:${q.sort}:${q.order}`;
    const cursor = decodeCursor(q.cursor, sig);
    const params: unknown[] = [actor.tenantId];
    const where = ['p.tenant_id = $1', 'p.deleted_at IS NULL'];
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.projectId) where.push(`p.project_id = ${push(q.projectId)}`);
    if (q.status?.length) where.push(`p.status = ANY(${push(q.status)}::property_status_enum[])`);
    if (q.propertyType) where.push(`p.property_type = ${push(q.propertyType)}::property_type_enum`);
    if (q.listingType) where.push(`p.listing_type = ${push(q.listingType)}::listing_type_enum`);
    if (q.bedroomsMin !== undefined) where.push(`p.bedrooms >= ${push(q.bedroomsMin)}`);
    if (q.priceMin !== undefined) where.push(`p.price >= ${push(q.priceMin)}`);
    if (q.priceMax !== undefined) where.push(`p.price <= ${push(q.priceMax)}`);
    if (q.areaMin !== undefined) where.push(`p.area_sqft >= ${push(q.areaMin)}`);
    if (q.city) where.push(`p.city ILIKE ${push(`%${escapeLike(q.city)}%`)}`);
    if (q.locality) where.push(`p.locality ILIKE ${push(`%${escapeLike(q.locality)}%`)}`);
    if (q.ownerId) where.push(`p.owner_id = ${push(q.ownerId)}`);
    if (q.tag) where.push(`p.tags @> ${push(normalizeTags([q.tag]))}::text[]`);
    if (q.q?.trim()) {
      const like = push(`%${escapeLike(q.q.trim().slice(0, 100))}%`);
      where.push(`(p.title ILIKE ${like} OR p.locality ILIKE ${like} OR p.city ILIKE ${like} OR p.location ILIKE ${like} OR p.unit_number ILIKE ${like} OR pr.name ILIKE ${like})`);
    }
    const key = SORTS[q.sort];
    const pred = cursorPredicate(cursor, params, key.sql, 'p.id', q.order, key.cast);
    if (pred) where.push(pred);
    params.push(q.limit + 1);
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${key.sql} ${q.order}, p.id ${q.order} LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r[key.field] as string);
      return { items: items.map(toDto), page };
    });
  }

  async get(actor: Actor, id: string) {
    assertCan(actor, 'properties:read');
    return this.db.readTenant(actor, async (tx) => {
      const p = await this.fetch(tx, actor.tenantId, id);
      if (!p) throw Errors.notFound('Property');
      const [files, price, status] = await Promise.all([
        tx.query(
          `SELECT id, kind, name, mime, size_bytes AS "sizeBytes", sort_order AS "sortOrder", created_at AS "createdAt" FROM files
            WHERE tenant_id = $1 AND entity_type = 'property' AND entity_id = $2 AND deleted_at IS NULL ORDER BY (id = $3) DESC, sort_order, created_at`,
          [actor.tenantId, id, p.coverFileId]
        ),
        tx.query(`SELECT h.price::float8 AS price, h.currency, h.created_at AS "at", u.name AS "changedBy" FROM property_price_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.property_id = $1 AND h.tenant_id = $2 ORDER BY h.created_at DESC, h.id DESC LIMIT 25`, [id, actor.tenantId]),
        tx.query(`SELECT h.from_status AS "from", h.to_status AS "to", h.reason, h.created_at AS "at", u.name AS "changedBy" FROM property_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.property_id = $1 AND h.tenant_id = $2 ORDER BY h.created_at DESC, h.id DESC LIMIT 25`, [id, actor.tenantId]),
      ]);
      // While a deal owns the unit's status, the status buttons are not offered (the server would refuse them anyway)
      const deal = (
        await tx.query(
          `SELECT status FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND (status IN ('offered','reserved') OR (status = 'completed' AND $3::boolean)) ORDER BY (status = 'reserved') DESC LIMIT 1`,
          [actor.tenantId, id, p.status === 'sold' || p.status === 'rented']
        )
      ).rows[0] as { status: string } | undefined;
      const statusLock = !deal
        ? null
        : deal.status === 'completed'
          ? 'A sale is recorded against this property. Reopen that lead (a manager can) to reverse it.'
          : deal.status === 'reserved'
            ? 'This property is reserved for a buyer. Release the reservation or record the sale from the deal.'
            : 'This property has an open offer. Close the offer from the deal to change its status.';
      return {
        ...p,
        images: files.rows.filter((f) => f.kind === 'image'),
        documents: files.rows.filter((f) => f.kind === 'document'),
        priceHistory: price.rows as Array<{ price: number; currency: string; at: string; changedBy: string | null }>,
        statusHistory: status.rows as Array<{ from: PropertyStatus | null; to: PropertyStatus; reason: string | null; at: string; changedBy: string | null }>,
        allowedStatuses: statusLock ? [] : STATUS_TRANSITIONS[p.status],
        statusLock,
      };
    });
  }

  async summary(actor: Actor) {
    assertCan(actor, 'properties:read');
    return this.db.readTenant(actor, async (tx) => {
      const [byStatus, byType, available] = await Promise.all([
        tx.query(`SELECT status, count(*)::int AS n FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY status`, [actor.tenantId]),
        tx.query(`SELECT property_type AS type, count(*)::int AS n FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY property_type ORDER BY n DESC`, [actor.tenantId]),
        tx.query(`SELECT COALESCE(sum(price), 0)::float8 AS value, avg(price_per_sqft)::float8 AS "avgPricePerSqft", count(*)::int AS n FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'available'`, [actor.tenantId]),
      ]);
      const counts = Object.fromEntries(PROPERTY_STATUSES.map((s) => [s, 0])) as Record<PropertyStatus, number>;
      for (const r of byStatus.rows) counts[r.status as PropertyStatus] = r.n;
      return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts, byType: byType.rows as Array<{ type: string; n: number }>, available: { count: available.rows[0].n, value: available.rows[0].value as number, avgPricePerSqft: (available.rows[0].avgPricePerSqft as number | null) ?? null } };
    });
  }

  async create(actor: Actor, input: PropertyInput): Promise<PropertyDto> {
    assertCan(actor, 'properties:create');
    return this.db.withTenant(actor, async (tx) => {
      await this.assertRefs(tx, actor, input.projectId, input.ownerId);
      const loc = blank(input.locality) && blank(input.city) ? `${input.locality!.trim()}, ${input.city!.trim()}` : (blank(input.locality) ?? blank(input.city));
      let id: string;
      try {
        const ins = await tx.query(
          `INSERT INTO properties (tenant_id, project_id, title, description, property_type, listing_type, price, currency, negotiable, bedrooms, bathrooms, area_sqft, carpet_area_sqft,
                                   unit_number, tower, floor, facing, furnishing, address, city, locality, location, possession_date, rera_id, amenities, tags, owner_id, created_by)
           VALUES ($1,$2,$3,$4,$5::property_type_enum,$6::listing_type_enum,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::text[],$26::text[],$27,$28) RETURNING id`,
          [
            actor.tenantId, input.projectId ?? null, input.title.trim(), blank(input.description), input.propertyType ?? 'apartment', input.listingType ?? 'sale', input.price, (input.currency ?? 'INR').toUpperCase(),
            input.negotiable ?? true, input.bedrooms ?? null, input.bathrooms ?? null, input.areaSqft ?? null, input.carpetAreaSqft ?? null, blank(input.unitNumber), blank(input.tower), input.floor ?? null,
            blank(input.facing), input.furnishing ?? null, blank(input.address), blank(input.city), blank(input.locality), loc, input.possessionDate ?? null, blank(input.reraId),
            (input.amenities ?? []).map((a) => a.trim()).filter(Boolean), normalizeTags(input.tags), input.ownerId === undefined ? actor.userId : input.ownerId, actor.userId,
          ]
        );
        id = ins.rows[0].id;
      } catch (e: any) {
        if (e?.code === '23505' && e.constraint === 'uq_property_unit_live') throw Errors.conflict('That unit already exists in this project');
        throw e;
      }
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'property.create', entityType: 'property', entityId: id, after: { title: dto.title, price: dto.price, projectId: dto.projectId } });
      await emit(tx, { type: 'property.created', aggregateId: id, payload: { projectId: dto.projectId } });
      return dto;
    });
  }

  async update(actor: Actor, id: string, patch: PropertyPatch, expectedVersion?: number): Promise<PropertyDto> {
    assertCan(actor, 'properties:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT version, status FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Property');
      if (expectedVersion !== undefined && expectedVersion !== cur.rows[0].version) throw Errors.preconditionFailed();
      if (patch.projectId !== undefined || patch.ownerId !== undefined) await this.assertRefs(tx, actor, patch.projectId, patch.ownerId);
      const before = (await this.fetch(tx, actor.tenantId, id))!;
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => (params.push(v), sets.push(`${col} = $${params.length}${cast}`));
      const map: Array<[keyof PropertyPatch, string, string?, ((v: any) => unknown)?]> = [
        ['projectId', 'project_id'], ['title', 'title', '', (v) => String(v).trim()], ['description', 'description', '', blank], ['propertyType', 'property_type', '::property_type_enum'],
        ['listingType', 'listing_type', '::listing_type_enum'], ['price', 'price'], ['currency', 'currency', '', (v) => String(v).toUpperCase()], ['negotiable', 'negotiable'], ['bedrooms', 'bedrooms'],
        ['bathrooms', 'bathrooms'], ['areaSqft', 'area_sqft'], ['carpetAreaSqft', 'carpet_area_sqft'], ['unitNumber', 'unit_number', '', blank], ['tower', 'tower', '', blank], ['floor', 'floor'],
        ['facing', 'facing', '', blank], ['furnishing', 'furnishing'], ['address', 'address', '', blank], ['city', 'city', '', blank], ['locality', 'locality', '', blank], ['possessionDate', 'possession_date'],
        ['reraId', 'rera_id', '', blank], ['ownerId', 'owner_id'],
      ];
      for (const [key, col, cast = '', fn] of map) if (patch[key] !== undefined) set(col, fn ? fn(patch[key]) : patch[key], cast);
      if (patch.amenities !== undefined) set('amenities', patch.amenities.map((a) => a.trim()).filter(Boolean), '::text[]');
      if (patch.tags !== undefined) set('tags', normalizeTags(patch.tags), '::text[]');
      if (patch.locality !== undefined || patch.city !== undefined) {
        const loc = blank(patch.locality !== undefined ? patch.locality : before.locality);
        const city = blank(patch.city !== undefined ? patch.city : before.city);
        set('location', loc && city ? `${loc}, ${city}` : (loc ?? city));
      }
      if (patch.listingType !== undefined) {
        if (before.status === 'sold' && patch.listingType !== 'sale') throw Errors.conflict('A sold property cannot be switched to rent or lease. Make it available first.');
        if (before.status === 'rented' && patch.listingType === 'sale') throw Errors.conflict('A rented property cannot be switched to sale. Make it available first.');
      }
      try {
        if (sets.length) await tx.query(`UPDATE properties SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      } catch (e: any) {
        if (e?.code === '23505' && e.constraint === 'uq_property_unit_live') throw Errors.conflict('That unit already exists in this project');
        throw e;
      }
      const after = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'property.update', entityType: 'property', entityId: id, before, after });
      await emit(tx, { type: 'property.updated', aggregateId: id, payload: { version: after.version, priceChanged: after.price !== before.price } });
      return after;
    });
  }

  async changeStatus(actor: Actor, id: string, to: PropertyStatus, reason?: string | null): Promise<PropertyDto> {
    assertCan(actor, 'properties:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT status, listing_type FROM properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      const row = cur.rows[0];
      if (!row) throw Errors.notFound('Property');
      const from = row.status as PropertyStatus;
      if (from === to) throw Errors.conflict(`This property is already ${to.replace('_', ' ')}`);
      await this.assertNoDeal(tx, actor, id, from);
      if (!STATUS_TRANSITIONS[from].includes(to)) throw Errors.invalidTransition(`A ${from.replace('_', ' ')} property can become: ${STATUS_TRANSITIONS[from].map((s) => s.replace('_', ' ')).join(', ')}`);
      if (to === 'sold' && row.listing_type !== 'sale') throw Errors.conflict('Only properties listed for sale can be marked sold. Use “rented” for rentals and leases.');
      if (to === 'rented' && row.listing_type === 'sale') throw Errors.conflict('Only properties listed for rent or lease can be marked rented. Use “sold” for sales.');
      if ((from === 'sold' || from === 'rented') && !reason?.trim()) throw Errors.validation([{ path: 'body.reason', message: `Say why this ${from === 'sold' ? 'sale' : 'rental'} is being reversed` }]);
      // The history trigger reads the reason from this transaction-local setting (set_config(..., true) cannot leak to other requests).
      await tx.query(`SELECT set_config('app.status_reason', $1, true)`, [reason?.trim().slice(0, 300) ?? '']);
      await tx.query(`UPDATE properties SET status = $3::property_status_enum WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId, to]);
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'property.status_change', entityType: 'property', entityId: id, before: { status: from }, after: { status: to, reason } });
      await emit(tx, { type: 'property.status_changed', aggregateId: id, payload: { from, to } });
      return dto;
    });
  }

  /**
   * While a buyer has an open offer or reservation on a unit, or a sale is recorded against it, its status belongs to that deal:
   * changing it by hand would leave the deal and the unit telling different stories. The deal is ended from the deal.
   */
  private async assertNoDeal(tx: pg.PoolClient, actor: Actor, id: string, from?: PropertyStatus) {
    const open = await tx.query(`SELECT status FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status IN ('offered','reserved') ORDER BY (status = 'reserved') DESC LIMIT 1`, [actor.tenantId, id]);
    if (open.rows[0]) {
      throw Errors.conflict(open.rows[0].status === 'reserved' ? 'This unit is reserved for a buyer. Release or complete that reservation from the deal instead of changing the status here.' : 'This unit has an open offer. Close the offer from the deal instead of changing the status here.', { extensions: { reason: 'open_deal' } });
    }
    if (from === 'sold' || from === 'rented') {
      const sale = await tx.query(`SELECT 1 FROM reservations WHERE tenant_id = $1 AND property_id = $2 AND status = 'completed'`, [actor.tenantId, id]);
      if (sale.rowCount) throw Errors.conflict('A sale is recorded against this unit. Reopen that lead (a manager can) to reverse the sale; the unit then becomes available again.', { extensions: { reason: 'recorded_sale' } });
    }
  }

  async archive(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'properties:delete');
    await this.db.withTenant(actor, async (tx) => {
      await this.assertNoDeal(tx, actor, id);
      const r = await tx.query(`UPDATE properties SET deleted_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING title`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Property');
      await audit(tx, { action: 'property.delete', entityType: 'property', entityId: id, before: r.rows[0] });
      await emit(tx, { type: 'property.updated', aggregateId: id, payload: { archived: true } });
    });
  }

  async restore(actor: Actor, id: string): Promise<PropertyDto> {
    assertCan(actor, 'properties:delete');
    return this.db.withTenant(actor, async (tx) => {
      try {
        const r = await tx.query(`UPDATE properties SET deleted_at = NULL WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL RETURNING id`, [id, actor.tenantId]);
        if (!r.rowCount) throw Errors.notFound('Archived property');
      } catch (e: any) {
        if (e?.code === '23505') throw Errors.conflict('Another property now uses that unit number in this project');
        throw e;
      }
      await audit(tx, { action: 'property.restore', entityType: 'property', entityId: id });
      await emit(tx, { type: 'property.updated', aggregateId: id, payload: { restored: true } });
      return (await this.fetch(tx, actor.tenantId, id))!;
    });
  }

  async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<PropertyDto | undefined> {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NULL`, [id, tenantId]);
    return rows[0] ? toDto(rows[0]) : undefined;
  }

  private async assertRefs(tx: pg.PoolClient, actor: Actor, projectId: string | null | undefined, ownerId: string | null | undefined) {
    if (projectId) {
      const ok = await tx.query(`SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [projectId, actor.tenantId]);
      if (!ok.rowCount) throw Errors.validation([{ path: 'body.projectId', message: 'Project not found' }]);
    }
    if (ownerId) {
      const ok = await tx.query(`SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND tm.is_active AND u.is_active`, [actor.tenantId, ownerId]);
      if (!ok.rowCount) throw Errors.validation([{ path: 'body.ownerId', message: 'Listing agent must be an active member of this workspace' }]);
    }
  }
}
