/*
# Lead Stage Transition Function and Auto-Seed Pipeline

## Purpose
1. Creates a SECURITY DEFINER function `transition_lead_stage` that safely
   validates and executes lead pipeline stage transitions with:
   - Tenant membership verification
   - Allowed-transition check against pipeline_stage_transitions
   - Atomic update of lead + insertion of stage history + audit log
   - First-contacted timestamp tracking
   - Returns the updated lead or an error message

2. Creates a SECURITY DEFINER function `seed_default_pipeline` that inserts
   the standard real estate pipeline with stages and allowed transitions
   for a given tenant. Called during tenant onboarding.

## Security
- Both functions are SECURITY DEFINER with explicit search_path.
- `transition_lead_stage` verifies the caller has an active membership
  in the lead's tenant before allowing any change.
- `seed_default_pipeline` verifies the caller is a tenant_owner or
  tenant_admin before creating pipeline data.

## Important Notes
- The transition function uses FOR UPDATE to lock the lead row during
  the transition, preventing concurrent stage changes.
- Invalid transitions return an error text, not an exception, so the
  caller can display it to the user.
*/

-- ============ TRANSITION LEAD STAGE FUNCTION ============
CREATE OR REPLACE FUNCTION transition_lead_stage(
  p_lead_id uuid,
  p_to_stage text,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_lead RECORD;
  v_tenant_id uuid;
  v_pipeline_id uuid;
  v_from_stage text;
  v_transition_allowed boolean;
  v_stage_exists boolean;
  v_user_id uuid := auth.uid();
  v_result jsonb;
BEGIN
  -- Check authentication
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  -- Lock the lead row and get current state
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Lead not found');
  END IF;

  v_tenant_id := v_lead.tenant_id;
  v_pipeline_id := v_lead.pipeline_id;
  v_from_stage := v_lead.stage;

  -- Verify the caller has active membership in this tenant
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = v_tenant_id
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('error', 'Not authorized to modify this lead');
  END IF;

  -- Check if target stage exists in the pipeline
  SELECT EXISTS (
    SELECT 1 FROM pipeline_stages
    WHERE pipeline_id = v_pipeline_id AND stage_key = p_to_stage
  ) INTO v_stage_exists;

  IF NOT v_stage_exists THEN
    RETURN jsonb_build_object('error', 'Target stage does not exist in pipeline');
  END IF;

  -- If already in target stage, no-op
  IF v_from_stage = p_to_stage THEN
    RETURN jsonb_build_object('error', 'already_in_stage', 'stage', v_from_stage);
  END IF;

  -- Check if transition is allowed
  SELECT is_allowed INTO v_transition_allowed
  FROM pipeline_stage_transitions
  WHERE pipeline_id = v_pipeline_id
    AND from_stage = v_from_stage
    AND to_stage = p_to_stage
  LIMIT 1;

  -- If no explicit transition record found, check if there's a wildcard
  IF v_transition_allowed IS NULL THEN
    SELECT is_allowed INTO v_transition_allowed
    FROM pipeline_stage_transitions
    WHERE pipeline_id = v_pipeline_id
      AND from_stage = '*'
      AND to_stage = p_to_stage
    LIMIT 1;
  END IF;

  -- If still no record, deny by default
  IF v_transition_allowed IS NULL OR v_transition_allowed = false THEN
    RETURN jsonb_build_object('error', 'Transition not allowed', 'from', v_from_stage, 'to', p_to_stage);
  END IF;

  -- Check required fields for this transition
  -- (simplified: check loss_reason for lost stages)
  IF p_to_stage IN ('lost', 'unqualified') AND v_lead.loss_reason IS NULL AND (p_reason IS NULL OR p_reason = '') THEN
    RETURN jsonb_build_object('error', 'Loss reason is required for this transition');
  END IF;

  -- Execute the transition
  UPDATE leads
  SET stage = p_to_stage,
      pipeline_stage_id = (
        SELECT id FROM pipeline_stages
        WHERE pipeline_id = v_pipeline_id AND stage_key = p_to_stage
        LIMIT 1
      ),
      loss_reason = CASE
        WHEN p_to_stage IN ('lost', 'unqualified') AND leads.loss_reason IS NULL
        THEN COALESCE(p_reason, leads.loss_reason)
        ELSE leads.loss_reason
      END,
      first_contacted_at = CASE
        WHEN p_to_stage IN ('contacted', 'contact_attempted') AND leads.first_contacted_at IS NULL
        THEN now()
        ELSE leads.first_contacted_at
      END,
      updated_at = now()
  WHERE id = p_lead_id;

  -- Insert stage history
  INSERT INTO lead_stage_history (tenant_id, lead_id, from_stage, to_stage, changed_by, reason, metadata)
  VALUES (v_tenant_id, p_lead_id, v_from_stage, p_to_stage, v_user_id, p_reason, p_metadata);

  -- Insert audit log
  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (
    v_tenant_id, v_user_id, 'lead_stage_transition', 'lead', p_lead_id,
    jsonb_build_object('from_stage', v_from_stage, 'to_stage', p_to_stage, 'reason', p_reason)
  );

  -- Insert activity
  INSERT INTO activities (tenant_id, lead_id, type, direction, subject, content, performed_by, is_internal, metadata)
  VALUES (
    v_tenant_id, p_lead_id, 'stage_change', 'internal',
    'Stage changed: ' || v_from_stage || ' → ' || p_to_stage,
    p_reason,
    v_user_id, true,
    jsonb_build_object('from_stage', v_from_stage, 'to_stage', p_to_stage)
  );

  RETURN jsonb_build_object('success', true, 'lead_id', p_lead_id, 'from_stage', v_from_stage, 'to_stage', p_to_stage);
END;
$$;

-- ============ SEED DEFAULT PIPELINE FUNCTION ============
CREATE OR REPLACE FUNCTION seed_default_pipeline(p_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_pipeline_id uuid;
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  -- Verify caller is tenant_owner or tenant_admin
  SELECT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
      AND role IN ('tenant_owner', 'tenant_admin')
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Not authorized to configure pipeline for this tenant';
  END IF;

  -- Check if a default pipeline already exists
  SELECT id INTO v_pipeline_id FROM pipelines WHERE tenant_id = p_tenant_id AND is_default = true LIMIT 1;
  IF v_pipeline_id IS NOT NULL THEN
    RETURN v_pipeline_id;
  END IF;

  -- Create pipeline
  INSERT INTO pipelines (tenant_id, name, is_default, sort_order)
  VALUES (p_tenant_id, 'Default Sales Pipeline', true, 0)
  RETURNING id INTO v_pipeline_id;

  -- Create stages
  INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, stage_type, sort_order, color) VALUES
    (p_tenant_id, v_pipeline_id, 'New', 'new', 'active', 0, '#3b82f6'),
    (p_tenant_id, v_pipeline_id, 'Contact Attempted', 'contact_attempted', 'active', 1, '#f59e0b'),
    (p_tenant_id, v_pipeline_id, 'Contacted', 'contacted', 'active', 2, '#0ea5e9'),
    (p_tenant_id, v_pipeline_id, 'Qualified', 'qualified', 'active', 3, '#10b981'),
    (p_tenant_id, v_pipeline_id, 'Viewing Scheduled', 'viewing_scheduled', 'active', 4, '#8b5cf6'),
    (p_tenant_id, v_pipeline_id, 'Viewing Completed', 'viewing_completed', 'active', 5, '#6366f1'),
    (p_tenant_id, v_pipeline_id, 'Negotiation', 'negotiation', 'active', 6, '#ec4899'),
    (p_tenant_id, v_pipeline_id, 'Booking Reserved', 'booking_reserved', 'active', 7, '#f97316'),
    (p_tenant_id, v_pipeline_id, 'Won', 'won', 'won', 8, '#22c55e'),
    (p_tenant_id, v_pipeline_id, 'Lost', 'lost', 'lost', 9, '#ef4444'),
    (p_tenant_id, v_pipeline_id, 'Invalid', 'invalid', 'terminal', 10, '#6b7280'),
    (p_tenant_id, v_pipeline_id, 'Unqualified', 'unqualified', 'lost', 11, '#94a3b8'),
    (p_tenant_id, v_pipeline_id, 'Nurture', 'nurture', 'active', 12, '#a855f7');

  -- Set won/lost flags
  UPDATE pipeline_stages SET is_won_stage = true WHERE pipeline_id = v_pipeline_id AND stage_key = 'won';
  UPDATE pipeline_stages SET is_lost_stage = true WHERE pipeline_id = v_pipeline_id AND stage_key IN ('lost', 'unqualified');
  UPDATE pipeline_stages SET requires_loss_reason = true WHERE pipeline_id = v_pipeline_id AND stage_key IN ('lost', 'unqualified');

  -- Create allowed transitions
  INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage, to_stage, is_allowed) VALUES
    -- From new
    (p_tenant_id, v_pipeline_id, 'new', 'contact_attempted', true),
    (p_tenant_id, v_pipeline_id, 'new', 'invalid', true),
    (p_tenant_id, v_pipeline_id, 'new', 'unqualified', true),
    -- From contact_attempted
    (p_tenant_id, v_pipeline_id, 'contact_attempted', 'contacted', true),
    (p_tenant_id, v_pipeline_id, 'contact_attempted', 'invalid', true),
    (p_tenant_id, v_pipeline_id, 'contact_attempted', 'unqualified', true),
    (p_tenant_id, v_pipeline_id, 'contact_attempted', 'nurture', true),
    -- From contacted
    (p_tenant_id, v_pipeline_id, 'contacted', 'qualified', true),
    (p_tenant_id, v_pipeline_id, 'contacted', 'unqualified', true),
    (p_tenant_id, v_pipeline_id, 'contacted', 'nurture', true),
    (p_tenant_id, v_pipeline_id, 'contacted', 'new', true),
    -- From qualified
    (p_tenant_id, v_pipeline_id, 'qualified', 'viewing_scheduled', true),
    (p_tenant_id, v_pipeline_id, 'qualified', 'negotiation', true),
    (p_tenant_id, v_pipeline_id, 'qualified', 'lost', true),
    (p_tenant_id, v_pipeline_id, 'qualified', 'nurture', true),
    -- From viewing_scheduled
    (p_tenant_id, v_pipeline_id, 'viewing_scheduled', 'viewing_completed', true),
    (p_tenant_id, v_pipeline_id, 'viewing_scheduled', 'no_show', false),
    (p_tenant_id, v_pipeline_id, 'viewing_scheduled', 'qualified', true),
    (p_tenant_id, v_pipeline_id, 'viewing_scheduled', 'lost', true),
    -- From viewing_completed
    (p_tenant_id, v_pipeline_id, 'viewing_completed', 'negotiation', true),
    (p_tenant_id, v_pipeline_id, 'viewing_completed', 'unqualified', true),
    (p_tenant_id, v_pipeline_id, 'viewing_completed', 'nurture', true),
    (p_tenant_id, v_pipeline_id, 'viewing_completed', 'lost', true),
    -- From negotiation
    (p_tenant_id, v_pipeline_id, 'negotiation', 'booking_reserved', true),
    (p_tenant_id, v_pipeline_id, 'negotiation', 'lost', true),
    (p_tenant_id, v_pipeline_id, 'negotiation', 'viewing_scheduled', true),
    -- From booking_reserved
    (p_tenant_id, v_pipeline_id, 'booking_reserved', 'won', true),
    (p_tenant_id, v_pipeline_id, 'booking_reserved', 'lost', true),
    -- From nurture
    (p_tenant_id, v_pipeline_id, 'nurture', 'qualified', true),
    (p_tenant_id, v_pipeline_id, 'nurture', 'lost', true),
    -- Wildcard: any active stage can go to lost
    (p_tenant_id, v_pipeline_id, '*', 'lost', true),
    -- Wildcard: any stage can go to invalid
    (p_tenant_id, v_pipeline_id, '*', 'invalid', true);

  RETURN v_pipeline_id;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION transition_lead_stage(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION seed_default_pipeline(uuid) TO authenticated;
