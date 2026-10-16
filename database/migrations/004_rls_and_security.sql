-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 004
-- Domain: Native Row-Level Security, Application Roles, and Trusted Functions
-- Independent of Supabase Auth / Roles / RPC Assumptions
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Helper Schema & Session Context Functions
-- ------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

-- Retrieve authenticated user ID set by trusted backend inside transaction
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Retrieve active tenant ID set by trusted backend inside transaction
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 2. Application Runtime Role Setup (Least Privilege Principle)
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE ROLE crm_app_user WITH LOGIN PASSWORD 'dev-app-password';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Grant schema usage (but REVOKE CREATE to prevent DDL by application role)
GRANT USAGE ON SCHEMA public, app TO crm_app_user;
REVOKE CREATE ON SCHEMA public FROM crm_app_user;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA app FROM crm_app_user;
REVOKE CREATE ON SCHEMA app FROM PUBLIC;

-- Grant operational DML privileges on public tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app_user;

-- Revoke mutation privileges on append-only audit logs (Security Requirement)
REVOKE UPDATE, DELETE ON audit_logs FROM crm_app_user;

-- Grant execution on app schema functions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO crm_app_user;

-- Ensure future tables inherit the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO crm_app_user;

-- ------------------------------------------------------------------------------
-- 3. Row-Level Security (RLS) Configuration (Defense-in-Depth)
-- ------------------------------------------------------------------------------
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE viewings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Contacts RLS
DROP POLICY IF EXISTS tenant_isolation_contacts ON contacts;
CREATE POLICY tenant_isolation_contacts ON contacts
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Pipelines & Stages RLS
DROP POLICY IF EXISTS tenant_isolation_pipelines ON pipelines;
CREATE POLICY tenant_isolation_pipelines ON pipelines
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_pipeline_stages ON pipeline_stages;
CREATE POLICY tenant_isolation_pipeline_stages ON pipeline_stages
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Leads & History RLS
DROP POLICY IF EXISTS tenant_isolation_leads ON leads;
CREATE POLICY tenant_isolation_leads ON leads
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_lead_stage_history ON lead_stage_history;
CREATE POLICY tenant_isolation_lead_stage_history ON lead_stage_history
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Properties & Projects RLS
DROP POLICY IF EXISTS tenant_isolation_projects ON projects;
CREATE POLICY tenant_isolation_projects ON projects
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_properties ON properties;
CREATE POLICY tenant_isolation_properties ON properties
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Viewings RLS
DROP POLICY IF EXISTS tenant_isolation_viewings ON viewings;
CREATE POLICY tenant_isolation_viewings ON viewings
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Activities & Tasks RLS
DROP POLICY IF EXISTS tenant_isolation_activities ON activities;
CREATE POLICY tenant_isolation_activities ON activities
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_tasks ON tasks;
CREATE POLICY tenant_isolation_tasks ON tasks
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Audit Logs RLS
DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Outbox Events RLS
DROP POLICY IF EXISTS tenant_isolation_outbox_events ON outbox_events;
CREATE POLICY tenant_isolation_outbox_events ON outbox_events
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Marketing Attribution RLS
DROP POLICY IF EXISTS tenant_isolation_marketing_attribution ON marketing_attribution;
CREATE POLICY tenant_isolation_marketing_attribution ON marketing_attribution
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Notifications RLS
DROP POLICY IF EXISTS tenant_isolation_notifications ON notifications;
CREATE POLICY tenant_isolation_notifications ON notifications
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- ------------------------------------------------------------------------------
-- 4. Transactional CRM Business Functions
-- ------------------------------------------------------------------------------

-- Transactional Lead Stage Transition
CREATE OR REPLACE FUNCTION app.transition_lead_stage(
    p_lead_id UUID,
    p_to_stage_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_from_stage_id UUID;
    v_pipeline_id UUID;
    v_lead_record RECORD;
BEGIN
    v_tenant_id := app.current_tenant_id();
    v_user_id := app.current_user_id();

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Tenant context missing';
    END IF;

    -- Verify lead exists in current tenant and lock for update
    SELECT * INTO v_lead_record FROM leads
    WHERE id = p_lead_id AND tenant_id = v_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Lead not found in active tenant';
    END IF;

    v_from_stage_id := v_lead_record.stage_id;
    v_pipeline_id := v_lead_record.pipeline_id;

    -- Verify target stage exists in current tenant and belongs to same pipeline
    IF NOT EXISTS (
        SELECT 1 FROM pipeline_stages 
        WHERE id = p_to_stage_id AND pipeline_id = v_pipeline_id AND tenant_id = v_tenant_id
    ) THEN
        RAISE EXCEPTION 'INVALID_STAGE: Target stage does not belong to lead pipeline';
    END IF;

    -- Update lead stage
    UPDATE leads
    SET stage_id = p_to_stage_id,
        updated_at = now()
    WHERE id = p_lead_id AND tenant_id = v_tenant_id;

    -- Record stage history
    INSERT INTO lead_stage_history (
        lead_id, tenant_id, from_stage_id, to_stage_id, changed_by, reason
    ) VALUES (
        p_lead_id, v_tenant_id, v_from_stage_id, p_to_stage_id, v_user_id, p_reason
    );

    -- Record activity
    INSERT INTO activities (
        lead_id, tenant_id, user_id, type, description, metadata
    ) VALUES (
        p_lead_id, v_tenant_id, v_user_id, 'stage_change', 
        COALESCE(p_reason, 'Stage transitioned'),
        jsonb_build_object('from_stage_id', v_from_stage_id, 'to_stage_id', p_to_stage_id)
    );

    -- Record audit log
    INSERT INTO audit_logs (
        tenant_id, actor_id, action, entity_type, entity_id, before_state, after_state
    ) VALUES (
        v_tenant_id, v_user_id, 'transition_stage', 'lead', p_lead_id,
        jsonb_build_object('stage_id', v_from_stage_id),
        jsonb_build_object('stage_id', p_to_stage_id)
    );

    RETURN jsonb_build_object(
        'success', true,
        'lead_id', p_lead_id,
        'from_stage_id', v_from_stage_id,
        'to_stage_id', p_to_stage_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomic Viewing Booking (with Concurrency Protection)
CREATE OR REPLACE FUNCTION app.schedule_viewing(
    p_lead_id UUID,
    p_property_id UUID,
    p_scheduled_at TIMESTAMPTZ,
    p_duration_minutes INT DEFAULT 30,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_viewing_id UUID;
BEGIN
    v_tenant_id := app.current_tenant_id();
    v_user_id := app.current_user_id();

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Tenant context missing';
    END IF;

    -- Verify lead belongs to active tenant
    IF NOT EXISTS (SELECT 1 FROM leads WHERE id = p_lead_id AND tenant_id = v_tenant_id) THEN
        RAISE EXCEPTION 'NOT_FOUND: Lead not found in active tenant';
    END IF;

    -- Verify property belongs to active tenant and lock row
    IF NOT EXISTS (SELECT 1 FROM properties WHERE id = p_property_id AND tenant_id = v_tenant_id FOR UPDATE) THEN
        RAISE EXCEPTION 'NOT_FOUND: Property not found in active tenant';
    END IF;

    -- Check for slot collisions
    IF EXISTS (
        SELECT 1 FROM viewings 
        WHERE property_id = p_property_id 
          AND scheduled_at = p_scheduled_at 
          AND status IN ('scheduled', 'confirmed')
    ) THEN
        RAISE EXCEPTION 'SLOT_OCCUPIED: Property already has a viewing booked for this time';
    END IF;

    -- Insert viewing
    INSERT INTO viewings (
        tenant_id, lead_id, property_id, agent_id, scheduled_at, duration_minutes, status, notes
    ) VALUES (
        v_tenant_id, p_lead_id, p_property_id, v_user_id, p_scheduled_at, p_duration_minutes, 'scheduled', p_notes
    ) RETURNING id INTO v_viewing_id;

    -- Record activity
    INSERT INTO activities (
        lead_id, tenant_id, user_id, type, description, metadata
    ) VALUES (
        p_lead_id, v_tenant_id, v_user_id, 'viewing',
        'Viewing scheduled',
        jsonb_build_object('viewing_id', v_viewing_id, 'property_id', p_property_id, 'scheduled_at', p_scheduled_at)
    );

    -- Update lead status
    UPDATE leads
    SET status = 'viewing_scheduled', updated_at = now()
    WHERE id = p_lead_id AND tenant_id = v_tenant_id;

    RETURN jsonb_build_object(
        'success', true,
        'viewing_id', v_viewing_id,
        'scheduled_at', p_scheduled_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardened Stuck Job Recovery (Strictly Tenant-Scoped and Role-Protected)
CREATE OR REPLACE FUNCTION app.reset_stuck_webhook_jobs(
    p_tenant_id UUID,
    p_timeout_minutes INT DEFAULT 10
)
RETURNS INT AS $$
DECLARE
    v_caller_user_id UUID;
    v_caller_role tenant_role;
    v_reset_count INT;
BEGIN
    v_caller_user_id := app.current_user_id();

    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_tenant_id is required';
    END IF;

    -- Verify caller has admin/owner role in target tenant
    SELECT role INTO v_caller_role FROM tenant_memberships
    WHERE tenant_id = p_tenant_id AND user_id = v_caller_user_id AND is_active = true;

    IF v_caller_role NOT IN ('tenant_owner', 'tenant_admin') THEN
        RAISE EXCEPTION 'FORBIDDEN: Administrative role required to reset stuck jobs';
    END IF;

    UPDATE webhook_inbox
    SET status = 'pending',
        attempts = attempts + 1,
        last_error = 'Auto-reset: processing timeout exceeded',
        updated_at = now()
    WHERE tenant_id = p_tenant_id
      AND status = 'processing'
      AND updated_at < now() - (p_timeout_minutes || ' minutes')::interval;

    GET DIAGNOSTICS v_reset_count = ROW_COUNT;

    INSERT INTO audit_logs (
        tenant_id, actor_id, action, entity_type, entity_id, after_state
    ) VALUES (
        p_tenant_id, v_caller_user_id, 'reset_stuck_webhook_jobs', 'webhook_inbox', gen_random_uuid(),
        jsonb_build_object('reset_count', v_reset_count, 'timeout_minutes', p_timeout_minutes)
    );

    RETURN v_reset_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
