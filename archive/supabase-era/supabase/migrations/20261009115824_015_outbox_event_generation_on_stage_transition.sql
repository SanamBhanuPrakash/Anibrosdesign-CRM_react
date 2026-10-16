/*
# Outbox Event Generation on Stage Transitions

## What This Migration Does
Extends the `transition_lead_stage` function to automatically create outbox
events when a lead transitions to a conversion-worthy stage (qualified, won).
This closes the loop between the CRM pipeline and the outbound conversion
feedback to Google/Meta.

## How It Works
1. After a successful stage transition, the function checks if the new stage
   is a conversion-worthy stage ('qualified' or 'won')
2. If so, it looks for an active integration matching the lead's lead_source
   (google_ads -> google_enhanced_conversions, meta_lead_ads -> meta_conversions)
3. Creates an outbox_event with:
   - The lead's contact info (email, phone) for PII hashing
   - Attribution data (gclid, fbclid, campaign_id)
   - A unique provider_event_id to prevent duplicate conversions
   - The lead's contact_id for consent checking
4. The process-outbox edge function will pick this up and send it to the provider

## Consent Check
The process-outbox edge function checks communication_consents before sending.
If the contact has opted out of advertising measurement, the event is rejected.

## Idempotency
The provider_event_id is constructed from lead_id + to_stage, so repeated
transitions to the same stage (e.g., qualified -> contacted -> qualified)
won't create duplicate outbox events — the unique constraint catches it.

## Security
- The function is already SECURITY DEFINER; this migration only modifies the body
- Outbox events are tenant-scoped via v_tenant_id from the lead record
- No new grants needed
*/

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
  v_contact RECORD;
  v_integration RECORD;
  v_outbox_provider text;
  v_outbox_event_type text;
  v_provider_event_id text;
  v_event_name text;
  v_is_conversion_stage boolean;
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

  -- If no explicit transition record found, check wildcard
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

  -- Check required fields for lost stages
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
    'Stage changed: ' || v_from_stage || ' -> ' || p_to_stage,
    p_reason,
    v_user_id, true,
    jsonb_build_object('from_stage', v_from_stage, 'to_stage', p_to_stage)
  );

  -- ===== Outbox Event Generation for Conversion Feedback =====
  -- Check if this stage is conversion-worthy
  v_is_conversion_stage := p_to_stage IN ('qualified', 'won');

  IF v_is_conversion_stage AND v_lead.integration_id IS NOT NULL THEN
    -- Fetch the contact for PII and consent checking
    SELECT email, phone, email_normalized, phone_normalized
    INTO v_contact
    FROM contacts
    WHERE id = v_lead.contact_id AND tenant_id = v_tenant_id;

    -- Fetch the integration to determine provider
    SELECT id, provider, config
    INTO v_integration
    FROM integrations
    WHERE id = v_lead.integration_id AND tenant_id = v_tenant_id AND status = 'active';

    IF FOUND THEN
      -- Map lead source to outbox provider and event type
      v_outbox_provider := CASE v_lead.lead_source
        WHEN 'google_ads' THEN 'google_enhanced_conversions'
        WHEN 'meta_lead_ads' THEN 'meta_conversions'
        ELSE NULL
      END;

      v_outbox_event_type := CASE v_lead.lead_source
        WHEN 'google_ads' THEN 'google_conversion'
        WHEN 'meta_lead_ads' THEN 'meta_conversion'
        ELSE NULL
      END;

      -- Map stage to event name (Meta CAPI standard event names)
      v_event_name := CASE p_to_stage
        WHEN 'qualified' THEN 'SubmitApplication'
        WHEN 'won' THEN 'Purchase'
        ELSE 'Lead'
      END;

      IF v_outbox_provider IS NOT NULL THEN
        -- Build a unique provider_event_id to prevent duplicate conversions
        -- Format: lead_id + to_stage ensures idempotency for repeated transitions
        v_provider_event_id := p_lead_id::text || '_' || p_to_stage;

        -- Insert outbox event (unique constraint on provider_event_id catches duplicates)
        BEGIN
          INSERT INTO outbox_events (
            tenant_id, integration_id, event_type, provider,
            provider_event_id, status, payload
          ) VALUES (
            v_tenant_id,
            v_lead.integration_id,
            v_outbox_event_type,
            v_outbox_provider,
            v_provider_event_id,
            'pending',
            jsonb_build_object(
              'lead_id', p_lead_id,
              'contact_id', v_lead.contact_id,
              'event_name', v_event_name,
              'event_id', v_provider_event_id,
              'email', v_contact.email,
              'phone', v_contact.phone,
              'gclid', v_lead.gclid,
              'fbclid', v_lead.fbclid,
              'campaign_id', v_lead.campaign_id,
              'conversion_value', CASE WHEN p_to_stage = 'won' THEN v_lead.budget_max ELSE 0 END,
              'stage', p_to_stage,
              'transitioned_at', now()::text
            )
          );
        EXCEPTION WHEN unique_violation THEN
          -- Duplicate outbox event — already created for this lead+stage combo
          -- This is expected when a lead transitions back and forth; skip silently
          NULL;
        END;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'lead_id', p_lead_id, 'from_stage', v_from_stage, 'to_stage', p_to_stage);
END;
$$;
