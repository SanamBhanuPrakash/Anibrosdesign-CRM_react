-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 003
-- Domain: Webhook Ingestion, Outbox Queues, Attribution, Notifications, Observability
-- Standard PostgreSQL FIFO/Retry Tables with Idempotency & Per-User Read Receipts
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Queue Status Enums
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE webhook_status AS ENUM (
        'pending',
        'processing',
        'completed',
        'failed',
        'dead_letter'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE outbox_status AS ENUM (
        'pending',
        'processing',
        'completed',
        'failed',
        'dead_letter'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Webhook Inbox (Durable Inbound Queue)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_inbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status webhook_status NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_webhook_provider_event UNIQUE (provider, provider_event_id)
);

CREATE TRIGGER trg_webhook_inbox_updated_at
    BEFORE UPDATE ON webhook_inbox
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status ON webhook_inbox(status, attempts);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_tenant ON webhook_inbox(tenant_id);

-- ------------------------------------------------------------------------------
-- 3. Outbox Events (Durable Outbound Conversion Queue)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    provider TEXT NOT NULL,
    status outbox_status NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    response_status INTEGER,
    response_body TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_outbox_events_updated_at
    BEFORE UPDATE ON outbox_events
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_outbox_status_retry ON outbox_events(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox_events(tenant_id);

-- ------------------------------------------------------------------------------
-- 4. Marketing Attribution
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_attribution (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    touch_type TEXT NOT NULL DEFAULT 'first_touch',
    campaign TEXT,
    source TEXT,
    medium TEXT,
    ad_group TEXT,
    keyword TEXT,
    click_id TEXT,
    utm_content TEXT,
    is_direct BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_attribution_lead_tenant FOREIGN KEY (lead_id, tenant_id)
        REFERENCES leads(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attribution_tenant ON marketing_attribution(tenant_id);
CREATE INDEX IF NOT EXISTS idx_attribution_lead ON marketing_attribution(lead_id);
CREATE INDEX IF NOT EXISTS idx_attribution_campaign ON marketing_attribution(tenant_id, campaign);

-- ------------------------------------------------------------------------------
-- 5. Notifications & Per-User Read Receipts
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_target tenant_role,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'info',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user ON notifications(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_role ON notifications(tenant_id, role_target);

CREATE TABLE IF NOT EXISTS notification_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_notification_user_read UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id);

-- ------------------------------------------------------------------------------
-- 6. Operational Logs & SRE System Health
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    component TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error', 'fatal')),
    message TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operational_logs_component_severity ON operational_logs(component, severity);
CREATE INDEX IF NOT EXISTS idx_operational_logs_created ON operational_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_logs_correlation ON operational_logs(correlation_id);

CREATE TABLE IF NOT EXISTS system_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
    latency_ms INTEGER DEFAULT 0,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
