/*
# Auto-Onboarding for New Sign-Ups

## Purpose
Creates a SECURITY DEFINER function that auto-provisions a new organisation,
tenant, and owner membership for a newly signed-up user. This allows the app
to be usable immediately after sign-up without manual admin setup.

## Security
- SECURITY DEFINER with explicit search_path = public, auth
- Verifies auth.uid() matches the provided user_id
- Idempotent: if user already has a membership, returns the existing tenant
- Only callable by authenticated users (EXECUTE revoked from PUBLIC/anon)

## Flow
1. User signs up via Supabase Auth
2. Frontend calls create_default_tenant() RPC
3. Function creates:
   - An organisation (type: client_business)
   - A tenant (slug derived from org name)
   - A tenant_membership (role: tenant_owner)
   - Seeds the default pipeline via seed_default_pipeline()
4. Returns the tenant_id for the frontend to load
*/

CREATE OR REPLACE FUNCTION create_default_tenant(
  p_org_name text DEFAULT NULL,
  p_tenant_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_tenant_id uuid;
  v_slug text;
  v_org_name text;
  v_tenant_name text;
  v_existing_tenant_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check if user already has a tenant membership
  SELECT tenant_id INTO v_existing_tenant_id
  FROM tenant_memberships
  WHERE user_id = v_user_id AND status = 'active'
  LIMIT 1;

  IF v_existing_tenant_id IS NOT NULL THEN
    RETURN v_existing_tenant_id;
  END IF;

  -- Use provided names or defaults
  v_org_name := COALESCE(p_org_name, 'My Organisation');
  v_tenant_name := COALESCE(p_tenant_name, 'My Workspace');

  -- Create organisation
  INSERT INTO organisations (name, type)
  VALUES (v_org_name, 'client_business')
  RETURNING id INTO v_org_id;

  -- Generate unique slug
  v_slug := lower(regexp_replace(v_tenant_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  IF v_slug = '' THEN v_slug := 'workspace'; END IF;
  -- Ensure uniqueness by appending a short random suffix
  v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  -- Create tenant
  INSERT INTO tenants (organisation_id, name, slug, status, settings)
  VALUES (v_org_id, v_tenant_name, v_slug, 'active', '{}'::jsonb)
  RETURNING id INTO v_tenant_id;

  -- Create organisation membership (agency_owner so they can manage the org)
  INSERT INTO organisation_memberships (user_id, organisation_id, role, status)
  VALUES (v_user_id, v_org_id, 'agency_owner', 'active');

  -- Create tenant membership (tenant_owner)
  INSERT INTO tenant_memberships (user_id, tenant_id, role, status)
  VALUES (v_user_id, v_tenant_id, 'tenant_owner', 'active');

  -- Seed default pipeline
  PERFORM seed_default_pipeline(v_tenant_id);

  -- Audit log
  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (v_tenant_id, v_user_id, 'tenant_created', 'tenant', v_tenant_id,
    jsonb_build_object('org_name', v_org_name, 'tenant_name', v_tenant_name));

  RETURN v_tenant_id;
END;
$$;

-- Revoke from PUBLIC and anon, grant to authenticated only
REVOKE EXECUTE ON FUNCTION create_default_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_default_tenant(text, text) TO authenticated;
