import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';

export type ViewEntity = 'lead' | 'contact';
export interface SavedViewDto {
  id: string;
  entity: ViewEntity;
  name: string;
  filters: Record<string, unknown>;
  sort: string | null;
  isShared: boolean;
  isMine: boolean;
  ownerName: string | null;
  updatedAt: string;
}

const MAX_VIEWS = 50;
const COLUMNS = `v.id, v.entity, v.name, v.filters, v.sort, v.is_shared AS "isShared", (v.owner_id = $2) AS "isMine", u.name AS "ownerName", v.updated_at AS "updatedAt"`;

/**
 * Saved views: a named filter + sort a person (or the whole team) comes back to — "My hot leads", "Unassigned today".
 * Private by default; managers may share a view with the workspace. Only the owner edits or deletes it.
 */
export class SavedViewsService {
  constructor(private db: Database) {}

  async list(actor: Actor, entity: ViewEntity): Promise<SavedViewDto[]> {
    assertCan(actor, 'saved_views:manage');
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${COLUMNS} FROM saved_views v JOIN users u ON u.id = v.owner_id
          WHERE v.tenant_id = $1 AND v.entity = $3 AND (v.owner_id = $2 OR v.is_shared) ORDER BY (v.owner_id = $2) DESC, lower(v.name)`,
        [actor.tenantId, actor.userId, entity]
      );
      return rows as SavedViewDto[];
    });
  }

  async create(actor: Actor, input: { entity: ViewEntity; name: string; filters: Record<string, unknown>; sort?: string | null; isShared?: boolean }): Promise<SavedViewDto> {
    assertCan(actor, 'saved_views:manage');
    this.assertMaySharing(actor, input.isShared);
    return this.db.withTenant(actor, async (tx) => {
      const n = await tx.query(`SELECT count(*)::int AS n FROM saved_views WHERE tenant_id = $1 AND owner_id = $2 AND entity = $3`, [actor.tenantId, actor.userId, input.entity]);
      if (n.rows[0].n >= MAX_VIEWS) throw Errors.conflict(`You can keep at most ${MAX_VIEWS} saved views. Delete one you no longer use.`);
      try {
        const ins = await tx.query(
          `INSERT INTO saved_views (tenant_id, owner_id, entity, name, filters, sort, is_shared) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
          [actor.tenantId, actor.userId, input.entity, input.name.trim(), JSON.stringify(input.filters), input.sort ?? null, Boolean(input.isShared)]
        );
        await audit(tx, { action: 'saved_view.create', entityType: 'saved_view', entityId: ins.rows[0].id, after: { name: input.name, entity: input.entity, shared: Boolean(input.isShared) } });
        return (await this.fetch(tx, actor, ins.rows[0].id))!;
      } catch (e: any) {
        if (e?.code === '23505') throw Errors.conflict('You already have a view with that name');
        throw e;
      }
    });
  }

  async update(actor: Actor, id: string, patch: { name?: string; filters?: Record<string, unknown>; sort?: string | null; isShared?: boolean }): Promise<SavedViewDto> {
    assertCan(actor, 'saved_views:manage');
    this.assertMaySharing(actor, patch.isShared);
    return this.db.withTenant(actor, async (tx) => {
      try {
        const r = await tx.query(
          `UPDATE saved_views SET name = COALESCE($4, name), filters = COALESCE($5::jsonb, filters), sort = CASE WHEN $6::boolean THEN $7 ELSE sort END, is_shared = COALESCE($8, is_shared)
            WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 RETURNING id`,
          [id, actor.tenantId, actor.userId, patch.name?.trim() ?? null, patch.filters ? JSON.stringify(patch.filters) : null, patch.sort !== undefined, patch.sort ?? null, patch.isShared ?? null]
        );
        if (!r.rowCount) throw Errors.notFound('Saved view');
      } catch (e: any) {
        if (e?.code === '23505') throw Errors.conflict('You already have a view with that name');
        throw e;
      }
      await audit(tx, { action: 'saved_view.update', entityType: 'saved_view', entityId: id, after: patch });
      return (await this.fetch(tx, actor, id))!;
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'saved_views:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`DELETE FROM saved_views WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 RETURNING name`, [id, actor.tenantId, actor.userId]);
      if (!r.rowCount) throw Errors.notFound('Saved view');
      await audit(tx, { action: 'saved_view.delete', entityType: 'saved_view', entityId: id, before: r.rows[0] });
    });
  }

  private assertMaySharing(actor: Actor, wantsShared: boolean | undefined) {
    if (wantsShared && scopeIfAllowed(actor, 'leads:bulk') !== 'all') throw Errors.forbidden('Only managers can share a view with the workspace');
  }

  private async fetch(tx: import('pg').PoolClient, actor: Actor, id: string) {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM saved_views v JOIN users u ON u.id = v.owner_id WHERE v.id = $1 AND v.tenant_id = $3`, [id, actor.userId, actor.tenantId]);
    return rows[0] as SavedViewDto | undefined;
  }
}
