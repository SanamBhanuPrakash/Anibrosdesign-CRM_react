-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 006
-- Domain: Native Email Verification & Auth Subsystem Hardening
-- Independent of Supabase Auth / Gotrue / External Auth Services
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Email Verification Tokens Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_active ON email_verification_tokens(expires_at) WHERE used_at IS NULL;

-- ------------------------------------------------------------------------------
-- 2. Principle of Least Privilege Grants for Application Runtime Role
-- ------------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON email_verification_tokens TO crm_app_user;
    END IF;
END $$;
