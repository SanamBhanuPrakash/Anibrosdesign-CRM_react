-- Fix ambiguous column reference in get_attribution_stats
CREATE OR REPLACE FUNCTION public.get_attribution_stats(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_source_breakdown jsonb;
  v_campaign_performance jsonb;
  v_channel_metrics jsonb;
  v_total_attributed int;
  v_stage_by_source jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id AND tenant_id = p_tenant_id AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  SELECT count(DISTINCT lead_id) INTO v_total_attributed
  FROM marketing_attribution WHERE tenant_id = p_tenant_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source', source,
    'lead_count', lead_count,
    'won_count', won_count,
    'qualified_count', qualified_count
  ) ORDER BY lead_count DESC), '[]'::jsonb) INTO v_source_breakdown
  FROM (
    SELECT
      l.lead_source as source,
      count(DISTINCT l.id) as lead_count,
      count(DISTINCT CASE WHEN l.stage = 'won' THEN l.id END) as won_count,
      count(DISTINCT CASE WHEN l.stage IN ('qualified','viewing_scheduled','viewing_completed','negotiation','booking_reserved') THEN l.id END) as qualified_count
    FROM leads l
    WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
    GROUP BY l.lead_source
  ) s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'campaign_name', campaign_name,
    'source', source,
    'lead_count', lead_count,
    'won_count', won_count
  ) ORDER BY lead_count DESC), '[]'::jsonb) INTO v_campaign_performance
  FROM (
    SELECT
      COALESCE(ma.campaign_name, 'Unknown') as campaign_name,
      ma.source,
      count(DISTINCT ma.lead_id) as lead_count,
      count(DISTINCT CASE WHEN l.stage = 'won' THEN l.id END) as won_count
    FROM marketing_attribution ma
    LEFT JOIN leads l ON l.id = ma.lead_id AND l.deleted_at IS NULL
    WHERE ma.tenant_id = p_tenant_id
      AND ma.campaign_name IS NOT NULL
    GROUP BY ma.campaign_name, ma.source
  ) c;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'channel', channel,
    'lead_count', lead_count,
    'conversion_rate', CASE WHEN lead_count > 0 THEN round((won_count::numeric / lead_count) * 100, 1) ELSE 0 END
  ) ORDER BY lead_count DESC), '[]'::jsonb) INTO v_channel_metrics
  FROM (
    SELECT
      COALESCE(ma.utm_medium, ma.source) as channel,
      count(DISTINCT ma.lead_id) as lead_count,
      count(DISTINCT CASE WHEN l.stage = 'won' THEN l.id END) as won_count
    FROM marketing_attribution ma
    LEFT JOIN leads l ON l.id = ma.lead_id AND l.deleted_at IS NULL
    WHERE ma.tenant_id = p_tenant_id
    GROUP BY COALESCE(ma.utm_medium, ma.source)
  ) ch;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source', source,
    'stage', stage,
    'count', cnt
  ) ORDER BY source, stage), '[]'::jsonb) INTO v_stage_by_source
  FROM (
    SELECT l.lead_source as source, l.stage, count(*) as cnt
    FROM leads l
    WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
    GROUP BY l.lead_source, l.stage
  ) ss;

  RETURN jsonb_build_object(
    'total_attributed', v_total_attributed,
    'source_breakdown', v_source_breakdown,
    'campaign_performance', v_campaign_performance,
    'channel_metrics', v_channel_metrics,
    'stage_by_source', v_stage_by_source
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_attribution_stats(uuid) TO authenticated;
