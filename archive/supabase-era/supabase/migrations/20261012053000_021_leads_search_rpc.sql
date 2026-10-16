-- Migration 021: Leads search RPC for contact-field full-text search
--
-- Purpose:
-- The LeadsPage previously attempted to use PostgREST's OR filter on a joined
-- contacts relation (contact.first_name.ilike...) which is unreliable for
-- embedded relations. This migration adds a server-side RPC that performs
-- proper contact-field text search with pagination support.
--
-- The RPC:
-- - Validates tenant membership (caller must be a member of p_tenant_id)
-- - Joins leads with contacts for searchable fields
-- - Accepts optional stage/source/search filters
-- - Returns leads with embedded contact data as JSON
-- - Is SECURITY DEFINER to bypass RLS and perform the join efficiently
-- - Uses fixed search_path for security
-- - Can be called from the frontend via supabase.rpc('search_leads', ...)

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

  -- Validate limit to prevent abuse
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
