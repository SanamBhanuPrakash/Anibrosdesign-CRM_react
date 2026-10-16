/*
# CRM Domain Tables — Pipelines, Contacts, Leads, Properties, Activities, Tasks, Viewings, Audit

## Purpose
Creates the core CRM business tables on top of the tenant hierarchy.
Every table has tenant_id and is protected by RLS checking tenant_memberships.

## Design Decisions
1. ALL tables (including child tables like pipeline_stages) have tenant_id
   directly, so RLS policies can use a uniform predicate. Child tables also
   have FK to their parent (pipeline_id), but tenant_id is always present.
2. Composite uniqueness checks at the application level prevent a child from
   referencing a parent in a different tenant.
3. Lead stage transitions validated by a SECURITY DEFINER function.

## New Tables (all with tenant_id)
- pipelines, pipeline_stages, pipeline_stage_transitions
- contacts, leads, lead_stage_history, marketing_attribution
- projects, properties, property_availability_history
- activities, tasks, viewings
- audit_logs
- webhook_inbox, outbox_events (for future integration phases)

## Security
- RLS enabled on every table with 4 policies each (SELECT/INSERT/UPDATE/DELETE).
- All policies check: tenant_id IN (SELECT tenant_id FROM tenant_memberships
  WHERE user_id = auth.uid() AND status = 'active')
*/

-- Enum types
DO $$ BEGIN CREATE TYPE lead_source AS ENUM ('google_ads', 'meta_lead_ads', 'website_form', 'manual', 'csv_import', 'whatsapp', 'referral', 'other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE qualification_status AS ENUM ('unqualified', 'pending', 'qualified', 'disqualified'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE transaction_intent AS ENUM ('buy', 'rent', 'lease', 'invest'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE expected_timeline AS ENUM ('immediate', '1_month', '3_months', '6_months', '12_months', 'exploring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE financing_status AS ENUM ('pre_approved', 'arranging', 'self_funded', 'not_discussed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE nurture_status AS ENUM ('none', 'active_nurture', 'paused', 'completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stage_type_enum AS ENUM ('active', 'won', 'lost', 'terminal'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE property_type_enum AS ENUM ('apartment', 'villa', 'plot', 'independent_house', 'commercial', 'shop', 'office', 'land'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE transaction_type_enum AS ENUM ('sale', 'rent', 'lease'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE listing_type_enum AS ENUM ('new_booking', 'resale', 'rental'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE availability_status AS ENUM ('available', 'reserved', 'soft_hold', 'under_negotiation', 'booked', 'sold', 'off_market'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE furnishing_type AS ENUM ('unfurnished', 'semi_furnished', 'fully_furnished'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE activity_type AS ENUM ('call', 'email', 'whatsapp', 'meeting', 'viewing', 'note', 'system', 'stage_change', 'assignment_change'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE activity_direction AS ENUM ('inbound', 'outbound', 'internal'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'completed', 'cancelled', 'overdue'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE viewing_status AS ENUM ('scheduled', 'confirmed', 'completed', 'no_show', 'cancelled', 'rescheduled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE viewing_outcome AS ENUM ('interested', 'not_interested', 'undecided', 'no_feedback'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE project_status AS ENUM ('planned', 'under_construction', 'ready', 'completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE webhook_status AS ENUM ('received', 'processing', 'completed', 'retrying', 'dead_letter', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'sent', 'retrying', 'dead_letter', 'superseded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ PIPELINES ============
CREATE TABLE IF NOT EXISTS pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant_id ON pipelines(tenant_id);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name text NOT NULL,
  stage_key text NOT NULL,
  stage_type stage_type_enum NOT NULL DEFAULT 'active',
  sort_order int NOT NULL DEFAULT 0,
  is_won_stage boolean NOT NULL DEFAULT false,
  is_lost_stage boolean NOT NULL DEFAULT false,
  requires_loss_reason boolean NOT NULL DEFAULT false,
  color text NOT NULL DEFAULT '#64748b',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline_key ON pipeline_stages(pipeline_id, stage_key);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline_id ON pipeline_stages(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_tenant_id ON pipeline_stages(tenant_id);

CREATE TABLE IF NOT EXISTS pipeline_stage_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  is_allowed boolean NOT NULL DEFAULT true,
  required_fields text[] NOT NULL DEFAULT '{}',
  side_effect text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transitions_pipeline_id ON pipeline_stage_transitions(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_transitions_tenant_id ON pipeline_stage_transitions(tenant_id);

-- ============ CONTACTS ============
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text,
  email text,
  email_normalized text,
  phone text,
  phone_normalized text,
  communication_consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON contacts(tenant_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts(tenant_id);

-- ============ LEADS ============
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  pipeline_stage_id uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'new',
  lead_source lead_source NOT NULL DEFAULT 'manual',
  integration_id uuid,
  provider_lead_id text,
  campaign_id text,
  ad_group_id text,
  ad_id text,
  form_id text,
  landing_page_url text,
  gclid text,
  gbraid text,
  wbraid text,
  fbclid text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  qualification_status qualification_status DEFAULT 'pending',
  qualification_notes text,
  budget_min numeric,
  budget_max numeric,
  desired_location text,
  property_type_preference text[],
  bedroom_preference int[],
  transaction_intent transaction_intent,
  expected_timeline expected_timeline,
  financing_status financing_status,
  loss_reason text,
  nurture_status nurture_status NOT NULL DEFAULT 'none',
  lead_score int NOT NULL DEFAULT 0,
  response_sla_due_at timestamptz,
  first_contacted_at timestamptz,
  last_activity_at timestamptz,
  title text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_integration_provider ON leads(integration_id, provider_lead_id) WHERE provider_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_assigned ON leads(tenant_id, assigned_to, stage);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_source ON leads(tenant_id, lead_source);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads(contact_id);

-- ============ LEAD STAGE HISTORY ============
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead_id ON lead_stage_history(lead_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_tenant_id ON lead_stage_history(tenant_id);

-- ============ MARKETING ATTRIBUTION ============
CREATE TABLE IF NOT EXISTS marketing_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  touch_type text NOT NULL,
  source text NOT NULL,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  ad_id text,
  form_id text,
  landing_page text,
  gclid text,
  fbclid text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  attributed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attribution_tenant_lead ON marketing_attribution(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_attribution_tenant_source ON marketing_attribution(tenant_id, source, campaign_id);

-- ============ PROJECTS ============
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  developer text,
  location text,
  rera_number text,
  status project_status NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id);

-- ============ PROPERTIES ============
CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  property_type property_type_enum NOT NULL,
  transaction_type transaction_type_enum NOT NULL DEFAULT 'sale',
  listing_type listing_type_enum NOT NULL DEFAULT 'new_booking',
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  locality text,
  latitude numeric,
  longitude numeric,
  bedrooms int,
  bathrooms int,
  built_up_area_sqft numeric,
  carpet_area_sqft numeric,
  floor_number int,
  total_floors int,
  facing text,
  furnishing furnishing_type,
  amenities text[] NOT NULL DEFAULT '{}',
  price numeric,
  currency text NOT NULL DEFAULT 'INR',
  price_per_sqft numeric,
  availability_status availability_status NOT NULL DEFAULT 'available',
  availability_expires_at timestamptz,
  owner_name text,
  commission_percentage numeric,
  notes text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_tenant_project_name ON properties(tenant_id, project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_tenant_type ON properties(tenant_id, property_type, transaction_type);
CREATE INDEX IF NOT EXISTS idx_properties_tenant_availability ON properties(tenant_id, availability_status);
CREATE INDEX IF NOT EXISTS idx_properties_tenant_locality ON properties(tenant_id, locality);
CREATE INDEX IF NOT EXISTS idx_properties_tenant_price ON properties(tenant_id, price);

-- ============ PROPERTY AVAILABILITY HISTORY ============
CREATE TABLE IF NOT EXISTS property_availability_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_prop_avail_history_property ON property_availability_history(property_id, changed_at);

-- ============ ACTIVITIES ============
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  type activity_type NOT NULL,
  direction activity_direction,
  subject text,
  content text,
  performed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_internal boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_lead ON activities(tenant_id, lead_id, performed_at);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_contact ON activities(tenant_id, contact_id, performed_at);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_date ON activities(tenant_id, performed_at);

-- ============ TASKS ============
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_date date,
  due_time time,
  priority task_priority NOT NULL DEFAULT 'medium',
  status task_status NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assignee ON tasks(tenant_id, assigned_to, status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_lead ON tasks(tenant_id, lead_id);

-- ============ VIEWINGS ============
CREATE TABLE IF NOT EXISTS viewings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  assigned_to uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scheduled_date date NOT NULL,
  scheduled_time time NOT NULL,
  duration_minutes int NOT NULL DEFAULT 60,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status viewing_status NOT NULL DEFAULT 'scheduled',
  notes text,
  feedback text,
  outcome viewing_outcome,
  cancelled_reason text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_viewings_agent_slot_conflict ON viewings(assigned_to, scheduled_date, scheduled_time) WHERE status IN ('scheduled', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_agent_date ON viewings(tenant_id, assigned_to, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_lead ON viewings(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_property ON viewings(tenant_id, property_id, scheduled_date);

-- ============ AUDIT LOGS ============
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_date ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action ON audit_logs(tenant_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_logs(user_id, created_at);

-- ============ WEBHOOK INBOX (for future Phase 4) ============
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  raw_payload jsonb NOT NULL,
  status webhook_status NOT NULL DEFAULT 'received',
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  processed_at timestamptz,
  error_detail text,
  is_test boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_inbox_integration_event ON webhook_inbox(integration_id, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status ON webhook_inbox(status, next_attempt_at) WHERE status IN ('received', 'retrying');

-- ============ OUTBOX EVENTS (for future Phase 5) ============
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status outbox_status NOT NULL DEFAULT 'pending',
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  provider_response jsonb,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_event_type_id ON outbox_events(event_type, event_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, next_attempt_at) WHERE status IN ('pending', 'retrying');

-- ============ RLS POLICIES ============
-- Apply RLS + 4 policies to all tenant-owned tables.
-- All tables now have tenant_id, so the uniform pattern works.

DO $$
DECLARE
  tbl text;
  tenant_owned_tables text[] := ARRAY[
    'pipelines', 'pipeline_stages', 'pipeline_stage_transitions',
    'contacts', 'leads', 'lead_stage_history', 'marketing_attribution',
    'projects', 'properties', 'property_availability_history',
    'activities', 'tasks', 'viewings', 'audit_logs',
    'webhook_inbox', 'outbox_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY tenant_owned_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "select_own_tenant_%s" ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY "select_own_tenant_%s" ON %I FOR SELECT TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = ''active''))', tbl, tbl);

    EXECUTE format('DROP POLICY IF EXISTS "insert_own_tenant_%s" ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY "insert_own_tenant_%s" ON %I FOR INSERT TO authenticated WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = ''active''))', tbl, tbl);

    EXECUTE format('DROP POLICY IF EXISTS "update_own_tenant_%s" ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY "update_own_tenant_%s" ON %I FOR UPDATE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = ''active'')) WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = ''active''))', tbl, tbl);

    EXECUTE format('DROP POLICY IF EXISTS "delete_own_tenant_%s" ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY "delete_own_tenant_%s" ON %I FOR DELETE TO authenticated USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() AND status = ''active''))', tbl, tbl);
  END LOOP;
END $$;
