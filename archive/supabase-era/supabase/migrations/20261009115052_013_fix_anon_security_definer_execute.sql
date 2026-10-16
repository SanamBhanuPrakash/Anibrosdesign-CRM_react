/*
# Fix SECURITY DEFINER Functions Executable by Anon Role

## Problem
The Supabase security advisor detected that 3 SECURITY DEFINER functions
can be executed by the `anon` role (unauthenticated users). This means
anyone with the anon key can call these privileged functions without
signing in.

## Affected Functions
1. `calculate_lead_score(p_lead_id uuid)` — can score arbitrary leads
2. `create_default_tenant(p_org_name text, p_tenant_name text)` — can create orgs/tenants
3. `invite_user_to_tenant(p_tenant_id uuid, p_user_email text, p_role text)` — can invite users

## Fix
Revoke EXECUTE from `anon` on all SECURITY DEFINER functions that were
missed in Migration 005. The `authenticated` role retains EXECUTE since
these functions verify caller permissions internally.

## Security Impact
After this migration, unauthenticated requests cannot invoke any
SECURITY DEFINER function. Only signed-in users can call them, and each
function validates the caller's membership/role before executing.
*/

REVOKE EXECUTE ON FUNCTION public.calculate_lead_score(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_default_tenant(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.invite_user_to_tenant(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reset_stuck_outbox_jobs(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reset_stuck_webhook_jobs(integer) FROM anon;
