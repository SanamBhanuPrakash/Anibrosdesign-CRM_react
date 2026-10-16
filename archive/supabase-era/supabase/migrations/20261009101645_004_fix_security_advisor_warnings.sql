/*
# Fix Security Advisor Warnings

## Purpose
1. Add explicit search_path to helper functions that were missing it
2. Revoke EXECUTE from anon role on all SECURITY DEFINER functions
   (these should only be callable by authenticated users)
3. Keep EXECUTE on authenticated role for transition_lead_stage
   and seed_default_pipeline (needed by the app)

## Security
- Helper functions (is_platform_admin, is_agency_admin_for_org,
  get_user_tenant_ids) are internal — revoke from anon, keep for authenticated
- transition_lead_stage and seed_default_pipeline verify auth.uid() internally
  so they're safe for authenticated, but not anon
*/

-- Fix search_path on helper functions
ALTER FUNCTION is_platform_admin(uuid) SET search_path = public, auth;
ALTER FUNCTION is_agency_admin_for_org(uuid, uuid) SET search_path = public, auth;
ALTER FUNCTION get_user_tenant_ids(uuid) SET search_path = public, auth;

-- Revoke anon execute on all SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION is_platform_admin(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION is_agency_admin_for_org(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION get_user_tenant_ids(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION seed_default_pipeline(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION transition_lead_stage(uuid, text, text, jsonb) FROM anon;
