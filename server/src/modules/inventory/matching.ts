import { z } from 'zod';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { defineRoute, type RouteSpec } from '../../platform/http/route';
import { LISTING_TYPES, PROPERTY_TYPES } from './properties.service';

/**
 * Property matching (rule-based, explainable). This is NOT AI: fixed weights, every point is explained in `matchReasons`.
 * Weights: budget 40, location 25, bedrooms 20, type 15 (neutral credit when a criterion is not given, so a vague search still ranks).
 * Only live (non-archived) properties that are currently available are considered.
 */
export interface MatchCriteria {
  budgetMin?: number;
  budgetMax?: number;
  location?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  listingType?: string;
}
export interface MatchCandidate {
  id: string;
  price: number;
  currency: string;
  location: string | null;
  bedrooms: number | null;
  property_type: string | null;
  listing_type: string | null;
}

export function scoreProperty(row: MatchCandidate, c: MatchCriteria): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const price = Number(row.price);

  if (c.budgetMin !== undefined || c.budgetMax !== undefined) {
    const min = c.budgetMin ?? 0;
    const max = c.budgetMax ?? Infinity;
    if (price >= min && price <= max) {
      score += 40;
      reasons.push(`Price (${price} ${row.currency}) is within requested budget range`);
    } else if ((c.budgetMin !== undefined && price >= c.budgetMin * 0.85 && price < c.budgetMin) || (c.budgetMax !== undefined && price <= c.budgetMax * 1.15 && price > c.budgetMax)) {
      score += 20;
      reasons.push(`Price (${price} ${row.currency}) is within 15% margin of budget`);
    }
  } else score += 20;

  const loc = c.location?.trim();
  if (loc) {
    if (row.location && row.location.toLowerCase().includes(loc.toLowerCase())) {
      score += 25;
      reasons.push(`Location matches preferred area '${loc}' (found: ${row.location})`);
    }
  } else if (c.location === undefined) score += 15;

  if (c.bedrooms !== undefined && c.bedrooms > 0) {
    if (row.bedrooms === c.bedrooms) {
      score += 20;
      reasons.push(`Exact bedroom match: ${c.bedrooms} BHK`);
    } else if (Math.abs((row.bedrooms || 0) - c.bedrooms) === 1) {
      score += 10;
      reasons.push(`Close bedroom count: property has ${row.bedrooms} BHK`);
    }
  } else score += 10;

  const type = c.propertyType?.trim();
  if (type) {
    if (row.property_type && row.property_type.toLowerCase() === type.toLowerCase()) {
      score += 15;
      reasons.push(`Property type matches: ${type}`);
    }
  } else score += 10;

  return { score: Math.min(100, Math.round(score)), reasons };
}

export class MatchingService {
  constructor(private db: Database) {}

  async match(actor: Actor, c: MatchCriteria, limit = 25) {
    assertCan(actor, 'matching:use');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = [`tenant_id = $1`, `deleted_at IS NULL`, `status = 'available'`];
      if (c.listingType) where.push(`listing_type = $${params.push(c.listingType)}::listing_type_enum`);
      const { rows } = await tx.query(
        `SELECT id, project_id, title, description, property_type, listing_type, status, price::float8 AS price, currency, bedrooms, bathrooms, area_sqft::float8 AS area_sqft,
                COALESCE(location, NULLIF(concat_ws(', ', locality, city), '')) AS location
           FROM properties WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 2000`,
        params
      );
      const matches = rows
        .map((row) => {
          const { score, reasons } = scoreProperty(row, c);
          return {
            property: { id: row.id, title: row.title, description: row.description, propertyType: row.property_type, listingType: row.listing_type, status: row.status, price: row.price, currency: row.currency, bedrooms: row.bedrooms, bathrooms: row.bathrooms, areaSqft: row.area_sqft, location: row.location },
            score,
            matchReasons: reasons,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { matches };
    });
  }
}

const money = z.number().min(0).max(1e13);
export function createMatchingRoutes(svc: MatchingService): RouteSpec[] {
  return [
    defineRoute({
      method: 'post',
      path: '/properties',
      summary: 'Suggest properties for a buyer',
      description: 'Scores available, non-archived properties against a buyer’s budget, area, bedrooms and type. Rule-based and explainable (every score lists its reasons). Returns the 25 best.',
      tags: ['Matching'],
      permission: 'matching:use',
      successStatus: 200,
      body: z.object({
        budgetMin: money.optional(), budgetMax: money.optional(), location: z.string().trim().max(100).optional(), propertyType: z.enum(PROPERTY_TYPES).optional(),
        bedrooms: z.number().int().min(0).max(50).optional(), bathrooms: z.number().int().min(0).max(50).optional(), listingType: z.enum(LISTING_TYPES).optional(),
      }),
      response: z.object({
        matches: z.array(z.object({ property: z.record(z.string(), z.unknown()), score: z.number().int(), matchReasons: z.array(z.string()) })),
      }),
      handler: async ({ body, actor }) => svc.match(actor, body),
    }),
  ];
}
