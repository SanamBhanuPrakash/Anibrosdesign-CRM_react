-- ==============================================================================
-- ANIBROS CRM — Native PostgreSQL Migration 015
-- Domain: Tasks v2 (reminders, recurrence, links) and in-app notifications
--
-- Reminder delivery design
--   Reminders are due-time events across ALL tenants, but the worker role must never read tenant data directly (RLS).
--   `app.dispatch_task_notifications()` is the single, narrow cross-tenant door: it claims due tasks with
--   FOR UPDATE SKIP LOCKED (N workers never double-send), stamps them, writes the notification and its domain event in the
--   same statement batch, and returns a count. EXECUTE is granted to the worker role only.
-- ==============================================================================

-- 1. Tasks ----------------------------------------------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind                 text NOT NULL DEFAULT 'todo';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS contact_id           uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by           uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by         uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_before_minutes integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_at            timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_sent_at     timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at  timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence           jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_root_id   uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version              integer NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at           timestamptz;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_kind;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_kind CHECK (kind IN ('todo', 'call', 'email', 'meeting', 'follow_up'));
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_remind;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_remind CHECK (remind_before_minutes IS NULL OR remind_before_minutes BETWEEN 0 AND 43200);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_recurrence;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_recurrence CHECK (recurrence IS NULL OR (
    jsonb_typeof(recurrence) = 'object' AND recurrence->>'freq' IN ('daily', 'weekly', 'monthly')
    AND (recurrence->>'interval')::int BETWEEN 1 AND 30));
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_title_len;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_title_len CHECK (length(btrim(title)) BETWEEN 1 AND 200);

-- contact link (composite FK keeps the tenant honest; SET NULL (column) leaves tenant_id alone)
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_task_contact_tenant;
ALTER TABLE tasks ADD CONSTRAINT fk_task_contact_tenant FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE SET NULL (contact_id);

DROP TRIGGER IF EXISTS trg_tasks_version ON tasks;
CREATE TRIGGER trg_tasks_version BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.bump_version();

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_open ON tasks (tenant_id, assigned_to, due_date, id) WHERE deleted_at IS NULL AND status IN ('pending', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_lead_open     ON tasks (tenant_id, lead_id) WHERE deleted_at IS NULL AND status IN ('pending', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_contact       ON tasks (tenant_id, contact_id) WHERE contact_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_created       ON tasks (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- worker queues (cross-tenant scans, so tiny partial indexes)
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_due  ON tasks (remind_at) WHERE reminder_sent_at IS NULL AND remind_at IS NOT NULL AND deleted_at IS NULL AND status IN ('pending', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_due   ON tasks (due_date)  WHERE overdue_notified_at IS NULL AND due_date IS NOT NULL AND deleted_at IS NULL AND status IN ('pending', 'in_progress');

-- 2. Notifications --------------------------------------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at     timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id   uuid;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link        text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key  text;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS ck_notification_link;
ALTER TABLE notifications ADD CONSTRAINT ck_notification_link CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%'));   -- in-app paths only, never external URLs
-- A logical notification is delivered once per recipient, however many times the producer retries. (Reminder keys include the
-- reminder time, so a task that is rescheduled legitimately notifies again.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON notifications (tenant_id, user_id, created_at DESC, id DESC);

-- 3. Cross-tenant dispatcher (worker only) ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.dispatch_task_notifications(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
    r record;
    v_id uuid;
    v_total integer := 0;
BEGIN
    -- reminders: due soon
    FOR r IN
        SELECT t.id, t.tenant_id, t.assigned_to, t.title, t.due_date, t.remind_at, t.lead_id
          FROM tasks t
         WHERE t.remind_at <= now() AND t.reminder_sent_at IS NULL AND t.deleted_at IS NULL
           AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL
         ORDER BY t.remind_at
         LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
    LOOP
        v_id := NULL;
        UPDATE tasks SET reminder_sent_at = now() WHERE id = r.id;
        INSERT INTO notifications (tenant_id, user_id, title, message, type, entity_type, entity_id, link, dedupe_key)
        VALUES (r.tenant_id, r.assigned_to, 'Task reminder', r.title || CASE WHEN r.due_date IS NOT NULL THEN ' · due ' || to_char(r.due_date AT TIME ZONE 'UTC', 'DD Mon HH24:MI') || ' UTC' ELSE '' END,
                'task_reminder', 'task', r.id, CASE WHEN r.lead_id IS NOT NULL THEN '/leads/' || r.lead_id ELSE '/tasks' END, 'task-reminder:' || r.id || ':' || floor(extract(epoch FROM r.remind_at))::bigint)
        ON CONFLICT DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
            INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id) VALUES (r.tenant_id, 'notification.created', 'notification', v_id);
        END IF;
        v_total := v_total + 1;
    END LOOP;

    -- overdue: past due and still open
    FOR r IN
        SELECT t.id, t.tenant_id, t.assigned_to, t.title, t.due_date, t.lead_id
          FROM tasks t
         WHERE t.due_date < now() AND t.overdue_notified_at IS NULL AND t.deleted_at IS NULL
           AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL
         ORDER BY t.due_date
         LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
    LOOP
        v_id := NULL;
        UPDATE tasks SET overdue_notified_at = now() WHERE id = r.id;
        INSERT INTO notifications (tenant_id, user_id, title, message, type, entity_type, entity_id, link, dedupe_key)
        VALUES (r.tenant_id, r.assigned_to, 'Task overdue', r.title, 'task_overdue', 'task', r.id,
                CASE WHEN r.lead_id IS NOT NULL THEN '/leads/' || r.lead_id ELSE '/tasks' END, 'task-overdue:' || r.id || ':' || floor(extract(epoch FROM r.due_date))::bigint)
        ON CONFLICT DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
            INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id) VALUES (r.tenant_id, 'notification.created', 'notification', v_id);
        END IF;
        v_total := v_total + 1;
    END LOOP;

    RETURN v_total;
END
$fn$;
-- Default privileges would hand EXECUTE to the API role (and PUBLIC): take it back, grant the worker only.
REVOKE ALL ON FUNCTION app.dispatch_task_notifications(integer) FROM PUBLIC, crm_app_user;
GRANT EXECUTE ON FUNCTION app.dispatch_task_notifications(integer) TO crm_worker;

-- 4. Lead version: derived columns (follow-up date follows the lead's tasks; last activity follows its timeline) must not
--    move the ETag a user's open edit form is holding.
CREATE OR REPLACE FUNCTION app.bump_lead_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at', 'next_followup_at', 'last_activity_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['lead_score', 'score_breakdown', 'version', 'updated_at', 'next_followup_at', 'last_activity_at']) THEN
        NEW.version := OLD.version + 1;
    ELSE
        NEW.version := OLD.version;
    END IF;
    RETURN NEW;
END
$fn$;
