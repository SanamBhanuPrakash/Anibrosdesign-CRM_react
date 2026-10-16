-- Migration 022: Atomic Viewing Scheduling RPC (Hardened Phase 5)
--
-- Purpose:
-- Solves Priority 5 reliability requirement:
-- Creating a viewing, writing the activity, transitioning the lead stage,
-- and writing audit telemetry must be completely atomic.
-- If any step fails or times out, the entire transaction rolls back cleanly,
-- leaving ZERO partially-committed state.
--
-- Concurrency & Overlap Controls:
-- - Uses pg_advisory_xact_lock per (assigned_to, scheduled_date) to serialize concurrent bookings.
-- - Validates time-window interval overlaps (startA < endB AND endA > startB), not just identical start times.
-- - Validates that the assigned agent and property belong to the active tenant.
-- - Enforces duration constraints (15 to 480 minutes).
-- - Calls canonical transition_lead_stage when available.

CREATE OR REPLACE FUNCTION public.schedule_viewing(
  p_lead_id uuid,
  p_property_id uuid DEFAULT NULL,
  p_assigned_to uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT NULL,
  p_scheduled_time time DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_duration_minutes int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_lead record;
  v_is_member boolean;
  v_assigned_user uuid;
  v_viewing_id uuid;
  v_conflict_exists boolean;
  v_advanced_stage boolean := false;
  v_duration int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_lead_id IS NULL OR p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'Missing required fields: lead_id, scheduled_date, scheduled_time';
  END IF;

  v_duration := COALESCE(p_duration_minutes, 60);
  IF v_duration < 15 OR v_duration > 480 THEN
    RAISE EXCEPTION 'Viewing duration must be between 15 and 480 minutes';
  END IF;

  -- 1. Fetch lead
  SELECT id, tenant_id, contact_id, stage, assigned_to
  INTO v_lead
  FROM public.leads
  WHERE id = p_lead_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  -- 2. Verify caller is an active member of the lead's tenant
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_memberships
    WHERE tenant_id = v_lead.tenant_id
      AND user_id = v_user_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  -- 3. Determine and validate assigned agent
  v_assigned_user := COALESCE(p_assigned_to, v_lead.assigned_to, v_user_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
    WHERE tenant_id = v_lead.tenant_id
      AND user_id = v_assigned_user
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Assigned agent is not an active member of this tenant';
  END IF;

  -- 4. Validate property belongs to tenant if provided
  IF p_property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = p_property_id
      AND tenant_id = v_lead.tenant_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Property not found in active tenant';
  END IF;

  -- 5. Serialize concurrent booking attempts for this agent & date using transaction advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(v_assigned_user::text || p_scheduled_date::text));

  -- 6. Check for actual time-interval overlap for the assigned agent
  SELECT EXISTS (
    SELECT 1 FROM public.viewings v
    WHERE v.tenant_id = v_lead.tenant_id
      AND v.assigned_to = v_assigned_user
      AND v.scheduled_date = p_scheduled_date
      AND v.status IN ('scheduled', 'confirmed')
      AND (
        -- Overlap: (StartA < EndB) AND (EndA > StartB)
        v.scheduled_time < (p_scheduled_time + (v_duration || ' minutes')::interval)
        AND
        (v.scheduled_time + (COALESCE(v.duration_minutes, 60) || ' minutes')::interval) > p_scheduled_time
      )
  ) INTO v_conflict_exists;

  IF v_conflict_exists THEN
    RAISE EXCEPTION 'The assigned agent already has a viewing scheduled during this time window';
  END IF;

  -- 7. Insert viewing record
  BEGIN
    INSERT INTO public.viewings (
      tenant_id,
      lead_id,
      property_id,
      assigned_to,
      scheduled_date,
      scheduled_time,
      duration_minutes,
      status,
      notes
    ) VALUES (
      v_lead.tenant_id,
      p_lead_id,
      p_property_id,
      v_assigned_user,
      p_scheduled_date,
      p_scheduled_time,
      v_duration,
      'scheduled',
      p_notes
    ) RETURNING id INTO v_viewing_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'The assigned agent already has a viewing scheduled at this date and time';
  END;

  -- 8. Insert activity record atomically
  INSERT INTO public.activities (
    tenant_id,
    lead_id,
    contact_id,
    type,
    direction,
    subject,
    content,
    is_internal
  ) VALUES (
    v_lead.tenant_id,
    p_lead_id,
    v_lead.contact_id,
    'meeting',
    'internal',
    'Viewing scheduled for ' || to_char(p_scheduled_date, 'YYYY-MM-DD') || ' at ' || to_char(p_scheduled_time, 'HH24:MI'),
    p_notes,
    true
  );

  -- 9. Advance stage to viewing_scheduled if in an earlier active stage
  IF v_lead.stage IN ('new', 'contact_attempted', 'contacted', 'qualified') THEN
    BEGIN
      -- Attempt canonical stage transition RPC if available
      PERFORM public.transition_lead_stage(p_lead_id, 'viewing_scheduled', 'Automated stage advance on viewing scheduled');
      v_advanced_stage := true;
    EXCEPTION
      WHEN undefined_function THEN
        UPDATE public.leads
        SET stage = 'viewing_scheduled',
            updated_at = now()
        WHERE id = p_lead_id;

        -- Record audit log for stage change
        INSERT INTO public.audit_logs (
          tenant_id,
          user_id,
          action,
          entity_type,
          entity_id,
          old_value,
          new_value
        ) VALUES (
          v_lead.tenant_id,
          v_user_id,
          'lead_stage_transition',
          'leads',
          p_lead_id,
          jsonb_build_object('stage', v_lead.stage),
          jsonb_build_object('stage', 'viewing_scheduled', 'reason', 'Automated stage advance on viewing scheduled')
        );

        v_advanced_stage := true;
    END;
  END IF;

  -- 10. Write audit log for viewing creation
  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_value
  ) VALUES (
    v_lead.tenant_id,
    v_user_id,
    'viewing_scheduled',
    'viewings',
    v_viewing_id,
    jsonb_build_object(
      'lead_id', p_lead_id,
      'property_id', p_property_id,
      'assigned_to', v_assigned_user,
      'scheduled_date', p_scheduled_date,
      'scheduled_time', p_scheduled_time,
      'duration_minutes', v_duration,
      'stage_advanced', v_advanced_stage
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'viewing_id', v_viewing_id,
    'stage_advanced', v_advanced_stage,
    'new_stage', CASE WHEN v_advanced_stage THEN 'viewing_scheduled' ELSE v_lead.stage END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_viewing(uuid, uuid, uuid, date, time, text, int) TO authenticated;
