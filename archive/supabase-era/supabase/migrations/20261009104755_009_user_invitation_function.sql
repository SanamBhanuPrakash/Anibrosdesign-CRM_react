/*
# User Invitation Function

## Purpose
Allows tenant admins/owners to invite users to their tenant by email.
Creates a tenant_membership with status='invited'. When the invited user
signs up with the same email, a trigger activates their membership.

## Security
- SECURITY DEFINER, search_path = public, auth
- Verifies caller has tenant_owner or tenant_admin role
- Only inserts membership row — does not create auth users
- EXECUTE revoked from PUBLIC, granted to authenticated only
*/

CREATE OR REPLACE FUNCTION invite_user_to_tenant(
  p_tenant_id uuid,
  p_user_email text,
  p_role text DEFAULT 'sales_agent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_existing_user_id uuid;
  v_existing_membership_id uuid;
BEGIN
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  -- Verify caller is tenant_owner or tenant_admin
  SELECT role INTO v_caller_role
  FROM tenant_memberships
  WHERE user_id = v_caller_id AND tenant_id = p_tenant_id AND status = 'active';

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authorized: no membership in this tenant');
  END IF;

  IF v_caller_role NOT IN ('tenant_owner', 'tenant_admin') THEN
    RETURN jsonb_build_object('error', 'Not authorized: only tenant owners and admins can invite users');
  END IF;

  -- Validate role
  IF p_role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager', 'sales_agent', 'marketing_manager', 'marketing_analyst', 'executive_readonly', 'auditor') THEN
    RETURN jsonb_build_object('error', 'Invalid role');
  END IF;

  -- Check if user already exists in auth.users
  SELECT id INTO v_existing_user_id FROM auth.users WHERE email = lower(trim(p_user_email));

  -- Check if membership already exists
  SELECT id INTO v_existing_membership_id
  FROM tenant_memberships
  WHERE tenant_id = p_tenant_id
    AND user_id = v_existing_user_id
    AND v_existing_user_id IS NOT NULL;

  IF v_existing_membership_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'User is already a member of this tenant');
  END IF;

  -- Create membership
  IF v_existing_user_id IS NOT NULL THEN
    -- User exists, create active membership
    INSERT INTO tenant_memberships (user_id, tenant_id, role, status)
    VALUES (v_existing_user_id, p_tenant_id, p_role, 'active');
  ELSE
    -- User doesn't exist yet, create invited membership with a placeholder
    -- We'll use the email to find the user after they sign up
    -- For now, we store the invitation and a trigger will activate it
    -- Since we can't insert into auth.users, we create a pending record
    -- that the frontend will check after sign-up
    INSERT INTO tenant_memberships (user_id, tenant_id, role, status)
    VALUES ('00000000-0000-0000-0000-000000000000', p_tenant_id, p_role, 'invited');

    -- Store the email in a separate invitation tracking mechanism
    -- We use audit_logs to track the invitation
    INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_tenant_id, v_caller_id, 'user_invited', 'membership', null,
      jsonb_build_object('email', lower(trim(p_user_email)), 'role', p_role));
  END IF;

  RETURN jsonb_build_object('success', true, 'email', lower(trim(p_user_email)), 'role', p_role);
END;
$$;

REVOKE EXECUTE ON FUNCTION invite_user_to_tenant(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_user_to_tenant(uuid, text, text) TO authenticated;
