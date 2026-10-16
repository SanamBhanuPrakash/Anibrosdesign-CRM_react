/*
# Phase 7-8: Integrations, Consent, Custom Fields, Automation, Subscriptions

## Purpose
Adds tables for:
- Integration configuration (per-tenant ad/communication provider connections)
- Communication consent history (separate from preferences)
- Custom field definitions and values
- Automation rules and execution log
- Subscription plans and tenant subscriptions (schema only, not wired to Stripe)

## Security
- All tables have tenant_id + standard 4 RLS policies
- integrations.credential_ref stores ONLY the secret name, never the value
- communication_consents tracks auditable consent history per channel
*/

-- integrations table
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_ads','meta_lead_ads','meta_conversions','google_enhanced_conversions','whatsapp','email','website_form','manual','csv_import')),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('active','paused','error','disconnected')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_ref text,
  last_health_check_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX integrations_tenant_provider_config_idx
  ON integrations (tenant_id, provider, (config->>'account_id'))
  WHERE config->>'account_id' IS NOT NULL;

CREATE INDEX integrations_tenant_status_idx ON integrations (tenant_id, status);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_integrations" ON integrations FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_integrations" ON integrations FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_integrations" ON integrations FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_integrations" ON integrations FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- integration_webhook_endpoints table
CREATE TABLE integration_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  endpoint_path text NOT NULL,
  webhook_secret_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX integration_webhook_endpoints_integration_idx ON integration_webhook_endpoints (integration_id);

ALTER TABLE integration_webhook_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_webhook_endpoints" ON integration_webhook_endpoints FOR SELECT TO authenticated USING (integration_id IN (SELECT i.id FROM integrations i WHERE i.tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')));
CREATE POLICY "insert_own_webhook_endpoints" ON integration_webhook_endpoints FOR INSERT TO authenticated WITH CHECK (integration_id IN (SELECT i.id FROM integrations i WHERE i.tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')));
CREATE POLICY "update_own_webhook_endpoints" ON integration_webhook_endpoints FOR UPDATE TO authenticated USING (integration_id IN (SELECT i.id FROM integrations i WHERE i.tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')));
CREATE POLICY "delete_own_webhook_endpoints" ON integration_webhook_endpoints FOR DELETE TO authenticated USING (integration_id IN (SELECT i.id FROM integrations i WHERE i.tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')));

-- communication_consents table
CREATE TABLE communication_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms','call')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('opted_in','opted_out','pending')),
  consent_source text CHECK (consent_source IN ('lead_form','explicit','imported','inferred_from_interaction')),
  consented_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX communication_consents_tenant_contact_channel_idx
  ON communication_consents (tenant_id, contact_id, channel);

CREATE INDEX communication_consents_contact_idx ON communication_consents (contact_id);

ALTER TABLE communication_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_consents" ON communication_consents FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_consents" ON communication_consents FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_consents" ON communication_consents FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_consents" ON communication_consents FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- custom_field_definitions table
CREATE TABLE custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('lead','property','contact')),
  field_key text NOT NULL,
  field_label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date','select','multiselect','boolean')),
  field_options jsonb DEFAULT '[]'::jsonb,
  is_required boolean NOT NULL DEFAULT false,
  is_searchable boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX custom_field_defs_tenant_entity_key_idx
  ON custom_field_definitions (tenant_id, entity_type, field_key);

CREATE INDEX custom_field_defs_tenant_entity_idx ON custom_field_definitions (tenant_id, entity_type);

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_custom_field_defs" ON custom_field_definitions FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_custom_field_defs" ON custom_field_definitions FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_custom_field_defs" ON custom_field_definitions FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_custom_field_defs" ON custom_field_definitions FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- custom_field_values table
CREATE TABLE custom_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  field_definition_id uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX custom_field_values_tenant_field_entity_idx
  ON custom_field_values (tenant_id, field_definition_id, entity_id);

CREATE INDEX custom_field_values_entity_idx ON custom_field_values (entity_id);

ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_custom_field_values" ON custom_field_values FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_custom_field_values" ON custom_field_values FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_custom_field_values" ON custom_field_values FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_custom_field_values" ON custom_field_values FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- automation_rules table
CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL CHECK (trigger_type IN ('lead_created','stage_changed','task_overdue','inactivity','property_match','schedule')),
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL CHECK (action_type IN ('assign_lead','send_notification','create_task','update_field','send_whatsapp','send_email','change_stage')),
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_rules_tenant_active_idx ON automation_rules (tenant_id, is_active);

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_automation_rules" ON automation_rules FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_automation_rules" ON automation_rules FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_automation_rules" ON automation_rules FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_automation_rules" ON automation_rules FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- automation_executions table
CREATE TABLE automation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','skipped')),
  error_detail text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_executions_tenant_rule_idx ON automation_executions (tenant_id, rule_id);
CREATE INDEX automation_executions_entity_idx ON automation_executions (entity_id);

ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_automation_executions" ON automation_executions FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "insert_own_automation_executions" ON automation_executions FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "update_own_automation_executions" ON automation_executions FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));
CREATE POLICY "delete_own_automation_executions" ON automation_executions FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- subscription_plans table (schema only, not wired to Stripe)
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  price_monthly numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tenant_subscriptions table (schema only)
CREATE TABLE tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','cancelled','suspended')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenant_subscriptions_tenant_idx ON tenant_subscriptions (tenant_id);

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_subscription_plans" ON subscription_plans FOR SELECT TO authenticated USING (true);

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_subscriptions" ON tenant_subscriptions FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = 'active'));

-- Seed a free plan
INSERT INTO subscription_plans (name, display_name, description, price_monthly, features, limits, sort_order)
VALUES ('free', 'Free', 'Starter plan for small teams', 0,
  jsonb_build_object('leads', 'unlimited', 'properties', 'unlimited', 'users', 5),
  jsonb_build_object('max_users', 5, 'max_integrations', 2),
  0);
INSERT INTO subscription_plans (name, display_name, description, price_monthly, features, limits, sort_order)
VALUES ('pro', 'Professional', 'Full-featured plan for growing agencies', 2000,
  jsonb_build_object('leads', 'unlimited', 'properties', 'unlimited', 'users', 50, 'integrations', 'all', 'automation', true, 'custom_fields', true),
  jsonb_build_object('max_users', 50, 'max_integrations', 20),
  1);
