-- Migration 023: Client Telemetry RPC and RLS Policy
--
-- Purpose:
-- Resolves the operational_logs client write constraint safely.
-- Previously, operational_logs only had a SELECT policy (migration 019),
-- so client-side error and diagnostic logging returned HTTP 403 (42501).
--
-- Security Model:
-- 1. Does NOT grant unrestricted insert access.
-- 2. Provides a SECURITY DEFINER RPC `log_client_telemetry` that:
--    - Enforces authentication (`auth.uid() IS NOT NULL`)
--    - Enforces tenant membership (`tenant_memberships` active check)
--    - Enforces permitted severity levels (`info`, `warn`, `error` only, never `fatal` or system-spoofed levels)
--    - Namespaces events strictly under `frontend.`
--    - Automatically tags the row with `component = 'frontend'` and `actor_user_id = auth.uid()`
-- 3. Provides a restrictive client INSERT RLS policy `insert_client_oplogs`
--    preventing spoofed tenant IDs, non-frontend components, or unauthorized severity levels.
-- 4. Preserves append-only invariants: operational_logs has no client UPDATE or DELETE policies.

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
  -- 1. Must be authenticated
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 2. Must be an active member of the specified tenant
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_memberships
    WHERE tenant_id = p_tenant_id
      AND user_id = v_user_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  -- 3. Severity enforcement: ordinary clients may only log info, warn, or error
  v_clean_severity := lower(trim(p_severity));
  IF v_clean_severity NOT IN ('info', 'warn', 'error') THEN
    v_clean_severity := 'info';
  END IF;

  -- 4. Event name enforcement: client events must have 'frontend.' namespace
  v_clean_event := trim(p_event_name);
  IF NOT (v_clean_event LIKE 'frontend.%') THEN
    v_clean_event := 'frontend.' || v_clean_event;
  END IF;

  -- 5. Insert operational log row with trusted attribution
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

-- Restrictive client INSERT policy for operational_logs fallback
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
