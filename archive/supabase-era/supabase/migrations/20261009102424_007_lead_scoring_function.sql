/*
# Lead Scoring Function

## Purpose
Implements rule-based, explainable lead scoring. The function calculates a score
0-100 based on weighted criteria and updates the lead's lead_score field.

## Scoring Rules (max 100 points)
- Source quality: google_ads=20, meta_lead_ads=20, website_form=15, referral=25, whatsapp=15, manual=10, other=5 (max 25)
- Budget indicated: budget_max > 0 = 15 points
- Intent specified: transaction_intent not null = 10 points
- Timeline urgency: immediate=15, 1_month=12, 3_months=8, 6_months=5, 12_months=3, exploring=1 (max 15)
- Qualification status: qualified=20, pending=10, unqualified=0, disqualified=0 (max 20)
- Activity engagement: has first_contacted_at = 10, has last_activity_at within 3 days = 5 (max 15)

## Security
- SECURITY DEFINER, search_path = public, auth
- Verifies tenant membership before scoring
- EXECUTE revoked from PUBLIC, granted to authenticated only
*/

CREATE OR REPLACE FUNCTION calculate_lead_score(p_lead_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_lead RECORD;
  v_score int := 0;
  v_breakdown jsonb;
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Lead not found');
  END IF;

  -- Verify membership
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id AND tenant_id = v_lead.tenant_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('error', 'Not authorized');
  END IF;

  -- Source quality (max 25)
  v_score := v_score + CASE v_lead.lead_source
    WHEN 'referral' THEN 25
    WHEN 'google_ads' THEN 20
    WHEN 'meta_lead_ads' THEN 20
    WHEN 'website_form' THEN 15
    WHEN 'whatsapp' THEN 15
    WHEN 'manual' THEN 10
    ELSE 5
  END;

  -- Budget indicated (15)
  IF v_lead.budget_max IS NOT NULL AND v_lead.budget_max > 0 THEN
    v_score := v_score + 15;
  END IF;

  -- Intent specified (10)
  IF v_lead.transaction_intent IS NOT NULL THEN
    v_score := v_score + 10;
  END IF;

  -- Timeline urgency (max 15)
  v_score := v_score + CASE v_lead.expected_timeline
    WHEN 'immediate' THEN 15
    WHEN '1_month' THEN 12
    WHEN '3_months' THEN 8
    WHEN '6_months' THEN 5
    WHEN '12_months' THEN 3
    WHEN 'exploring' THEN 1
    ELSE 0
  END;

  -- Qualification (max 20)
  v_score := v_score + CASE v_lead.qualification_status
    WHEN 'qualified' THEN 20
    WHEN 'pending' THEN 10
    ELSE 0
  END;

  -- Activity engagement (max 15)
  IF v_lead.first_contacted_at IS NOT NULL THEN
    v_score := v_score + 10;
  END IF;
  IF v_lead.last_activity_at IS NOT NULL AND v_lead.last_activity_at > now() - interval '3 days' THEN
    v_score := v_score + 5;
  END IF;

  -- Cap at 100
  v_score := LEAST(v_score, 100);

  -- Build explainable breakdown
  v_breakdown := jsonb_build_object(
    'source_quality', CASE v_lead.lead_source WHEN 'referral' THEN 25 WHEN 'google_ads' THEN 20 WHEN 'meta_lead_ads' THEN 20 WHEN 'website_form' THEN 15 WHEN 'whatsapp' THEN 15 WHEN 'manual' THEN 10 ELSE 5 END,
    'budget_indicated', CASE WHEN v_lead.budget_max IS NOT NULL AND v_lead.budget_max > 0 THEN 15 ELSE 0 END,
    'intent_specified', CASE WHEN v_lead.transaction_intent IS NOT NULL THEN 10 ELSE 0 END,
    'timeline_urgency', CASE v_lead.expected_timeline WHEN 'immediate' THEN 15 WHEN '1_month' THEN 12 WHEN '3_months' THEN 8 WHEN '6_months' THEN 5 WHEN '12_months' THEN 3 WHEN 'exploring' THEN 1 ELSE 0 END,
    'qualification', CASE v_lead.qualification_status WHEN 'qualified' THEN 20 WHEN 'pending' THEN 10 ELSE 0 END,
    'activity_engagement', (CASE WHEN v_lead.first_contacted_at IS NOT NULL THEN 10 ELSE 0 END + CASE WHEN v_lead.last_activity_at IS NOT NULL AND v_lead.last_activity_at > now() - interval '3 days' THEN 5 ELSE 0 END),
    'total_score', v_score
  );

  -- Update lead
  UPDATE leads SET lead_score = v_score, updated_at = now() WHERE id = p_lead_id;

  RETURN jsonb_build_object('success', true, 'lead_id', p_lead_id, 'score', v_score, 'breakdown', v_breakdown);
END;
$$;

REVOKE EXECUTE ON FUNCTION calculate_lead_score(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calculate_lead_score(uuid) TO authenticated;
