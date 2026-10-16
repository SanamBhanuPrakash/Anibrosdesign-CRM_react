-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 013
-- Domain: Contacts v2 — normalised identifiers (race-safe dedupe), ownership, tags, optimistic concurrency, merge history
--
-- Why a separate identifiers table: "no two live contacts share an e-mail / E.164 phone" must hold under concurrent
-- inserts (two webhooks for the same person arriving in the same millisecond). Only a UNIQUE constraint can promise that;
-- application-level "SELECT then INSERT" cannot. It also gives multiple phones/e-mails per person and makes merge a
-- simple re-parenting of rows.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Contact columns ---------------------------------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company        text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS job_title      text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city           text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_id       uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_by     uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags           text[] NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields  jsonb  NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS version        integer NOT NULL DEFAULT 1;       -- ETag / If-Match
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into_id uuid;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS display_name   text GENERATED ALWAYS AS (btrim(first_name || ' ' || coalesce(last_name, ''))) STORED;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS ck_contacts_tags_len;
ALTER TABLE contacts ADD CONSTRAINT ck_contacts_tags_len CHECK (cardinality(tags) <= 30);
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS ck_contacts_custom_fields_size;
ALTER TABLE contacts ADD CONSTRAINT ck_contacts_custom_fields_size CHECK (pg_column_size(custom_fields) <= 16384);

CREATE INDEX IF NOT EXISTS idx_contacts_owner_live   ON contacts (tenant_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_name_live    ON contacts (tenant_id, display_name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_updated_live ON contacts (tenant_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tags         ON contacts USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm    ON contacts USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_company_trgm ON contacts USING gin (company gin_trgm_ops);

-- keep updated_at honest and bump the version on every real change
CREATE OR REPLACE FUNCTION app.bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.version := OLD.version + 1;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_contacts_version ON contacts;
CREATE TRIGGER trg_contacts_version BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION app.bump_version();

-- 2. Identifiers ---------------------------------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE identifier_kind AS ENUM ('email', 'phone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contact_identifiers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id  uuid NOT NULL,
    kind        identifier_kind NOT NULL,
    value       text NOT NULL,                       -- normalised: lower-case e-mail, E.164 phone
    is_primary  boolean NOT NULL DEFAULT false,
    released_at timestamptz,                         -- set when the contact is archived: frees the value for a new contact
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_identifier_contact_tenant FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT ck_identifier_value CHECK (length(value) BETWEEN 3 AND 254)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identifier_live    ON contact_identifiers (tenant_id, kind, value) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_identifier_primary ON contact_identifiers (contact_id, kind) WHERE is_primary AND released_at IS NULL;
CREATE INDEX        IF NOT EXISTS idx_identifiers_contact    ON contact_identifiers (contact_id);
CREATE INDEX        IF NOT EXISTS idx_identifiers_value_trgm ON contact_identifiers USING gin (value gin_trgm_ops);

-- Backfill from the legacy single columns (best effort: legacy data may contain duplicates or unparsable phones).
INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value, is_primary)
SELECT tenant_id, id, 'email', lower(btrim(email::text)), true
  FROM contacts WHERE deleted_at IS NULL AND email IS NOT NULL AND btrim(email::text) <> '' AND length(btrim(email::text)) >= 3
ON CONFLICT DO NOTHING;

INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value, is_primary)
SELECT tenant_id, id, 'phone', '+' || regexp_replace(phone, '\D', '', 'g'), true
  FROM contacts WHERE deleted_at IS NULL AND phone ~ '^\+\d[\d\s().-]{7,18}$'
ON CONFLICT DO NOTHING;

-- 3. Merge history (reversible for 30 days) ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_merges (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    survivor_id  uuid NOT NULL,
    merged_id    uuid NOT NULL,
    snapshot     jsonb NOT NULL,                     -- what moved, so an undo can put it back
    merged_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    undone_at    timestamptz,
    CONSTRAINT fk_merge_survivor FOREIGN KEY (survivor_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT fk_merge_merged   FOREIGN KEY (merged_id,   tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT ck_merge_distinct CHECK (survivor_id <> merged_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_merges_survivor ON contact_merges (tenant_id, survivor_id, created_at DESC);

-- 4. RLS + grants (same model as every other tenant table) ---------------------------------------------------------------
ALTER TABLE contact_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_merges      ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['contact_identifiers', 'contact_merges'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_identifiers, contact_merges TO crm_app_user;
REVOKE DELETE ON contact_merges FROM crm_app_user;      -- history is kept; undo marks undone_at

-- 5. Consent: tenant-scoped RLS policy existed only via the generic migration; make sure the append/revoke model has indexes
CREATE INDEX IF NOT EXISTS idx_consents_contact_channel ON communication_consents (tenant_id, contact_id, channel, created_at DESC);
