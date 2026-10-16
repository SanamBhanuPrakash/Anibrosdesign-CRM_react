/*
# Organisation and Tenant Hierarchy

## Purpose
Sets up the foundational multi-tenant hierarchy:
- organisations (platform owner, agency, client business)
- tenants (workspaces belonging to organisations)
- branches (locations within tenants)
- organisation_memberships (users with org-level roles)
- tenant_memberships (users with tenant-level roles)
- Core SECURITY DEFINER helper functions for RLS evaluation
*/

-- ============ ENUMS ============
DO $$ BEGIN CREATE TYPE organisation_type AS ENUM ('platform_owner', 'agency', 'client_business'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'offboarded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE membership_status AS ENUM ('active', 'invited', 'revoked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE org_role AS ENUM ('platform_owner', 'platform_admin', 'agency_owner', 'agency_admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tenant_role AS ENUM ('tenant_owner', 'tenant_admin', 'sales_manager', 'sales_agent', 'marketing_manager', 'marketing_analyst', 'executive_readonly', 'auditor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ TABLES ============

-- 1. Organisations
CREATE TABLE IF NOT EXISTS public.organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type organisation_type NOT NULL DEFAULT 'client_business',
  parent_organisation_id uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 2. Tenants
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status tenant_status NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 3. Branches
CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Organisation Memberships
CREATE TABLE IF NOT EXISTS public.organisation_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  role org_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_org_memberships_user_org UNIQUE (user_id, organisation_id)
);

-- 5. Tenant Memberships
CREATE TABLE IF NOT EXISTS public.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  role tenant_role NOT NULL DEFAULT 'sales_agent',
  status membership_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_memberships_user_tenant UNIQUE (user_id, tenant_id)
);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_organisations_parent ON public.organisations(parent_organisation_id);
CREATE INDEX IF NOT EXISTS idx_tenants_org_id ON public.tenants(organisation_id);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants(slug);
CREATE INDEX IF NOT EXISTS idx_branches_tenant ON public.branches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON public.organisation_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON public.organisation_memberships(organisation_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON public.tenant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON public.tenant_memberships(tenant_id);

-- ============ HELPER FUNCTIONS ============

CREATE OR REPLACE FUNCTION public.get_user_tenant_ids(check_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT tenant_id FROM public.tenant_memberships
  WHERE user_id = check_user_id AND status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.is_platform_admin(check_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_memberships
    WHERE user_id = check_user_id
      AND role IN ('platform_owner', 'platform_admin')
      AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_agency_admin_for_org(check_user_id uuid, check_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_memberships
    WHERE user_id = check_user_id
      AND organisation_id = check_org_id
      AND role IN ('platform_owner', 'platform_admin', 'agency_owner', 'agency_admin')
      AND status = 'active'
  );
$$;

-- ============ ROW LEVEL SECURITY ============

ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;

-- Organisations policies
CREATE POLICY select_organisations ON public.organisations
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT organisation_id FROM public.organisation_memberships WHERE user_id = auth.uid() AND status = 'active')
    OR public.is_platform_admin(auth.uid())
  );

CREATE POLICY manage_organisations ON public.organisations
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_agency_admin_for_org(auth.uid(), id)
  );

-- Tenants policies
CREATE POLICY select_tenants ON public.tenants
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT public.get_user_tenant_ids(auth.uid()))
    OR organisation_id IN (SELECT organisation_id FROM public.organisation_memberships WHERE user_id = auth.uid() AND status = 'active')
    OR public.is_platform_admin(auth.uid())
  );

CREATE POLICY manage_tenants ON public.tenants
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_agency_admin_for_org(auth.uid(), organisation_id)
    OR id IN (SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid() AND role IN ('tenant_owner', 'tenant_admin') AND status = 'active')
  );

-- Branches policies
CREATE POLICY select_branches ON public.branches
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (SELECT public.get_user_tenant_ids(auth.uid()))
  );

CREATE POLICY manage_branches ON public.branches
  FOR ALL TO authenticated
  USING (
    tenant_id IN (SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid() AND role IN ('tenant_owner', 'tenant_admin') AND status = 'active')
  );

-- Organisation memberships policies
CREATE POLICY select_org_memberships ON public.organisation_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_platform_admin(auth.uid())
  );

CREATE POLICY manage_org_memberships ON public.organisation_memberships
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_agency_admin_for_org(auth.uid(), organisation_id)
  );

-- Tenant memberships policies
CREATE POLICY select_tenant_memberships ON public.tenant_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR tenant_id IN (SELECT public.get_user_tenant_ids(auth.uid()))
  );

CREATE POLICY manage_tenant_memberships ON public.tenant_memberships
  FOR ALL TO authenticated
  USING (
    tenant_id IN (SELECT tenant_id FROM public.tenant_memberships WHERE user_id = auth.uid() AND role IN ('tenant_owner', 'tenant_admin') AND status = 'active')
    OR public.is_platform_admin(auth.uid())
  );

-- ============ GRANTS ============
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisation_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_memberships TO authenticated;

GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_agency_admin_for_org(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_tenant_ids(uuid) TO authenticated;
