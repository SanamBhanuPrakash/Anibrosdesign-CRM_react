-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 014
-- Domain: Pipelines (stage semantics, probabilities), Leads v2, saved views, import jobs
--
-- Design notes
--  * A stage MEANS something: `maps_to_status` says what lifecycle status a lead has while it sits in that stage and
--    `probability` feeds the weighted forecast. A trigger keeps leads.stage_key / status / closed_at consistent with the
--    stage no matter which code path moves the lead (API, import, automation, SQL function).
--  * History, activity, audit and domain events are written by the service in the same transaction; the trigger only
--    maintains derived columns, so it cannot double-write.
-- ==============================================================================

-- 1. Pipelines & stages -----------------------------------------------------------------------------------------------
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS maps_to_status lead_status NOT NULL DEFAULT 'open';
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS probability smallint NOT NULL DEFAULT 0;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS ck_stage_probability;
ALTER TABLE pipeline_stages ADD CONSTRAINT ck_stage_probability CHECK (probability BETWEEN 0 AND 100);

-- Defaults for the standard real-estate stage keys (custom stages are set explicitly through the API).
CREATE OR REPLACE FUNCTION app.stage_defaults(p_key text, OUT p_status lead_status, OUT p_probability smallint)
LANGUAGE sql IMMUTABLE AS $$
    SELECT s::lead_status, p::smallint FROM (VALUES
        ('new', 'open', 5), ('contact_attempted', 'open', 8), ('contacted', 'contacted', 15), ('qualified', 'qualified', 30),
        ('viewing_scheduled', 'viewing_scheduled', 45), ('viewing_completed', 'viewing_scheduled', 55),
        ('negotiation', 'negotiation', 70), ('booking_reserved', 'negotiation', 90), ('won', 'won', 100),
        ('lost', 'lost', 0), ('invalid', 'disqualified', 0), ('unqualified', 'disqualified', 0), ('nurture', 'open', 10)
    ) AS t(k, s, p) WHERE k = p_key
$$;

CREATE OR REPLACE FUNCTION app.pipeline_stage_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
    -- Only fill in when the inserter left the columns at their column defaults.
    IF NEW.stage_key IS NOT NULL AND NEW.maps_to_status = 'open' AND NEW.probability = 0 THEN
        SELECT * INTO d FROM app.stage_defaults(NEW.stage_key);
        IF d.p_status IS NOT NULL THEN   -- custom keys have no defaults: keep the column defaults
            NEW.maps_to_status := d.p_status;
            NEW.probability := d.p_probability;
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stage_defaults ON pipeline_stages;
CREATE TRIGGER trg_stage_defaults BEFORE INSERT ON pipeline_stages FOR EACH ROW EXECUTE FUNCTION app.pipeline_stage_defaults();

UPDATE pipeline_stages ps
   SET maps_to_status = d.p_status, probability = d.p_probability
  FROM (SELECT id, (app.stage_defaults(stage_key)).* FROM pipeline_stages WHERE stage_key IS NOT NULL) d
 WHERE ps.id = d.id AND d.p_status IS NOT NULL AND ps.maps_to_status = 'open' AND ps.probability = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stage_key_per_pipeline ON pipeline_stages (pipeline_id, stage_key) WHERE stage_key IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_default_pipeline_per_tenant ON pipelines (tenant_id) WHERE is_default AND archived_at IS NULL;

-- 2. Leads ------------------------------------------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags                text[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS version             integer NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_by          uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at         timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at           timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS loss_reason         text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_min          numeric(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_max          numeric(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bedrooms_min        smallint;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS locations           text[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_types      property_type_enum[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS listing_type        listing_type_enum;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign            text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_at   timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_activity_at    timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at    timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_breakdown     jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_leads_budget;
ALTER TABLE leads ADD CONSTRAINT ck_leads_budget CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_leads_value;
ALTER TABLE leads ADD CONSTRAINT ck_leads_value CHECK (estimated_value IS NULL OR estimated_value >= 0);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_leads_score;
ALTER TABLE leads ADD CONSTRAINT ck_leads_score CHECK (lead_score BETWEEN 0 AND 100);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_leads_tags_len;
ALTER TABLE leads ADD CONSTRAINT ck_leads_tags_len CHECK (cardinality(tags) <= 30);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_leads_custom_fields_size;
ALTER TABLE leads ADD CONSTRAINT ck_leads_custom_fields_size CHECK (pg_column_size(custom_fields) <= 16384);

-- The version is the ETag clients send back in If-Match: it moves on real edits only. Re-scoring is derived data and
-- must not invalidate somebody's open edit form.
CREATE OR REPLACE FUNCTION app.bump_lead_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at']) THEN
        NEW.version := OLD.version + 1;
    ELSE
        NEW.version := OLD.version;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_leads_version ON leads;
CREATE TRIGGER trg_leads_version BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION app.bump_lead_version();

-- Derived columns follow the stage, whichever path moved the lead.
CREATE OR REPLACE FUNCTION app.sync_lead_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
    IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
        SELECT stage_key, maps_to_status INTO s FROM pipeline_stages WHERE id = NEW.stage_id AND tenant_id = NEW.tenant_id;
        IF FOUND THEN
            NEW.stage_key := s.stage_key;
            NEW.status := s.maps_to_status;
            IF s.maps_to_status IN ('won', 'lost', 'disqualified') THEN
                NEW.closed_at := now();
            ELSE
                NEW.closed_at := NULL;
                NEW.loss_reason := NULL;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_leads_stage_sync ON leads;
CREATE TRIGGER trg_leads_stage_sync BEFORE INSERT OR UPDATE OF stage_id ON leads FOR EACH ROW EXECUTE FUNCTION app.sync_lead_stage();

-- Existing rows: make derived columns agree with their stage once.
UPDATE leads l SET status = ps.maps_to_status, stage_key = COALESCE(ps.stage_key, l.stage_key),
                   closed_at = CASE WHEN ps.maps_to_status IN ('won','lost','disqualified') THEN COALESCE(l.closed_at, l.updated_at) END
  FROM pipeline_stages ps WHERE ps.id = l.stage_id AND ps.tenant_id = l.tenant_id
   AND (l.status IS DISTINCT FROM ps.maps_to_status OR (ps.maps_to_status IN ('won','lost','disqualified') AND l.closed_at IS NULL));

CREATE INDEX IF NOT EXISTS idx_leads_tags            ON leads USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_leads_owner_created   ON leads (tenant_id, owner_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_stage_created   ON leads (tenant_id, stage_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_updated         ON leads (tenant_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_score           ON leads (tenant_id, lead_score DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_followup        ON leads (tenant_id, next_followup_at) WHERE next_followup_at IS NOT NULL AND closed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_sla_open        ON leads (tenant_id, first_response_due_at) WHERE first_response_at IS NULL AND closed_at IS NULL AND deleted_at IS NULL;

-- 3. Saved views --------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_views (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity      text NOT NULL CHECK (entity IN ('lead', 'contact')),
    name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    filters     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(filters) <= 8192),
    sort        text,
    is_shared   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_saved_view_name UNIQUE (tenant_id, owner_id, entity, name)
);
DROP TRIGGER IF EXISTS trg_saved_views_updated_at ON saved_views;
CREATE TRIGGER trg_saved_views_updated_at BEFORE UPDATE ON saved_views FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_saved_views_lookup ON saved_views (tenant_id, entity, is_shared, owner_id);

-- 4. Import jobs (CSV upload → worker) ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('leads')),
    status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    file_name       text,
    file_sha256     text NOT NULL,
    payload_csv     text,                                   -- removed when finished (retention)
    mapping         jsonb NOT NULL DEFAULT '{}'::jsonb,
    options         jsonb NOT NULL DEFAULT '{}'::jsonb,
    total_rows      integer NOT NULL DEFAULT 0,
    processed_rows  integer NOT NULL DEFAULT 0,
    created_count   integer NOT NULL DEFAULT 0,
    matched_count   integer NOT NULL DEFAULT 0,             -- rows that matched an existing contact
    skipped_count   integer NOT NULL DEFAULT 0,
    error_count     integer NOT NULL DEFAULT 0,
    errors          jsonb NOT NULL DEFAULT '[]'::jsonb,     -- first 200 row errors: [{row, field, message}]
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_import_payload_size CHECK (payload_csv IS NULL OR length(payload_csv) <= 6000000)
);
-- Re-uploading the very same file while one is still active is refused; a finished one may be re-run deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_active_file ON import_jobs (tenant_id, kind, file_sha256) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_import_jobs_tenant ON import_jobs (tenant_id, created_at DESC);

-- 5. RLS + grants ---------------------------------------------------------------------------------------------------------
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['saved_views', 'import_jobs'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views, import_jobs TO crm_app_user;
REVOKE DELETE ON import_jobs FROM crm_app_user;
