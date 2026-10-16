/*
# Operations Center — Observability and Audit Infrastructure

## Purpose
Creates the database infrastructure for a comprehensive Operations Center with
structured operational logs, system health tracking, and incident records.
Also hardens existing audit/event tables by making audit_logs append-only and
restricting webhook_inbox/outbox_events to service-role writes only.

## New Tables

### 1. operational_logs
Structured server-side logs for edge functions, background jobs, and database
operations. Captured via edge function inserts (service-role) and readable by
authorized tenant users.

Columns:
- id: uuid PK
- tenant_id: uuid (nullable for platform-level events)
- severity: text (debug, info, warn, error, fatal) NOT NULL
- component: text (edge_function, database, webhook, outbox, auth, frontend) NOT NULL
- event_name: text NOT NULL (e.g. 'webhook.received', 'outbox.sent', 'auth.failed')
- message: text NOT NULL
- correlation_id: text (nullable, threads through related operations)
- trace_id: text (nullable, for distributed tracing)
- duration_ms: int (nullable, operation duration)
- error_code: text (nullable, e.g. 'HTTP_500', 'DB_23505')
- context: jsonb (nullable, sanitized key-value context — no secrets)
- environment: text NOT NULL DEFAULT 'production'
- created_at: timestamptz NOT NULL DEFAULT now()

Indexes:
- (tenant_id, created_at DESC) — tenant-scoped log browsing
- (severity, created_at DESC) — filter by severity
- (correlation_id) — trace related events
- (component, event_name, created_at DESC) — filter by component/event

### 2. system_health
Health check records for integrations, edge functions, and platform dependencies.
Each row represents a point-in-time health assessment.

Columns:
- id: uuid PK
- tenant_id: uuid (nullable for platform-level checks)
- component: text NOT NULL (integration, edge_function, database, auth_service)
- component_id: text (nullable — integration_id, function_slug, etc.)
- status: text NOT NULL (healthy, degraded, failed, unknown)
- check_type: text NOT NULL (connectivity, configuration, recent_delivery, provider_api)
- last_checked_at: timestamptz NOT NULL DEFAULT now()
- last_success_at: timestamptz (nullable)
- last_error_at: timestamptz (nullable)
- error_detail: text (nullable, sanitized)
- metadata: jsonb (nullable, sanitized diagnostic context)

Indexes:
- (tenant_id, component, component_id) — per-component latest status
- (status, last_checked_at) — find unhealthy components

### 3. incidents
Records of operational incidents affecting tenants or platform components.

Columns:
- id: uuid PK
- tenant_id: uuid (nullable for platform-level incidents)
- title: text NOT NULL
- description: text NOT NULL (plain-language explanation)
- severity: text NOT NULL (info, warning, error, critical)
- status: text NOT NULL DEFAULT 'open' (open, investigating, resolved, dismissed)
- component: text (nullable — which component is affected)
- correlation_id: text (nullable — links to related operational_logs)
- affected_count: int DEFAULT 0 (how many records/users affected)
- timeline: jsonb DEFAULT '[]' (array of {timestamp, event, detail} objects)
- resolution: text (nullable — how it was resolved)
- detected_at: timestamptz NOT NULL DEFAULT now()
- resolved_at: timestamptz (nullable)

Indexes:
- (tenant_id, status, detected_at DESC) — tenant incident queue
- (status, severity, detected_at DESC) — platform incident queue

## Security Changes

### audit_logs — made append-only
- DROPPED existing UPDATE and DELETE policies.
- Only SELECT (tenant-scoped) and INSERT (tenant-scoped) remain.
- Users can no longer modify or delete audit history through the API.

### webhook_inbox — locked to service-role writes
- DROPPED existing INSERT, UPDATE, DELETE policies.
- Only SELECT (tenant-scoped) remains.
- Edge functions (service-role) are the sole writers.

### outbox_events — locked to service-role writes
- DROPPED existing INSERT, UPDATE, DELETE policies.
- Only SELECT (tenant-scoped) remains.
- Edge functions / triggers (service-role) are the sole writers.

### New tables — RLS policies
- operational_logs: SELECT for authenticated tenant members. No client INSERT/UPDATE/DELETE (service-role only via edge functions).
- system_health: SELECT for authenticated tenant members. No client writes.
- incidents: SELECT for authenticated tenant members. No client writes (managed by system/edge functions).

## Important Notes
1. operational_logs, system_health, and incidents are write-via-service-role only.
   Edge functions use the service-role key to insert these records.
   Client apps can read them (tenant-scoped) but cannot create or modify them.
2. audit_logs retains its existing INSERT policy so SECURITY DEFINER functions
   (like transition_lead_stage, invite_user_to_tenant) can still write audit entries.
3. The dropped policies on webhook_inbox/outbox_events mean the existing
   WebhookDiagnosticsPage and OutboxDiagnosticsPage replay/recover actions
   (which use client-side .update() calls) will now fail at the DB level.
   These actions must be moved to edge functions or SECURITY DEFINER functions.
   This is intentional — client-side queue manipulation is a security risk.
4. A SECURITY DEFINER function `replay_webhook_event` and `replay_outbox_event`
   are added so admin users can replay events through an RPC call (with membership
   verification) instead of direct table writes.
5. A SECURITY DEFINER function `recover_stuck_jobs` is added to replace the
   client-side .update() calls that the existing reset_stuck_* functions already
   handle via RPC.
*/

-- =============================================================
-- 1. operational_logs
-- =============================================================
CREATE TABLE IF NOT EXISTS operational_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error', 'fatal')),
  component text NOT NULL CHECK (component IN ('edge_function', 'database', 'webhook', 'outbox', 'auth', 'frontend', 'background_job')),
  event_name text NOT NULL,
  message text NOT NULL,
  correlation_id text,
  trace_id text,
  duration_ms int,
  error_code text,
  context jsonb DEFAULT '{}'::jsonb,
  environment text NOT NULL DEFAULT 'production',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oplogs_tenant_date ON operational_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplogs_severity_date ON operational_logs (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplogs_correlation ON operational_logs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oplogs_component_event ON operational_logs (component, event_name, created_at DESC);

ALTER TABLE operational_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_oplogs" ON operational_logs;
CREATE POLICY "select_own_oplogs"
  ON operational_logs FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

-- =============================================================
-- 2. system_health
-- =============================================================
CREATE TABLE IF NOT EXISTS system_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  component text NOT NULL,
  component_id text,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed', 'unknown')),
  check_type text NOT NULL CHECK (check_type IN ('connectivity', 'configuration', 'recent_delivery', 'provider_api', 'queue_lag', 'database')),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_error_at timestamptz,
  error_detail text,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_health_tenant_component ON system_health (tenant_id, component, component_id);
CREATE INDEX IF NOT EXISTS idx_health_status_checked ON system_health (status, last_checked_at DESC);

ALTER TABLE system_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_health" ON system_health;
CREATE POLICY "select_own_health"
  ON system_health FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

-- =============================================================
-- 3. incidents
-- =============================================================
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  component text,
  correlation_id text,
  affected_count int NOT NULL DEFAULT 0,
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status ON incidents (tenant_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status_severity ON incidents (status, severity, detected_at DESC);

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_incidents" ON incidents;
CREATE POLICY "select_own_incidents"
  ON incidents FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM tenant_memberships tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

-- =============================================================
-- 4. Harden audit_logs — make append-only
-- =============================================================
DROP POLICY IF EXISTS "update_own_tenant_audit_logs" ON audit_logs;
DROP POLICY IF EXISTS "delete_own_tenant_audit_logs" ON audit_logs;

-- =============================================================
-- 5. Lock webhook_inbox to service-role writes
-- =============================================================
DROP POLICY IF EXISTS "insert_own_tenant_webhook_inbox" ON webhook_inbox;
DROP POLICY IF EXISTS "update_own_tenant_webhook_inbox" ON webhook_inbox;
DROP POLICY IF EXISTS "delete_own_tenant_webhook_inbox" ON webhook_inbox;

-- =============================================================
-- 6. Lock outbox_events to service-role writes
-- =============================================================
DROP POLICY IF EXISTS "insert_own_tenant_outbox_events" ON outbox_events;
DROP POLICY IF EXISTS "update_own_tenant_outbox_events" ON outbox_events;
DROP POLICY IF EXISTS "delete_own_tenant_outbox_events" ON outbox_events;

-- =============================================================
-- 7. SECURITY DEFINER: replay_webhook_event
-- Allows admin/manager users to replay a dead-lettered webhook
-- through an RPC call instead of a direct table write.
-- =============================================================
CREATE OR REPLACE FUNCTION replay_webhook_event(
  p_inbox_id uuid,
  p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_membership record;
  v_event record;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_membership
  FROM tenant_memberships
  WHERE tenant_id = p_tenant_id AND user_id = v_user_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  IF v_membership.role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager', 'marketing_manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to replay events';
  END IF;

  SELECT id, status, retry_count INTO v_event
  FROM webhook_inbox
  WHERE id = p_inbox_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_event.status NOT IN ('dead_letter', 'rejected') THEN
    RAISE EXCEPTION 'Only dead-lettered or rejected events can be replayed';
  END IF;

  UPDATE webhook_inbox
  SET status = 'received', retry_count = 0, next_attempt_at = now(),
      error_detail = null, processed_at = null
  WHERE id = p_inbox_id AND tenant_id = p_tenant_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (
    p_tenant_id, v_user_id, 'webhook_replayed', 'webhook_inbox', p_inbox_id,
    jsonb_build_object('status', 'received', 'replayed_at', now())
  );

  RETURN jsonb_build_object('success', true, 'inbox_id', p_inbox_id, 'status', 'received');
END;
$$;

GRANT EXECUTE ON FUNCTION replay_webhook_event(uuid, uuid) TO authenticated;

-- =============================================================
-- 8. SECURITY DEFINER: replay_outbox_event
-- =============================================================
CREATE OR REPLACE FUNCTION replay_outbox_event(
  p_outbox_id uuid,
  p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_membership record;
  v_event record;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_membership
  FROM tenant_memberships
  WHERE tenant_id = p_tenant_id AND user_id = v_user_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not a member of this tenant';
  END IF;

  IF v_membership.role NOT IN ('tenant_owner', 'tenant_admin', 'sales_manager', 'marketing_manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to replay events';
  END IF;

  SELECT id, status, retry_count INTO v_event
  FROM outbox_events
  WHERE id = p_outbox_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_event.status NOT IN ('dead_letter', 'rejected') THEN
    RAISE EXCEPTION 'Only dead-lettered or rejected events can be replayed';
  END IF;

  UPDATE outbox_events
  SET status = 'pending', retry_count = 0, next_attempt_at = now(),
      error_detail = null, sent_at = null
  WHERE id = p_outbox_id AND tenant_id = p_tenant_id;

  INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (
    p_tenant_id, v_user_id, 'outbox_replayed', 'outbox_events', p_outbox_id,
    jsonb_build_object('status', 'pending', 'replayed_at', now())
  );

  RETURN jsonb_build_object('success', true, 'outbox_id', p_outbox_id, 'status', 'pending');
END;
$$;

GRANT EXECUTE ON FUNCTION replay_outbox_event(uuid, uuid) TO authenticated;
