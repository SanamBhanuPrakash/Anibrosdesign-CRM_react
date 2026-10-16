import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';

export interface NotificationDto {
  id: string;
  title: string;
  message: string;
  type: string;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

/** In-app notifications are strictly personal: every query is pinned to the caller's own user id. */
export class NotificationsService {
  constructor(private db: Database) {}

  private who(actor: Actor): string {
    if (!actor.userId) throw Errors.forbidden('Notifications belong to people, not API keys');
    return actor.userId;
  }

  async list(actor: Actor, q: { limit: number; cursor?: string; unreadOnly: boolean }): Promise<{ items: NotificationDto[]; page: PageInfo }> {
    assertCan(actor, 'notifications:read');
    const userId = this.who(actor);
    const sig = `notifications:${q.unreadOnly ? 'unread' : 'all'}`;
    const cursor = decodeCursor(q.cursor, sig);
    const params: unknown[] = [actor.tenantId, userId];
    const pred = cursorPredicate(cursor, params, 'n.created_at', 'n.id', 'desc', '::timestamptz');
    params.push(q.limit + 1);
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT n.id, n.title, n.message, n.type, n.link, n.entity_type AS "entityType", n.entity_id AS "entityId", n.is_read AS "isRead", n.read_at AS "readAt",
                n.created_at AS "createdAt", n.created_at::text AS _k
           FROM notifications n WHERE n.tenant_id = $1 AND n.user_id = $2 ${q.unreadOnly ? 'AND NOT n.is_read' : ''} ${pred ? `AND ${pred}` : ''}
          ORDER BY n.created_at DESC, n.id DESC LIMIT $${params.length}`,
        params
      );
      const { items, page } = buildPage(rows as Array<{ id: string; _k: string } & Record<string, unknown>>, q.limit, sig, (r) => r._k);
      return { items: items.map(({ _k, ...rest }) => rest as unknown as NotificationDto), page };
    });
  }

  async unreadCount(actor: Actor): Promise<number> {
    assertCan(actor, 'notifications:read');
    const userId = this.who(actor);
    return this.db.readTenant(actor, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND NOT is_read`, [actor.tenantId, userId])).rows[0].n);
  }

  async markRead(actor: Actor, which: 'all' | string[]): Promise<number> {
    assertCan(actor, 'notifications:read');
    const userId = this.who(actor);
    return this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(
        `UPDATE notifications SET is_read = true, read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND NOT is_read ${which === 'all' ? '' : 'AND id = ANY($3::uuid[])'}`,
        which === 'all' ? [actor.tenantId, userId] : [actor.tenantId, userId, which]
      );
      return r.rowCount ?? 0;
    });
  }
}
