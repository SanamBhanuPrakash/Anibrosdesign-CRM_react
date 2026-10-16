-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 016
-- A lead's version is the ETag behind optimistic concurrency ("someone else changed this while you were editing").
-- Columns that merely FOLLOW other activity must not move it, or logging a call would make a colleague's open edit form
-- fail with 412: score, last activity, follow-up date (015) and now the first-response timestamp (set by the first
-- logged call or the first stage move).
-- ==============================================================================
CREATE OR REPLACE FUNCTION app.bump_lead_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at', 'next_followup_at', 'last_activity_at', 'first_response_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at', 'next_followup_at', 'last_activity_at', 'first_response_at']) THEN
        NEW.version := OLD.version + 1;
    ELSE
        NEW.version := OLD.version;
    END IF;
    RETURN NEW;
END
$fn$;
