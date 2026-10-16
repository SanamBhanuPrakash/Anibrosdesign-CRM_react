-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 011
-- Domain: Identity hardening — sessions, MFA, API keys, invitations, pre-tenant lookups
-- Defects closed: C8 (token races), H6 (sessions), invitation acceptance gap, explicit tenant selection (C9/#13)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Users / tenants: locale & time zone (viewings, reminders and reports are time-zone aware)
-- ------------------------------------------------------------------------------
ALTER TABLE users   ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE users   ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en-IN';
ALTER TABLE users   ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_currency varchar(3) NOT NULL DEFAULT 'INR';

-- ------------------------------------------------------------------------------
-- 2. Sessions: sliding idle timeout, device label, server-side active workspace, assurance level
-- ------------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_label text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_level smallint NOT NULL DEFAULT 1 CHECK (auth_level IN (1, 2)); -- 1 password, 2 password+MFA
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------------------
-- 3. Multi-factor authentication (TOTP + recovery codes)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_factors (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          text NOT NULL DEFAULT 'totp' CHECK (type IN ('totp')),
    secret_enc    text NOT NULL,                     -- field-encrypted (AES-256-GCM, AAD = user id)
    confirmed_at  timestamptz,                       -- NULL until the user proves possession with a valid code
    last_used_step bigint,                           -- RFC 6238 time-step of last accepted code (replay protection)
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_one_confirmed_per_user ON mfa_factors (user_id) WHERE confirmed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- ------------------------------------------------------------------------------
-- 4. API keys (machine access to the public API). Only a hash of the secret is stored.
--    Format shown once:  crm_live_<prefix>_<secret>
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    prefix        text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{10}$'),
    secret_hash   text NOT NULL,
    role          tenant_role NOT NULL DEFAULT 'sales_agent',   -- ceiling: a key can never exceed its role
    scopes        text[] NOT NULL DEFAULT '{}',                  -- explicit allow-list of permissions
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at    timestamptz,
    last_used_at  timestamptz,
    last_used_ip  text,
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_api_keys ON api_keys;
CREATE POLICY tenant_isolation_api_keys ON api_keys FOR ALL TO crm_app_user
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON api_keys TO crm_app_user;
REVOKE DELETE ON api_keys FROM crm_app_user;  -- revoke, never delete (audit trail)

-- ------------------------------------------------------------------------------
-- 5. Invitations: acceptance lifecycle
-- ------------------------------------------------------------------------------
ALTER TABLE tenant_invitations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE tenant_invitations ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_pending ON tenant_invitations (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_invitations ON tenant_invitations;
CREATE POLICY tenant_isolation_tenant_invitations ON tenant_invitations FOR ALL TO crm_app_user
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- ------------------------------------------------------------------------------
-- 6. Narrow SECURITY DEFINER lookups for flows that run BEFORE a tenant context exists.
--    Each returns only what the caller needs and takes an unguessable secret-derived key, so they are not enumeration oracles.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_api_key(p_prefix text)
RETURNS TABLE (id uuid, tenant_id uuid, secret_hash text, role tenant_role, scopes text[], expires_at timestamptz, revoked_at timestamptz, tenant_active boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT k.id, k.tenant_id, k.secret_hash, k.role, k.scopes, k.expires_at, k.revoked_at, t.is_active
      FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.prefix = p_prefix
$$;

CREATE OR REPLACE FUNCTION app.touch_api_key(p_id uuid, p_ip text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
    UPDATE api_keys SET last_used_at = now(), last_used_ip = p_ip
     WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;

CREATE OR REPLACE FUNCTION app.resolve_invitation(p_token_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, email citext, role tenant_role, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT i.id, i.tenant_id, t.name, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at
      FROM tenant_invitations i JOIN tenants t ON t.id = i.tenant_id
     WHERE i.token_hash = p_token_hash
$$;

-- Mail is the only job type the API may enqueue without a tenant (password reset / verification for multi-tenant users).
CREATE OR REPLACE FUNCTION app.enqueue_mail(p_payload jsonb, p_dedupe_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
    IF pg_column_size(p_payload) > 65536 THEN RAISE EXCEPTION 'INVALID_ARGUMENT: payload too large'; END IF;
    INSERT INTO jobs (tenant_id, type, payload, dedupe_key, max_attempts, priority)
    VALUES (NULL, 'mail.send', p_payload, p_dedupe_key, 6, 10)
    ON CONFLICT (type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING jobs.id INTO v_id;
    RETURN v_id;
END $$;

-- Readiness: the API role cannot read schema_migrations, but may ask for the highest applied version.
CREATE OR REPLACE FUNCTION app.schema_version() RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, app, pg_temp AS $$
    SELECT max(version) FROM schema_migrations
$$;

REVOKE ALL ON FUNCTION app.resolve_api_key(text), app.touch_api_key(uuid, text), app.resolve_invitation(text),
                       app.enqueue_mail(jsonb, text), app.schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_api_key(text), app.touch_api_key(uuid, text), app.resolve_invitation(text),
                          app.enqueue_mail(jsonb, text), app.schema_version() TO crm_app_user, crm_worker;

-- ------------------------------------------------------------------------------
-- 7. Login attempts: used for forensics/alerting (throttling itself is in-process, see platform rate limiter)
-- ------------------------------------------------------------------------------
GRANT DELETE ON login_attempts TO crm_worker;
REVOKE DELETE ON login_attempts FROM crm_app_user;
