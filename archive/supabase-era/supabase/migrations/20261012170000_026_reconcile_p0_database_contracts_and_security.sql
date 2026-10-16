/*
# Migration 026: Reconcile P0 Database Contracts, Schema Invariants, and Role Authorization

## Purpose
1. Reconcile leads search RPC (`search_leads`) to use `l.lead_score` instead of invalid `l.score`, and return `total_count`.
2. Expand `outbox_events` schema to include `provider`, `integration_id`, `response_status`, `response_body`, and `updated_at`.
3. Expand `marketing_attribution` schema to include `integration_id` and `is_direct`, and set default `touch_type = 'first_touch'`.
4. Add `updated_at` to `webhook_inbox` and `outbox_events`.
5. Harden stuck job recovery (`reset_stuck_webhook_jobs`, `reset_stuck_outbox_jobs`):
   - Enforce explicit `p_tenant_id` scoping (strictly preventing cross-tenant mutation).
   - Enforce authentication and role verification (`tenant_owner`, `tenant_admin`, or `sales_manager`).
   - Record immutable audit logs for recovery events.
6. Reconcile notification role authorization in `create_tenant_notification` (`tenant_owner`, `tenant_admin`, `sales_manager`, `marketing_manager`).
7. Implement per-user broadcast read receipts via `notification_reads` table and updated read RPCs.
8. Implement `tenant_invitations` table to eliminate invalid zero-UUID foreign key violations during pending invitations.
*/

-- ============================================================
-- 1. Leads Search RPC Reconciled (search_leads)
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_leads(
  p_tenant_id uuid,
  p_search text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_results jsonb;
  v_total_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify caller is active tenant member
  SELECT EXISTS(
    SELECT 1 FROM public.tenant_memberships
    WHERE user_id = v_user_id
      AND tenant_id = p_tenant_id
      AND status = 'active'
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  -- Clamp pagination
  IF p_limit > 500 THEN
    p_limit := 500;
  ELSIF p_limit < 1 THEN
    p_limit := 50;
  END IF;

  IF p_offset < 0 THEN
    p_offset := 0;
  END IF;

  -- Calculate total filtered count
  SELECT count(*)
  INTO v_total_count
  FROM public.leads l
  LEFT JOIN public.contacts c ON c.id = l.contact_id AND c.tenant_id = p_tenant_id
  WHERE l.tenant_id = p_tenant_id
    AND l.deleted_at IS NULL
    AND (p_stage IS NULL OR p_stage = '' OR l.stage = p_stage)
    AND (p_source IS NULL OR p_source = '' OR l.lead_source::text = p_source)
    AND (
      p_search IS NULL OR p_search = ''
      OR l.title ILIKE '%' || p_search || '%'
      OR c.first_name ILIKE '%' || p_search || '%'
      OR c.last_name ILIKE '%' || p_search || '%'
      OR c.email ILIKE '%' || p_search || '%'
      OR c.phone ILIKE '%' || p_search || '%'
      OR c.email_normalized ILIKE '%' || p_search || '%'
      OR c.phone_normalized ILIKE '%' || p_search || '%'
    );

  -- Fetch paginated results
  SELECT COALESCE(jsonb_agg(row_json ORDER BY l.created_at DESC), '[]'::jsonb)
  INTO v_results
  FROM (
    SELECT jsonb_build_object(
      'id', l.id,
      'tenant_id', l.tenant_id,
      'contact_id', l.contact_id,
      'pipeline_id', l.pipeline_id,
      'pipeline_stage_id', l.pipeline_stage_id,
      'stage', l.stage,
      'lead_source', l.lead_source,
      'title', l.title,
      'description', l.description,
      'budget_min', l.budget_min,
      'budget_max', l.budget_max,
      'desired_location', l.desired_location,
      'transaction_intent', l.transaction_intent,
      'assigned_to', l.assigned_to,
      'lead_score', l.lead_score,
      'score', l.lead_score, -- backwards compatibility
      'qualification_status', l.qualification_status,
      'last_activity_at', l.last_activity_at,
      'created_at', l.created_at,
      'updated_at', l.updated_at,
      'deleted_at', l.deleted_at,
      'contact', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object(
        'id', c.id,
        'first_name', c.first_name,
        'last_name', c.last_name,
        'email', c.email,
        'phone', c.phone,
        'email_normalized', c.email_normalized,
        'phone_normalized', c.phone_normalized
      ) ELSE NULL END
    ) AS row_json
    FROM public.leads l
    LEFT JOIN public.contacts c ON c.id = l.contact_id AND c.tenant_id = p_tenant_id
    WHERE l.tenant_id = p_tenant_id
      AND l.deleted_at IS NULL
      AND (p_stage IS NULL OR p_stage = '' OR l.stage = p_stage)
      AND (p_source IS NULL OR p_source = '' OR l.lead_source::text = p_source)
      AND (
        p_search IS NULL OR p_search = ''
        OR l.title ILIKE '%' || p_search || '%'
        OR c.first_name ILIKE '%' || p_search || '%'
        OR c.last_name ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email_normalized ILIKE '%' || p_search || '%'
        OR c.phone_normalized ILIKE '%' || p_search || '%'
      )
    ORDER BY l.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ) sub(row_json);

  RETURN jsonb_build_object(
    'leads', v_results,
    'total_count', v_total_count,
    'offset', p_offset,
    'limit', p_limit
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_leads(uuid, text, text, text, int, int) TO authenticated;

-- ============================================================
-- 2. Outbox Events & Webhook Inbox Schema Enhancements
-- ============================================================

ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.outbox_events
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS integration_id uuid REFERENCES public.integrations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS response_status int,
  ADD COLUMN IF NOT EXISTS response_body text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant_status ON public.outbox_events(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant_provider ON public.outbox_events(tenant_id, provider);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_tenant_status ON public.webhook_inbox(tenant_id, status);

-- Trigger to maintain updated_at
CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_webhook_inbox_updated_at ON public.webhook_inbox;
CREATE TRIGGER trg_webhook_inbox_updated_at
  BEFORE UPDATE ON public.webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_outbox_events_updated_at ON public.outbox_events;
CREATE TRIGGER trg_outbox_events_updated_at
  BEFORE UPDATE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();

-- ============================================================
-- 3. Marketing Attribution Schema Enhancements
-- ============================================================

ALTER TABLE public.marketing_attribution
  ADD COLUMN IF NOT EXISTS integration_id uuid REFERENCES public.integrations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_direct boolean NOT NULL DEFAULT false;

ALTER TABLE public.marketing_attribution
  ALTER COLUMN touch_type SET DEFAULT 'first_touch';

-- ============================================================
-- 4. Hardened Tenant-Scoped Stuck-Job Recovery RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION public.reset_stuck_webhook_jobs(
  p_tenant_id uuid,
  p_timeout_minutes int DEFAULT 10
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role public.tenant_role;
  affected_count int;
BEGIN
  IF v_user_id IS NULL AND current_user != 'service_role' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate role if called by regular user
  IF v_user_id IS NOT NULL THEN
    v_role := public.get_user_tenant_role(p_tenant_id);
    IF v_role IS NULL OR v_role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager') THEN
      RAISE EXCEPTION 'Access denied: insufficient permissions to recover stuck jobs';
    END IF;
  END IF;

  -- Bound timeout parameter (minimum 2 minutes, max 1440 minutes / 24 hours)
  IF p_timeout_minutes < 2 THEN
    p_timeout_minutes := 2;
  ELSIF p_timeout_minutes > 1440 THEN
    p_timeout_minutes := 1440;
  END IF;

  UPDATE public.webhook_inbox
  SET status = 'received',
      next_attempt_at = now(),
      error_detail = COALESCE(error_detail, '') || ' [auto-recovered from stuck processing]',
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND status = 'processing'
    AND updated_at < (now() - (p_timeout_minutes || ' minutes')::interval);

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  -- Audit log recovery event
  IF affected_count > 0 AND v_user_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_tenant_id, v_user_id, 'recovery_webhook_jobs', 'webhook_inbox', NULL,
      jsonb_build_object('affected_count', affected_count, 'timeout_minutes', p_timeout_minutes));
  END IF;

  RETURN affected_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_stuck_webhook_jobs(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_stuck_outbox_jobs(
  p_tenant_id uuid,
  p_timeout_minutes int DEFAULT 10
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role public.tenant_role;
  affected_count int;
BEGIN
  IF v_user_id IS NULL AND current_user != 'service_role' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_user_id IS NOT NULL THEN
    v_role := public.get_user_tenant_role(p_tenant_id);
    IF v_role IS NULL OR v_role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager') THEN
      RAISE EXCEPTION 'Access denied: insufficient permissions to recover stuck jobs';
    END IF;
  END IF;

  IF p_timeout_minutes < 2 THEN
    p_timeout_minutes := 2;
  ELSIF p_timeout_minutes > 1440 THEN
    p_timeout_minutes := 1440;
  END IF;

  UPDATE public.outbox_events
  SET status = 'pending',
      next_attempt_at = now(),
      error_detail = COALESCE(error_detail, '') || ' [auto-recovered from stuck processing]',
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND status = 'processing'
    AND updated_at < (now() - (p_timeout_minutes || ' minutes')::interval);

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  IF affected_count > 0 AND v_user_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_tenant_id, v_user_id, 'recovery_outbox_jobs', 'outbox_events', NULL,
      jsonb_build_object('affected_count', affected_count, 'timeout_minutes', p_timeout_minutes));
  END IF;

  RETURN affected_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_stuck_outbox_jobs(uuid, int) TO authenticated;

-- ============================================================
-- 5. Notifications Hardening & Per-User Read Receipts
-- ============================================================

-- Table for tracking read receipts of broadcast and private notifications
CREATE TABLE IF NOT EXISTS public.notification_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_reads_user UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_lookup ON public.notification_reads(notification_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON public.notification_reads(user_id, tenant_id);

ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_notification_reads" ON public.notification_reads
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "insert_own_notification_reads" ON public.notification_reads
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Reconcile create_tenant_notification with actual tenant_role enum values
CREATE OR REPLACE FUNCTION public.create_tenant_notification(
  p_tenant_id uuid,
  p_user_id uuid,
  p_title text,
  p_message text,
  p_type text DEFAULT 'system',
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
  v_caller_role public.tenant_role;
  v_notification_id uuid;
BEGIN
  IF v_caller_id IS NULL AND current_user != 'service_role' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate caller membership & role in tenant if called by regular user
  IF v_caller_id IS NOT NULL THEN
    v_caller_role := public.get_user_tenant_role(p_tenant_id);

    IF v_caller_role IS NULL THEN
      RAISE EXCEPTION 'Access denied: not an active member of this tenant';
    END IF;

    -- Privileged alert types require admin, manager, or owner privileges
    IF p_type IN ('incident', 'system') AND v_caller_role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager', 'marketing_manager') THEN
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

-- Mark Single Notification As Read (supports broadcast and targeted notifications)
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
  v_notif record;
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

  SELECT * INTO v_notif
  FROM public.notifications
  WHERE id = p_notification_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_notif.user_id IS NULL THEN
    -- Broadcast notification: record per-user read receipt
    INSERT INTO public.notification_reads (notification_id, tenant_id, user_id, read_at)
    VALUES (p_notification_id, p_tenant_id, v_user_id, now())
    ON CONFLICT (notification_id, user_id) DO UPDATE SET read_at = now();
  ELSIF v_notif.user_id = v_user_id THEN
    -- Direct notification for this user
    UPDATE public.notifications
    SET read = true, read_at = now()
    WHERE id = p_notification_id AND tenant_id = p_tenant_id;

    INSERT INTO public.notification_reads (notification_id, tenant_id, user_id, read_at)
    VALUES (p_notification_id, p_tenant_id, v_user_id, now())
    ON CONFLICT (notification_id, user_id) DO NOTHING;
  ELSE
    RAISE EXCEPTION 'Access denied: cannot mark another user notification as read';
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid, uuid) TO authenticated;

-- Mark All Notifications As Read for Caller in Tenant
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
  v_affected int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = v_user_id AND tm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Access denied: not an active member of this tenant';
  END IF;

  -- 1. Mark personal unread notifications
  UPDATE public.notifications
  SET read = true, read_at = now()
  WHERE tenant_id = p_tenant_id
    AND user_id = v_user_id
    AND read = false;

  -- 2. Mark broadcast notifications by recording receipts in notification_reads
  INSERT INTO public.notification_reads (notification_id, tenant_id, user_id, read_at)
  SELECT n.id, n.tenant_id, v_user_id, now()
  FROM public.notifications n
  WHERE n.tenant_id = p_tenant_id
    AND n.user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.notification_reads nr
      WHERE nr.notification_id = n.id AND nr.user_id = v_user_id
    )
  ON CONFLICT (notification_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(uuid) TO authenticated;

-- ============================================================
-- 6. Dedicated Tenant Invitations Table & Safe Lifecycle
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role public.tenant_role NOT NULL DEFAULT 'sales_agent',
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'expired', 'revoked'
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_invitations_email UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_lookup ON public.tenant_invitations(tenant_id, email, status);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_email ON public.tenant_invitations(email, status);

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_tenant_invitations" ON public.tenant_invitations
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

CREATE POLICY "manage_tenant_invitations" ON public.tenant_invitations
  FOR ALL TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_memberships tm
      WHERE tm.user_id = auth.uid()
        AND tm.role IN ('tenant_owner', 'tenant_admin')
        AND tm.status = 'active'
    )
  );

-- Reconciled invite_user_to_tenant RPC (No zero-UUID foreign key violations!)
CREATE OR REPLACE FUNCTION public.invite_user_to_tenant(
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
  v_caller_role public.tenant_role;
  v_normalized_email text := lower(trim(p_user_email));
  v_existing_user_id uuid;
  v_existing_membership_id uuid;
  v_parsed_role public.tenant_role;
BEGIN
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  IF v_normalized_email = '' OR v_normalized_email NOT LIKE '%_@__%.__%' THEN
    RETURN jsonb_build_object('error', 'Invalid email address');
  END IF;

  -- Verify caller is tenant_owner or tenant_admin
  v_caller_role := public.get_user_tenant_role(p_tenant_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('tenant_owner', 'tenant_admin') THEN
    RETURN jsonb_build_object('error', 'Not authorized: only tenant owners and admins can invite users');
  END IF;

  -- Parse and validate role
  BEGIN
    v_parsed_role := p_role::public.tenant_role;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'Invalid role: ' || p_role);
  END;

  -- Check if user already exists in auth.users
  SELECT id INTO v_existing_user_id FROM auth.users WHERE email = v_normalized_email LIMIT 1;

  IF v_existing_user_id IS NOT NULL THEN
    -- Check if membership already exists
    SELECT id INTO v_existing_membership_id
    FROM public.tenant_memberships
    WHERE tenant_id = p_tenant_id AND user_id = v_existing_user_id;

    IF v_existing_membership_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'User is already a member of this workspace');
    END IF;

    -- Directly create active membership for existing auth user
    INSERT INTO public.tenant_memberships (user_id, tenant_id, role, status)
    VALUES (v_existing_user_id, p_tenant_id, v_parsed_role, 'active');

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_tenant_id, v_caller_id, 'user_added', 'tenant_membership', v_existing_user_id,
      jsonb_build_object('email', v_normalized_email, 'role', v_parsed_role));

    RETURN jsonb_build_object('success', true, 'status', 'added', 'email', v_normalized_email, 'role', v_parsed_role);
  ELSE
    -- Store clean record in tenant_invitations
    INSERT INTO public.tenant_invitations (tenant_id, email, role, invited_by, status, expires_at)
    VALUES (p_tenant_id, v_normalized_email, v_parsed_role, v_caller_id, 'pending', now() + interval '7 days')
    ON CONFLICT (tenant_id, email) DO UPDATE
      SET role = EXCLUDED.role,
          invited_by = EXCLUDED.invited_by,
          status = 'pending',
          expires_at = now() + interval '7 days',
          updated_at = now();

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_tenant_id, v_caller_id, 'user_invited', 'tenant_invitation', NULL,
      jsonb_build_object('email', v_normalized_email, 'role', v_parsed_role));

    RETURN jsonb_build_object('success', true, 'status', 'invited', 'email', v_normalized_email, 'role', v_parsed_role);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.invite_user_to_tenant(uuid, text, text) TO authenticated;
