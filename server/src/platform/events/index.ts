import type pg from 'pg';
import type { Database } from '../db';
import { logger } from '../../logger';

/**
 * Domain events — the single spine for "something happened".
 *
 *   emit(tx, …)  writes a row to `domain_events` INSIDE the business transaction (transactional outbox).
 *                Commit ⇒ event exists and listeners are NOTIFYed. Rollback ⇒ neither. No lost or phantom events.
 *   dispatcher   (worker) reads events in (tx_id, id) order up to the oldest in-flight transaction, per-consumer cursor.
 *                Delivery is at-least-once; consumers are idempotent (jobs are enqueued with dedupe keys).
 *
 * Realtime fan-out to browsers does NOT use the dispatcher: the API processes LISTEN to the NOTIFY the insert trigger
 * emits (ids/types only) and push to authorized sockets; clients refetch authoritative data via the normal API.
 */

/** Event catalog: add new events here so they are discoverable, typed and documented. */
export const EVENT_CATALOG = {
  'lead.created': { aggregate: 'lead', description: 'A lead was created (any channel).', permission: 'leads:read' },
  'lead.updated': { aggregate: 'lead', description: 'Lead fields changed.', permission: 'leads:read' },
  'lead.deleted': { aggregate: 'lead', description: 'Lead was archived (soft-deleted).', permission: 'leads:read' },
  'lead.assigned': { aggregate: 'lead', description: 'Lead owner changed.', permission: 'leads:read' },
  'lead.stage_changed': { aggregate: 'lead', description: 'Lead moved to another pipeline stage.', permission: 'leads:read' },
  'pipeline.updated': { aggregate: 'pipeline', description: 'A pipeline, its stages or its transition rules changed.', permission: 'pipeline:read' },
  'import.updated': { aggregate: 'import', description: 'A CSV import changed state or progressed.', permission: 'leads:import' },
  'contact.created': { aggregate: 'contact', description: 'A contact was created.', permission: 'contacts:read' },
  'contact.updated': { aggregate: 'contact', description: 'Contact fields changed.', permission: 'contacts:read' },
  'contact.deleted': { aggregate: 'contact', description: 'A contact was archived.', permission: 'contacts:read' },
  'contact.merged': { aggregate: 'contact', description: 'Two contacts were merged.', permission: 'contacts:read' },
  'activity.created': { aggregate: 'activity', description: 'A note/call/email/meeting was logged.', permission: 'activities:read' },
  'task.created': { aggregate: 'task', description: 'A task was created.', permission: 'tasks:read' },
  'task.updated': { aggregate: 'task', description: 'A task changed.', permission: 'tasks:read' },
  'task.deleted': { aggregate: 'task', description: 'A task was deleted.', permission: 'tasks:read' },
  'task.completed': { aggregate: 'task', description: 'A task was completed.', permission: 'tasks:read' },
  'viewing.scheduled': { aggregate: 'viewing', description: 'A viewing was booked.', permission: 'viewings:read' },
  'viewing.updated': { aggregate: 'viewing', description: 'A viewing changed (reschedule, status).', permission: 'viewings:read' },
  'project.updated': { aggregate: 'project', description: 'A project (development) or its files changed.', permission: 'projects:read' },
  'reservation.created': { aggregate: 'reservation', description: 'An offer was recorded on a unit.', permission: 'reservations:read' },
  'reservation.updated': { aggregate: 'reservation', description: 'A reservation was made or an open offer or reservation was edited.', permission: 'reservations:read' },
  'reservation.completed': { aggregate: 'reservation', description: 'A sale was recorded (deal value tied to a unit).', permission: 'reservations:read' },
  'reservation.closed': { aggregate: 'reservation', description: 'An offer or reservation ended without a sale, or a recorded sale was reversed.', permission: 'reservations:read' },
  'shortlist.changed': { aggregate: 'lead', description: 'A property was added to, changed on or removed from a buyer’s shortlist.', permission: 'leads:read' },
  'property.created': { aggregate: 'property', description: 'A property was created.', permission: 'properties:read' },
  'property.updated': { aggregate: 'property', description: 'A property changed.', permission: 'properties:read' },
  'property.status_changed': { aggregate: 'property', description: 'Availability status changed.', permission: 'properties:read' },
  'notification.created': { aggregate: 'notification', description: 'An in-app notification was created.', permission: 'notifications:read' },
  'lead_source.updated': { aggregate: 'lead_source', description: 'A lead source (inbound endpoint) was created, changed, paused or deleted.', permission: 'integrations:read' },
  'inbound.updated': { aggregate: 'inbound_event', description: 'A lead-source delivery was received, processed, retried or ignored.', permission: 'integrations:manage' },
  'integration.updated': { aggregate: 'integration', description: 'Integration configuration or health changed.', permission: 'integrations:read' },
  'webhook.received': { aggregate: 'webhook_inbox', description: 'An inbound provider webhook was durably received.', permission: 'operations:read' },
  'automation.updated': { aggregate: 'automation', description: 'An automation was turned on or off, or one of its runs finished.', permission: 'automation:read' },
  'member.invited': { aggregate: 'member', description: 'A workspace invitation was sent.', permission: 'members:read' },
  'member.updated': { aggregate: 'member', description: 'Membership role/status changed.', permission: 'members:read' },
} as const;

export type EventType = keyof typeof EVENT_CATALOG;

export interface EmitInput {
  type: EventType;
  aggregateId: string;
  /** Small, non-sensitive facts for consumers (ids, from/to values). Hard limit 4 kB (CHECK constraint). */
  payload?: Record<string, unknown>;
}

/** Must be called with the transaction client of the business operation. */
export async function emit(tx: pg.PoolClient, event: EmitInput): Promise<void> {
  await tx.query(
    `INSERT INTO domain_events (type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [event.type, EVENT_CATALOG[event.type].aggregate, event.aggregateId, JSON.stringify(event.payload ?? {})]
  );
}

export interface DomainEventRow {
  id: string; // bigint as string
  txId: string;
  tenantId: string;
  type: EventType | string;
  aggregateType: string;
  aggregateId: string;
  actorUserId: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface EventConsumer {
  name: string;
  /** Runs inside the cursor-advancing transaction: enqueue idempotent jobs here, do NOT do external I/O. */
  handle(events: DomainEventRow[], tx: pg.PoolClient): Promise<void>;
}

export interface DispatcherOptions {
  batchSize?: number;
}

/**
 * Per-consumer cursor dispatcher. Safe with N worker replicas: a row lock on the consumer cursor means exactly one
 * replica advances a given consumer at a time.
 */
export class EventDispatcher {
  constructor(
    private db: Database,
    private consumers: EventConsumer[],
    private opts: DispatcherOptions = {}
  ) {}

  /** Process one batch for every consumer. Returns the number of events handled per consumer. */
  async runOnce(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const consumer of this.consumers) {
      try {
        result[consumer.name] = await this.runConsumer(consumer);
      } catch (err: any) {
        result[consumer.name] = 0;
        logger.error('Event consumer failed; cursor not advanced', { consumer: consumer.name, error: err.message });
      }
    }
    return result;
  }

  private async runConsumer(consumer: EventConsumer): Promise<number> {
    const batch = this.opts.batchSize ?? 200;
    return this.db.tx(async (tx) => {
      await tx.query(`INSERT INTO event_consumers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [consumer.name]);
      const cur = await tx.query<{ last_tx_id: string; last_event_id: string }>(
        `SELECT last_tx_id::text, last_event_id::text FROM event_consumers WHERE name = $1 FOR UPDATE SKIP LOCKED`,
        [consumer.name]
      );
      if (cur.rowCount === 0) return 0; // another replica is advancing this consumer

      const { last_tx_id, last_event_id } = cur.rows[0];
      const { rows } = await tx.query(
        `SELECT id::text, tx_id::text AS "txId", tenant_id AS "tenantId", type, aggregate_type AS "aggregateType",
                aggregate_id AS "aggregateId", actor_user_id AS "actorUserId", correlation_id AS "correlationId",
                payload, occurred_at AS "occurredAt"
           FROM domain_events
          WHERE (tx_id, id) > ($1::xid8, $2::bigint)
            AND tx_id < pg_snapshot_xmin(pg_current_snapshot())   -- only fully-finished transactions: no skipped late commits
          ORDER BY tx_id, id
          LIMIT $3`,
        [last_tx_id, last_event_id, batch]
      );
      if (rows.length === 0) return 0;

      await consumer.handle(rows as DomainEventRow[], tx);

      const last = rows[rows.length - 1];
      await tx.query(
        `UPDATE event_consumers SET last_tx_id = $2::xid8, last_event_id = $3::bigint, updated_at = now() WHERE name = $1`,
        [consumer.name, last.txId, last.id]
      );
      return rows.length;
    });
  }
}
