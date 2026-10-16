-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 009
-- Domain: Database role model (no credentials in git) + enum drift fixes
-- Defects closed: C2 (runtime must not be superuser), C6 (membership 'revoked'), C10 (hard-coded dev password)
--
-- ROLE MODEL (roles are CLUSTER-wide, so every statement here is idempotent)
--   crm_app_user   NOLOGIN group  : DML grants on tenant tables, RLS applies. Members: API login role.
--   crm_worker     NOLOGIN group  : member of crm_app_user + extra queue-table policies (cross-tenant).
--   crm_api_login / crm_worker_login : LOGIN roles created by scripts/db/provision-roles.ts using
--                                      passwords taken from the environment, never from SQL files.
-- The migrator/owner role (superuser in local dev) is used ONLY for DDL and is never used by the app at runtime.
-- ==============================================================================

-- 1. Enum drift: masterplan membership lifecycle is active | invited | suspended | revoked
ALTER TYPE membership_status ADD VALUE IF NOT EXISTS 'revoked';

-- 2. Neutralise the legacy credential created by migration 004.
--    From here on crm_app_user is a pure group role. It can never log in or authenticate with a password.
ALTER ROLE crm_app_user NOLOGIN PASSWORD NULL;

-- 3. Worker group role (inherits every runtime grant; gains cross-tenant policies on queue tables in later migrations)
DO $$ BEGIN
    CREATE ROLE crm_worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT crm_app_user TO crm_worker;

-- 4. Make sure runtime roles can never create objects anywhere
REVOKE CREATE ON SCHEMA public FROM crm_app_user, crm_worker;
REVOKE CREATE ON SCHEMA app    FROM crm_app_user, crm_worker;
GRANT USAGE ON SCHEMA public, app TO crm_app_user, crm_worker;
