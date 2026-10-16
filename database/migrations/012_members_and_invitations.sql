-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 012
-- Domain: Workspace members & invitation acceptance
-- ==============================================================================

-- Membership bookkeeping
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_memberships_tenant_role ON tenant_memberships (tenant_id, role) WHERE status = 'active';

-- Atomic, email-bound, single-use invitation consumption.
-- Runs before the invitee has any tenant context, hence SECURITY DEFINER. It returns a row ONLY when the caller proves
-- possession of the token AND (when an email is supplied) that the token was issued to that exact mailbox.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_token_hash text, p_email citext)
RETURNS TABLE (id uuid, tenant_id uuid, email citext, role tenant_role, invited_by uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
    UPDATE tenant_invitations i
       SET accepted_at = now()
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       AND (p_email IS NULL OR i.email = p_email)
    RETURNING i.id, i.tenant_id, i.email, i.role, i.invited_by
$$;
REVOKE ALL ON FUNCTION app.consume_invitation(text, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_invitation(text, citext) TO crm_app_user, crm_worker;

-- Pending invitations are visible to the tenant's admins only through the API; make sure tokens never leave the table.
-- (A column-level REVOKE is a no-op while a table-level SELECT grant exists, so revoke at table level and re-grant columns.)
REVOKE SELECT ON tenant_invitations FROM crm_app_user, crm_worker;
GRANT  SELECT (id, tenant_id, email, role, invited_by, expires_at, accepted_at, revoked_at, accepted_by, created_at) ON tenant_invitations TO crm_app_user, crm_worker;
