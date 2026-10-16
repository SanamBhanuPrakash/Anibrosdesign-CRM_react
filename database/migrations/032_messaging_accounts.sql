-- ==============================================================================
-- 032  Messaging accounts: a client's own WhatsApp Business number
--
-- E-mail goes out through the platform's mail server (the client's name as the sender, the employee as reply-to), so it needs no
-- per-client setup. WhatsApp needs the client's own WhatsApp Business (Cloud API) number: the phone number id and an access token.
-- The token is stored encrypted and is never returned by the API. One account per channel per client workspace.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS messaging_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel       text NOT NULL CHECK (channel IN ('whatsapp')),
    display_phone text,
    phone_number_id text NOT NULL CHECK (char_length(phone_number_id) BETWEEN 5 AND 40),
    token_enc     text NOT NULL,
    token_hint    text,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    last_error    text,
    last_sent_at  timestamptz,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_messaging_account UNIQUE (tenant_id, channel)
);
DROP TRIGGER IF EXISTS trg_messaging_accounts_updated_at ON messaging_accounts;
CREATE TRIGGER trg_messaging_accounts_updated_at BEFORE UPDATE ON messaging_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE messaging_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_messaging_accounts ON messaging_accounts;
CREATE POLICY tenant_isolation_messaging_accounts ON messaging_accounts FOR ALL TO crm_app_user
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON messaging_accounts FROM crm_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON messaging_accounts TO crm_app_user;
-- ==============================================================================
-- END OF MIGRATION 032
-- ==============================================================================
