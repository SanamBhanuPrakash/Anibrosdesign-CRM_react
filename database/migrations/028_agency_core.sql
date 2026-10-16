-- ==============================================================================
-- 028  Agency core: one agency (organisation), many isolated clients (tenants), shared employees
--
--   tenants.kind        'agency_hq' (the agency's own workspace + staff directory) | 'client'
--   tenants.industry    drives wording/modules per client (real_estate keeps the property modules)
--   tenants.archived_at archiving a client is reversible; it also sets is_active = false
--   activities          calls/WhatsApp/SMS get real columns (direction, outcome, duration) instead of JSON only
--
-- Design: docs/AGENCY_DESIGN.md. No policy is changed: client isolation is the existing tenant RLS.
-- ==============================================================================

-- 1. Clients ------------------------------------------------------------------------------------------------------------------
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'client',
    ADD COLUMN IF NOT EXISTS industry      text,
    ADD COLUMN IF NOT EXISTS website       text,
    ADD COLUMN IF NOT EXISTS contact_name  text,
    ADD COLUMN IF NOT EXISTS contact_email text,
    ADD COLUMN IF NOT EXISTS contact_phone text,
    ADD COLUMN IF NOT EXISTS notes         text,
    ADD COLUMN IF NOT EXISTS archived_at   timestamptz;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ck_tenants_kind;
ALTER TABLE tenants ADD CONSTRAINT ck_tenants_kind CHECK (kind IN ('agency_hq', 'client'));
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ck_tenants_industry;
ALTER TABLE tenants ADD CONSTRAINT ck_tenants_industry CHECK (industry IS NULL OR industry IN
    ('real_estate', 'healthcare', 'restaurant', 'finance', 'retail', 'education', 'beauty_wellness', 'automotive', 'travel', 'professional_services', 'other'));
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ck_tenants_text_lengths;
ALTER TABLE tenants ADD CONSTRAINT ck_tenants_text_lengths CHECK (
    coalesce(length(website), 0) <= 300 AND coalesce(length(contact_name), 0) <= 150 AND coalesce(length(contact_email), 0) <= 254
    AND coalesce(length(contact_phone), 0) <= 40 AND coalesce(length(notes), 0) <= 4000);

-- Workspaces that existed before this migration were real-estate workspaces; the oldest one of each organisation is its HQ.
UPDATE tenants SET industry = 'real_estate' WHERE industry IS NULL;
UPDATE tenants t SET kind = 'agency_hq'
 WHERE t.id = (SELECT x.id FROM tenants x WHERE x.organisation_id = t.organisation_id ORDER BY x.created_at, x.id LIMIT 1);

-- Exactly one HQ per organisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_one_hq ON tenants (organisation_id) WHERE kind = 'agency_hq';
CREATE INDEX IF NOT EXISTS idx_tenants_org_kind ON tenants (organisation_id, kind) WHERE archived_at IS NULL;

-- 2. Activities: what an employee did on a lead --------------------------------------------------------------------------------
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'whatsapp';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'sms';

ALTER TABLE activities
    ADD COLUMN IF NOT EXISTS direction        text,
    ADD COLUMN IF NOT EXISTS outcome          text,
    ADD COLUMN IF NOT EXISTS duration_minutes integer;

ALTER TABLE activities DROP CONSTRAINT IF EXISTS ck_activities_direction;
ALTER TABLE activities ADD CONSTRAINT ck_activities_direction CHECK (direction IS NULL OR direction IN ('outbound', 'inbound'));
ALTER TABLE activities DROP CONSTRAINT IF EXISTS ck_activities_outcome;
ALTER TABLE activities ADD CONSTRAINT ck_activities_outcome CHECK (outcome IS NULL OR length(outcome) <= 100);
ALTER TABLE activities DROP CONSTRAINT IF EXISTS ck_activities_duration;
ALTER TABLE activities ADD CONSTRAINT ck_activities_duration CHECK (duration_minutes IS NULL OR (duration_minutes >= 0 AND duration_minutes <= 1440));

-- Activities logged before this migration kept outcome/duration in metadata.
UPDATE activities
   SET outcome = left(metadata ->> 'outcome', 100)
 WHERE outcome IS NULL AND coalesce(metadata ->> 'outcome', '') <> '';
UPDATE activities
   SET duration_minutes = (metadata ->> 'durationMinutes')::integer
 WHERE duration_minutes IS NULL AND (metadata ->> 'durationMinutes') ~ '^[0-9]{1,4}$' AND (metadata ->> 'durationMinutes')::integer <= 1440;

-- "Calls made per employee per client per day" and the export's activity sheet.
CREATE INDEX IF NOT EXISTS idx_activities_tenant_user ON activities (tenant_id, user_id, created_at DESC);
