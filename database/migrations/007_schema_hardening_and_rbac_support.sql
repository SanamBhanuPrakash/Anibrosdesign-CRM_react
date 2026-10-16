-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 007
-- Domain: Schema Hardening, Security Fixes, Missing Enum Values, Performance Indexes
-- Fixes identified in: ANIBROS_CRM_DEEP_DIVE_ANALYSIS.md Wave 0 + Wave 1
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Add Missing tenant_role Enum Values (B2 Blocker Fix)
--    tenant_role in migration 001 only has 5 values. The masterplan requires 8.
--    Inviting users with roles marketing_analyst, executive_readonly, or auditor
--    would throw a PostgreSQL type constraint violation.
-- ------------------------------------------------------------------------------
-- PostgreSQL >= 12 permits ADD VALUE inside a transaction block (the value just cannot be
-- *used* until commit). No blanket exception handler: a real failure must fail the migration.
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'marketing_analyst';
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'executive_readonly';
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'auditor';

-- ------------------------------------------------------------------------------
-- 2. Add tenant_id to system_health (H3 Fix)
--    system_health table lacks tenant scoping — all tenants could see
--    platform-level infrastructure info. Add tenant_id (nullable = platform-level).
-- ------------------------------------------------------------------------------
ALTER TABLE system_health ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Create index for tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_system_health_tenant ON system_health(tenant_id) WHERE tenant_id IS NOT NULL;

-- Make component non-UNIQUE globally — each tenant can have their own component record
-- (Drop the global unique constraint since component is now tenant-scoped)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'system_health_component_key'
          AND conrelid = 'system_health'::regclass
    ) THEN
        ALTER TABLE system_health DROP CONSTRAINT system_health_component_key;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_system_health_component_tenant
            ON system_health(component, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 3. Fix Viewing Conflict Check — Use OVERLAPS Instead of Exact-Match (B5 Fix)
--    The previous schedule_viewing() used scheduled_at = p_scheduled_at (exact
--    timestamp equality). This misses overlapping viewings. E.g., a 10:00 30-min
--    viewing and a 10:15 30-min viewing would NOT conflict. Replace with OVERLAPS.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.check_viewing_overlap(
    p_property_id UUID,
    p_scheduled_at TIMESTAMPTZ,
    p_duration_minutes INTEGER DEFAULT 30,
    p_exclude_viewing_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    v_overlap_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO v_overlap_count
    FROM viewings
    WHERE property_id = p_property_id
      AND status IN ('scheduled', 'confirmed')
      AND (p_exclude_viewing_id IS NULL OR id != p_exclude_viewing_id)
      -- OVERLAPS: (start1, end1) OVERLAPS (start2, end2)
      AND (p_scheduled_at, p_scheduled_at + (p_duration_minutes || ' minutes')::interval)
          OVERLAPS
          (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval);

    RETURN v_overlap_count > 0;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.check_viewing_overlap(UUID, TIMESTAMPTZ, INTEGER, UUID) TO crm_app_user;

-- ------------------------------------------------------------------------------
-- 4. Add Login Attempt Tracking Table (H4 — Account Lockout Support)
--    Tracks failed login attempts per email to enforce lockout after N failures.
--    The application layer reads this to enforce a 15-minute lockout.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL,
    ip_address TEXT,
    success BOOLEAN NOT NULL DEFAULT false,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time   ON login_attempts(ip_address, attempted_at DESC);

-- Auto-purge old login attempts older than 24 hours to prevent unbounded growth
-- (Application should also periodically call this or use pg_cron)
CREATE OR REPLACE FUNCTION app.purge_old_login_attempts()
RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM login_attempts WHERE attempted_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.purge_old_login_attempts() TO crm_app_user;

-- ------------------------------------------------------------------------------
-- 5. Add soft-delete support to leads and contacts (H8 Fix)
--    Permanent deletes risk accidental data loss. Add deleted_at column.
--    Application should filter WHERE deleted_at IS NULL on all reads.
-- ------------------------------------------------------------------------------
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes to keep queries fast (only indexes non-deleted rows)
CREATE INDEX IF NOT EXISTS idx_leads_active    ON leads(tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------------------
-- 6. Add Critical Missing Performance Indexes (M2 Fix)
--    Without these, queries at 10K+ records will be extremely slow (full table scans).
-- ------------------------------------------------------------------------------

-- Lead queries by agent assignment (agent lead list, dashboard "my leads")
CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned ON leads(tenant_id, owner_id) WHERE deleted_at IS NULL;

-- Lead source attribution reports
CREATE INDEX IF NOT EXISTS idx_leads_tenant_source ON leads(tenant_id, source);

-- Lead status + tenant (pipeline board, kanban view)
-- NOTE: distinct name; "idx_leads_tenant_status" already exists from 002 so IF NOT EXISTS would silently skip it.
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status_active ON leads(tenant_id, status) WHERE deleted_at IS NULL;

-- Contact deduplication by email (normalized search)
CREATE INDEX IF NOT EXISTS idx_contacts_email_active ON contacts(tenant_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Contact deduplication by phone
CREATE INDEX IF NOT EXISTS idx_contacts_phone_active ON contacts(tenant_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- Activity timeline queries (lead detail page — most accessed pattern)
CREATE INDEX IF NOT EXISTS idx_activities_tenant_lead ON activities(tenant_id, lead_id, created_at DESC);

-- Audit log browsing (admin view, compliance)
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_time ON audit_logs(tenant_id, created_at DESC);

-- Pipeline stage history: idx_lead_stage_history_lead (lead_id, created_at DESC) already exists from 002.
-- (The previous definition referenced a non-existent column "changed_at" and broke clean bootstrap.)

-- Viewings by agent (agent calendar view)
CREATE INDEX IF NOT EXISTS idx_viewings_agent_time ON viewings(agent_id, scheduled_at);

-- Viewings by tenant + status (upcoming viewings dashboard widget)
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_status ON viewings(tenant_id, status, scheduled_at);

-- Tasks overdue detection (background job + dashboard widget)
CREATE INDEX IF NOT EXISTS idx_tasks_due_status ON tasks(tenant_id, due_date, status) WHERE status != 'completed';

-- Webhook inbox by tenant + status (operations center)
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_tenant_status ON webhook_inbox(tenant_id, status, created_at DESC);

-- Outbox retry queue (worker batch query)
CREATE INDEX IF NOT EXISTS idx_outbox_pending_retry ON outbox_events(status, next_retry_at ASC) WHERE status IN ('pending', 'failed');

-- Sessions lookup by user (session management / security audit)
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- Notification delivery (user notification panel — most accessed read path)
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(tenant_id, user_id, created_at DESC);

-- ------------------------------------------------------------------------------
-- 7. Grant new table permissions to crm_app_user
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO crm_app_user;
    END IF;
END $$;

-- Also ensure new enum values flow through to the application role
-- (PostgreSQL enum additions are automatically visible — no grant needed)

-- ------------------------------------------------------------------------------
-- 8. Notification read receipts — add is_read convenience column to notifications
--    (Avoids join to notification_reads for simple unread count queries)
-- ------------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(tenant_id, user_id, is_read)
    WHERE is_read = false;

-- ==============================================================================
-- END OF MIGRATION 007
-- ==============================================================================
