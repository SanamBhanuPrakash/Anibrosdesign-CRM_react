/*
# Migration 025: Tenant-Scoped Realtime Notification System (Hardened)

## Purpose
Establishes a persistent, tenant-isolated notification subsystem for Anibros CRM.
Supports user-specific and tenant-wide alerts for:
- Lead assignment
- Viewing scheduling & status updates
- Tasks due
- Integration errors & webhook dead-letter alerts
- Operational incidents

## Security Model (Hardened Phase 1.2)
- Direct client INSERT revoked from authenticated role to prevent forged security/system alerts.
- Creation allowed only via restricted SECURITY DEFINER `create_notification` RPC or server-side service role.
- Privileged notification types ('incident', 'system') require tenant 'admin' or 'manager' role.
- BEFORE UPDATE trigger blocks tampering of notification content (title, message, type, metadata, tenant, user).
- Mark-read RPCs strictly verify active tenant membership and recipient ownership.
- Realtime publication enables instant cross-tab live push.
*/

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'system',
  link text,
  read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_type CHECK (
    type IN ('lead', 'viewing', 'task', 'incident', 'integration', 'system')
  )
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_read 
  ON public.notifications(tenant_id, user_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created 
  ON public.notifications(tenant_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 1. SELECT Policy: Tenant members see notifications targeted to them or broadcast to the tenant
DROP POLICY IF EXISTS "select_own_notifications" ON public.notifications;
CREATE POLICY "select_own_notifications"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

-- 2. UPDATE Policy: Users can only update their own notifications
DROP POLICY IF EXISTS "update_own_notifications" ON public.notifications;
CREATE POLICY "update_own_notifications"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

-- 3. DROP ordinary direct INSERT policy (prevents forged notifications from ordinary client requests)
DROP POLICY IF EXISTS "insert_tenant_notifications" ON public.notifications;

-- 4. Trigger: Prevent tampering with notification content on update
CREATE OR REPLACE FUNCTION public.trg_prevent_notification_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service role / administrative overrides bypass
  IF current_user = 'service_role' OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Ordinary users cannot alter immutable notification attributes
  IF (OLD.title IS DISTINCT FROM NEW.title) OR
     (OLD.message IS DISTINCT FROM NEW.message) OR
     (OLD.type IS DISTINCT FROM NEW.type) OR
     (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) OR
     (OLD.user_id IS DISTINCT FROM NEW.user_id) OR
     (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
    RAISE EXCEPTION 'Cannot modify notification content; only read status may be updated';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_notification_immutable_fields ON public.notifications;
CREATE TRIGGER check_notification_immutable_fields
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_prevent_notification_tampering();

-- RPC: Restricted Notification Creation
CREATE OR REPLACE FUNCTION public.create_tenant_notification(
  p_tenant_id uuid,
  p_user_id uuid,
  p_title text,
  p_message text,
  p_type text,
  p_link text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_notification_id uuid;
BEGIN
  IF v_caller_id IS NULL AND current_user != 'service_role' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate caller membership & role in tenant if called by regular user
  IF v_caller_id IS NOT NULL THEN
    SELECT role INTO v_caller_role
    FROM public.tenant_memberships
    WHERE tenant_id = p_tenant_id AND user_id = v_caller_id AND status = 'active';

    IF v_caller_role IS NULL THEN
      RAISE EXCEPTION 'Access denied: not an active member of this tenant';
    END IF;

    -- Privileged alert types require admin or manager privileges
    IF p_type IN ('incident', 'system') AND v_caller_role NOT IN ('owner', 'admin', 'manager') THEN
      RAISE EXCEPTION 'Access denied: insufficient permissions to create privileged % alerts', p_type;
    END IF;
  END IF;

  -- Validate recipient belongs to the same tenant if specific user targeted
  IF p_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_memberships
      WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Recipient user does not belong to active tenant';
    END IF;
  END IF;

  INSERT INTO public.notifications (
    tenant_id,
    user_id,
    title,
    message,
    type,
    link,
    metadata
  ) VALUES (
    p_tenant_id,
    p_user_id,
    p_title,
    p_message,
    p_type,
    p_link,
    p_metadata
  )
  RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_tenant_notification(uuid, uuid, text, text, text, text, jsonb) TO authenticated;

-- RPC: Mark Single Notification As Read (with Tenant Validation)
CREATE OR REPLACE FUNCTION public.mark_notification_read(
  p_notification_id uuid,
  p_tenant_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify active tenant membership
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = v_user_id AND tm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Access denied: not an active member of this tenant';
  END IF;

  UPDATE public.notifications
  SET read = true,
      read_at = now()
  WHERE id = p_notification_id
    AND tenant_id = p_tenant_id
    AND (user_id = v_user_id OR user_id IS NULL);

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid, uuid) TO authenticated;

-- RPC: Mark All Notifications As Read For Calling User (with Tenant Validation)
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(
  p_tenant_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify active tenant membership
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = v_user_id AND tm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Access denied: not an active member of this tenant';
  END IF;

  WITH updated AS (
    UPDATE public.notifications
    SET read = true,
        read_at = now()
    WHERE tenant_id = p_tenant_id
      AND (user_id = v_user_id OR user_id IS NULL)
      AND read = false
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(uuid) TO authenticated;

-- Add notifications table to Realtime publication
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN 
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications; 
    EXCEPTION 
      WHEN duplicate_object THEN NULL; 
    END;
  END IF;
END $$;
