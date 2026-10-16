-- ==============================================================================
-- 029  Per-client custom lead fields
--
-- Each client (tenant) defines its own fields for its leads. The definition table already existed (migration 008, tenant RLS);
-- values live on the lead (leads.custom_fields jsonb) so they are fast to read, filter and export. This migration tightens the
-- definition table into a real contract:
--   * the key is a safe snake_case identifier and never changes, the label is free text
--   * labels are unique per client among visible fields (no two columns that look the same)
--   * fields are hidden, never deleted (a deleted definition would orphan values already saved on leads)
--   * help text and "show in the lead list" for the screens
-- (validation_regex stays unused on purpose: user-supplied regular expressions run on every save are a denial-of-service risk.)
-- ==============================================================================

ALTER TABLE custom_field_definitions
    ADD COLUMN IF NOT EXISTS help_text    text,
    ADD COLUMN IF NOT EXISTS show_in_list boolean NOT NULL DEFAULT false;

ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS ck_cfd_key;
ALTER TABLE custom_field_definitions ADD CONSTRAINT ck_cfd_key CHECK (field_key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS ck_cfd_text;
ALTER TABLE custom_field_definitions ADD CONSTRAINT ck_cfd_text CHECK (
    char_length(btrim(label)) BETWEEN 1 AND 60
    AND coalesce(char_length(help_text), 0) <= 200
    AND coalesce(char_length(default_value), 0) <= 500
    AND validation_regex IS NULL);
ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS ck_cfd_options;
ALTER TABLE custom_field_definitions ADD CONSTRAINT ck_cfd_options CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 50);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cfd_visible_label ON custom_field_definitions (tenant_id, entity_type, lower(btrim(label))) WHERE is_visible;

-- Definitions are retired (is_visible = false), never deleted by the application roles.
REVOKE DELETE ON custom_field_definitions FROM crm_app_user, crm_worker;
