-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 020
-- app.platform_health() must expose PLATFORM components only. system_health also holds tenant-scoped rows (migration 007), which
-- a different workspace must never learn about.
-- ==============================================================================
CREATE OR REPLACE FUNCTION app.platform_health() RETURNS TABLE (component text, status text, last_checked_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT h.component, h.status, h.last_checked_at FROM system_health h WHERE h.tenant_id IS NULL
$$;
