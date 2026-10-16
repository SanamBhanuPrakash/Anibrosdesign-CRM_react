-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 005
-- Domain: Pipeline Stage Transitions & Robust Viewing Scheduling Invariants
-- Enforces: Allowed-transition validation & Real-Estate Interval Non-Overlap
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Add stage_key to Pipeline Stages and Leads if not present
-- ------------------------------------------------------------------------------
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stage_key TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_key TEXT;

-- ------------------------------------------------------------------------------
-- 2. Pipeline Stage Transitions Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_stage_transitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL,
    from_stage_id UUID,
    to_stage_id UUID,
    from_stage_key TEXT NOT NULL,
    to_stage_key TEXT NOT NULL,
    is_allowed BOOLEAN NOT NULL DEFAULT true,
    required_fields TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_stage_transition UNIQUE (pipeline_id, from_stage_key, to_stage_key),
    CONSTRAINT fk_transition_pipeline_tenant FOREIGN KEY (pipeline_id, tenant_id)
        REFERENCES pipelines(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transitions_pipeline ON pipeline_stage_transitions(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_transitions_tenant ON pipeline_stage_transitions(tenant_id);

-- Enable RLS on pipeline_stage_transitions
ALTER TABLE pipeline_stage_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_transitions ON pipeline_stage_transitions;
CREATE POLICY tenant_isolation_transitions ON pipeline_stage_transitions
    FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stage_transitions TO crm_app_user;

-- ------------------------------------------------------------------------------
-- 3. Procedure to Seed Default Pipeline with Stages & Allowed Transitions
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seed_default_pipeline(p_tenant_id UUID)
RETURNS UUID AS $$
DECLARE
    v_pipeline_id UUID;
    v_s_new UUID;
    v_s_contact_attempted UUID;
    v_s_contacted UUID;
    v_s_qualified UUID;
    v_s_viewing_scheduled UUID;
    v_s_viewing_completed UUID;
    v_s_negotiation UUID;
    v_s_booking_reserved UUID;
    v_s_won UUID;
    v_s_lost UUID;
    v_s_invalid UUID;
    v_s_unqualified UUID;
    v_s_nurture UUID;
BEGIN
    -- Check if default pipeline already exists
    SELECT id INTO v_pipeline_id FROM pipelines 
    WHERE tenant_id = p_tenant_id AND is_default = true 
    LIMIT 1;

    IF v_pipeline_id IS NOT NULL THEN
        RETURN v_pipeline_id;
    END IF;

    -- Create default pipeline
    INSERT INTO pipelines (tenant_id, name, is_default)
    VALUES (p_tenant_id, 'Default Real Estate Pipeline', true)
    RETURNING id INTO v_pipeline_id;

    -- Insert standard real estate stages
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'New', 'new', 0, '#3b82f6') RETURNING id INTO v_s_new;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Contact Attempted', 'contact_attempted', 1, '#f59e0b') RETURNING id INTO v_s_contact_attempted;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Contacted', 'contacted', 2, '#0ea5e9') RETURNING id INTO v_s_contacted;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Qualified', 'qualified', 3, '#10b981') RETURNING id INTO v_s_qualified;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Viewing Scheduled', 'viewing_scheduled', 4, '#8b5cf6') RETURNING id INTO v_s_viewing_scheduled;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Viewing Completed', 'viewing_completed', 5, '#6366f1') RETURNING id INTO v_s_viewing_completed;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Negotiation', 'negotiation', 6, '#ec4899') RETURNING id INTO v_s_negotiation;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Booking Reserved', 'booking_reserved', 7, '#f97316') RETURNING id INTO v_s_booking_reserved;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Won', 'won', 8, '#22c55e') RETURNING id INTO v_s_won;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Lost', 'lost', 9, '#ef4444') RETURNING id INTO v_s_lost;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Invalid', 'invalid', 10, '#6b7280') RETURNING id INTO v_s_invalid;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Unqualified', 'unqualified', 11, '#94a3b8') RETURNING id INTO v_s_unqualified;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color)
    VALUES (p_tenant_id, v_pipeline_id, 'Nurture', 'nurture', 12, '#a855f7') RETURNING id INTO v_s_nurture;

    -- Seed allowed transitions
    INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed) VALUES
        (p_tenant_id, v_pipeline_id, v_s_new, v_s_contact_attempted, 'new', 'contact_attempted', true),
        (p_tenant_id, v_pipeline_id, v_s_new, v_s_invalid, 'new', 'invalid', true),
        (p_tenant_id, v_pipeline_id, v_s_new, v_s_unqualified, 'new', 'unqualified', true),

        (p_tenant_id, v_pipeline_id, v_s_contact_attempted, v_s_contacted, 'contact_attempted', 'contacted', true),
        (p_tenant_id, v_pipeline_id, v_s_contact_attempted, v_s_invalid, 'contact_attempted', 'invalid', true),
        (p_tenant_id, v_pipeline_id, v_s_contact_attempted, v_s_unqualified, 'contact_attempted', 'unqualified', true),
        (p_tenant_id, v_pipeline_id, v_s_contact_attempted, v_s_nurture, 'contact_attempted', 'nurture', true),

        (p_tenant_id, v_pipeline_id, v_s_contacted, v_s_qualified, 'contacted', 'qualified', true),
        (p_tenant_id, v_pipeline_id, v_s_contacted, v_s_unqualified, 'contacted', 'unqualified', true),
        (p_tenant_id, v_pipeline_id, v_s_contacted, v_s_nurture, 'contacted', 'nurture', true),
        (p_tenant_id, v_pipeline_id, v_s_contacted, v_s_new, 'contacted', 'new', true),

        (p_tenant_id, v_pipeline_id, v_s_qualified, v_s_viewing_scheduled, 'qualified', 'viewing_scheduled', true),
        (p_tenant_id, v_pipeline_id, v_s_qualified, v_s_negotiation, 'qualified', 'negotiation', true),
        (p_tenant_id, v_pipeline_id, v_s_qualified, v_s_lost, 'qualified', 'lost', true),
        (p_tenant_id, v_pipeline_id, v_s_qualified, v_s_nurture, 'qualified', 'nurture', true),

        (p_tenant_id, v_pipeline_id, v_s_viewing_scheduled, v_s_viewing_completed, 'viewing_scheduled', 'viewing_completed', true),
        (p_tenant_id, v_pipeline_id, v_s_viewing_scheduled, v_s_qualified, 'viewing_scheduled', 'qualified', true),
        (p_tenant_id, v_pipeline_id, v_s_viewing_scheduled, v_s_lost, 'viewing_scheduled', 'lost', true),

        (p_tenant_id, v_pipeline_id, v_s_viewing_completed, v_s_negotiation, 'viewing_completed', 'negotiation', true),
        (p_tenant_id, v_pipeline_id, v_s_viewing_completed, v_s_unqualified, 'viewing_completed', 'unqualified', true),
        (p_tenant_id, v_pipeline_id, v_s_viewing_completed, v_s_nurture, 'viewing_completed', 'nurture', true),
        (p_tenant_id, v_pipeline_id, v_s_viewing_completed, v_s_lost, 'viewing_completed', 'lost', true),

        (p_tenant_id, v_pipeline_id, v_s_negotiation, v_s_booking_reserved, 'negotiation', 'booking_reserved', true),
        (p_tenant_id, v_pipeline_id, v_s_negotiation, v_s_lost, 'negotiation', 'lost', true),
        (p_tenant_id, v_pipeline_id, v_s_negotiation, v_s_viewing_scheduled, 'negotiation', 'viewing_scheduled', true),

        (p_tenant_id, v_pipeline_id, v_s_booking_reserved, v_s_won, 'booking_reserved', 'won', true),
        (p_tenant_id, v_pipeline_id, v_s_booking_reserved, v_s_lost, 'booking_reserved', 'lost', true);

    RETURN v_pipeline_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 4. Hardened Lead Stage Transition Function (Enforcing Allowed Transitions)
-- ------------------------------------------------------------------------------
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
    v_from_stage_key TEXT;
    v_to_stage_key TEXT;
    v_pipeline_id UUID;
    v_is_allowed BOOLEAN;
BEGIN
    v_tenant_id := app.current_tenant_id();
    v_user_id := app.current_user_id();

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Tenant context missing';
    END IF;

    -- Verify lead exists in current tenant and lock for update
    SELECT l.stage_id, l.pipeline_id, s.stage_key 
    INTO v_from_stage_id, v_pipeline_id, v_from_stage_key
    FROM leads l
    LEFT JOIN pipeline_stages s ON s.id = l.stage_id
    WHERE l.id = p_lead_id AND l.tenant_id = v_tenant_id
    FOR UPDATE OF l;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Lead not found in active tenant';
    END IF;

    -- Verify target stage exists in current tenant and belongs to same pipeline
    SELECT stage_key INTO v_to_stage_key
    FROM pipeline_stages 
    WHERE id = p_to_stage_id AND pipeline_id = v_pipeline_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_STAGE: Target stage does not belong to lead pipeline';
    END IF;

    -- If transition matrix exists for this pipeline, enforce allowed transition check
    IF EXISTS (SELECT 1 FROM pipeline_stage_transitions WHERE pipeline_id = v_pipeline_id) THEN
        SELECT is_allowed INTO v_is_allowed
        FROM pipeline_stage_transitions
        WHERE pipeline_id = v_pipeline_id
          AND (
              (from_stage_id = v_from_stage_id AND to_stage_id = p_to_stage_id) OR
              (from_stage_key = v_from_stage_key AND to_stage_key = v_to_stage_key)
          );

        IF v_is_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'ILLEGAL_TRANSITION: Stage transition from % to % is not allowed', 
                COALESCE(v_from_stage_key, v_from_stage_id::text), 
                COALESCE(v_to_stage_key, p_to_stage_id::text);
        END IF;
    END IF;

    -- Update lead stage
    UPDATE leads
    SET stage_id = p_to_stage_id,
        stage_key = v_to_stage_key,
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
        jsonb_build_object(
            'from_stage_id', v_from_stage_id, 
            'to_stage_id', p_to_stage_id,
            'from_stage_key', v_from_stage_key,
            'to_stage_key', v_to_stage_key
        )
    );

    -- Record audit log
    INSERT INTO audit_logs (
        tenant_id, actor_id, action, entity_type, entity_id, before_state, after_state
    ) VALUES (
        v_tenant_id, v_user_id, 'transition_stage', 'lead', p_lead_id,
        jsonb_build_object('stage_id', v_from_stage_id, 'stage_key', v_from_stage_key),
        jsonb_build_object('stage_id', p_to_stage_id, 'stage_key', v_to_stage_key)
    );

    RETURN jsonb_build_object(
        'success', true,
        'lead_id', p_lead_id,
        'from_stage_id', v_from_stage_id,
        'to_stage_id', p_to_stage_id,
        'from_stage_key', v_from_stage_key,
        'to_stage_key', v_to_stage_key
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 5. Hardened Viewing Scheduling (Enforcing Real-Estate Interval Non-Overlap)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.schedule_viewing(UUID, UUID, TIMESTAMPTZ, INT, TEXT);

CREATE OR REPLACE FUNCTION app.schedule_viewing(
    p_lead_id UUID,
    p_property_id UUID,
    p_scheduled_at TIMESTAMPTZ,
    p_duration_minutes INT DEFAULT 30,
    p_notes TEXT DEFAULT NULL,
    p_agent_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_agent_id UUID;
    v_viewing_id UUID;
    v_prop_status property_status_enum;
    v_duration INT;
    v_end_time TIMESTAMPTZ;
BEGIN
    v_tenant_id := app.current_tenant_id();
    v_user_id := app.current_user_id();
    v_duration := COALESCE(p_duration_minutes, 30);
    v_end_time := p_scheduled_at + (v_duration || ' minutes')::interval;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Tenant context missing';
    END IF;

    v_agent_id := COALESCE(p_agent_id, v_user_id);

    -- 1. Verify lead belongs to active tenant
    IF NOT EXISTS (SELECT 1 FROM leads WHERE id = p_lead_id AND tenant_id = v_tenant_id) THEN
        RAISE EXCEPTION 'NOT_FOUND: Lead not found in active tenant';
    END IF;

    -- 2. Lock property row and verify status is 'available'
    SELECT status INTO v_prop_status 
    FROM properties 
    WHERE id = p_property_id AND tenant_id = v_tenant_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND: Property not found in active tenant';
    END IF;

    IF v_prop_status != 'available' THEN
        RAISE EXCEPTION 'PROPERTY_UNAVAILABLE: Property is currently % and cannot be booked', v_prop_status;
    END IF;

    -- 3. Check for Interval Overlap on Property (Mathematical Interval Overlap)
    IF EXISTS (
        SELECT 1 FROM viewings
        WHERE property_id = p_property_id
          AND status IN ('scheduled', 'confirmed')
          AND (
              (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval)
              OVERLAPS
              (p_scheduled_at, v_end_time)
          )
    ) THEN
        RAISE EXCEPTION 'SLOT_OCCUPIED: Property already has an overlapping appointment in this time window';
    END IF;

    -- 4. Check for Interval Overlap on Agent (Agent cannot be in two places at once)
    IF v_agent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM viewings
        WHERE agent_id = v_agent_id
          AND status IN ('scheduled', 'confirmed')
          AND (
              (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval)
              OVERLAPS
              (p_scheduled_at, v_end_time)
          )
    ) THEN
        RAISE EXCEPTION 'AGENT_UNAVAILABLE: Assigned agent already has an overlapping viewing scheduled';
    END IF;

    -- 5. Insert viewing record
    INSERT INTO viewings (
        tenant_id, lead_id, property_id, agent_id, scheduled_at, duration_minutes, status, notes
    ) VALUES (
        v_tenant_id, p_lead_id, p_property_id, v_agent_id, p_scheduled_at, v_duration, 'scheduled', p_notes
    ) RETURNING id INTO v_viewing_id;

    -- 6. Record activity timeline entry
    INSERT INTO activities (
        lead_id, tenant_id, user_id, type, description, metadata
    ) VALUES (
        p_lead_id, v_tenant_id, v_user_id, 'viewing',
        'Viewing appointment scheduled',
        jsonb_build_object(
            'viewing_id', v_viewing_id, 
            'property_id', p_property_id, 
            'scheduled_at', p_scheduled_at,
            'duration_minutes', v_duration
        )
    );

    -- 7. Update lead status to 'viewing_scheduled'
    UPDATE leads
    SET status = 'viewing_scheduled', updated_at = now()
    WHERE id = p_lead_id AND tenant_id = v_tenant_id;

    -- 8. Record audit log
    INSERT INTO audit_logs (
        tenant_id, actor_id, action, entity_type, entity_id, after_state
    ) VALUES (
        v_tenant_id, v_user_id, 'schedule_viewing', 'viewing', v_viewing_id,
        jsonb_build_object(
            'lead_id', p_lead_id,
            'property_id', p_property_id,
            'scheduled_at', p_scheduled_at,
            'duration_minutes', v_duration
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'viewing_id', v_viewing_id,
        'scheduled_at', p_scheduled_at,
        'duration_minutes', v_duration,
        'agent_id', v_agent_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
