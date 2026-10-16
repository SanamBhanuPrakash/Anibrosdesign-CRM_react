-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 002
-- Domain: Core CRM Entities (Contacts, Pipelines, Leads, Viewings, Activities, Tasks, Audit)
-- Hardened with Tenant-Aware Composite Foreign Keys & Anti-Double-Booking Protection
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CRM Domain Enums
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE lead_source AS ENUM (
        'website',
        'referral',
        'portal',
        'direct',
        'meta_ads',
        'google_ads',
        'walk_in',
        'other'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE lead_status AS ENUM (
        'open',
        'contacted',
        'qualified',
        'viewing_scheduled',
        'negotiation',
        'won',
        'lost',
        'disqualified'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE property_type_enum AS ENUM (
        'apartment',
        'villa',
        'townhouse',
        'penthouse',
        'office',
        'retail',
        'plot',
        'other'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE listing_type_enum AS ENUM (
        'sale',
        'rent',
        'lease'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE property_status_enum AS ENUM (
        'available',
        'under_offer',
        'reserved',
        'sold',
        'rented',
        'inactive'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE viewing_status AS ENUM (
        'scheduled',
        'confirmed',
        'completed',
        'cancelled',
        'no_show'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE task_priority AS ENUM (
        'low',
        'medium',
        'high',
        'urgent'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE task_status AS ENUM (
        'pending',
        'in_progress',
        'completed',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE activity_type AS ENUM (
        'note',
        'call',
        'email',
        'meeting',
        'viewing',
        'status_change',
        'stage_change',
        'task_created',
        'task_completed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Contacts Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT,
    email CITEXT,
    phone TEXT,
    source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_contact_tenant_composite UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(tenant_id, email);

-- ------------------------------------------------------------------------------
-- 3. Pipelines & Pipeline Stages
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_pipeline_tenant_composite UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_pipelines_updated_at
    BEFORE UPDATE ON pipelines
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pipeline_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#3B82F6',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_pipeline_stage_tenant_composite UNIQUE (id, tenant_id),
    CONSTRAINT fk_stage_pipeline_tenant FOREIGN KEY (pipeline_id, tenant_id) 
        REFERENCES pipelines(id, tenant_id) ON DELETE CASCADE
);

CREATE TRIGGER trg_pipeline_stages_updated_at
    BEFORE UPDATE ON pipeline_stages
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_stages_pipeline_order ON pipeline_stages(pipeline_id, order_index);

-- ------------------------------------------------------------------------------
-- 4. Leads Table (Hardened with Composite Foreign Keys)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id UUID,
    pipeline_id UUID NOT NULL,
    stage_id UUID NOT NULL,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    source lead_source NOT NULL DEFAULT 'other',
    status lead_status NOT NULL DEFAULT 'open',
    lead_score INTEGER NOT NULL DEFAULT 0,
    estimated_value NUMERIC(14, 2) DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lead_tenant_composite UNIQUE (id, tenant_id),
    CONSTRAINT fk_lead_contact_tenant FOREIGN KEY (contact_id, tenant_id)
        REFERENCES contacts(id, tenant_id) ON DELETE SET NULL,
    CONSTRAINT fk_lead_pipeline_tenant FOREIGN KEY (pipeline_id, tenant_id)
        REFERENCES pipelines(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT fk_lead_stage_tenant FOREIGN KEY (stage_id, tenant_id)
        REFERENCES pipeline_stages(id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_leads_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_owner ON leads(tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_contact ON leads(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads(tenant_id, created_at DESC);

-- ------------------------------------------------------------------------------
-- 5. Lead Stage Transition History
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_stage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    from_stage_id UUID,
    to_stage_id UUID NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_stage_history_lead_tenant FOREIGN KEY (lead_id, tenant_id)
        REFERENCES leads(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT fk_stage_history_to_stage_tenant FOREIGN KEY (to_stage_id, tenant_id)
        REFERENCES pipeline_stages(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead ON lead_stage_history(lead_id, created_at DESC);

-- ------------------------------------------------------------------------------
-- 6. Projects & Properties (Inventory)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_project_tenant_composite UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID,
    title TEXT NOT NULL,
    description TEXT,
    property_type property_type_enum NOT NULL DEFAULT 'apartment',
    listing_type listing_type_enum NOT NULL DEFAULT 'sale',
    status property_status_enum NOT NULL DEFAULT 'available',
    price NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    bedrooms INTEGER DEFAULT 0,
    bathrooms INTEGER DEFAULT 0,
    area_sqft NUMERIC(10, 2) DEFAULT 0,
    location TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_property_tenant_composite UNIQUE (id, tenant_id),
    CONSTRAINT fk_property_project_tenant FOREIGN KEY (project_id, tenant_id)
        REFERENCES projects(id, tenant_id) ON DELETE SET NULL
);

CREATE TRIGGER trg_properties_updated_at
    BEFORE UPDATE ON properties
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_properties_tenant_status ON properties(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_properties_tenant_price ON properties(tenant_id, price);

-- ------------------------------------------------------------------------------
-- 7. Viewings (with Anti-Double-Booking Protection)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS viewings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    property_id UUID NOT NULL,
    agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    status viewing_status NOT NULL DEFAULT 'scheduled',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_viewing_tenant_composite UNIQUE (id, tenant_id),
    CONSTRAINT fk_viewing_lead_tenant FOREIGN KEY (lead_id, tenant_id)
        REFERENCES leads(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT fk_viewing_property_tenant FOREIGN KEY (property_id, tenant_id)
        REFERENCES properties(id, tenant_id) ON DELETE CASCADE
);

CREATE TRIGGER trg_viewings_updated_at
    BEFORE UPDATE ON viewings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Prevent double-booking same property at the same scheduled start time
CREATE UNIQUE INDEX IF NOT EXISTS uq_viewings_prevent_double_booking 
    ON viewings(property_id, scheduled_at) 
    WHERE status IN ('scheduled', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_viewings_tenant_scheduled ON viewings(tenant_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_viewings_lead ON viewings(lead_id);

-- ------------------------------------------------------------------------------
-- 8. Activities & Tasks
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type activity_type NOT NULL DEFAULT 'note',
    description TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_activity_lead_tenant FOREIGN KEY (lead_id, tenant_id)
        REFERENCES leads(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_tenant ON activities(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority task_priority NOT NULL DEFAULT 'medium',
    status task_status NOT NULL DEFAULT 'pending',
    due_date TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_task_lead_tenant FOREIGN KEY (lead_id, tenant_id)
        REFERENCES leads(id, tenant_id) ON DELETE CASCADE
);

CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_due ON tasks(assigned_to, due_date);

-- ------------------------------------------------------------------------------
-- 9. Append-Only Business Audit Logs
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    before_state JSONB,
    after_state JSONB,
    ip_address TEXT,
    correlation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity ON audit_logs(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
