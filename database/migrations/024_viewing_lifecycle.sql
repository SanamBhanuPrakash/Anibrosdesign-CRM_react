-- ==============================================================================
-- 024 · Viewing lifecycle (roadmap Slice 3)
--
-- A viewing can now be rescheduled, cancelled, completed (with an outcome) or marked no-show, and each viewing has a real reminder
-- TASK. Additive only: existing viewings keep their status and become version 1 with no outcome and no reminder.
--   version           ETag for optimistic concurrency (If-Match) on reschedule
--   outcome_code      what happened at a completed visit (fixed list, in code), outcome_note is free text
--   closed_at         when it was completed / cancelled / marked no-show
--   cancel_reason     optional, free text
--   reminder_task_id  the task that reminds the agent; its due date follows the viewing
-- ==============================================================================

ALTER TABLE viewings ADD COLUMN IF NOT EXISTS version          integer NOT NULL DEFAULT 1;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS outcome_code     text;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS outcome_note     text;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS closed_at        timestamptz;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS cancel_reason    text;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS reminder_task_id uuid;

DO $$ BEGIN
    ALTER TABLE viewings ADD CONSTRAINT ck_viewings_outcome_code CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z][a-z0-9_]{1,39}$');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TABLE viewings ADD CONSTRAINT ck_viewings_text_len CHECK (coalesce(length(outcome_note), 0) <= 1000 AND coalesce(length(cancel_reason), 0) <= 500);
EXCEPTION WHEN duplicate_object THEN null; END $$;
-- the reminder task belongs to the same workspace (composite FK, like every other cross-table reference)
DO $$ BEGIN
    ALTER TABLE tasks ADD CONSTRAINT uq_task_tenant_composite UNIQUE (id, tenant_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;
DO $$ BEGIN
    ALTER TABLE viewings ADD CONSTRAINT fk_viewing_reminder_task_tenant FOREIGN KEY (reminder_task_id, tenant_id) REFERENCES tasks(id, tenant_id) ON DELETE SET NULL (reminder_task_id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- "what is on my calendar this week": by agent and time, and by lead
CREATE INDEX IF NOT EXISTS idx_viewings_agent_time ON viewings (tenant_id, agent_id, scheduled_at) WHERE status IN ('scheduled', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_viewings_lead ON viewings (tenant_id, lead_id, scheduled_at DESC);

-- ==============================================================================
-- END OF MIGRATION 024
-- ==============================================================================
