-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 018
-- Domain: Lead sources — per-tenant inbound endpoints (Meta Lead Ads, Google Ads lead forms, website forms, generic JSON)
--
-- Design:
--   * One endpoint row per source. The public URL is /hooks/<endpoint id>; the id only locates the endpoint, authenticity comes
--     from the provider signature / key (verified by the API before anything is stored).
--   * The tenant is decided by the endpoint row and nothing else (never from the payload).
--   * Receipt is durable first: app.inbound_receive() stores the events and enqueues the processing jobs in ONE statement
--     sequence, then the HTTP handler answers 200. Processing is asynchronous, idempotent and retried by the worker.
--   * Secrets (Meta app secret, Meta page access token, Google key, generic signing secret) are AES-256-GCM encrypted
--     with the endpoint id as AAD; only a 4-character hint is kept in the clear.
--   * The API role has no direct access to other tenants' endpoints. The pre-tenant lookup and the receipt go through two
--     narrow SECURITY DEFINER functions that are only reachable with the (unguessable) endpoint id.
-- ==============================================================================

-- 1. Endpoints ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_endpoints (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider         text NOT NULL CHECK (provider IN ('meta', 'google', 'website', 'generic')),
    name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    secret_enc       text,                      -- Meta app secret / Google key / generic signing secret (NULL for website forms)
    secret_hint      text,                      -- last 4 characters, for display only
    verify_token     text,                      -- Meta GET handshake (random, not a credential for anything else)
    access_token_enc text,                      -- Meta page access token used to fetch the lead by id (optional)
    config           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(config) < 16384),
    last_received_at timestamptz,
    received_count   bigint NOT NULL DEFAULT 0,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz
);
DROP TRIGGER IF EXISTS trg_inbound_endpoints_updated_at ON inbound_endpoints;
CREATE TRIGGER trg_inbound_endpoints_updated_at BEFORE UPDATE ON inbound_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_inbound_endpoints_tenant ON inbound_endpoints (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- 2. Received events (durable receipt + processing outcome) -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id       uuid NOT NULL REFERENCES inbound_endpoints(id) ON DELETE CASCADE,
    provider          text NOT NULL,
    provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
    status            text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'created', 'duplicate', 'needs_review', 'ignored', 'failed')),
    is_test           boolean NOT NULL DEFAULT false,
    payload           jsonb NOT NULL CHECK (pg_column_size(payload) < 131072),
    lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
    attempts          integer NOT NULL DEFAULT 0,
    reason            text,                      -- plain-language explanation for duplicate / needs_review / failed
    received_at       timestamptz NOT NULL DEFAULT now(),
    processed_at      timestamptz,
    CONSTRAINT uq_inbound_event UNIQUE (endpoint_id, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_events_list   ON inbound_events (tenant_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_events_status ON inbound_events (tenant_id, status, received_at DESC) WHERE status <> 'created';
CREATE INDEX IF NOT EXISTS idx_inbound_events_endpoint ON inbound_events (endpoint_id, received_at DESC);

-- 3. Where a lead came from (campaign / ad / form ids, click ids, the form answers that have no column of their own) --------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS ck_lead_source_details_size;
ALTER TABLE leads ADD CONSTRAINT ck_lead_source_details_size CHECK (pg_column_size(source_details) < 16384);

-- 4. RLS + grants ------------------------------------------------------------------------------------------------------------
ALTER TABLE inbound_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events    ENABLE ROW LEVEL SECURITY;
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['inbound_endpoints', 'inbound_events'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END
$do$;
-- Default privileges hand every new table full DML to crm_app_user; narrow it: endpoints are soft-deleted, deliveries are only
-- ever purged by the worker's retention job (crm_worker inherits crm_app_user, so its DELETE is granted explicitly).
REVOKE ALL ON inbound_endpoints, inbound_events FROM crm_app_user;
GRANT SELECT, INSERT, UPDATE ON inbound_endpoints, inbound_events TO crm_app_user;
GRANT DELETE ON inbound_events TO crm_worker;

-- 5. Pre-tenant functions (the only way the public receiver touches these tables) --------------------------------------------
-- Looks an endpoint up by its id. Returns nothing for deleted endpoints and for suspended workspaces.
CREATE OR REPLACE FUNCTION app.inbound_endpoint_lookup(p_id uuid)
RETURNS TABLE (id uuid, tenant_id uuid, provider text, status text, secret_enc text, verify_token text, config jsonb)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT e.id, e.tenant_id, e.provider, e.status, e.secret_enc, e.verify_token, e.config
      FROM inbound_endpoints e JOIN tenants t ON t.id = e.tenant_id
     WHERE e.id = p_id AND e.deleted_at IS NULL AND t.is_active
$$;

-- Durable receipt. p_events = [{ "eventId": text, "payload": object, "isTest": boolean }]. Returns how many were NEW
-- (a redelivery of an event id that is already stored is a silent no-op). Each new event gets its processing job in the same
-- transaction, so "stored" and "will be processed" can never disagree.
CREATE OR REPLACE FUNCTION app.inbound_receive(p_endpoint_id uuid, p_events jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
DECLARE
    v_ep    inbound_endpoints%ROWTYPE;
    v_item  jsonb;
    v_id    uuid;
    v_new   integer := 0;
BEGIN
    IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 100 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: events';
    END IF;
    SELECT e.* INTO v_ep FROM inbound_endpoints e JOIN tenants t ON t.id = e.tenant_id
     WHERE e.id = p_endpoint_id AND e.deleted_at IS NULL AND e.status = 'active' AND t.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: endpoint'; END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_events) LOOP
        INSERT INTO inbound_events (tenant_id, endpoint_id, provider, provider_event_id, payload, is_test)
        VALUES (v_ep.tenant_id, v_ep.id, v_ep.provider, left(v_item->>'eventId', 200), v_item->'payload', COALESCE((v_item->>'isTest')::boolean, false))
        ON CONFLICT (endpoint_id, provider_event_id) DO NOTHING
        RETURNING inbound_events.id INTO v_id;
        IF v_id IS NOT NULL THEN
            v_new := v_new + 1;
            INSERT INTO jobs (tenant_id, type, payload, dedupe_key, max_attempts, priority)
            VALUES (v_ep.tenant_id, 'inbound.process', jsonb_build_object('eventId', v_id), 'inbound:' || v_id, 6, 5)
            ON CONFLICT (type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
            v_id := NULL;
        END IF;
    END LOOP;

    UPDATE inbound_endpoints SET last_received_at = now(), received_count = received_count + v_new WHERE id = v_ep.id;
    RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION app.inbound_endpoint_lookup(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.inbound_receive(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inbound_endpoint_lookup(uuid) TO crm_app_user;
GRANT EXECUTE ON FUNCTION app.inbound_receive(uuid, jsonb) TO crm_app_user;
