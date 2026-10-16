/*
# Harden audit_logs INSERT policy — prevent actor forgery

## Purpose
The existing audit_logs INSERT policy allows any authenticated tenant member
to insert audit records with an arbitrary user_id. This means a user could
forge audit entries impersonating another user or the system.

## Change
Replace the INSERT policy to require user_id = auth.uid() for client-side
inserts. SECURITY DEFINER functions (which bypass RLS) can still set any
user_id — this is correct because those functions derive identity from
auth.uid() within their own logic and are trusted.

## Security
- SELECT: unchanged (tenant-scoped read)
- INSERT: now requires user_id = auth.uid() AND tenant membership
- UPDATE: still dropped (append-only)
- DELETE: still dropped (append-only)
*/

DROP POLICY IF EXISTS "insert_own_tenant_audit_logs" ON audit_logs;

CREATE POLICY "insert_own_tenant_audit_logs"
  ON audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND tenant_id IN (
      SELECT tm.tenant_id FROM tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );
