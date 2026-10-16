-- ==============================================================================
-- 022 · Automation engine, first template ("follow up every new lead")
-- Roadmap Slice 1 / decision D9. Additive only; nothing applied before is edited.
--
--  * automation_rules      += template, params, version  — a rule is an instance of a code-defined TEMPLATE (one per workspace per template)
--  * automation_executions += trigger_event_id, rule_version, attempts, summary — and a UNIQUE (rule_id, trigger_event_id):
--                             the database, not the code, guarantees one execution per rule per event, however often an event is replayed
--  * tasks                 += dedupe_key  — unique per workspace: a retried automation can never create a second follow-up task
--
-- Rows written by the retired legacy editor (template IS NULL) are left untouched and are never executed.
-- ==============================================================================

-- 1. rules -----------------------------------------------------------------------------------------------------------------
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS template text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS params   jsonb   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS version  integer NOT NULL DEFAULT 1;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- When the rule last became active. An event that happened BEFORE this moment is never processed, however late the worker gets to it.
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS active_since timestamptz;

DO $$ BEGIN
    ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_params_size CHECK (pg_column_size(params) <= 4096);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- one rule per template per workspace (archived rules do not block a fresh one)
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_rule_template
    ON automation_rules (tenant_id, template) WHERE template IS NOT NULL AND status <> 'archived';

-- 2. executions ------------------------------------------------------------------------------------------------------------
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS trigger_event_id bigint;
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS rule_version     integer;
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS attempts         integer NOT NULL DEFAULT 0;
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS summary          text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_execution_event
    ON automation_executions (rule_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_exec_entity
    ON automation_executions (tenant_id, trigger_entity_id, created_at DESC);

-- History is append-mostly: the application role may write and update an execution, never delete it.
REVOKE DELETE, TRUNCATE ON automation_executions FROM crm_app_user;

-- 3. tasks: exactly-once creation by automation ---------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_dedupe ON tasks (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ==============================================================================
-- END OF MIGRATION 022
-- ==============================================================================
