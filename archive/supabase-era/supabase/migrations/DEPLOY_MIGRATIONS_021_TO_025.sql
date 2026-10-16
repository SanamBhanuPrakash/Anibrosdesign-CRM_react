-- ============================================================================
-- ANIBROS CRM — RECONCILED DEPLOYMENT MIGRATIONS 021 TO 025 (CANONICAL BUNDLE)
-- ============================================================================
-- Purpose:
-- Transactional deployment bundle containing migrations 021, 022, 023, 024, and 025.
-- Completely reconciled statement-for-statement with standalone migration files.
--
-- Contents:
-- - 021: search_leads RPC (contact search, pagination, tenant authorization)
-- - 022: schedule_viewing RPC (atomic booking, pg_advisory_xact_lock, interval overlap checks)
-- - 023: log_client_telemetry RPC & insert_client_oplogs RLS policy
-- - 024: Enable Realtime publications on 10 CRM tables
-- - 025: notifications system (table, RLS, create_tenant_notification, mark-read RPCs, publication)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: MIGRATION 021 — SEARCH LEADS RPC
-- ============================================================================

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
    SELECT 1 FROM public.tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  -- Validate limit to prevent unbounded memory usage
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
    FROM public.leads l
    LEFT JOIN public.contacts c ON c.id = l.contact_id AND c.tenant_id = p_tenant_id
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


-- ============================================================================
-- SECTION 2: MIGRATION 022 — ATOMIC VIEWING SCHEDULING RPC
-- ============================================================================

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
      PERFORM public.transition_lead_stage(p_lead_id, 'viewing_scheduled', 'Automated stage advance on viewing scheduled');
      v_advanced_stage := true;
    EXCEPTION
      WHEN undefined_function THEN
        UPDATE public.leads
        SET stage = 'viewing_scheduled',
            updated_at = now()
        WHERE id = p_lead_id;

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


-- ============================================================================
-- SECTION 3: MIGRATION 023 — CLIENT TELEMETRY RPC & RLS
-- ============================================================================

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
    SELECT 1 FROM public.tenant_memberships
    WHERE tenant_id = p_tenant_id
      AND user_id = v_user_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  v_clean_severity := lower(trim(p_severity));
  IF v_clean_severity NOT IN ('info', 'warn', 'error') THEN
    v_clean_severity := 'info';
  END IF;

  v_clean_event := trim(p_event_name);
  IF NOT (v_clean_event LIKE 'frontend.%') THEN
    v_clean_event := 'frontend.' || v_clean_event;
  END IF;

  INSERT INTO public.operational_logs (
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

DROP POLICY IF EXISTS "insert_client_oplogs" ON public.operational_logs;
CREATE POLICY "insert_client_oplogs"
  ON public.operational_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND component = 'frontend'
    AND severity IN ('info', 'warn', 'error')
    AND event_name LIKE 'frontend.%'
  );


-- ============================================================================
-- SECTION 4: MIGRATION 024 — REALTIME WAL PUBLICATIONS
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.leads; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.activities; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.viewings; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.operational_logs; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.system_health; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.incidents; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.webhook_inbox; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.outbox_events; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;


-- ============================================================================
-- SECTION 5: MIGRATION 025 — TENANT-SCOPED NOTIFICATION SUBSYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'system',
  link text,
  read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_type CHECK (
    type IN ('lead', 'viewing', 'task', 'incident', 'integration', 'system')
  )
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_read 
  ON public.notifications(tenant_id, user_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created 
  ON public.notifications(tenant_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_notifications" ON public.notifications;
CREATE POLICY "select_own_notifications"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

DROP POLICY IF EXISTS "update_own_notifications" ON public.notifications;
CREATE POLICY "update_own_notifications"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

-- Direct client inserts revoked to prevent forged alerts
DROP POLICY IF EXISTS "insert_tenant_notifications" ON public.notifications;

-- Trigger to prevent tampering with notification content on update
CREATE OR REPLACE FUNCTION public.trg_prevent_notification_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'service_role' OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (OLD.title IS DISTINCT FROM NEW.title) OR
     (OLD.message IS DISTINCT FROM NEW.message) OR
     (OLD.type IS DISTINCT FROM NEW.type) OR
     (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) OR
     (OLD.user_id IS DISTINCT FROM NEW.user_id) OR
     (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
    RAISE EXCEPTION 'Cannot modify notification content; only read status may be updated';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_notification_immutable_fields ON public.notifications;
CREATE TRIGGER check_notification_immutable_fields
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_prevent_notification_tampering();

CREATE OR REPLACE FUNCTION public.create_tenant_notification(
  p_tenant_id uuid,
  p_user_id uuid,
  p_title text,
  p_message text,
  p_type text,
  p_link text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_notification_id uuid;
BEGIN
  IF v_caller_id IS NULL AND current_user != 'service_role' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_caller_id IS NOT NULL THEN
    SELECT role INTO v_caller_role
    FROM public.tenant_memberships
    WHERE tenant_id = p_tenant_id AND user_id = v_caller_id AND status = 'active';

    IF v_caller_role IS NULL THEN
      RAISE EXCEPTION 'Access denied: not an active member of this tenant';
    END IF;

    IF p_type IN ('incident', 'system') AND v_caller_role NOT IN ('owner', 'admin', 'manager') THEN
      RAISE EXCEPTION 'Access denied: insufficient permissions to create privileged % alerts', p_type;
    END IF;
  END IF;

  IF p_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_memberships
      WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Recipient user does not belong to active tenant';
    END IF;
  END IF;

  INSERT INTO public.notifications (
    tenant_id,
    user_id,
    title,
    message,
    type,
    link,
    metadata
  ) VALUES (
    p_tenant_id,
    p_user_id,
    p_title,
    p_message,
    p_type,
    p_link,
    p_metadata
  )
  RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_tenant_notification(uuid, uuid, text, text, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_notification_read(
  p_notification_id uuid,
  p_tenant_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = v_user_id AND tm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Access denied: not an active member of this tenant';
  END IF;

  UPDATE public.notifications
  SET read = true,
      read_at = now()
  WHERE id = p_notification_id
    AND tenant_id = p_tenant_id
    AND (user_id = v_user_id OR user_id IS NULL);

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(
  p_tenant_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = v_user_id AND tm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Access denied: not an active member of this tenant';
  END IF;

  WITH updated AS (
    UPDATE public.notifications
    SET read = true,
        read_at = now()
    WHERE tenant_id = p_tenant_id
      AND (user_id = v_user_id OR user_id IS NULL)
      AND read = false
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(uuid) TO authenticated;

-- Add notifications table to Realtime publication
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN 
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications; 
    EXCEPTION 
      WHEN duplicate_object THEN NULL; 
    END;
  END IF;
END $$;

COMMIT;
