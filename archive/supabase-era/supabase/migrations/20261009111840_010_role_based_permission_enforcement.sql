/*
# Role-Based Permission Enforcement

## Purpose
Enforce role-based permissions at the database level so that tenant membership alone
does not grant unrestricted CRUD. Sales agents cannot delete records. Marketing analysts
are read-only. Auditors can only read audit logs. Only admin/owner roles can perform
destructive operations or modify configuration.

## Changes

### 1. New helper function
- `get_user_tenant_role(p_tenant_id uuid)` — returns the user's role in a specific tenant

### 2. Role-aware DELETE policies (replacing existing ones)
Tables: leads, contacts, properties, projects, pipelines, pipeline_stages,
pipeline_stage_transitions, integrations, automation_rules, custom_field_definitions,
custom_field_values, tasks, viewings, activities, webhook_inbox, outbox_events,
communication_consents, marketing_attribution, lead_stage_history,
property_availability_history, automation_executions

### 3. Role-aware UPDATE policies for config tables
Tables: integrations, automation_rules, pipeline_stages, pipelines,
pipeline_stage_transitions, custom_field_definitions, webhook_inbox, outbox_events

### 4. Role-aware INSERT policies for config tables
Tables: integrations, automation_rules, pipeline_stages, pipelines,
pipeline_stage_transitions, custom_field_definitions, webhook_inbox, outbox_events

### 5. tenant_subscriptions DELETE policy (new)

## Security
- All policies still check tenant membership first
- Role check adds an additional layer
- EXECUTE on new helper function: authenticated only
*/

-- ============================================================
-- 1. Helper function: get_user_tenant_role
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_tenant_role(p_tenant_id uuid)
RETURNS public.tenant_role
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM tenant_memberships
  WHERE user_id = auth.uid()
    AND tenant_id = p_tenant_id
    AND status = 'active'
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_tenant_role(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_tenant_role(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_tenant_role(uuid) TO authenticated;

-- ============================================================
-- 2. Role-aware DELETE policies
-- ============================================================

DROP POLICY IF EXISTS "delete_own_tenant_leads" ON leads;
CREATE POLICY "delete_own_tenant_leads" ON leads FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'sales_manager')
  );

DROP POLICY IF EXISTS "delete_own_tenant_contacts" ON contacts;
CREATE POLICY "delete_own_tenant_contacts" ON contacts FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_properties" ON properties;
CREATE POLICY "delete_own_tenant_properties" ON properties FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_projects" ON projects;
CREATE POLICY "delete_own_tenant_projects" ON projects FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_pipelines" ON pipelines;
CREATE POLICY "delete_own_tenant_pipelines" ON pipelines FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_pipeline_stages" ON pipeline_stages;
CREATE POLICY "delete_own_tenant_pipeline_stages" ON pipeline_stages FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions;
CREATE POLICY "delete_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_integrations" ON integrations;
CREATE POLICY "delete_own_integrations" ON integrations FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_automation_rules" ON automation_rules;
CREATE POLICY "delete_own_automation_rules" ON automation_rules FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "delete_own_custom_field_defs" ON custom_field_definitions;
CREATE POLICY "delete_own_custom_field_defs" ON custom_field_definitions FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_custom_field_values" ON custom_field_values;
CREATE POLICY "delete_own_custom_field_values" ON custom_field_values FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_tasks" ON tasks;
CREATE POLICY "delete_own_tenant_tasks" ON tasks FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'sales_manager')
  );

DROP POLICY IF EXISTS "delete_own_tenant_viewings" ON viewings;
CREATE POLICY "delete_own_tenant_viewings" ON viewings FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'sales_manager')
  );

DROP POLICY IF EXISTS "delete_own_tenant_activities" ON activities;
CREATE POLICY "delete_own_tenant_activities" ON activities FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'sales_manager')
  );

DROP POLICY IF EXISTS "delete_own_tenant_webhook_inbox" ON webhook_inbox;
CREATE POLICY "delete_own_tenant_webhook_inbox" ON webhook_inbox FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_outbox_events" ON outbox_events;
CREATE POLICY "delete_own_tenant_outbox_events" ON outbox_events FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_consents" ON communication_consents;
CREATE POLICY "delete_own_consents" ON communication_consents FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_marketing_attribution" ON marketing_attribution;
CREATE POLICY "delete_own_tenant_marketing_attribution" ON marketing_attribution FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_lead_stage_history" ON lead_stage_history;
CREATE POLICY "delete_own_tenant_lead_stage_history" ON lead_stage_history FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_tenant_property_availability_history" ON property_availability_history;
CREATE POLICY "delete_own_tenant_property_availability_history" ON property_availability_history FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "delete_own_automation_executions" ON automation_executions;
CREATE POLICY "delete_own_automation_executions" ON automation_executions FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

-- tenant_subscriptions: new DELETE policy (didn't exist before)
DROP POLICY IF EXISTS "delete_own_subscriptions" ON tenant_subscriptions;
CREATE POLICY "delete_own_subscriptions" ON tenant_subscriptions FOR DELETE
  TO authenticated USING (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

-- ============================================================
-- 3. Role-aware UPDATE policies for config tables
-- ============================================================

DROP POLICY IF EXISTS "update_own_integrations" ON integrations;
CREATE POLICY "update_own_integrations" ON integrations FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "update_own_automation_rules" ON automation_rules;
CREATE POLICY "update_own_automation_rules" ON automation_rules FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "update_own_tenant_pipeline_stages" ON pipeline_stages;
CREATE POLICY "update_own_tenant_pipeline_stages" ON pipeline_stages FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "update_own_tenant_pipelines" ON pipelines;
CREATE POLICY "update_own_tenant_pipelines" ON pipelines FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "update_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions;
CREATE POLICY "update_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "update_own_custom_field_defs" ON custom_field_definitions;
CREATE POLICY "update_own_custom_field_defs" ON custom_field_definitions FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "update_own_tenant_webhook_inbox" ON webhook_inbox;
CREATE POLICY "update_own_tenant_webhook_inbox" ON webhook_inbox FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "update_own_tenant_outbox_events" ON outbox_events;
CREATE POLICY "update_own_tenant_outbox_events" ON outbox_events FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'))
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

-- ============================================================
-- 4. Role-aware INSERT policies for config tables
-- ============================================================

DROP POLICY IF EXISTS "insert_own_integrations" ON integrations;
CREATE POLICY "insert_own_integrations" ON integrations FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "insert_own_automation_rules" ON automation_rules;
CREATE POLICY "insert_own_automation_rules" ON automation_rules FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "insert_own_tenant_pipeline_stages" ON pipeline_stages;
CREATE POLICY "insert_own_tenant_pipeline_stages" ON pipeline_stages FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "insert_own_tenant_pipelines" ON pipelines;
CREATE POLICY "insert_own_tenant_pipelines" ON pipelines FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "insert_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions;
CREATE POLICY "insert_own_tenant_pipeline_stage_transitions" ON pipeline_stage_transitions FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "insert_own_custom_field_defs" ON custom_field_definitions;
CREATE POLICY "insert_own_custom_field_defs" ON custom_field_definitions FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin')
  );

DROP POLICY IF EXISTS "insert_own_tenant_webhook_inbox" ON webhook_inbox;
CREATE POLICY "insert_own_tenant_webhook_inbox" ON webhook_inbox FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );

DROP POLICY IF EXISTS "insert_own_tenant_outbox_events" ON outbox_events;
CREATE POLICY "insert_own_tenant_outbox_events" ON outbox_events FOR INSERT
  TO authenticated WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')
    AND public.get_user_tenant_role(tenant_id) IN ('tenant_owner', 'tenant_admin', 'marketing_manager')
  );
