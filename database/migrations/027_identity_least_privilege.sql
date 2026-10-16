-- ==============================================================================
-- 027 · Least privilege on identity tables; guard the one unguarded SECURITY DEFINER seeding function
--
-- Found by the schema-wide guarantees test (server/src/tests/schema-guarantees.test.ts), not by a user report.
--
-- 1. app.seed_lead_scoring_config(uuid) was SECURITY DEFINER, had no pinned search_path and no tenant check, and the API role could
--    execute it for ANY tenant id. It now behaves like the other seeding wrappers (seed_default_pipeline, seed_beginner_pipeline):
--    it refuses a tenant id that differs from the transaction's tenant context and pins its search_path.
--
-- 2. The identity tables (users, organisations, tenants, tenant_memberships) have no tenant_id RLS, because sign-in, invitation and
--    session lookup must read them before a workspace is chosen. The application scopes every query on them, but the runtime roles
--    also held DELETE, which no code path uses (memberships are revoked by status, never deleted). DELETE is withdrawn so that a
--    future bug or injection cannot erase another workspace's members. INSERT/UPDATE stay (sign-up, invitations, role changes).
--    A full row-level policy for these tables needs SECURITY DEFINER lookup functions for the pre-sign-in flows; that is tracked as
--    residual risk R-1 in docs/SECURITY_MODEL.md and is deliberately NOT attempted in this migration.
--
-- Additive and idempotent.
-- ==============================================================================

CREATE OR REPLACE FUNCTION app.seed_lead_scoring_config(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
BEGIN
    IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'FORBIDDEN: tenant context mismatch';
    END IF;
    INSERT INTO lead_scoring_config (tenant_id) VALUES (p_tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION app.seed_lead_scoring_config(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seed_lead_scoring_config(uuid) TO crm_app_user;

REVOKE DELETE ON tenant_memberships, tenants, organisations, users FROM crm_app_user, crm_worker;
