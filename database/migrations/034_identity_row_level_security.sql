-- ==============================================================================
-- 034 · Row-level security on the identity tables (closes residual risk R-1)
--
-- Until now users, organisations, tenants, tenant_memberships, sessions, the token tables, mfa_* and notification_reads had no policy:
-- sign-in, invitations and session lookup must read them before a workspace is chosen, so the runtime roles could read every row and
-- only the application's own WHERE clauses kept workspaces apart. A forgotten WHERE would have shown another workspace's members.
--
-- Now every one of those tables enforces who may see and change which rows, in the database:
--
--   workspace context   (app.current_tenant_id, set by withTenant/readTenant)
--       sees its own workspace, the members of it, and the people who share a workspace with the signed-in person
--   user context        (app.current_user_id only, set by Database.asUser; used by the agency layer, which looks across clients)
--       sees the workspaces the person belongs to, plus every client of an agency they are an owner/admin of
--   identity flow       (app.identity_flow = 'on', set only by Database.identity; sign-in, sign-up, sessions, tokens, invitations)
--       the one place that must look people up by e-mail or token before any context exists
--   no context          sees nothing
--
-- The policies call small SECURITY DEFINER helpers (owner-run, so they do not recurse into the policies they serve). Reading the
-- members' security state (MFA on, last seen) for the members screen goes through one function that only answers for the caller's own
-- workspace. Ending a removed person's sessions and the worker's retention purge go through two narrow functions (detach_sessions, purge_identity), so no role needs
-- to read or delete another person's session, token or sign-in attempt.
--
-- schema_migrations stays without a policy on purpose: it is not writable by the runtime roles and holds no personal data.
-- Additive and idempotent.
-- ==============================================================================

-- ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.identity_flow() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.identity_flow', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION app.tenant_org(p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT organisation_id FROM tenants WHERE id = p_tenant $$;

CREATE OR REPLACE FUNCTION app.is_member_of(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_tenant IS NOT NULL AND app.current_user_id() IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = app.current_user_id() AND m.status = 'active' AND m.is_active)
$$;

/** The signed-in person owns or administers the agency (the HQ workspace of this organisation). */
CREATE OR REPLACE FUNCTION app.is_org_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_org IS NOT NULL AND app.current_user_id() IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_memberships m JOIN tenants h ON h.id = m.tenant_id
         WHERE h.organisation_id = p_org AND h.kind = 'agency_hq' AND m.user_id = app.current_user_id()
           AND m.role IN ('tenant_owner', 'tenant_admin') AND m.status = 'active' AND m.is_active)
$$;

/** p_org is passed from the row itself (not looked up by id) so an INSERT ... RETURNING of a brand-new row can pass its own check. */
CREATE OR REPLACE FUNCTION app.tenant_visible(p_tenant uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT p_tenant = app.current_tenant_id() OR app.is_member_of(p_tenant) OR app.is_org_admin(p_org) $$;

CREATE OR REPLACE FUNCTION app.org_visible(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_org = (SELECT organisation_id FROM tenants WHERE id = app.current_tenant_id())
        OR (app.current_user_id() IS NOT NULL AND EXISTS (
              SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
               WHERE t.organisation_id = p_org AND m.user_id = app.current_user_id() AND m.status = 'active' AND m.is_active))
$$;

/** A person is visible to: themselves, anyone who ever belonged to the current workspace, and the people they share a workspace with. */
CREATE OR REPLACE FUNCTION app.user_visible(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_user = app.current_user_id()
        OR EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = p_user AND m.tenant_id = app.current_tenant_id())
        OR (app.current_user_id() IS NOT NULL AND EXISTS (
              SELECT 1 FROM tenant_memberships a JOIN tenant_memberships b ON b.tenant_id = a.tenant_id
               WHERE a.user_id = p_user AND b.user_id = app.current_user_id() AND b.status = 'active' AND b.is_active))
$$;

/** MFA on / last seen for the members of the caller's own workspace (the members screen). Answers for no other workspace. */
CREATE OR REPLACE FUNCTION app.member_security(p_tenant uuid)
RETURNS TABLE (user_id uuid, mfa_enabled boolean, last_seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.user_id,
           EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = m.user_id AND f.confirmed_at IS NOT NULL),
           (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = m.user_id AND s.revoked_at IS NULL)
      FROM tenant_memberships m
     WHERE m.tenant_id = p_tenant AND p_tenant = app.current_tenant_id()
$$;

REVOKE ALL ON FUNCTION app.identity_flow(), app.tenant_org(uuid), app.is_member_of(uuid), app.is_org_admin(uuid), app.tenant_visible(uuid, uuid),
                       app.org_visible(uuid), app.user_visible(uuid), app.member_security(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_flow(), app.tenant_org(uuid), app.is_member_of(uuid), app.is_org_admin(uuid), app.tenant_visible(uuid, uuid),
                          app.org_visible(uuid), app.user_visible(uuid), app.member_security(uuid) TO crm_app_user, crm_worker;

-- ── policies ──────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select ON users;
DROP POLICY IF EXISTS users_insert ON users;
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_select ON users FOR SELECT USING (app.identity_flow() OR app.user_visible(id));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (app.identity_flow());
CREATE POLICY users_update ON users FOR UPDATE USING (app.identity_flow() OR id = app.current_user_id()) WITH CHECK (app.identity_flow() OR id = app.current_user_id());

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organisations_select ON organisations;
DROP POLICY IF EXISTS organisations_insert ON organisations;
DROP POLICY IF EXISTS organisations_update ON organisations;
CREATE POLICY organisations_select ON organisations FOR SELECT USING (app.identity_flow() OR app.org_visible(id));
CREATE POLICY organisations_insert ON organisations FOR INSERT WITH CHECK (app.identity_flow());
CREATE POLICY organisations_update ON organisations FOR UPDATE USING (app.identity_flow() OR app.is_org_admin(id)) WITH CHECK (app.identity_flow() OR app.is_org_admin(id));

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_select ON tenants;
DROP POLICY IF EXISTS tenants_insert ON tenants;
DROP POLICY IF EXISTS tenants_update ON tenants;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (app.identity_flow() OR app.tenant_visible(id, organisation_id));
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (app.identity_flow() OR (kind = 'client' AND app.is_org_admin(organisation_id)));
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (app.identity_flow() OR id = app.current_tenant_id() OR app.is_org_admin(organisation_id))
                                                   WITH CHECK (app.identity_flow() OR id = app.current_tenant_id() OR app.is_org_admin(organisation_id));

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_select ON tenant_memberships;
DROP POLICY IF EXISTS memberships_insert ON tenant_memberships;
DROP POLICY IF EXISTS memberships_update ON tenant_memberships;
CREATE POLICY memberships_select ON tenant_memberships FOR SELECT
    USING (app.identity_flow() OR tenant_id = app.current_tenant_id() OR user_id = app.current_user_id() OR app.is_member_of(tenant_id) OR app.is_org_admin(app.tenant_org(tenant_id)));
CREATE POLICY memberships_insert ON tenant_memberships FOR INSERT
    WITH CHECK (app.identity_flow() OR tenant_id = app.current_tenant_id() OR app.is_org_admin(app.tenant_org(tenant_id)));
CREATE POLICY memberships_update ON tenant_memberships FOR UPDATE
    USING (app.identity_flow() OR tenant_id = app.current_tenant_id() OR app.is_org_admin(app.tenant_org(tenant_id)))
    WITH CHECK (app.identity_flow() OR tenant_id = app.current_tenant_id() OR app.is_org_admin(app.tenant_org(tenant_id)));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_select ON sessions;
DROP POLICY IF EXISTS sessions_insert ON sessions;
DROP POLICY IF EXISTS sessions_update ON sessions;
DROP POLICY IF EXISTS worker_purge_sessions ON sessions;
CREATE POLICY sessions_select ON sessions FOR SELECT USING (app.identity_flow() OR user_id = app.current_user_id());
CREATE POLICY sessions_insert ON sessions FOR INSERT WITH CHECK (app.identity_flow());
CREATE POLICY sessions_update ON sessions FOR UPDATE
    USING (app.identity_flow() OR user_id = app.current_user_id()) WITH CHECK (app.identity_flow() OR user_id = app.current_user_id());
-- the application only ever sets these three columns on an existing session; whose session it is (user_id) and its token can never be rewritten
REVOKE UPDATE ON sessions FROM crm_app_user, crm_worker;
GRANT UPDATE (last_seen_at, revoked_at, active_tenant_id) ON sessions TO crm_app_user;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['login_attempts', 'email_verification_tokens', 'password_reset_tokens'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS identity_flow_only ON %I', t);
        EXECUTE format('CREATE POLICY identity_flow_only ON %I FOR ALL USING (app.identity_flow()) WITH CHECK (app.identity_flow())', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['mfa_factors', 'mfa_recovery_codes', 'notification_reads'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS own_rows ON %I', t);
        EXECUTE format('CREATE POLICY own_rows ON %I FOR ALL USING (app.identity_flow() OR user_id = app.current_user_id()) WITH CHECK (app.identity_flow() OR user_id = app.current_user_id())', t);
    END LOOP;
END $$;

-- ── the two things that legitimately reach across people, as narrow functions instead of table access ───────────────────────────────

/**
 * Point sessions away from a workspace (someone was removed, or the workspace was archived). Only for the caller's own current workspace or
 * a client of an agency they own or administer; clears the active workspace of those sessions and touches nothing else.
 */
CREATE OR REPLACE FUNCTION app.detach_sessions(p_tenant uuid, p_user uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
    -- COALESCE: with no current workspace the comparison is NULL, and NOT NULL would let the caller through
    IF p_tenant IS NULL OR NOT COALESCE(p_tenant = app.current_tenant_id() OR app.is_org_admin(app.tenant_org(p_tenant)), false) THEN
        RAISE EXCEPTION 'FORBIDDEN: not your workspace';
    END IF;
    UPDATE sessions SET active_tenant_id = NULL WHERE active_tenant_id = p_tenant AND (p_user IS NULL OR user_id = p_user);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

/** Retention for the identity tables, for the background worker only (it has no read or delete access to them otherwise). */
CREATE OR REPLACE FUNCTION app.purge_identity(p_kind text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
    IF p_kind = 'login_attempts' THEN DELETE FROM login_attempts WHERE attempted_at < now() - interval '14 days';
    ELSIF p_kind = 'verification_tokens' THEN DELETE FROM email_verification_tokens WHERE expires_at < now() - interval '7 days';
    ELSIF p_kind = 'reset_tokens' THEN DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days';
    ELSIF p_kind = 'sessions' THEN DELETE FROM sessions WHERE (expires_at < now() - interval '30 days') OR (revoked_at < now() - interval '30 days');
    ELSE RAISE EXCEPTION 'unknown retention task %', p_kind;
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION app.detach_sessions(uuid, uuid), app.purge_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.detach_sessions(uuid, uuid) TO crm_app_user, crm_worker;
REVOKE ALL ON FUNCTION app.purge_identity(text) FROM crm_app_user;
GRANT EXECUTE ON FUNCTION app.purge_identity(text) TO crm_worker;
