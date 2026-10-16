-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 019
-- Domain: Monitoring — persistent event log, audit explorer indexes, platform health lookup
--
--   * operational_logs becomes the workspace-visible "activity log": notable events (server errors, security denials, slow requests,
--     failed background jobs, rejected lead deliveries). Everything is still written to stdout as JSON for the log pipeline; this table
--     holds what a workspace admin needs to see in the Monitor panel. Rows are tenant-scoped by RLS, redacted before insert, kept 30 days.
--   * audit_logs gets the indexes the explorer filters on (the table itself is append-only for the application).
--   * Tenants must not read the global system_health table, but the Monitor shows "is the worker alive?": one narrow DEFINER function
--     returns component, status and last heartbeat only.
-- ==============================================================================

ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE operational_logs DROP CONSTRAINT IF EXISTS ck_oplog_context_size;
ALTER TABLE operational_logs ADD CONSTRAINT ck_oplog_context_size CHECK (pg_column_size(context) < 16384);
CREATE INDEX IF NOT EXISTS idx_oplogs_tenant_time ON operational_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_oplogs_tenant_attention ON operational_logs (tenant_id, created_at DESC) WHERE severity IN ('warn', 'error', 'fatal');

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time   ON audit_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action ON audit_logs (tenant_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor  ON audit_logs (tenant_id, actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.platform_health() RETURNS TABLE (component text, status text, last_checked_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT h.component, h.status, h.last_checked_at FROM system_health h
$$;
REVOKE ALL ON FUNCTION app.platform_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_health() TO crm_app_user;
