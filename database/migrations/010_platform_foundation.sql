-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 010
-- Domain: Platform foundation — event spine, job queue, idempotency, RLS completion, privilege hardening
-- Defects closed: C2 (RLS enforceable), C7 (platform rows visible to tenants), C9 (duplicate/lossy realtime),
--                 C5 (queue leases), H5 (worker separation), H10 prerequisites
-- Design: docs/ARCHITECTURE_V2.md §2.4 (event spine), §2.5 (jobs), §2.6 (multi-tenancy)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Context helpers (plain SQL → inlinable, no SECURITY DEFINER needed to read a GUC)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_request_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_request_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.current_ip() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_ip', true), '') $$;

-- ------------------------------------------------------------------------------
-- 2. Privilege hardening
-- ------------------------------------------------------------------------------
-- Migration bookkeeping must be unreachable from runtime roles (tamper vector).
REVOKE ALL ON schema_migrations FROM crm_app_user, crm_worker;

-- No TEMP objects for runtime roles (prevents search_path/temp-table shadowing of SECURITY DEFINER code).
DO $$ BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- Functions are executable by PUBLIC by default: close that for everything in schema app.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO crm_app_user, crm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT  EXECUTE ON FUNCTIONS TO crm_app_user, crm_worker;

-- Every SECURITY DEFINER function pins its search_path (pg_temp last).
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.prosecdef
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, app, pg_temp', r.sig);
    END LOOP;
END $$;

-- seed_default_pipeline(p_tenant_id) was callable by any session for ANY tenant id. Wrap it with a context guard.
ALTER FUNCTION app.seed_default_pipeline(uuid) RENAME TO seed_default_pipeline_unsafe;
REVOKE ALL ON FUNCTION app.seed_default_pipeline_unsafe(uuid) FROM PUBLIC, crm_app_user, crm_worker;

CREATE OR REPLACE FUNCTION app.seed_default_pipeline(p_tenant_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
BEGIN
    IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'FORBIDDEN: tenant context mismatch';
    END IF;
    RETURN app.seed_default_pipeline_unsafe(p_tenant_id);
END $$;
GRANT EXECUTE ON FUNCTION app.seed_default_pipeline(uuid) TO crm_app_user, crm_worker;

-- ------------------------------------------------------------------------------
-- 3. Domain event spine (transactional outbox) — replaces per-table NOTIFY triggers & direct broadcasts
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domain_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Transaction id: consumers only read rows from transactions that have finished (see dispatcher), so a
    -- late-committing lower id can never be skipped (the classic outbox ordering gap).
    tx_id           xid8 NOT NULL DEFAULT pg_current_xact_id(),
    tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
    type            text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    aggregate_type  text NOT NULL,
    aggregate_id    uuid NOT NULL,
    actor_user_id   uuid DEFAULT app.current_user_id(),
    correlation_id  text DEFAULT app.current_request_id(),
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) < 4096),
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_domain_events_cursor    ON domain_events (tx_id, id);
CREATE INDEX IF NOT EXISTS idx_domain_events_tenant    ON domain_events (tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate ON domain_events (tenant_id, aggregate_type, aggregate_id, id DESC);

-- Fan-out signal: ids/types only (≤ 8 kB NOTIFY limit, no PII). Delivered at COMMIT, never for rolled-back work.
CREATE OR REPLACE FUNCTION app.notify_domain_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, app, pg_temp AS $$
BEGIN
    PERFORM pg_notify('crm_events', json_build_object(
        'id', NEW.id, 't', NEW.tenant_id, 'ty', NEW.type, 'a', NEW.aggregate_type, 'i', NEW.aggregate_id
    )::text);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_domain_events_notify ON domain_events;
CREATE TRIGGER trg_domain_events_notify AFTER INSERT ON domain_events
    FOR EACH ROW EXECUTE FUNCTION app.notify_domain_event();

CREATE TABLE IF NOT EXISTS event_consumers (
    name           text PRIMARY KEY,
    last_tx_id     xid8   NOT NULL DEFAULT '0'::xid8,
    last_event_id  bigint NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 4. Generic job queue (lease-based, SKIP LOCKED)
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,       -- NULL = platform job
    type          text NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) < 262144),
    status        job_status NOT NULL DEFAULT 'queued',
    priority      smallint NOT NULL DEFAULT 0,
    run_at        timestamptz NOT NULL DEFAULT now(),
    attempts      integer NOT NULL DEFAULT 0,
    max_attempts  integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
    lease_until   timestamptz,
    locked_by     text,
    dedupe_key    text,
    last_error    text,
    result        jsonb,
    correlation_id text DEFAULT app.current_request_id(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe ON jobs (type, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claim   ON jobs (priority DESC, run_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_reaper  ON jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_jobs_tenant  ON jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_dead    ON jobs (updated_at DESC) WHERE status = 'dead';

-- Wake the worker immediately when work is enqueued (statement-level: one signal per INSERT statement).
CREATE OR REPLACE FUNCTION app.notify_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, app, pg_temp AS $$
BEGIN
    PERFORM pg_notify('crm_jobs', '');
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_jobs_notify ON jobs;
CREATE TRIGGER trg_jobs_notify AFTER INSERT ON jobs FOR EACH STATEMENT EXECUTE FUNCTION app.notify_job();

-- ------------------------------------------------------------------------------
-- 5. Idempotency keys (public API POSTs)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
    key            text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
    request_hash   text NOT NULL,
    status_code    integer,
    response_body  jsonb,
    locked_until   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys (created_at);

-- ------------------------------------------------------------------------------
-- 6. Audit log: identity/correlation default from the transaction context
-- ------------------------------------------------------------------------------
ALTER TABLE audit_logs ALTER COLUMN tenant_id      SET DEFAULT app.current_tenant_id();
ALTER TABLE audit_logs ALTER COLUMN actor_id       SET DEFAULT app.current_user_id();
ALTER TABLE audit_logs ALTER COLUMN correlation_id SET DEFAULT app.current_request_id();
ALTER TABLE audit_logs ALTER COLUMN ip_address     SET DEFAULT app.current_ip();

-- ------------------------------------------------------------------------------
-- 7. Row-Level Security for the remaining tenant-bearing tables + worker policies on queues
--    Existing business tables already have `tenant_isolation_*` policies (migration 004/008).
--    Rule: runtime roles never own tables, so ENABLE (without FORCE) is sufficient and keeps migrations simple.
-- ------------------------------------------------------------------------------
ALTER TABLE webhook_inbox     ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_health     ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_consumers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys  ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped access for API sessions (the worker role inherits these as a member of crm_app_user)
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['webhook_inbox', 'operational_logs', 'system_health', 'jobs', 'idempotency_keys'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%1$s ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%1$s ON %1$I FOR ALL TO crm_app_user
               USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
    END LOOP;
END $$;

-- operational_logs may be written without a tenant (platform-level, e.g. pre-auth failures) but never READ by tenants.
DROP POLICY IF EXISTS tenant_isolation_operational_logs ON operational_logs;
CREATE POLICY tenant_read_operational_logs ON operational_logs FOR SELECT TO crm_app_user
    USING (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_write_operational_logs ON operational_logs FOR INSERT TO crm_app_user
    WITH CHECK (tenant_id IS NULL OR tenant_id = app.current_tenant_id());

-- Domain events are append-only for the API: tenant can read its own, insert its own, never update/delete.
DROP POLICY IF EXISTS tenant_read_domain_events   ON domain_events;
DROP POLICY IF EXISTS tenant_insert_domain_events ON domain_events;
CREATE POLICY tenant_read_domain_events   ON domain_events FOR SELECT TO crm_app_user USING (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_insert_domain_events ON domain_events FOR INSERT TO crm_app_user WITH CHECK (tenant_id = app.current_tenant_id());

-- Worker-only cross-tenant policies. These are the ONLY cross-tenant access paths and exist for queue tables only.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['webhook_inbox', 'outbox_events', 'jobs', 'operational_logs', 'system_health', 'idempotency_keys'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS worker_all_%1$s ON %1$I', t);
        EXECUTE format('CREATE POLICY worker_all_%1$s ON %1$I FOR ALL TO crm_worker USING (true) WITH CHECK (true)', t);
    END LOOP;
END $$;
DROP POLICY IF EXISTS worker_read_domain_events   ON domain_events;
DROP POLICY IF EXISTS worker_delete_domain_events ON domain_events;
CREATE POLICY worker_read_domain_events   ON domain_events FOR SELECT TO crm_worker USING (true);
CREATE POLICY worker_delete_domain_events ON domain_events FOR DELETE TO crm_worker USING (true);
DROP POLICY IF EXISTS worker_all_event_consumers ON event_consumers;
CREATE POLICY worker_all_event_consumers ON event_consumers FOR ALL TO crm_worker USING (true) WITH CHECK (true);

-- Table privileges (policies are necessary, privileges are the second lock)
REVOKE ALL ON event_consumers FROM crm_app_user;
GRANT  SELECT, INSERT, UPDATE ON event_consumers TO crm_worker;

REVOKE UPDATE, DELETE ON domain_events FROM crm_app_user;
GRANT  DELETE ON domain_events TO crm_worker;

REVOKE UPDATE, DELETE ON jobs FROM crm_app_user;       -- API may enqueue and read; only the worker mutates
GRANT  UPDATE, DELETE ON jobs TO crm_worker;

REVOKE UPDATE, DELETE ON operational_logs FROM crm_app_user;
GRANT  DELETE ON operational_logs TO crm_worker;

REVOKE DELETE ON webhook_inbox, outbox_events, system_health FROM crm_app_user;
GRANT  DELETE ON webhook_inbox, outbox_events TO crm_worker;

GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO crm_app_user;
GRANT DELETE ON idempotency_keys TO crm_worker;
