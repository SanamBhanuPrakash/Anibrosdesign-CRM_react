import type pg from 'pg';
import { redactSensitiveData } from '../../logger';

/**
 * Audit trail writer. Runs INSIDE the business transaction so "action happened" and "action was recorded" are atomic;
 * if the audit insert fails the business change rolls back (mandatory-audit semantics).
 * Tenant, actor, IP and correlation id come from the transaction context (column defaults, migration 010),
 * so callers cannot forge them.
 */
export interface AuditInput {
  action: string; // verb_noun, e.g. 'lead.create', 'member.role_change'
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(tx: pg.PoolClient, input: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, before_state, after_state)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      input.action,
      input.entityType,
      input.entityId,
      input.before === undefined ? null : JSON.stringify(redactSensitiveData(input.before)),
      input.after === undefined ? null : JSON.stringify(redactSensitiveData(input.after)),
    ]
  );
}
