-- Fix infinite RLS recursion on tenant_memberships and organisation_memberships
--
-- Root cause: The SELECT policies on tenant_memberships and organisation_memberships
-- contained subqueries that referenced the same table, causing infinite RLS recursion.
-- When a user queried their memberships, the RLS policy triggered a subquery on the
-- same table, which triggered the same RLS policy again, resulting in:
-- "infinite recursion detected in policy for relation"
-- PostgREST returned an empty/error response, so the frontend saw zero memberships
-- and displayed "Workspace Setup Required" even though the data existed.
--
-- Fix: Use SECURITY DEFINER functions (which bypass RLS) to look up the user's
-- tenant/org IDs, eliminating the self-referential subquery in the policy.

-- 1. Create a SECURITY DEFINER function to get a user's organisation IDs
CREATE OR REPLACE FUNCTION public.get_user_org_ids(check_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
SELECT organisation_id FROM organisation_memberships
WHERE user_id = check_user_id AND status = 'active';
$function$;

GRANT EXECUTE ON FUNCTION public.get_user_org_ids(uuid) TO authenticated;

-- 2. Drop and recreate the tenant_memberships SELECT policy
--    Old policy: (user_id = auth.uid()) OR (tenant_id IN (SELECT ... FROM tenant_memberships ...))
--    New policy: (user_id = auth.uid()) OR (tenant_id IN (SELECT get_user_tenant_ids(auth.uid())))
--    The first condition lets a user read their own memberships.
--    The second condition lets tenant owners/admins read other members in their tenant,
--    using the SECURITY DEFINER function to avoid RLS recursion.
DROP POLICY IF EXISTS select_tenant_memberships ON tenant_memberships;

CREATE POLICY select_tenant_memberships ON tenant_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR tenant_id IN (
      SELECT get_user_tenant_ids(auth.uid())
    )
  );

-- 3. Drop and recreate the organisation_memberships SELECT policy
--    Same fix: use SECURITY DEFINER function instead of self-referencing subquery
DROP POLICY IF EXISTS select_org_memberships ON organisation_memberships;

CREATE POLICY select_org_memberships ON organisation_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR organisation_id IN (
      SELECT get_user_org_ids(auth.uid())
    )
  );
