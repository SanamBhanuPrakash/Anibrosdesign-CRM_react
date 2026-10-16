-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 008
-- Domain: Complete CRM Schema — Integrations, Custom Fields, Automation,
--         Consent, Branches, Lead Scoring
-- Wave 2 from: ANIBROS_CRM_DEEP_DIVE_ANALYSIS.md
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Integration Providers (H1 — Third-Party Platform Config)
-- Stores OAuth tokens, API keys and webhook endpoint configs per tenant.
-- Credentials are stored encrypted; application decrypts at runtime.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,  -- 'google_ads', 'meta_ads', 'whatsapp', 'mailgun', 'twilio'
    display_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    -- Encrypted credential blob (AES-256-GCM, key from env)
    credentials_enc TEXT,
    -- Outbound webhook config
    webhook_url TEXT,
    webhook_secret_enc TEXT,
    -- OAuth state
    oauth_access_token_enc TEXT,
    oauth_refresh_token_enc TEXT,
    oauth_expires_at TIMESTAMPTZ,
    oauth_scope TEXT,
    -- Configuration and feature flags
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_integration_tenant_provider UNIQUE (tenant_id, provider)
);

CREATE TRIGGER trg_integrations_updated_at
    BEFORE UPDATE ON integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_integrations_tenant    ON integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_integrations_provider  ON integrations(provider) WHERE is_active = true;

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_integrations ON integrations;
CREATE POLICY tenant_isolation_integrations ON integrations
    FOR ALL USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Integration webhook inbound endpoints (per-provider per-tenant)
CREATE TABLE IF NOT EXISTS integration_webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    endpoint_path TEXT UNIQUE NOT NULL, -- e.g. /api/webhooks/meta/abc123
    secret_hash TEXT NOT NULL,          -- SHA-256 of the signing secret
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iwe_tenant        ON integration_webhook_endpoints(tenant_id);
CREATE INDEX IF NOT EXISTS idx_iwe_path          ON integration_webhook_endpoints(endpoint_path) WHERE is_active = true;

-- ------------------------------------------------------------------------------
-- 2. Communication Consent Records (GDPR / DPDP compliance)
-- Tracks explicit opt-in per channel per contact. Immutable append-only.
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE consent_channel AS ENUM ('email', 'sms', 'whatsapp', 'push', 'phone_call');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE consent_status AS ENUM ('granted', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS communication_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL,
    channel consent_channel NOT NULL,
    status consent_status NOT NULL DEFAULT 'granted',
    source TEXT NOT NULL DEFAULT 'manual', -- 'manual', 'form', 'api', 'import'
    -- Legal basis: GDPR Article 6 lawful basis
    legal_basis TEXT NOT NULL DEFAULT 'consent', -- 'consent', 'legitimate_interest', 'contract'
    ip_address TEXT,
    user_agent TEXT,
    -- Consent proof: URL of the form, timestamp, double opt-in token
    proof_url TEXT,
    double_opt_in_confirmed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_consent_contact_tenant FOREIGN KEY (contact_id, tenant_id)
        REFERENCES contacts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consents_contact     ON communication_consents(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_consents_channel     ON communication_consents(tenant_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_consents_active      ON communication_consents(tenant_id, status, expires_at)
    WHERE status = 'granted';

-- Utility function: check if contact has active consent for a channel
CREATE OR REPLACE FUNCTION app.has_consent(
    p_tenant_id UUID,
    p_contact_id UUID,
    p_channel consent_channel
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM communication_consents
        WHERE tenant_id = p_tenant_id
          AND contact_id = p_contact_id
          AND channel = p_channel
          AND status = 'granted'
          AND (expires_at IS NULL OR expires_at > now())
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.has_consent(UUID, UUID, consent_channel) TO crm_app_user;

-- ------------------------------------------------------------------------------
-- 3. Custom Field Definitions & Values (M8)
-- Tenants can define their own fields on leads and contacts.
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE custom_field_entity AS ENUM ('lead', 'contact', 'property', 'viewing');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE custom_field_type AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type custom_field_entity NOT NULL,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    field_key TEXT NOT NULL, -- snake_case identifier, e.g. 'preferred_locality'
    field_type custom_field_type NOT NULL DEFAULT 'text',
    is_required BOOLEAN NOT NULL DEFAULT false,
    is_visible BOOLEAN NOT NULL DEFAULT true,
    options JSONB NOT NULL DEFAULT '[]'::jsonb, -- For select/multi_select types
    default_value TEXT,
    validation_regex TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_custom_field_key UNIQUE (tenant_id, entity_type, field_key)
);

CREATE TRIGGER trg_custom_field_defs_updated_at
    BEFORE UPDATE ON custom_field_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_custom_field_defs_tenant ON custom_field_definitions(tenant_id, entity_type);

CREATE TABLE IF NOT EXISTS custom_field_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    field_id UUID NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    entity_type custom_field_entity NOT NULL,
    entity_id UUID NOT NULL,
    value TEXT, -- Stored as text, typed interpretation in application layer
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_custom_field_value UNIQUE (field_id, entity_id)
);

CREATE TRIGGER trg_custom_field_values_updated_at
    BEFORE UPDATE ON custom_field_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_custom_field_values_entity ON custom_field_values(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_field  ON custom_field_values(field_id);

-- ------------------------------------------------------------------------------
-- 4. Automation Rules & Execution Log (M7)
-- Tenant-configurable triggers → conditions → actions (no-code automation).
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE automation_trigger AS ENUM (
        'lead_created', 'lead_stage_changed', 'lead_status_changed',
        'viewing_scheduled', 'viewing_completed', 'viewing_no_show',
        'task_overdue', 'task_completed',
        'contact_created',
        'time_based'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE automation_action_type AS ENUM (
        'send_email', 'send_whatsapp', 'send_sms',
        'create_task', 'assign_lead', 'change_lead_stage',
        'add_tag', 'remove_tag',
        'notify_agent', 'webhook_call'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE automation_status AS ENUM ('active', 'paused', 'draft', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    trigger_type automation_trigger NOT NULL,
    trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. { stage_key: 'qualified' }
    conditions JSONB NOT NULL DEFAULT '[]'::jsonb,     -- AND-joined list of conditions
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,        -- Ordered list of actions to execute
    status automation_status NOT NULL DEFAULT 'draft',
    run_count INTEGER NOT NULL DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_automation_rules_updated_at
    BEFORE UPDATE ON automation_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant  ON automation_rules(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger ON automation_rules(tenant_id, trigger_type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS automation_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    trigger_entity_type TEXT NOT NULL,
    trigger_entity_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    actions_run INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    execution_log JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_exec_rule   ON automation_executions(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_exec_tenant ON automation_executions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_exec_status ON automation_executions(status) WHERE status IN ('pending', 'running');

-- (Section 5 removed 2026-10-13: subscriptions/billing are deferred by owner decision. See docs/SUBSCRIPTION_DESIGN.md)

-- ------------------------------------------------------------------------------
-- 6. Branches (Property Inventory Organizational Unit)
-- Real estate agencies have multiple branches / offices.
-- Properties and agents can be associated with a branch.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL, -- Short code e.g. 'HYD-01'
    address TEXT,
    city TEXT,
    state TEXT,
    country TEXT NOT NULL DEFAULT 'IN',
    phone TEXT,
    email TEXT,
    manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_branch_tenant_code UNIQUE (tenant_id, code)
);

CREATE TRIGGER trg_branches_updated_at
    BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id, is_active);

-- Add branch_id to properties and users
ALTER TABLE properties ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_branch ON properties(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads(branch_id) WHERE branch_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 7. Lead Scoring Configuration (per tenant)
-- Tenants can configure weights for lead scoring criteria.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_scoring_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Source weights
    weight_source_meta_ads INTEGER NOT NULL DEFAULT 20,
    weight_source_google_ads INTEGER NOT NULL DEFAULT 20,
    weight_source_referral INTEGER NOT NULL DEFAULT 30,
    weight_source_website INTEGER NOT NULL DEFAULT 15,
    weight_source_portal INTEGER NOT NULL DEFAULT 10,
    weight_source_walk_in INTEGER NOT NULL DEFAULT 25,
    weight_source_other INTEGER NOT NULL DEFAULT 5,
    -- Engagement weights
    weight_viewing_scheduled INTEGER NOT NULL DEFAULT 15,
    weight_viewing_completed INTEGER NOT NULL DEFAULT 25,
    weight_call_made INTEGER NOT NULL DEFAULT 10,
    weight_email_replied INTEGER NOT NULL DEFAULT 10,
    -- Recency decay (days)
    recency_decay_days INTEGER NOT NULL DEFAULT 30,
    -- Budget fit weights
    weight_budget_fit_exact INTEGER NOT NULL DEFAULT 20,
    weight_budget_fit_close INTEGER NOT NULL DEFAULT 10,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_scoring_config_tenant UNIQUE (tenant_id)
);

-- Default scoring config auto-created per tenant
CREATE OR REPLACE FUNCTION app.seed_lead_scoring_config(p_tenant_id UUID)
RETURNS void AS $$
BEGIN
    INSERT INTO lead_scoring_config (tenant_id)
    VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.seed_lead_scoring_config(UUID) TO crm_app_user;

-- (Section 8 removed 2026-10-13: per-table NOTIFY triggers duplicated route-level broadcasts. Realtime now uses the
--  transactional domain_events spine introduced in a later migration.)

-- ------------------------------------------------------------------------------
-- 9. Grant permissions for all new tables to crm_app_user
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            integrations,
            integration_webhook_endpoints,
            communication_consents,
            custom_field_definitions,
            custom_field_values,
            automation_rules,
            automation_executions,
            branches,
            lead_scoring_config
        TO crm_app_user;

    END IF;
END $$;

-- Enable RLS on new tables
ALTER TABLE integrations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_consents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values         ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_executions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scoring_config         ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies for new tables
DO $$
DECLARE
    tbl TEXT;
    tables_with_tenant TEXT[] := ARRAY[
        'integration_webhook_endpoints', 'communication_consents',
        'custom_field_definitions', 'custom_field_values',
        'automation_rules', 'automation_executions',
        'branches', 'lead_scoring_config'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables_with_tenant LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_isolation_%s ON %I;
             CREATE POLICY tenant_isolation_%s ON %I
                 FOR ALL
                 USING (tenant_id = app.current_tenant_id())
                 WITH CHECK (tenant_id = app.current_tenant_id());',
            tbl, tbl, tbl, tbl
        );
    END LOOP;
END $$;

-- ==============================================================================
-- END OF MIGRATION 008
-- ==============================================================================
