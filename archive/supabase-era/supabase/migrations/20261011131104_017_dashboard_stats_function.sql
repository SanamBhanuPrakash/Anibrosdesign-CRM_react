-- Create a dashboard stats function that returns all metrics in a single RPC call.
-- This replaces 9 separate client queries (including a client-side pipeline value
-- calculation that fetched all matching lead rows) with one server-side query.
-- The function is SECURITY DEFINER with a fixed search_path to bypass RLS for
-- the aggregate queries (the caller's tenant_id is validated via auth.uid()
-- membership check, so no cross-tenant data leakage is possible).

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_total_leads int;
  v_new_leads int;
  v_qualified_leads int;
  v_won_deals int;
  v_pipeline_value numeric;
  v_unassigned_leads int;
  v_stale_leads int;
  v_tasks_due_today int;
  v_recent_leads jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify the caller is a member of this tenant
  SELECT EXISTS(
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  -- Count queries
  SELECT count(*) INTO v_total_leads
  FROM leads WHERE tenant_id = p_tenant_id AND deleted_at IS NULL;

  SELECT count(*) INTO v_new_leads
  FROM leads WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND stage = 'new';

  SELECT count(*) INTO v_qualified_leads
  FROM leads WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND stage = 'qualified';

  SELECT count(*) INTO v_won_deals
  FROM leads WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND stage = 'won';

  SELECT COALESCE(sum(budget_max), 0) INTO v_pipeline_value
  FROM leads
  WHERE tenant_id = p_tenant_id
    AND deleted_at IS NULL
    AND stage IN ('qualified', 'viewing_scheduled', 'viewing_completed', 'negotiation', 'booking_reserved');

  SELECT count(*) INTO v_unassigned_leads
  FROM leads WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND assigned_to IS NULL;

  SELECT count(*) INTO v_stale_leads
  FROM leads
  WHERE tenant_id = p_tenant_id
    AND deleted_at IS NULL
    AND last_activity_at < (now() - interval '7 days');

  SELECT count(*) INTO v_tasks_due_today
  FROM tasks
  WHERE tenant_id = p_tenant_id
    AND status = 'open'
    AND due_date = current_date;

  -- Recent 5 leads with contact info
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', l.id,
    'stage', l.stage,
    'lead_source', l.lead_source,
    'created_at', l.created_at,
    'contact_first_name', c.first_name,
    'contact_last_name', c.last_name,
    'contact_email', c.email,
    'contact_phone', c.phone
  ) ORDER BY l.created_at DESC), '[]'::jsonb) INTO v_recent_leads
  FROM leads l
  LEFT JOIN contacts c ON c.id = l.contact_id
  WHERE l.tenant_id = p_tenant_id
    AND l.deleted_at IS NULL
  LIMIT 5;

  RETURN jsonb_build_object(
    'total_leads', v_total_leads,
    'new_leads', v_new_leads,
    'qualified_leads', v_qualified_leads,
    'won_deals', v_won_deals,
    'pipeline_value', v_pipeline_value,
    'unassigned_leads', v_unassigned_leads,
    'stale_leads', v_stale_leads,
    'tasks_due_today', v_tasks_due_today,
    'recent_leads', v_recent_leads
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(uuid) TO authenticated;
