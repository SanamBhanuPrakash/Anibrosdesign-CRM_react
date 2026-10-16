-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 021
-- Remediation slice 0 (docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md): data-integrity and viewing safety. Additive and forward-only.
--
--   1. custom_field_values can no longer point at another workspace's field definition (audit finding S-1).
--      If such rows already exist the migration STOPS and changes nothing; they are reviewed by a person
--      (`npm run db:report-integrity`), never deleted or rewritten automatically.
--   2. A lead's status is derived from its stage. The old viewing function overwrote it directly; the stage sync trigger only
--      reacted to stage changes, so nothing stopped drift. A guard now refuses any status that disagrees with the stage.
--   3. app.schedule_viewing is replaced (not edited in place; migration 005 stays as applied):
--        - runs as the CALLER (SECURITY INVOKER) so row-level security applies, with a pinned search_path
--        - lead and property must be live (not archived)
--        - property must be available or under offer (decision D6); reserved, sold, rented, inactive are refused
--        - an explicit agent must be an active member of THIS workspace
--        - it no longer rewrites the lead's status, and it emits a viewing.scheduled domain event
-- ==============================================================================

-- 1. custom_field_values: composite tenant FK ---------------------------------------------------------------------------
DO $guard$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n
      FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_id
     WHERE d.tenant_id <> v.tenant_id;
    IF n > 0 THEN
        RAISE EXCEPTION 'Migration 021 stopped: % custom_field_values row(s) point at a field definition of another workspace. Nothing was changed. Run "npm run db:report-integrity" to list them, review them, then resolve them deliberately before re-running (docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md, step 0.3).', n;
    END IF;
END
$guard$;

ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS uq_custom_field_def_tenant;
ALTER TABLE custom_field_definitions ADD CONSTRAINT uq_custom_field_def_tenant UNIQUE (id, tenant_id);
ALTER TABLE custom_field_values DROP CONSTRAINT IF EXISTS fk_custom_field_value_def_tenant;
ALTER TABLE custom_field_values ADD CONSTRAINT fk_custom_field_value_def_tenant
    FOREIGN KEY (field_id, tenant_id) REFERENCES custom_field_definitions (id, tenant_id) ON DELETE CASCADE;

-- 2. lead status is derived from the stage -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_lead_status_from_stage() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, app, pg_temp AS $$
DECLARE v_status lead_status;
BEGIN
    SELECT s.maps_to_status INTO v_status FROM pipeline_stages s WHERE s.id = NEW.stage_id AND s.tenant_id = NEW.tenant_id;
    IF v_status IS NOT NULL AND NEW.status IS DISTINCT FROM v_status THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: a lead''s status is set by its stage (%), it cannot be changed on its own', v_status;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_leads_status_guard ON leads;
CREATE TRIGGER trg_leads_status_guard BEFORE UPDATE OF status ON leads FOR EACH ROW EXECUTE FUNCTION app.guard_lead_status_from_stage();

-- 3. viewing booking -----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.schedule_viewing(
    p_lead_id UUID,
    p_property_id UUID,
    p_scheduled_at TIMESTAMPTZ,
    p_duration_minutes INT DEFAULT 30,
    p_notes TEXT DEFAULT NULL,
    p_agent_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, app, pg_temp AS $$
DECLARE
    v_tenant_id   UUID := app.current_tenant_id();
    v_user_id     UUID := app.current_user_id();
    v_agent_id    UUID;
    v_viewing_id  UUID;
    v_prop_status property_status_enum;
    v_duration    INT := COALESCE(p_duration_minutes, 30);
    v_end_time    TIMESTAMPTZ;
BEGIN
    IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED: Tenant context missing'; END IF;
    IF v_duration < 5 OR v_duration > 480 THEN RAISE EXCEPTION 'INVALID_ARGUMENT: duration must be between 5 and 480 minutes'; END IF;
    v_end_time := p_scheduled_at + (v_duration || ' minutes')::interval;

    -- 1. the lead must be live in THIS workspace
    IF NOT EXISTS (SELECT 1 FROM leads WHERE id = p_lead_id AND tenant_id = v_tenant_id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'NOT_FOUND: Lead not found in this workspace';
    END IF;

    -- 2. lock the property; it must be live and open to visits (available or under offer)
    SELECT status INTO v_prop_status FROM properties
     WHERE id = p_property_id AND tenant_id = v_tenant_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Property not found in this workspace'; END IF;
    IF v_prop_status NOT IN ('available', 'under_offer') THEN
        RAISE EXCEPTION 'PROPERTY_UNAVAILABLE: This property is %, so a viewing cannot be booked. Only available or under-offer properties can be viewed.', replace(v_prop_status::text, '_', ' ');
    END IF;

    -- 3. the agent (default: the caller) must be an active member of THIS workspace
    v_agent_id := COALESCE(p_agent_id, v_user_id);
    IF v_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = v_tenant_id AND m.user_id = v_agent_id AND m.status = 'active' AND m.is_active AND u.is_active
    ) THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: The chosen agent is not an active member of this workspace';
    END IF;

    -- 4. property overlap
    IF EXISTS (
        SELECT 1 FROM viewings
         WHERE tenant_id = v_tenant_id AND property_id = p_property_id AND status IN ('scheduled', 'confirmed')
           AND (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) OVERLAPS (p_scheduled_at, v_end_time)
    ) THEN
        RAISE EXCEPTION 'SLOT_OCCUPIED: Property already has an overlapping appointment in this time window';
    END IF;

    -- 5. agent overlap
    IF v_agent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM viewings
         WHERE tenant_id = v_tenant_id AND agent_id = v_agent_id AND status IN ('scheduled', 'confirmed')
           AND (scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) OVERLAPS (p_scheduled_at, v_end_time)
    ) THEN
        RAISE EXCEPTION 'AGENT_UNAVAILABLE: Assigned agent already has an overlapping viewing scheduled';
    END IF;

    INSERT INTO viewings (tenant_id, lead_id, property_id, agent_id, scheduled_at, duration_minutes, status, notes)
    VALUES (v_tenant_id, p_lead_id, p_property_id, v_agent_id, p_scheduled_at, v_duration, 'scheduled', p_notes)
    RETURNING id INTO v_viewing_id;

    INSERT INTO activities (lead_id, tenant_id, user_id, type, description, metadata)
    VALUES (p_lead_id, v_tenant_id, v_user_id, 'viewing', 'Viewing appointment scheduled',
            jsonb_build_object('viewing_id', v_viewing_id, 'property_id', p_property_id, 'scheduled_at', p_scheduled_at, 'duration_minutes', v_duration));

    INSERT INTO audit_logs (action, entity_type, entity_id, after_state)
    VALUES ('viewing.schedule', 'viewing', v_viewing_id,
            jsonb_build_object('lead_id', p_lead_id, 'property_id', p_property_id, 'agent_id', v_agent_id, 'scheduled_at', p_scheduled_at, 'duration_minutes', v_duration));

    INSERT INTO domain_events (type, aggregate_type, aggregate_id, payload)
    VALUES ('viewing.scheduled', 'viewing', v_viewing_id, jsonb_build_object('leadId', p_lead_id, 'propertyId', p_property_id, 'agentId', v_agent_id));

    RETURN jsonb_build_object('success', true, 'viewing_id', v_viewing_id, 'scheduled_at', p_scheduled_at, 'duration_minutes', v_duration, 'agent_id', v_agent_id);
END $$;
