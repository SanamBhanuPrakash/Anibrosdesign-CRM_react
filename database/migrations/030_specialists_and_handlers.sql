-- ==============================================================================
-- 030  Specialist employees and shared leads
--
-- An agency has generalists (calls, follow-ups, everything) and specialists (only calls, only WhatsApp, only Instagram messages, only
-- site visits). Two small additions make that real:
--   * tenant_memberships.work_channels: which kinds of work this person may log inside this client. NULL = everything (the default).
--   * lead_handlers: people who work ON a lead without owning it (the owner stays accountable). A handler sees the lead and logs the work
--     they are allowed to log; they cannot edit, move or reassign it.
-- Instagram messages get their own activity type.
-- ==============================================================================

ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'instagram';

ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS work_channels text[];
ALTER TABLE tenant_memberships DROP CONSTRAINT IF EXISTS ck_tm_work_channels;
ALTER TABLE tenant_memberships ADD CONSTRAINT ck_tm_work_channels CHECK (
    work_channels IS NULL
    OR (work_channels <@ ARRAY['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting']::text[] AND cardinality(work_channels) BETWEEN 1 AND 6));

CREATE TABLE IF NOT EXISTS lead_handlers (
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id    uuid NOT NULL,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (lead_id, user_id),
    CONSTRAINT fk_lead_handler_lead FOREIGN KEY (lead_id, tenant_id) REFERENCES leads(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_handlers_user ON lead_handlers (tenant_id, user_id);

ALTER TABLE lead_handlers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_lead_handlers ON lead_handlers;
CREATE POLICY tenant_isolation_lead_handlers ON lead_handlers FOR ALL TO crm_app_user
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_handlers TO crm_app_user;

-- ==============================================================================
-- END OF MIGRATION 030
-- ==============================================================================
