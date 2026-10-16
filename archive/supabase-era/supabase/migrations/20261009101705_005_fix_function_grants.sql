/*
# Fix SECURITY DEFINER Function Execute Permissions

## Purpose
PostgreSQL grants EXECUTE on functions to PUBLIC by default, which includes anon.
REVOKE FROM anon alone doesn't work because PUBLIC still grants it.
This migration revokes from PUBLIC and grants only to authenticated.

## Security
- transition_lead_stage and seed_default_pipeline: authenticated only
  (they verify auth.uid() internally)
- Helper functions (is_platform_admin, is_agency_admin_for_org,
  get_user_tenant_ids): authenticated only (internal helper functions)
*/

-- Revoke from PUBLIC (which includes anon), then grant to authenticated only
REVOKE EXECUTE ON FUNCTION is_platform_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION is_agency_admin_for_org(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_tenant_ids(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION seed_default_pipeline(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION transition_lead_stage(uuid, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION is_platform_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION is_agency_admin_for_org(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_tenant_ids(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION seed_default_pipeline(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION transition_lead_stage(uuid, text, text, jsonb) TO authenticated;
