-- ==============================================================================
-- 026 · Attribution touches, marketing spend and channel mapping (roadmap Slice 5, decisions D5 and D8)
--
-- Additive only. Nothing existing is rewritten.
--   marketing_attribution   (existing, never written until now) becomes the touch log:
--                             first_touch  exactly one per lead, written at creation, IMMUTABLE
--                             later_touch  appended when a person who already has an open lead enquires again
--                           Existing leads get a first_touch reconstructed from their current source and campaign, flagged
--                           backfilled = true, so reports can say how many were reconstructed instead of pretending.
--   marketing_spend         money spent per source (and optionally campaign) for a period, entered by hand or by CSV (D5).
--                           One figure per source, campaign and exact period; overlapping periods are refused by the service.
--   channel_mappings        per-workspace override of which channel a source belongs to (the default table lives in code).
-- ==============================================================================

-- 1. Touches ------------------------------------------------------------------------------------------------------------------
ALTER TABLE marketing_attribution ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE marketing_attribution ADD COLUMN IF NOT EXISTS backfilled boolean NOT NULL DEFAULT false;
UPDATE marketing_attribution SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE marketing_attribution ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE marketing_attribution ALTER COLUMN occurred_at SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE marketing_attribution ADD CONSTRAINT ck_attribution_touch_type CHECK (touch_type IN ('first_touch', 'later_touch'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TABLE marketing_attribution ADD CONSTRAINT ck_attribution_text_len CHECK (
        coalesce(length(campaign), 0) <= 200 AND coalesce(length(source), 0) <= 60 AND coalesce(length(medium), 0) <= 100 AND coalesce(length(ad_group), 0) <= 200
        AND coalesce(length(keyword), 0) <= 200 AND coalesce(length(click_id), 0) <= 300 AND coalesce(length(utm_content), 0) <= 200);
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attribution_first_touch ON marketing_attribution (tenant_id, lead_id) WHERE touch_type = 'first_touch';
CREATE INDEX IF NOT EXISTS idx_attribution_lead_time ON marketing_attribution (tenant_id, lead_id, occurred_at DESC, id DESC);

-- First touch is a fact about the past: nothing may edit it, whatever happens to the lead afterwards.
CREATE OR REPLACE FUNCTION app.guard_first_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.touch_type = 'first_touch' THEN
        RAISE EXCEPTION 'The first touch of a lead cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_attribution_first_touch_guard ON marketing_attribution;
CREATE TRIGGER trg_attribution_first_touch_guard BEFORE UPDATE ON marketing_attribution FOR EACH ROW EXECUTE FUNCTION app.guard_first_touch();

-- Existing leads: reconstruct the first touch from what the lead carries today. Flagged, so it is never mistaken for a measured touch.
INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, campaign, source, medium, ad_group, keyword, click_id, utm_content, is_direct, backfilled, occurred_at)
SELECT l.tenant_id, l.id, 'first_touch', NULLIF(left(btrim(l.campaign), 200), ''), l.source::text,
       left(l.source_details -> 'tracking' ->> 'utm_medium', 100),
       left(COALESCE(l.source_details ->> 'adgroupId', l.source_details ->> 'adsetId'), 200),
       left(l.source_details -> 'tracking' ->> 'utm_term', 200),
       left(COALESCE(l.source_details ->> 'gclid', l.source_details -> 'tracking' ->> 'gclid', l.source_details -> 'tracking' ->> 'fbclid'), 300),
       left(l.source_details -> 'tracking' ->> 'utm_content', 200),
       l.source::text = 'direct', true, l.created_at
  FROM leads l
 WHERE NOT EXISTS (SELECT 1 FROM marketing_attribution a WHERE a.tenant_id = l.tenant_id AND a.lead_id = l.id AND a.touch_type = 'first_touch');

-- 2. Channel mapping ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_mappings (
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source     lead_source NOT NULL,
    channel    text NOT NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source),
    CONSTRAINT ck_channel_mapping_channel CHECK (channel IN ('paid_social', 'paid_search', 'website', 'referral', 'portal', 'offline', 'direct', 'untracked'))
);

-- 3. Marketing spend -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_spend (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source       lead_source NOT NULL,
    campaign     text,
    period_start date NOT NULL,
    period_end   date NOT NULL,
    amount       numeric(14,2) NOT NULL,
    currency     varchar(3) NOT NULL,
    note         text,
    import_batch uuid,
    entered_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    version      integer NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_spend_amount   CHECK (amount >= 0 AND amount < 1e12),
    CONSTRAINT ck_spend_period   CHECK (period_end >= period_start AND period_end - period_start <= 366),
    CONSTRAINT ck_spend_text     CHECK (coalesce(length(campaign), 0) <= 150 AND coalesce(length(note), 0) <= 300 AND (campaign IS NULL OR btrim(campaign) <> ''))
);
DROP TRIGGER IF EXISTS trg_marketing_spend_updated_at ON marketing_spend;
CREATE TRIGGER trg_marketing_spend_updated_at BEFORE UPDATE ON marketing_spend FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- one figure per source, campaign and exact period (a CSV imported twice cannot count twice); campaign names compare case-insensitively
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_spend_key ON marketing_spend (tenant_id, source, lower(coalesce(campaign, '')), period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_marketing_spend_period ON marketing_spend (tenant_id, period_start, period_end);

-- 4. RLS and grants -------------------------------------------------------------------------------------------------------------
ALTER TABLE channel_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_spend  ENABLE ROW LEVEL SECURITY;
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['channel_mappings', 'marketing_spend'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END
$do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_mappings, marketing_spend TO crm_app_user;
-- the touch log is append-only for the application: a touch is added, never edited or removed
REVOKE UPDATE, DELETE ON marketing_attribution FROM crm_app_user;

-- ==============================================================================
-- END OF MIGRATION 026
-- ==============================================================================
