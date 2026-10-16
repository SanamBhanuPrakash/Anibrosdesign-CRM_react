import type pg from 'pg';
import { emit } from './events';

export interface NotifyInput {
  userId: string;
  title: string;
  message: string;
  type: string;
  /** In-app path only ("/leads/…"); the database refuses anything else so a notification can never be a phishing link. */
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Same key for the same logical notification ⇒ delivered once, however often the producer retries. */
  dedupeKey?: string;
}

/** Runs inside the producer's transaction: the notification exists iff the business change committed. */
export async function notify(tx: pg.PoolClient, n: NotifyInput): Promise<string | null> {
  const { rows } = await tx.query(
    `INSERT INTO notifications (tenant_id, user_id, title, message, type, link, entity_type, entity_id, dedupe_key)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING RETURNING id`,
    [n.userId, n.title.slice(0, 200), n.message.slice(0, 500), n.type, n.link ?? null, n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null]
  );
  const id = rows[0]?.id as string | undefined;
  if (id) await emit(tx, { type: 'notification.created', aggregateId: id, payload: { userId: n.userId } });
  return id ?? null;
}
