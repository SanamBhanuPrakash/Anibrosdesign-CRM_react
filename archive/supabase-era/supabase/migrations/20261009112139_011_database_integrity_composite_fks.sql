/*
# Database Integrity — Composite Foreign Keys

## Purpose
Prevent cross-tenant child references at the database level. A lead in tenant A
should not be able to reference a pipeline or contact from tenant B.

## Approach
1. Add composite UNIQUE constraints (tenant_id, id) on parent tables
2. Drop existing single-column FKs on child→parent relationships
3. Recreate them as composite FKs: (tenant_id, parent_id) REFERENCES parent(tenant_id, id)

## Parent tables getting (tenant_id, id) unique constraint:
- pipelines, pipeline_stages, contacts, leads, properties, projects,
  automation_rules, custom_field_definitions, integrations

## Child→parent FKs being converted to composite:
- leads → pipelines (pipeline_id)
- leads → pipeline_stages (pipeline_stage_id)
- leads → contacts (contact_id)
- pipeline_stages → pipelines (pipeline_id)
- pipeline_stage_transitions → pipelines (pipeline_id)
- properties → projects (project_id)
- activities → leads (lead_id)
- activities → contacts (contact_id)
- tasks → leads (lead_id)
- viewings → leads (lead_id)
- viewings → properties (property_id)
- lead_stage_history → leads (lead_id)
- marketing_attribution → leads (lead_id)
- communication_consents → contacts (contact_id)
- property_availability_history → properties (property_id)
- custom_field_values → custom_field_definitions (field_definition_id)
- automation_executions → automation_rules (rule_id)
- webhook_inbox → integrations (integration_id)
- outbox_events → integrations (integration_id)

## Safety
- Does NOT drop tenant_id → tenants FK (that stays as-is)
- Does NOT drop any data
- Only replaces FK constraints, not columns or data
*/

-- ============================================================
-- Step 1: Add composite UNIQUE constraints on parent tables
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipelines_tenant_id_id ON pipelines(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stages_tenant_id_id ON pipeline_stages(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_tenant_id_id ON contacts(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_id_id ON leads(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_tenant_id_id ON properties(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_tenant_id_id ON projects(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_rules_tenant_id_id ON automation_rules(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_defs_tenant_id_id ON custom_field_definitions(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_tenant_id_id ON integrations(tenant_id, id);

-- ============================================================
-- Step 2: Add composite FK constraints (add new ones first, then drop old ones)
-- We use ADD CONSTRAINT with composite FKs, then drop the old single-column ones.
-- The old and new constraints coexist briefly; dropping the old one is safe.
-- ============================================================

-- leads → pipelines
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_id_fkey;
ALTER TABLE leads ADD CONSTRAINT leads_pipeline_id_fkey
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id) ON DELETE CASCADE;

-- leads → pipeline_stages
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_stage_id_fkey;
ALTER TABLE leads ADD CONSTRAINT leads_pipeline_stage_id_fkey
  FOREIGN KEY (tenant_id, pipeline_stage_id) REFERENCES pipeline_stages(tenant_id, id);

-- leads → contacts
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_contact_id_fkey;
ALTER TABLE leads ADD CONSTRAINT leads_contact_id_fkey
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL;

-- pipeline_stages → pipelines
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_pipeline_id_fkey;
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_pipeline_id_fkey
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id) ON DELETE CASCADE;

-- pipeline_stage_transitions → pipelines
ALTER TABLE pipeline_stage_transitions DROP CONSTRAINT IF EXISTS pipeline_stage_transitions_pipeline_id_fkey;
ALTER TABLE pipeline_stage_transitions ADD CONSTRAINT pipeline_stage_transitions_pipeline_id_fkey
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id) ON DELETE CASCADE;

-- properties → projects
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_project_id_fkey;
ALTER TABLE properties ADD CONSTRAINT properties_project_id_fkey
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE SET NULL;

-- activities → leads
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_lead_id_fkey;
ALTER TABLE activities ADD CONSTRAINT activities_lead_id_fkey
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE;

-- activities → contacts
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_contact_id_fkey;
ALTER TABLE activities ADD CONSTRAINT activities_contact_id_fkey
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL;

-- tasks → leads
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_lead_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_lead_id_fkey
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE;

-- viewings → leads
ALTER TABLE viewings DROP CONSTRAINT IF EXISTS viewings_lead_id_fkey;
ALTER TABLE viewings ADD CONSTRAINT viewings_lead_id_fkey
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE;

-- viewings → properties
ALTER TABLE viewings DROP CONSTRAINT IF EXISTS viewings_property_id_fkey;
ALTER TABLE viewings ADD CONSTRAINT viewings_property_id_fkey
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties(tenant_id, id) ON DELETE SET NULL;

-- lead_stage_history → leads
ALTER TABLE lead_stage_history DROP CONSTRAINT IF EXISTS lead_stage_history_lead_id_fkey;
ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_lead_id_fkey
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE;

-- marketing_attribution → leads
ALTER TABLE marketing_attribution DROP CONSTRAINT IF EXISTS marketing_attribution_lead_id_fkey;
ALTER TABLE marketing_attribution ADD CONSTRAINT marketing_attribution_lead_id_fkey
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE;

-- communication_consents → contacts
ALTER TABLE communication_consents DROP CONSTRAINT IF EXISTS communication_consents_contact_id_fkey;
ALTER TABLE communication_consents ADD CONSTRAINT communication_consents_contact_id_fkey
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE;

-- property_availability_history → properties
ALTER TABLE property_availability_history DROP CONSTRAINT IF EXISTS property_availability_history_property_id_fkey;
ALTER TABLE property_availability_history ADD CONSTRAINT property_availability_history_property_id_fkey
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties(tenant_id, id) ON DELETE CASCADE;

-- custom_field_values → custom_field_definitions
ALTER TABLE custom_field_values DROP CONSTRAINT IF EXISTS custom_field_values_field_definition_id_fkey;
ALTER TABLE custom_field_values ADD CONSTRAINT custom_field_values_field_definition_id_fkey
  FOREIGN KEY (tenant_id, field_definition_id) REFERENCES custom_field_definitions(tenant_id, id) ON DELETE CASCADE;

-- automation_executions → automation_rules
ALTER TABLE automation_executions DROP CONSTRAINT IF EXISTS automation_executions_rule_id_fkey;
ALTER TABLE automation_executions ADD CONSTRAINT automation_executions_rule_id_fkey
  FOREIGN KEY (tenant_id, rule_id) REFERENCES automation_rules(tenant_id, id) ON DELETE CASCADE;

-- webhook_inbox → integrations (add FK if integration_id column exists and has data)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_inbox' AND column_name = 'integration_id'
  ) THEN
    ALTER TABLE webhook_inbox DROP CONSTRAINT IF EXISTS webhook_inbox_integration_id_fkey;
    ALTER TABLE webhook_inbox ADD CONSTRAINT webhook_inbox_integration_id_fkey
      FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

-- outbox_events → integrations
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox_events' AND column_name = 'integration_id'
  ) THEN
    ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_integration_id_fkey;
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_integration_id_fkey
      FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- Step 3: Add performance indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned ON leads(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_source ON leads(tenant_id, lead_source);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email_normalized);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON contacts(tenant_id, phone_normalized);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status_next ON webhook_inbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next ON outbox_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_lead ON activities(tenant_id, lead_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assigned_status ON tasks(tenant_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_date ON viewings(tenant_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_properties_tenant_type_status ON properties(tenant_id, property_type, availability_status);
