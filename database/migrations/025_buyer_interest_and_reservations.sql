-- ==============================================================================
-- 025 · Buyer interest, offers/reservations and deal value (roadmap Slice 4, decision D3)
--
-- Additive only. Nothing existing is rewritten, deleted or re-labelled.
--   lead_properties   a buyer's shortlist: which properties a lead is considering (manual, from Matching, or from a visit)
--   reservations      one row per buyer-and-property deal attempt, as a small state machine:
--                       offered  → reserved  → completed        (completed = the sale: a recorded deal value)
--                       offered | reserved   → closed           (with a reason; a completed deal can also be reversed → closed)
--                     Booking (reserved) and the sale (completed) are separate milestones (D3).
--   pipelines.deal_value_required   Won needs a recorded deal value tied to a unit. On for the recommended pipeline,
--                                   off for existing pipelines until an admin switches it on (same approach as reason codes).
--
-- "No double reservation" is a database guarantee, not a check in code: a partial unique index allows at most one RESERVED
-- row per property, and at most one open (offered/reserved) row per buyer and property.
-- ==============================================================================

-- 1. Pipelines: is a recorded deal value required to win? --------------------------------------------------------------------
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deal_value_required boolean NOT NULL DEFAULT false;

-- New recommended pipelines (signup, "apply recommended") require it; the seed function itself is not edited (it is part of 023).
CREATE OR REPLACE FUNCTION app.pipeline_deal_value_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.template = 'beginner_v1' THEN
        NEW.deal_value_required := true;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_pipelines_deal_value_default ON pipelines;
CREATE TRIGGER trg_pipelines_deal_value_default BEFORE INSERT ON pipelines FOR EACH ROW EXECUTE FUNCTION app.pipeline_deal_value_default();
-- Recommended pipelines that already exist (created since migration 023) follow the same rule as the ones created from now on.
UPDATE pipelines SET deal_value_required = true WHERE template = 'beginner_v1' AND NOT deal_value_required;

-- 2. Buyer interest / shortlist -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_properties (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id     uuid NOT NULL,
    property_id uuid NOT NULL,
    status      text NOT NULL DEFAULT 'shortlisted',
    source      text NOT NULL DEFAULT 'manual',
    match_score integer,
    note        text,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_lead_property UNIQUE (tenant_id, lead_id, property_id),
    CONSTRAINT fk_lead_property_lead     FOREIGN KEY (lead_id, tenant_id)     REFERENCES leads(id, tenant_id)      ON DELETE CASCADE,
    CONSTRAINT fk_lead_property_property FOREIGN KEY (property_id, tenant_id) REFERENCES properties(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT ck_lead_property_status CHECK (status IN ('shortlisted', 'interested', 'rejected')),
    CONSTRAINT ck_lead_property_source CHECK (source IN ('manual', 'matching', 'viewing', 'offer')),
    CONSTRAINT ck_lead_property_score  CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 100),
    CONSTRAINT ck_lead_property_note   CHECK (note IS NULL OR length(note) <= 500)
);
DROP TRIGGER IF EXISTS trg_lead_properties_updated_at ON lead_properties;
CREATE TRIGGER trg_lead_properties_updated_at BEFORE UPDATE ON lead_properties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_lead_properties_lead     ON lead_properties (tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_properties_property ON lead_properties (tenant_id, property_id);

-- 3. Offers, reservations and completed deals ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id       uuid NOT NULL,
    property_id   uuid NOT NULL,
    status        text NOT NULL DEFAULT 'offered',
    offer_price   numeric(14,2),
    agreed_price  numeric(14,2),
    token_amount  numeric(14,2),
    deal_value    numeric(14,2),
    currency      varchar(3) NOT NULL,
    hold_until    timestamptz,
    note          text,
    closed_reason text,
    closed_note   text,
    offered_at    timestamptz NOT NULL DEFAULT now(),
    reserved_at   timestamptz,
    completed_at  timestamptz,
    closed_at     timestamptz,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    reserved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    completed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    version       integer NOT NULL DEFAULT 1,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_reservation_tenant_composite UNIQUE (id, tenant_id),
    CONSTRAINT fk_reservation_lead     FOREIGN KEY (lead_id, tenant_id)     REFERENCES leads(id, tenant_id),
    CONSTRAINT fk_reservation_property FOREIGN KEY (property_id, tenant_id) REFERENCES properties(id, tenant_id),
    CONSTRAINT ck_reservation_status   CHECK (status IN ('offered', 'reserved', 'completed', 'closed')),
    CONSTRAINT ck_reservation_amounts  CHECK (coalesce(offer_price, 0) >= 0 AND coalesce(agreed_price, 0) >= 0 AND coalesce(token_amount, 0) >= 0 AND coalesce(deal_value, 0) >= 0),
    -- each state carries the facts that make it true
    CONSTRAINT ck_reservation_reserved  CHECK (status <> 'reserved'  OR (reserved_at IS NOT NULL AND agreed_price IS NOT NULL AND token_amount IS NOT NULL)),
    CONSTRAINT ck_reservation_completed CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND deal_value IS NOT NULL AND deal_value > 0)),
    CONSTRAINT ck_reservation_closed    CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (status <> 'closed' OR closed_reason IS NOT NULL)),
    CONSTRAINT ck_reservation_reason    CHECK (closed_reason IS NULL OR closed_reason ~ '^[a-z][a-z0-9_]{1,39}$'),
    CONSTRAINT ck_reservation_text      CHECK (coalesce(length(note), 0) <= 1000 AND coalesce(length(closed_note), 0) <= 500)
);
DROP TRIGGER IF EXISTS trg_reservations_updated_at ON reservations;
CREATE TRIGGER trg_reservations_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- THE guarantee: a unit is held by at most one buyer, and one buyer has at most one open deal attempt per unit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_one_holder    ON reservations (tenant_id, property_id)          WHERE status = 'reserved';
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_one_open_each ON reservations (tenant_id, lead_id, property_id) WHERE status IN ('offered', 'reserved');
CREATE INDEX IF NOT EXISTS idx_reservations_property ON reservations (tenant_id, property_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_lead     ON reservations (tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_status   ON reservations (tenant_id, status, created_at DESC, id DESC);
-- reports: sum of recorded deal value by completion date
CREATE INDEX IF NOT EXISTS idx_reservations_completed ON reservations (tenant_id, completed_at) WHERE status = 'completed';

-- 4. RLS and grants (tables created with default privileges: say exactly what each role may do) ------------------------------
ALTER TABLE lead_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations    ENABLE ROW LEVEL SECURITY;
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['lead_properties', 'reservations'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END
$do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_properties TO crm_app_user;
GRANT SELECT, INSERT, UPDATE         ON reservations    TO crm_app_user;
REVOKE DELETE ON reservations FROM crm_app_user;   -- a deal attempt is closed, never deleted: the record of who held a unit and when stays

-- ==============================================================================
-- END OF MIGRATION 025
-- ==============================================================================
