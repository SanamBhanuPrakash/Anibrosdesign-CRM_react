-- ==============================================================================
-- 031  Outbound webhooks: the CRM tells another system when something happens
--
-- Inbound lead capture (018) is "their system -> the CRM". This is the other direction: a client (or the agency) gives a URL, picks the
-- events it cares about (new lead, lead moved, lead assigned, activity logged, task done) and the CRM POSTs a signed JSON message to it.
--
--   outbound_endpoints   one row per receiving URL, per client workspace (RLS by tenant). The signing secret is stored encrypted.
--   outbound_deliveries  one row per (endpoint, event): the log the client sees, and the idempotency guard (UNIQUE endpoint+event) so
--                        an event replayed by the dispatcher can never be delivered twice.
-- Delivery itself is a background job with retries and back-off; an endpoint that keeps failing is switched off, never retried forever.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS outbound_endpoints (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    url                  text NOT NULL CHECK (char_length(url) BETWEEN 8 AND 2000),
    secret_enc           text NOT NULL,
    secret_hint          text,
    events               text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
    status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
    disabled_reason      text,
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_delivery_at     timestamptz,
    last_status          integer,
    last_error           text,
    created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz,
    CONSTRAINT uq_outbound_endpoint_tenant UNIQUE (id, tenant_id)
);
DROP TRIGGER IF EXISTS trg_outbound_endpoints_updated_at ON outbound_endpoints;
CREATE TRIGGER trg_outbound_endpoints_updated_at BEFORE UPDATE ON outbound_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_outbound_endpoints_tenant ON outbound_endpoints (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_endpoints_active ON outbound_endpoints (tenant_id) WHERE deleted_at IS NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS outbound_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id     uuid NOT NULL,
    event_id        bigint,
    event_type      text NOT NULL,
    is_test         boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead', 'skipped')),
    attempts        integer NOT NULL DEFAULT 0,
    response_status integer,
    response_ms     integer,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    CONSTRAINT fk_outbound_delivery_endpoint FOREIGN KEY (endpoint_id, tenant_id) REFERENCES outbound_endpoints(id, tenant_id) ON DELETE CASCADE
);
-- One delivery per endpoint per event (tests have no event id and are exempt).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_delivery_event ON outbound_deliveries (endpoint_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_list ON outbound_deliveries (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_endpoint ON outbound_deliveries (endpoint_id, created_at DESC);

ALTER TABLE outbound_endpoints  ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_deliveries ENABLE ROW LEVEL SECURITY;
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['outbound_endpoints', 'outbound_deliveries'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END
$do$;
-- Endpoints are soft-deleted; the delivery log is only ever purged by the worker's retention job.
REVOKE ALL ON outbound_endpoints, outbound_deliveries FROM crm_app_user;
GRANT SELECT, INSERT, UPDATE ON outbound_endpoints, outbound_deliveries TO crm_app_user;
GRANT DELETE ON outbound_deliveries TO crm_worker;
-- Retention runs without a workspace context, so row-level security would hide every row from it: allow it to delete, and only delete.
DROP POLICY IF EXISTS worker_purge_outbound_deliveries ON outbound_deliveries;
CREATE POLICY worker_purge_outbound_deliveries ON outbound_deliveries FOR DELETE TO crm_worker USING (true);
-- Same gap in 018: its retention job had the grant but no policy that applies without a workspace, so it removed nothing.
DROP POLICY IF EXISTS worker_purge_inbound_events ON inbound_events;
CREATE POLICY worker_purge_inbound_events ON inbound_events FOR DELETE TO crm_worker USING (true);

-- The event dispatcher runs without a workspace context, so it cannot read the tables above. This one-bit function answers "does this
-- workspace have an active outgoing webhook at all?" so events of workspaces with none cost nothing. It reveals no row content.
CREATE OR REPLACE FUNCTION app.tenant_has_outbound(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
    SELECT EXISTS (SELECT 1 FROM outbound_endpoints WHERE tenant_id = p_tenant AND deleted_at IS NULL AND status = 'active');
$fn$;
REVOKE ALL ON FUNCTION app.tenant_has_outbound(uuid) FROM PUBLIC, crm_app_user;
GRANT EXECUTE ON FUNCTION app.tenant_has_outbound(uuid) TO crm_worker;

-- ==============================================================================
-- END OF MIGRATION 031
-- ==============================================================================
