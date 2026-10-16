-- ==============================================================================
-- ANIBROS CRM — RECONCILED BACKEND MIGRATION BUNDLE (021 -> 024)
-- ==============================================================================
-- Target Project: Supabase ref vwujgupnmxwetzyuwzbx
-- Review Date: 12 October 2026
--
-- Contents:
-- 1. Migration 021: Leads Full-Text Search RPC (`search_leads`)
-- 2. Migration 022: Atomic Viewing Scheduling RPC (`schedule_viewing`)
-- 3. Migration 023: Client Telemetry Persistence RPC & Restricted RLS (`log_client_telemetry`)
-- 4. Migration 024: Realtime WAL Publication for CRM & Operations Tables
--
-- All statements are idempotent and wrapped with transaction boundaries.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. MIGRATION 021: LEADS SEARCH RPC
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.search_leads(
  p_tenant_id uuid,
  p_search text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_results jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify the caller is an active member of this tenant
  SELECT EXISTS(
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  -- Validate limit to prevent resource abuse
  IF p_limit > 500 THEN
    p_limit := 500;
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY l.created_at DESC), '[]'::jsonb)
  INTO v_results
  FROM (
    SELECT jsonb_build_object(
      'id', l.id,
      'tenant_id', l.tenant_id,
      'contact_id', l.contact_id,
      'pipeline_id', l.pipeline_id,
      'pipeline_stage_id', l.pipeline_stage_id,
      'stage', l.stage,
      'lead_source', l.lead_source,
      'title', l.title,
      'description', l.description,
      'budget_min', l.budget_min,
      'budget_max', l.budget_max,
      'desired_location', l.desired_location,
      'transaction_intent', l.transaction_intent,
      'assigned_to', l.assigned_to,
      'score', l.score,
      'qualification_status', l.qualification_status,
      'last_activity_at', l.last_activity_at,
      'created_at', l.created_at,
      'updated_at', l.updated_at,
      'deleted_at', l.deleted_at,
      'contact', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object(
        'id', c.id,
        'first_name', c.first_name,
        'last_name', c.last_name,
        'email', c.email,
        'phone', c.phone,
        'email_normalized', c.email_normalized,
        'phone_normalized', c.phone_normalized
      ) ELSE NULL END
    ) AS row_json
    FROM leads l
    LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = p_tenant_id
    WHERE l.tenant_id = p_tenant_id
      AND l.deleted_at IS NULL
      AND (p_stage IS NULL OR p_stage = '' OR l.stage = p_stage)
      AND (p_source IS NULL OR p_source = '' OR l.lead_source = p_source)
      AND (
        p_search IS NULL OR p_search = ''
        OR l.title ILIKE '%' || p_search || '%'
        OR c.first_name ILIKE '%' || p_search || '%'
        OR c.last_name ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email_normalized ILIKE '%' || p_search || '%'
      )
    ORDER BY l.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ) sub(row_json);

  RETURN jsonb_build_object(
    'leads', v_results,
    'offset', p_offset,
    'limit', p_limit
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_leads(uuid, text, text, text, int, int) TO authenticated;


-- ==============================================================================
-- 2. MIGRATION 022: ATOMIC VIEWING SCHEDULING RPC
-- ==============================================================================

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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_lead_id IS NULL OR p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'Missing required fields: lead_id, scheduled_date, scheduled_time';
  END IF;

  -- 1. Fetch lead
  SELECT id, tenant_id, contact_id, stage, assigned_to
  INTO v_lead
  FROM leads
  WHERE id = p_lead_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  -- 2. Verify caller is an active member of the lead's tenant
  SELECT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE tenant_id = v_lead.tenant_id
      AND user_id = v_user_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  -- 3. Determine assigned agent
  v_assigned_user := COALESCE(p_assigned_to, v_lead.assigned_to, v_user_id);

  -- 4. Check for slot conflict for the assigned agent (prevent double booking)
  SELECT EXISTS (
    SELECT 1 FROM viewings
    WHERE assigned_to = v_assigned_user
      AND scheduled_date = p_scheduled_date
      AND scheduled_time = p_scheduled_time
      AND status IN ('scheduled', 'confirmed')
  ) INTO v_conflict_exists;

  IF v_conflict_exists THEN
    RAISE EXCEPTION 'The assigned agent already has a viewing scheduled at this date and time';
  END IF;

  -- 5. Insert viewing record (protected against concurrent race conditions by partial unique index)
  BEGIN
    INSERT INTO viewings (
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
      COALESCE(p_duration_minutes, 60),
      'scheduled',
      p_notes
    ) RETURNING id INTO v_viewing_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'The assigned agent already has a viewing scheduled at this date and time';
  END;

  -- 6. Insert activity record atomically
  INSERT INTO activities (
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

  -- 7. Advance stage to viewing_scheduled if in an earlier active stage
  IF v_lead.stage IN ('new', 'contact_attempted', 'contacted', 'qualified') THEN
    UPDATE leads
    SET stage = 'viewing_scheduled',
        updated_at = now()
    WHERE id = p_lead_id;

    -- Record audit log for stage change
    INSERT INTO audit_logs (
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
  END IF;

  -- 8. Write audit log for viewing creation
  INSERT INTO audit_logs (
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


-- ==============================================================================
-- 3. MIGRATION 023: CLIENT TELEMETRY RPC & RESTRICTED RLS
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.log_client_telemetry(
  p_tenant_id uuid,
  p_severity text,
  p_event_name text,
  p_message text,
  p_correlation_id text DEFAULT NULL,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_duration_ms int DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_log_id uuid;
  v_clean_severity text;
  v_clean_event text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE tenant_id = p_tenant_id
      AND user_id = v_user_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  -- Enforce severity boundary (clients cannot forge fatal or system debug)
  v_clean_severity := lower(trim(p_severity));
  IF v_clean_severity NOT IN ('info', 'warn', 'error') THEN
    v_clean_severity := 'info';
  END IF;

  -- Enforce frontend namespace
  v_clean_event := trim(p_event_name);
  IF NOT (v_clean_event LIKE 'frontend.%') THEN
    v_clean_event := 'frontend.' || v_clean_event;
  END IF;

  INSERT INTO operational_logs (
    tenant_id,
    severity,
    component,
    event_name,
    message,
    correlation_id,
    duration_ms,
    context,
    environment
  ) VALUES (
    p_tenant_id,
    v_clean_severity,
    'frontend',
    v_clean_event,
    substring(COALESCE(p_message, 'Unknown client error'), 1, 1000),
    p_correlation_id,
    p_duration_ms,
    jsonb_build_object(
      'actor_user_id', v_user_id,
      'client_context', COALESCE(p_context, '{}'::jsonb)
    ),
    'production'
  ) RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_client_telemetry(uuid, text, text, text, text, jsonb, int) TO authenticated;

-- Restricted fallback policy for operational_logs
DROP POLICY IF EXISTS "insert_client_oplogs" ON operational_logs;
CREATE POLICY "insert_client_oplogs"
  ON operational_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND component = 'frontend'
    AND severity IN ('info', 'warn', 'error')
    AND event_name LIKE 'frontend.%'
  );


-- ==============================================================================
-- 4. MIGRATION 024: ENABLE REALTIME WAL PUBLICATIONS
-- ==============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE leads; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE contacts; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE tasks; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE activities; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE viewings; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE operational_logs; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE system_health; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE incidents; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE webhook_inbox; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE outbox_events; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

COMMIT;
