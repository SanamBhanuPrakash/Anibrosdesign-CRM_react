-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 017
-- Domain: Inventory v2 — projects, properties (the sellable/rentable unit), availability history, price history, files
--
-- Modelling decision: a "unit" IS a property. A project (development / building) groups properties; a property carries
-- tower / floor / unit number. One table for everything you can sell or rent keeps search, matching and viewings simple and
-- avoids a second, nearly identical entity.
-- History is written by TRIGGERS, not by application code: availability and price changes are audit data, so no code path
-- (API, import, script, SQL function) is allowed to skip them.
-- ==============================================================================

-- 1. Projects ------------------------------------------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS developer        text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS city             text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS locality         text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS address          text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rera_id          text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS possession_date  date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS amenities        text[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by       uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version          integer NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;
UPDATE projects SET status = 'active' WHERE status NOT IN ('upcoming', 'active', 'on_hold', 'completed');   -- legacy free-text values
ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_project_status;
ALTER TABLE projects ADD CONSTRAINT ck_project_status CHECK (status IN ('upcoming', 'active', 'on_hold', 'completed'));
ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_project_name_len;
ALTER TABLE projects ADD CONSTRAINT ck_project_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 150);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_name_live ON projects (tenant_id, lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_list ON projects (tenant_id, lower(name), id) WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_projects_version ON projects;
CREATE TRIGGER trg_projects_version BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION app.bump_version();

-- 2. Properties ----------------------------------------------------------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS unit_number        text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tower              text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS floor              integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS facing             text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS furnishing         text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS carpet_area_sqft   numeric(10,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address            text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS city               text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS locality           text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS possession_date    date;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rera_id            text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS amenities          text[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tags               text[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_id           uuid REFERENCES users(id) ON DELETE SET NULL;   -- listing agent
ALTER TABLE properties ADD COLUMN IF NOT EXISTS created_by         uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS negotiable         boolean NOT NULL DEFAULT true;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS status_changed_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE properties ADD COLUMN IF NOT EXISTS cover_file_id      uuid;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS version            integer NOT NULL DEFAULT 1;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deleted_at         timestamptz;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS price_per_sqft     numeric(12,2) GENERATED ALWAYS AS (CASE WHEN area_sqft > 0 THEN round(price / area_sqft, 2) END) STORED;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS ck_property_numbers;
ALTER TABLE properties ADD CONSTRAINT ck_property_numbers CHECK (price >= 0 AND COALESCE(bedrooms, 0) BETWEEN 0 AND 50 AND COALESCE(bathrooms, 0) BETWEEN 0 AND 50 AND COALESCE(area_sqft, 0) >= 0 AND COALESCE(carpet_area_sqft, 0) >= 0);
ALTER TABLE properties DROP CONSTRAINT IF EXISTS ck_property_furnishing;
ALTER TABLE properties ADD CONSTRAINT ck_property_furnishing CHECK (furnishing IS NULL OR furnishing IN ('unfurnished', 'semi_furnished', 'furnished'));
ALTER TABLE properties DROP CONSTRAINT IF EXISTS ck_property_title_len;
ALTER TABLE properties ADD CONSTRAINT ck_property_title_len CHECK (length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE properties DROP CONSTRAINT IF EXISTS ck_property_arrays;
ALTER TABLE properties ADD CONSTRAINT ck_property_arrays CHECK (cardinality(amenities) <= 60 AND cardinality(tags) <= 30);
-- a project cannot list the same unit twice (tower may be empty)
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_unit_live ON properties (tenant_id, project_id, COALESCE(tower, ''), lower(unit_number)) WHERE project_id IS NOT NULL AND unit_number IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_project   ON properties (tenant_id, project_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_list_new  ON properties (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_list_price ON properties (tenant_id, price, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_match     ON properties (tenant_id, status, listing_type, property_type, price) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_tags      ON properties USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_properties_title_trgm ON properties USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_properties_locality_trgm ON properties USING gin (locality gin_trgm_ops);
DROP TRIGGER IF EXISTS trg_properties_version ON properties;
CREATE TRIGGER trg_properties_version BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION app.bump_version();

-- 3. History (trigger-written) -------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_status_history (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    from_status property_status_enum,
    to_status   property_status_enum NOT NULL,
    reason      text,
    changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_psh_property FOREIGN KEY (property_id, tenant_id) REFERENCES properties(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_psh_property ON property_status_history (property_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS property_price_history (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    property_id uuid NOT NULL,
    price       numeric(14,2) NOT NULL,
    currency    varchar(3) NOT NULL,
    changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_pph_property FOREIGN KEY (property_id, tenant_id) REFERENCES properties(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pph_property ON property_price_history (property_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION app.record_property_history() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO property_status_history (tenant_id, property_id, from_status, to_status, reason, changed_by)
        VALUES (NEW.tenant_id, NEW.id, NULL, NEW.status, 'Listed', app.current_user_id());
        INSERT INTO property_price_history (tenant_id, property_id, price, currency, changed_by)
        VALUES (NEW.tenant_id, NEW.id, NEW.price, NEW.currency, app.current_user_id());
        RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.status_changed_at := now();
        INSERT INTO property_status_history (tenant_id, property_id, from_status, to_status, reason, changed_by)
        VALUES (NEW.tenant_id, NEW.id, OLD.status, NEW.status, NULLIF(current_setting('app.status_reason', true), ''), app.current_user_id());
    END IF;
    IF NEW.price IS DISTINCT FROM OLD.price OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        INSERT INTO property_price_history (tenant_id, property_id, price, currency, changed_by)
        VALUES (NEW.tenant_id, NEW.id, NEW.price, NEW.currency, app.current_user_id());
    END IF;
    RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS trg_properties_history_ins ON properties;
CREATE TRIGGER trg_properties_history_ins AFTER INSERT ON properties FOR EACH ROW EXECUTE FUNCTION app.record_property_history();
DROP TRIGGER IF EXISTS trg_properties_history_upd ON properties;
CREATE TRIGGER trg_properties_history_upd BEFORE UPDATE OF status, price, currency ON properties FOR EACH ROW EXECUTE FUNCTION app.record_property_history();

-- Existing rows get their opening history entries once.
INSERT INTO property_status_history (tenant_id, property_id, from_status, to_status, reason, created_at)
SELECT p.tenant_id, p.id, NULL, p.status, 'Listed', p.created_at FROM properties p
 WHERE NOT EXISTS (SELECT 1 FROM property_status_history h WHERE h.property_id = p.id);
INSERT INTO property_price_history (tenant_id, property_id, price, currency, created_at)
SELECT p.tenant_id, p.id, p.price, p.currency, p.created_at FROM properties p
 WHERE NOT EXISTS (SELECT 1 FROM property_price_history h WHERE h.property_id = p.id);

-- 4. Files (blob metadata; bytes live behind the storage adapter) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type  text NOT NULL CHECK (entity_type IN ('property', 'project')),
    entity_id    uuid NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('image', 'document')),
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    mime         text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_key  text NOT NULL UNIQUE,
    sort_order   integer NOT NULL DEFAULT 0,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_files_entity ON files (tenant_id, entity_type, entity_id, sort_order, created_at) WHERE deleted_at IS NULL;
-- the same bytes are stored once per entity
CREATE UNIQUE INDEX IF NOT EXISTS uq_files_entity_content ON files (tenant_id, entity_type, entity_id, sha256) WHERE deleted_at IS NULL;

-- 5. RLS + grants -----------------------------------------------------------------------------------------------------------
ALTER TABLE property_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_price_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE files                   ENABLE ROW LEVEL SECURITY;
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['property_status_history', 'property_price_history', 'files'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END
$do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON property_status_history, property_price_history, files TO crm_app_user;
REVOKE UPDATE, DELETE ON property_status_history, property_price_history FROM crm_app_user;   -- history is append-only
REVOKE DELETE ON files FROM crm_app_user;                                                     -- soft delete; blobs are purged by retention

-- 6. Reminder text in the workspace's own time zone (replaces the UTC wording from 015) ---------------------------------------
CREATE OR REPLACE FUNCTION app.dispatch_task_notifications(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
    r record;
    v_id uuid;
    v_total integer := 0;
BEGIN
    FOR r IN
        SELECT t.id, t.tenant_id, t.assigned_to, t.title, t.due_date, t.remind_at, t.lead_id, COALESCE(tn.timezone, 'UTC') AS tz
          FROM tasks t JOIN tenants tn ON tn.id = t.tenant_id
         WHERE t.remind_at <= now() AND t.reminder_sent_at IS NULL AND t.deleted_at IS NULL
           AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL
         ORDER BY t.remind_at
         LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
    LOOP
        v_id := NULL;
        UPDATE tasks SET reminder_sent_at = now() WHERE id = r.id;
        INSERT INTO notifications (tenant_id, user_id, title, message, type, entity_type, entity_id, link, dedupe_key)
        VALUES (r.tenant_id, r.assigned_to, 'Task reminder',
                r.title || CASE WHEN r.due_date IS NOT NULL THEN ' · due ' || to_char(r.due_date AT TIME ZONE r.tz, 'DD Mon, HH12:MI AM') ELSE '' END,
                'task_reminder', 'task', r.id, CASE WHEN r.lead_id IS NOT NULL THEN '/leads/' || r.lead_id ELSE '/tasks' END,
                'task-reminder:' || r.id || ':' || floor(extract(epoch FROM r.remind_at))::bigint)
        ON CONFLICT DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
            INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id) VALUES (r.tenant_id, 'notification.created', 'notification', v_id);
        END IF;
        v_total := v_total + 1;
    END LOOP;

    FOR r IN
        SELECT t.id, t.tenant_id, t.assigned_to, t.title, t.due_date, t.lead_id
          FROM tasks t
         WHERE t.due_date < now() AND t.overdue_notified_at IS NULL AND t.deleted_at IS NULL
           AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL
         ORDER BY t.due_date
         LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
    LOOP
        v_id := NULL;
        UPDATE tasks SET overdue_notified_at = now() WHERE id = r.id;
        INSERT INTO notifications (tenant_id, user_id, title, message, type, entity_type, entity_id, link, dedupe_key)
        VALUES (r.tenant_id, r.assigned_to, 'Task overdue', r.title, 'task_overdue', 'task', r.id,
                CASE WHEN r.lead_id IS NOT NULL THEN '/leads/' || r.lead_id ELSE '/tasks' END,
                'task-overdue:' || r.id || ':' || floor(extract(epoch FROM r.due_date))::bigint)
        ON CONFLICT DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
            INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id) VALUES (r.tenant_id, 'notification.created', 'notification', v_id);
        END IF;
        v_total := v_total + 1;
    END LOOP;

    RETURN v_total;
END
$fn$;
REVOKE ALL ON FUNCTION app.dispatch_task_notifications(integer) FROM PUBLIC, crm_app_user;
GRANT EXECUTE ON FUNCTION app.dispatch_task_notifications(integer) TO crm_worker;
