/*
# Automation Rule Execution Engine

## What This Migration Does
Adds a `execute_automation_rules` SECURITY DEFINER function that evaluates
active automation rules when a trigger event occurs and executes the
configured action. This closes the gap where automation rules existed in
the UI and database but had no backend execution path.

## How It Works
1. Called with a trigger type (e.g., 'lead_created', 'stage_changed') and context
2. Fetches all active automation rules for the tenant matching the trigger type
3. For each matching rule, executes the configured action:
   - 'assign_lead': Round-robin assignment to specified team members
   - 'set_field': Update a field on the lead (e.g., nurture_status, qualification_status)
   - 'create_task': Create a follow-up task linked to the lead
   - 'add_tag' / 'send_notification': Log an activity record
4. Records each execution in automation_executions table
5. Returns summary of executed/skipped/failed rules
6. Protected against recursive execution (execution entries are checked)

## Security
- SECURITY DEFINER, EXECUTE granted to authenticated only, revoked from anon/PUBLIC
- Validates caller's tenant membership
- search_path set explicitly
- All operations are tenant-scoped
*/

CREATE OR REPLACE FUNCTION public.execute_automation_rules(
  p_tenant_id uuid,
  p_trigger_type text,
  p_entity_id uuid,
  p_entity_type text DEFAULT 'lead',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_membership_exists boolean;
  v_rule record;
  v_executed int := 0;
  v_skipped int := 0;
  v_failed int := 0;
  v_errors text[] := '{}';
  v_action_config jsonb;
  v_lead record;
  v_assignee_id uuid;
  v_existing_execution boolean;
  v_task_title text;
  v_task_due_date date;
  v_round_robin_idx int;
BEGIN
  -- Validate caller has active membership in this tenant
  SELECT EXISTS(
    SELECT 1 FROM tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
  ) INTO v_membership_exists;

  IF NOT v_membership_exists THEN
    RETURN jsonb_build_object('error', 'No active membership in tenant');
  END IF;

  -- Fetch active rules matching the trigger type, ordered by priority
  FOR v_rule IN
    SELECT id, name, action_type, action_config, priority
    FROM automation_rules
    WHERE tenant_id = p_tenant_id
      AND is_active = true
      AND trigger_type = p_trigger_type
    ORDER BY priority ASC
  LOOP
    -- Check if this rule already executed for this entity (idempotency)
    SELECT EXISTS(
      SELECT 1 FROM automation_executions
      WHERE tenant_id = p_tenant_id
        AND rule_id = v_rule.id
        AND entity_id = p_entity_id
        AND entity_type = p_entity_type
        AND status = 'completed'
    ) INTO v_existing_execution;

    IF v_existing_execution THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      v_action_config := v_rule.action_config;

      -- Fetch lead data if entity is a lead
      IF p_entity_type = 'lead' THEN
        SELECT * INTO v_lead FROM leads WHERE id = p_entity_id AND tenant_id = p_tenant_id;
        IF NOT FOUND THEN
          v_failed := v_failed + 1;
          v_errors := array_append(v_errors, 'Lead not found: ' || p_entity_id::text);
          CONTINUE;
        END IF;
      END IF;

      -- Execute action based on type
      CASE v_rule.action_type
        -- Assign lead to a team member (round-robin among configured members)
        WHEN 'assign_lead' THEN
          BEGIN
            v_assignee_id := NULL;
            -- Try round-robin: pick the member with fewest assigned leads
            SELECT assigned_to INTO v_assignee_id
            FROM (
              SELECT tm.user_id as assigned_to,
                     COALESCE(l.lead_count, 0) as lead_count
              FROM tenant_memberships tm
              LEFT JOIN (
                SELECT assigned_to, COUNT(*) as lead_count
                FROM leads
                WHERE tenant_id = p_tenant_id
                  AND assigned_to IS NOT NULL
                  AND deleted_at IS NULL
                GROUP BY assigned_to
              ) l ON l.assigned_to = tm.user_id
              WHERE tm.tenant_id = p_tenant_id
                AND tm.status = 'active'
                AND tm.user_id = ANY(
                  ARRAY(
                    SELECT jsonb_array_elements_text(v_action_config->'assignee_ids')
                  )
                )
              ORDER BY lead_count ASC, tm.created_at ASC
              LIMIT 1
            ) sub;

            IF v_assignee_id IS NOT NULL THEN
              UPDATE leads
              SET assigned_to = v_assignee_id,
                  assigned_at = now(),
                  updated_at = now()
              WHERE id = p_entity_id AND tenant_id = p_tenant_id;

              INSERT INTO activities (
                tenant_id, lead_id, type, direction, subject, content,
                performed_by, is_internal
              ) VALUES (
                p_tenant_id, p_entity_id, 'assignment_change', 'internal',
                'Automated assignment',
                'Lead assigned by automation rule: ' || v_rule.name,
                v_user_id, true
              );
            END IF;
          END;

        -- Set a field on the lead
        WHEN 'set_field' THEN
          BEGIN
            IF p_entity_type = 'lead' THEN
              EXECUTE format(
                'UPDATE leads SET %I = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3',
                (v_action_config->>'field_name')
              )
              USING (v_action_config->>'field_value')::text,
                    p_entity_id,
                    p_tenant_id;
            END IF;
          END;

        -- Create a follow-up task
        WHEN 'create_task' THEN
          BEGIN
            v_task_title := COALESCE(v_action_config->>'task_title', 'Follow-up task');
            v_task_due_date := CASE
              WHEN v_action_config->>'due_in_days' IS NOT NULL
              THEN (now() + ((v_action_config->>'due_in_days')::int || ' days')::interval)::date
              ELSE (now() + interval '1 day')::date
            END;

            INSERT INTO tasks (
              tenant_id, lead_id, assigned_to, title, description,
              due_date, priority, status, created_by
            ) VALUES (
              p_tenant_id,
              p_entity_id,
              COALESCE(v_lead.assigned_to, v_user_id),
              v_task_title,
              COALESCE(v_action_config->>'task_description', 'Created by automation: ' || v_rule.name),
              v_task_due_date,
              COALESCE(v_action_config->>'priority', 'medium'),
              'open',
              v_user_id
            );
          END;

        -- Log a notification/activity
        WHEN 'add_tag' THEN
          BEGIN
            INSERT INTO activities (
              tenant_id, lead_id, type, direction, subject, content,
              performed_by, is_internal
            ) VALUES (
              p_tenant_id,
              p_entity_id,
              'note',
              'internal',
              COALESCE(v_action_config->>'tag_label', 'Automated tag'),
              'Tag added by automation rule: ' || v_rule.name || ' — ' || COALESCE(v_action_config->>'tag_value', ''),
              v_user_id,
              true
            );
          END;

        -- Default: log as system activity
        ELSE
          BEGIN
            INSERT INTO activities (
              tenant_id, lead_id, type, direction, subject, content,
              performed_by, is_internal
            ) VALUES (
              p_tenant_id,
              p_entity_id,
              'system',
              'internal',
              'Automation rule executed: ' || v_rule.name,
              'Action type: ' || v_rule.action_type || ', metadata: ' || p_metadata::text,
              v_user_id,
              true
            );
          END;
      END CASE;

      -- Record successful execution
      INSERT INTO automation_executions (
        tenant_id, rule_id, entity_id, entity_type, status, executed_at
      ) VALUES (
        p_tenant_id, v_rule.id, p_entity_id, p_entity_type, 'completed', now()
      );

      v_executed := v_executed + 1;

    EXCEPTION WHEN OTHERS THEN
      -- Record failed execution
      INSERT INTO automation_executions (
        tenant_id, rule_id, entity_id, entity_type, status, executed_at, error_detail
      ) VALUES (
        p_tenant_id, v_rule.id, p_entity_id, p_entity_type, 'failed', now(),
        SQLERRM
      );

      v_failed := v_failed + 1;
      v_errors := array_append(v_errors, 'Rule ' || v_rule.name || ': ' || SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'executed', v_executed,
    'skipped', v_skipped,
    'failed', v_failed,
    'errors', to_jsonb(v_errors)
  );
END;
$$;

-- Grant and revoke appropriately
REVOKE EXECUTE ON FUNCTION public.execute_automation_rules(uuid, text, uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.execute_automation_rules(uuid, text, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_automation_rules(uuid, text, uuid, text, jsonb) TO authenticated;

-- Add trigger to automatically execute automation rules when a lead is created
CREATE OR REPLACE FUNCTION public.trigger_automation_on_lead_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Only trigger if lead was just created (not updated)
  IF TG_OP = 'INSERT' THEN
    v_result := public.execute_automation_rules(
      NEW.tenant_id,
      'lead_created',
      NEW.id,
      'lead',
      jsonb_build_object('source', NEW.lead_source, 'stage', NEW.stage)
    );
  END IF;

  -- Log the result for debugging (not stored in the lead row to avoid bloat)
  -- The automation_executions table has the full audit trail

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trigger_automation_on_lead_created() FROM anon;
REVOKE EXECUTE ON FUNCTION public.trigger_automation_on_lead_created() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trigger_automation_on_lead_created() TO authenticated;

-- Create trigger on leads table
DROP TRIGGER IF EXISTS leads_automation_trigger ON leads;
CREATE TRIGGER leads_automation_trigger
  AFTER INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_automation_on_lead_created();

-- Add index for automation rule lookup by trigger type
CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant_trigger
  ON automation_rules (tenant_id, trigger_type, is_active)
  WHERE is_active = true;
