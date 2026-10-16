import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { escapeLike } from '../contacts/normalize';

export const PROJECT_STATUSES = ['upcoming', 'active', 'on_hold', 'completed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  developer: string | null;
  city: string | null;
  locality: string | null;
  address: string | null;
  reraId: string | null;
  possessionDate: string | null;
  amenities: string[];
  status: ProjectStatus;
  units: { total: number; available: number; held: number; closed: number; inactive: number; minPrice: number | null; maxPrice: number | null; availableValue: number };
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectInput {
  name: string;
  description?: string | null;
  developer?: string | null;
  city?: string | null;
  locality?: string | null;
  address?: string | null;
  reraId?: string | null;
  possessionDate?: string | null;
  amenities?: string[];
  status?: ProjectStatus;
}

const COLUMNS = `
  pr.id, pr.name, pr.description, pr.developer, pr.city, pr.locality, pr.address, pr.rera_id AS "reraId", to_char(pr.possession_date, 'YYYY-MM-DD') AS "possessionDate",
  pr.amenities, pr.status, pr.version, pr.created_at AS "createdAt", pr.updated_at AS "updatedAt",
  COALESCE(s.total, 0) AS _total, COALESCE(s.available, 0) AS _available, COALESCE(s.held, 0) AS _held, COALESCE(s.closed, 0) AS _closed, COALESCE(s.inactive, 0) AS _inactive,
  s.min_price::float8 AS _min, s.max_price::float8 AS _max, COALESCE(s.available_value, 0)::float8 AS _value,
  lower(pr.name) AS _k_name, pr.created_at::text AS _k_created`;
const FROM = `projects pr LEFT JOIN LATERAL (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE p.status = 'available')::int AS available,
           count(*) FILTER (WHERE p.status IN ('under_offer', 'reserved'))::int AS held,
           count(*) FILTER (WHERE p.status IN ('sold', 'rented'))::int AS closed,
           count(*) FILTER (WHERE p.status = 'inactive')::int AS inactive,
           min(p.price) FILTER (WHERE p.status = 'available') AS min_price, max(p.price) FILTER (WHERE p.status = 'available') AS max_price,
           COALESCE(sum(p.price) FILTER (WHERE p.status = 'available'), 0) AS available_value
      FROM properties p WHERE p.project_id = pr.id AND p.tenant_id = pr.tenant_id AND p.deleted_at IS NULL) s ON true`;

function toDto(row: any): ProjectDto {
  const { _total, _available, _held, _closed, _inactive, _min, _max, _value, _k_name, _k_created, ...rest } = row;
  return { ...rest, units: { total: _total, available: _available, held: _held, closed: _closed, inactive: _inactive, minPrice: _min, maxPrice: _max, availableValue: _value } } as ProjectDto;
}
const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export class ProjectsService {
  constructor(private db: Database) {}

  async list(actor: Actor, q: { limit: number; cursor?: string; q?: string; status?: ProjectStatus; city?: string; sort: 'name' | 'created'; order: 'asc' | 'desc' }): Promise<{ items: ProjectDto[]; page: PageInfo }> {
    assertCan(actor, 'projects:read');
    const sig = `projects:${q.sort}:${q.order}`;
    const cursor = decodeCursor(q.cursor, sig);
    const params: unknown[] = [actor.tenantId];
    const where = ['pr.tenant_id = $1', 'pr.deleted_at IS NULL'];
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.status) where.push(`pr.status = ${push(q.status)}`);
    if (q.city) where.push(`pr.city ILIKE ${push(`%${escapeLike(q.city)}%`)}`);
    if (q.q?.trim()) {
      const like = push(`%${escapeLike(q.q.trim().slice(0, 100))}%`);
      where.push(`(pr.name ILIKE ${like} OR pr.developer ILIKE ${like} OR pr.locality ILIKE ${like} OR pr.city ILIKE ${like})`);
    }
    const key = q.sort === 'name' ? { sql: 'lower(pr.name)', cast: '', field: '_k_name' } : { sql: 'pr.created_at', cast: '::timestamptz', field: '_k_created' };
    const pred = cursorPredicate(cursor, params, key.sql, 'pr.id', q.order, key.cast);
    if (pred) where.push(pred);
    params.push(q.limit + 1);
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${key.sql} ${q.order}, pr.id ${q.order} LIMIT $${params.length}`, params);
      const { items, page } = buildPage(rows as Array<{ id: string } & Record<string, any>>, q.limit, sig, (r) => r[key.field] as string);
      return { items: items.map(toDto), page };
    });
  }

  async get(actor: Actor, id: string): Promise<ProjectDto> {
    assertCan(actor, 'projects:read');
    return this.db.readTenant(actor, async (tx) => {
      const p = await this.fetch(tx, actor.tenantId, id);
      if (!p) throw Errors.notFound('Project');
      return p;
    });
  }

  async create(actor: Actor, input: ProjectInput): Promise<ProjectDto> {
    assertCan(actor, 'projects:create');
    return this.db.withTenant(actor, async (tx) => {
      let id: string;
      try {
        const r = await tx.query(
          `INSERT INTO projects (tenant_id, name, description, developer, city, locality, address, rera_id, possession_date, amenities, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12) RETURNING id`,
          [actor.tenantId, input.name.trim(), blank(input.description), blank(input.developer), blank(input.city), blank(input.locality), blank(input.address), blank(input.reraId), input.possessionDate ?? null, (input.amenities ?? []).map((a) => a.trim()).filter(Boolean), input.status ?? 'active', actor.userId]
        );
        id = r.rows[0].id;
      } catch (e: any) {
        if (e?.code === '23505' && e.constraint === 'uq_project_name_live') throw Errors.conflict('You already have a project with that name');
        throw e;
      }
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'project.create', entityType: 'project', entityId: id, after: { name: dto.name } });
      await emit(tx, { type: 'project.updated', aggregateId: id });
      return dto;
    });
  }

  async update(actor: Actor, id: string, patch: Partial<ProjectInput>, expectedVersion?: number): Promise<ProjectDto> {
    assertCan(actor, 'projects:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT version FROM projects WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Project');
      if (expectedVersion !== undefined && expectedVersion !== cur.rows[0].version) throw Errors.preconditionFailed();
      const before = (await this.fetch(tx, actor.tenantId, id))!;
      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => (params.push(v), sets.push(`${col} = $${params.length}${cast}`));
      if (patch.name !== undefined) set('name', patch.name.trim());
      for (const [k, col] of [['description', 'description'], ['developer', 'developer'], ['city', 'city'], ['locality', 'locality'], ['address', 'address'], ['reraId', 'rera_id']] as const) {
        if (patch[k] !== undefined) set(col, blank(patch[k]));
      }
      if (patch.possessionDate !== undefined) set('possession_date', patch.possessionDate);
      if (patch.amenities !== undefined) set('amenities', patch.amenities.map((a) => a.trim()).filter(Boolean), '::text[]');
      if (patch.status !== undefined) set('status', patch.status);
      try {
        if (sets.length) await tx.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      } catch (e: any) {
        if (e?.code === '23505' && e.constraint === 'uq_project_name_live') throw Errors.conflict('You already have a project with that name');
        throw e;
      }
      const after = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'project.update', entityType: 'project', entityId: id, before, after });
      await emit(tx, { type: 'project.updated', aggregateId: id, payload: { version: after.version } });
      return after;
    });
  }

  async archive(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'projects:delete');
    await this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT name FROM projects WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Project');
      const n = await tx.query(`SELECT count(*)::int AS n FROM properties WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, actor.tenantId]);
      if (n.rows[0].n > 0) throw Errors.conflict(`This project still has ${n.rows[0].n} propert${n.rows[0].n === 1 ? 'y' : 'ies'}. Archive or move them first.`, { extensions: { reason: 'project_in_use', propertyCount: n.rows[0].n } });
      await tx.query(`UPDATE projects SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      await audit(tx, { action: 'project.delete', entityType: 'project', entityId: id, before: cur.rows[0] });
      await emit(tx, { type: 'project.updated', aggregateId: id, payload: { archived: true } });
    });
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<ProjectDto | undefined> {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE pr.id = $1 AND pr.tenant_id = $2 AND pr.deleted_at IS NULL`, [id, tenantId]);
    return rows[0] ? toDto(rows[0]) : undefined;
  }
}
