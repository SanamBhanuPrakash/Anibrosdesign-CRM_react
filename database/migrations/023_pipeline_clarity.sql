-- ==============================================================================
-- 023 · Pipeline clarity (roadmap Slice 2; decisions D4 and D7)
--
--  1. History that does not change when a stage is renamed or re-weighted: every stage-history row carries a SNAPSHOT of the
--     stage name, meaning and probability as they were at that moment (filled by a trigger, so no code path can forget).
--     Existing rows are back-filled from the current values and FLAGGED, because for them "as it was then" is unknowable.
--  2. Reason codes for Lost and Not a fit (D4): a code on the lead and on the history row, and a per-pipeline switch that
--     makes the code mandatory. Existing pipelines keep today's rule (a written reason); nothing is rewritten.
--  3. The recommended beginner pipeline (D7) as a SQL seed, used for NEW workspaces. Existing pipelines are never touched;
--     existing workspaces get it only through an explicit, audited action that adds a second pipeline.
--  4. Fix for a dead end in the original seeded rules: "Nurture" had no way out. Only exits are ADDED, only where the
--     pipeline restricts moves and Nurture has none.
-- Additive; nothing applied before is edited.
-- ==============================================================================

-- 1. history snapshots -----------------------------------------------------------------------------------------------
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS from_stage_name     text;
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS to_stage_name       text;
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS to_status           lead_status;
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS to_probability      smallint;
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS reason_code         text;
ALTER TABLE lead_stage_history ADD COLUMN IF NOT EXISTS snapshot_backfilled boolean NOT NULL DEFAULT false;

-- Back-fill existing rows with the CURRENT values and say so: these are best-effort, not point-in-time.
UPDATE lead_stage_history h
   SET to_stage_name = s.name, to_status = s.maps_to_status, to_probability = s.probability, snapshot_backfilled = true
  FROM pipeline_stages s
 WHERE s.id = h.to_stage_id AND s.tenant_id = h.tenant_id AND h.to_stage_name IS NULL;
UPDATE lead_stage_history h
   SET from_stage_name = s.name
  FROM pipeline_stages s
 WHERE h.from_stage_id IS NOT NULL AND s.id = h.from_stage_id AND s.tenant_id = h.tenant_id AND h.from_stage_name IS NULL;

CREATE OR REPLACE FUNCTION app.snapshot_stage_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, app, pg_temp AS $$
DECLARE s record;
BEGIN
    IF NEW.to_stage_name IS NULL THEN
        SELECT name, maps_to_status, probability INTO s FROM pipeline_stages WHERE id = NEW.to_stage_id AND tenant_id = NEW.tenant_id;
        IF FOUND THEN
            NEW.to_stage_name := s.name;
            NEW.to_status := s.maps_to_status;
            NEW.to_probability := s.probability;
        END IF;
    END IF;
    IF NEW.from_stage_id IS NOT NULL AND NEW.from_stage_name IS NULL THEN
        SELECT name INTO s FROM pipeline_stages WHERE id = NEW.from_stage_id AND tenant_id = NEW.tenant_id;
        IF FOUND THEN NEW.from_stage_name := s.name; END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stage_history_snapshot ON lead_stage_history;
CREATE TRIGGER trg_stage_history_snapshot BEFORE INSERT ON lead_stage_history FOR EACH ROW EXECUTE FUNCTION app.snapshot_stage_history();

-- 2. reason codes ----------------------------------------------------------------------------------------------------
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS loss_reason_code text;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS reason_codes_required boolean NOT NULL DEFAULT false;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS template text;
DO $$ BEGIN
    ALTER TABLE leads ADD CONSTRAINT ck_leads_reason_code CHECK (loss_reason_code IS NULL OR loss_reason_code ~ '^[a-z][a-z0-9_]{1,39}$');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TABLE lead_stage_history ADD CONSTRAINT ck_history_reason_code CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{1,39}$');
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_template ON pipelines (tenant_id, template) WHERE template IS NOT NULL AND archived_at IS NULL;

-- Reopening a lead clears its outcome, including the code (same rule the trigger already applied to the written reason).
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
                NEW.loss_reason_code := NULL;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- 3. the recommended beginner pipeline ------------------------------------------------------------------------------------
-- Used for NEW workspaces. Any open stage may move to any other stage and to Lost / Not a fit; only Won needs "Booked" first.
-- "Follow up later" demands a follow-up date. Lost and Not a fit require a reason code.
CREATE OR REPLACE FUNCTION app.seed_beginner_pipeline_unsafe(p_tenant_id uuid, p_name text DEFAULT 'Sales pipeline', p_make_default boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, app, pg_temp AS $$
DECLARE
    v_pipeline uuid;
BEGIN
    SELECT id INTO v_pipeline FROM pipelines WHERE tenant_id = p_tenant_id AND template = 'beginner_v1' AND archived_at IS NULL;
    IF v_pipeline IS NOT NULL THEN RETURN v_pipeline; END IF;

    IF p_make_default THEN
        UPDATE pipelines SET is_default = false WHERE tenant_id = p_tenant_id AND is_default AND archived_at IS NULL;
    END IF;
    INSERT INTO pipelines (tenant_id, name, description, is_default, template, reason_codes_required)
    VALUES (p_tenant_id, p_name, 'The recommended sales process for a real-estate team. Any stage can follow any other; a lead only becomes Won after Booked.',
            p_make_default, 'beginner_v1', true)
    RETURNING id INTO v_pipeline;

    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color, maps_to_status, probability)
    SELECT p_tenant_id, v_pipeline, d.name, d.key, d.ord, d.color, d.status::lead_status, d.prob
      FROM (VALUES
        ('new',               'New enquiry',       0, '#6F86A3', 'open',              5),
        ('contact_attempted', 'Trying to reach',   1, '#8A7F5C', 'open',              8),
        ('contacted',         'In conversation',   2, '#7C8C8A', 'contacted',        15),
        ('qualified',         'Qualified',         3, '#6B8F71', 'qualified',        30),
        ('viewing_scheduled', 'Site visit booked', 4, '#8F7A9B', 'viewing_scheduled',45),
        ('viewing_completed', 'Site visit done',   5, '#7A8FA6', 'viewing_scheduled',55),
        ('negotiation',       'Negotiating',       6, '#9A7B6B', 'negotiation',      70),
        ('booking_reserved',  'Booked',            7, '#B08D57', 'negotiation',      90),
        ('follow_up_later',   'Follow up later',   8, '#A3A3A3', 'open',             10),
        ('won',               'Won',               9, '#2E7D4F', 'won',             100),
        ('lost',              'Lost',             10, '#B3382C', 'lost',              0),
        ('not_a_fit',         'Not a fit',        11, '#6B6B66', 'disqualified',      0)
      ) AS d(key, name, ord, color, status, prob);

    -- free movement between open stages and into the two outcomes; Won only from Booked; Follow up later needs a date
    INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed, required_fields)
    SELECT p_tenant_id, v_pipeline, f.id, t.id, f.stage_key, t.stage_key, true,
           CASE WHEN t.stage_key = 'follow_up_later' THEN ARRAY['nextFollowupAt']::text[] ELSE '{}'::text[] END
      FROM pipeline_stages f JOIN pipeline_stages t ON t.pipeline_id = f.pipeline_id AND t.tenant_id = f.tenant_id AND t.id <> f.id
     WHERE f.pipeline_id = v_pipeline AND f.tenant_id = p_tenant_id
       AND f.maps_to_status NOT IN ('won', 'lost', 'disqualified')
       AND t.stage_key <> 'won';
    INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed)
    SELECT p_tenant_id, v_pipeline, f.id, t.id, f.stage_key, t.stage_key, true
      FROM pipeline_stages f JOIN pipeline_stages t ON t.pipeline_id = f.pipeline_id AND t.tenant_id = f.tenant_id
     WHERE f.pipeline_id = v_pipeline AND f.tenant_id = p_tenant_id AND f.stage_key = 'booking_reserved' AND t.stage_key = 'won';
    RETURN v_pipeline;
END $$;
REVOKE ALL ON FUNCTION app.seed_beginner_pipeline_unsafe(uuid, text, boolean) FROM PUBLIC, crm_app_user, crm_worker;

CREATE OR REPLACE FUNCTION app.seed_beginner_pipeline(p_tenant_id uuid, p_name text DEFAULT 'Sales pipeline', p_make_default boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
BEGIN
    IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'FORBIDDEN: tenant context mismatch';
    END IF;
    RETURN app.seed_beginner_pipeline_unsafe(p_tenant_id, p_name, p_make_default);
END $$;
REVOKE ALL ON FUNCTION app.seed_beginner_pipeline(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seed_beginner_pipeline(uuid, text, boolean) TO crm_app_user, crm_worker;

-- 4. "Nurture" is no longer a dead end (additive: exits only, only where it has none) ---------------------------------------
INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed)
SELECT n.tenant_id, n.pipeline_id, n.id, s.id, n.stage_key, s.stage_key, true
  FROM pipeline_stages n
  JOIN pipeline_stages s ON s.pipeline_id = n.pipeline_id AND s.tenant_id = n.tenant_id AND s.id <> n.id AND s.archived_at IS NULL AND s.maps_to_status <> 'won'
 WHERE n.stage_key = 'nurture' AND n.archived_at IS NULL
   AND EXISTS     (SELECT 1 FROM pipeline_stage_transitions t WHERE t.pipeline_id = n.pipeline_id AND t.is_allowed)
   AND NOT EXISTS (SELECT 1 FROM pipeline_stage_transitions t WHERE t.from_stage_id = n.id AND t.is_allowed)
ON CONFLICT (pipeline_id, from_stage_key, to_stage_key) DO NOTHING;

-- ==============================================================================
-- END OF MIGRATION 023
-- ==============================================================================
