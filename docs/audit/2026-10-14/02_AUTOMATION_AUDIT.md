# Audit 2026-10-14 · 02 — Automation engine

**Verdict: UI ONLY.** The Automation Rules screen collects a name, one trigger and one action from a dropdown and stores them in a settings blob. No code anywhere reads those rules, listens for the trigger, or performs the action. The database has tables for rules and executions and the platform has the infrastructure needed to build an engine (events, durable jobs, leases, retries), but **nothing connects them**.

Evidence: `evidence/automation_privileged.txt`, `evidence/automation_restricted.txt` (probe `audit_automation.mts`), `evidence/audit_ui.json` → `automation` (real browser run), source files cited below.

---

## 1. Architecture of what exists

```
 BROWSER  src/pages/settings/AutomationRulesPage.tsx          (legacy Bolt/Tailwind page)
    │  Create/Toggle/Delete = read whole tenant settings, edit a JS array, write the whole object back
    ▼
 PATCH /api/tenant/config   (routes/tenant.ts, owner/admin only)
    │  settings: z.record(any)   ← no schema, replaces the entire column
    ▼
 tenants.settings  JSON blob  ──►  key "automation_rules": [{ id, name, trigger_type, action_type, is_active, … }]
                                       │
                                       ✗  nothing reads this key (grep: only the page itself)

 ── unrelated, unused by any screen ─────────────────────────────────────────────────────────
 /api/automation  (routes/automation.ts, 4 pool.query calls)  ──►  table automation_rules      (migration 008)
                                                              ──►  table automation_executions (never written)
                                                              enum automation_trigger / automation_action_type (different vocabulary!)

 ── the pieces an engine would stand on (all working, none connected) ───────────────────────
 domain_events (emitted in the business transaction)  ─►  EventDispatcher (cursor, finished-tx only)
                                                          └─ worker.ts: eventConsumers = []        ← EMPTY
 jobs (leases, SKIP LOCKED, backoff, dead-letter)     ─►  worker.ts jobHandlers = { mail.send, leads.import, inbound.process }
                                                          └─ no 'automation.run'
```

## 2. Lifecycle trace (brief 1, Phase 1 items 1–7)

| # | Lifecycle step | What actually happens | Evidence |
|---|---|---|---|
| 1 | **Create / validate / persist** | The page stores `{trigger_type, action_type}` strings in the settings blob. The *server* validates nothing about them (`settings: z.record(z.string(), z.any())`; probe: `automation_rules: "not even a list"` is accepted and would crash the page on next load). The separate `/api/automation` route validates trigger names but accepts **any action `type` string and any `config`** | `routes/tenant.ts:253-257`; `routes/automation.ts:21-36`; probe `validate.unknownActionType` → **201** with `type: "drop_everything"` |
| 2 | **Edit / activate / deactivate** | Page rewrites the whole blob. Two admins saving at once: the last write erases the other's rules (probe `ui.lostUpdate.finalRules` = only the second rule). No version, no ETag | `AutomationRulesPage.tsx:76-147`, probe |
| 3 | **Trigger registration / event producers** | No registration exists. Some triggers have an event producer elsewhere in the system (see §3), but no listener. | `worker.ts:26-28` (`eventConsumers = []`) |
| 4 | **Match event to active rules in the right workspace** | Not implemented. | — |
| 5 | **Evaluate conditions** | The UI has no condition field; the backend schema accepts `conditions[]` (AND, 7 operators) but nothing evaluates it. | `routes/automation.ts:23-30` |
| 6 | **Execute the action** | Not implemented. Browser run: rule "Lead Created → Create Task" saved; a lead created; 20 s wait (worker ticks every 15 s, jobs poll every 2 s): **tasks before/after = 0 / 0**. DB: `automation_executions` = 0 rows, `jobs` of type `automation%` = 0, `run_count` = 0. | `audit_ui.json` (`tasksBeforeAfterNewLead: [0, 0]`), `automation_privileged.txt` |
| 7 | **Record result / show in UI** | The UI has no execution history. The API has `GET /api/automation/:id/executions` that always returns `[]`. | probe `crud.executions` |
| 8 | **Retry, recovery, duplicates, scheduling** | None (no executions to retry). | — |

## 3. Implementation matrix — triggers and actions the screen offers

Columns as requested: `Trigger/Action | UI Exists | Database/Persistence | Event Producer or Scheduler | Execution Handler | Failure Handling | Tests | Verified Status`.

### 3.1 Triggers

| Trigger (UI id) | UI | Persistence | Event producer / scheduler | Execution handler | Failure handling | Tests | Status |
|---|---|---|---|---|---|---|---|
| **Lead Created** (`lead_created`) | yes | blob (UI) · enum `lead_created` (API) | **exists**: `emit(tx, 'lead.created')` in `modules/leads/service.ts createInTx` (also from CSV import and from lead sources, same method) | none | none | none for automation; event emission itself covered by `leads.test.ts` | **UI ONLY** (producer ready) |
| **Stage Changed** (`stage_changed`; API enum is `lead_stage_changed`) | yes | blob · enum (different spelling) | **exists**: `lead.stage_changed` in the single stage-change method (API, bulk, import use it) | none | none | none | **UI ONLY** (producer ready) |
| **Task Overdue** (`task_overdue`) | yes | blob · enum | **partial**: overdue detection exists inside `app.dispatch_task_notifications()` (worker tick) but it only inserts a *notification* and stamps `overdue_notified_at`; it emits **no `task.overdue` domain event** | none | none | overdue notification itself tested (`tasks.test.ts`) | **UI ONLY** (needs a producer) |
| **Lead Inactive** (`inactivity`) | yes | blob · **no such enum value** in the API | **none**: `leads.last_activity_at` is maintained, but no job queries "no activity for N days" | none | none | none | **UI ONLY** |
| **Property Match Found** (`property_match`) | yes | blob · **no such enum value** | **none**: matching is an on-demand request (`POST /api/properties/match`), no new-property → matching-leads pass, no event | none | none | none | **UI ONLY** |
| **Scheduled** (`schedule`; API enum is `time_based`) | yes (no schedule input at all) | blob · enum, **no cron/interval/timezone column** | **none**: the worker tick (15 s) only calls the task-notification function and queue gauges; maintenance every 6 h | none | none | none | **UI ONLY** |

### 3.2 Actions

| Action (UI id) | UI | Persistence of parameters | Capability that exists to build on | Execution handler | Failure handling | Tests | Status |
|---|---|---|---|---|---|---|---|
| **Assign Lead** | yes, **no parameters** (who? which rule?) | none | `LeadsService` assignment incl. balanced picker with advisory serialisation (`leads/service.ts pickBalancedOwner`) | none | none | assignment itself tested (`leads.test.ts`) | **UI ONLY** |
| **Send Notification** | yes, **no parameters** (to whom? what text?) | none | `platform/notifications.ts notify()` with unique `dedupe_key` | none | none | notify tested via tasks | **UI ONLY** |
| **Create Task** | yes, **no parameters** (title, due, owner) | none | `TasksService.create` (reminders, recurrence) | none | none | tested via `tasks.test.ts` | **UI ONLY** |
| **Update Field** | yes, **no parameters** (which field, which value?) | none | `LeadsService.update` (ETag); custom fields exist but are not wired to any entity screen | none | none | — | **UI ONLY** |
| **Send WhatsApp** | yes | none | **nothing**: no provider adapter, templates, 24-hour window, consent check, status webhooks | none | none | — | **NOT IMPLEMENTED** · **EXTERNAL ACCOUNT REQUIRED** (WhatsApp Business) |
| **Send Email** | yes | none | transactional account e-mail only (`platform/mail`, `mail.send` job); no CRM templates, merge fields, tracking, unsubscribe, consent enforcement | none | account-mail retries exist | account mail tested | **NOT IMPLEMENTED** for CRM e-mail · real SMTP **EXTERNAL** |
| **Change Stage** | yes, **no parameters** (to which stage?) | none | the single stage-change method (rules, required fields, history, event) is explicitly designed for automation callers | none | none | tested via API | **UI ONLY** |

**Vocabulary mismatch** (a rule created in the UI could never be loaded by the API even if it were wired): UI `stage_changed / inactivity / property_match / schedule` vs API `lead_stage_changed / — / — / time_based`; UI `send_notification / update_field / change_stage` vs API `notify_agent / — / change_lead_stage`; API has actions the UI lacks (`send_sms`, `add_tag`, `remove_tag`, `webhook_call`) and triggers the UI lacks (`viewing_*`, `task_completed`, `contact_created`, `lead_status_changed`).

## 4. Reliability and security review (brief 1, Phase 2)

| # | Area | Finding | Evidence / status |
|---|---|---|---|
| 4.1 | **Tenant isolation, DB and server** | Tables have RLS (migration 008). The API process reads/writes them with `pool.query` **without tenant context**. *Privileged role*: RLS is bypassed and only the hand-written `WHERE tenant_id = $n` protects (cross-tenant PATCH/DELETE/executions → 404 ✓). *Restricted (production) role*: **create works, then list returns `[]`, PATCH and DELETE return 404, executions `[]`** — the feature cannot be used under the role production requires | `automation_restricted.txt` (`crud.list: []`, `crud.patch: 404`, `crud.delete: 404`) · **BROKEN** (restricted) |
| 4.2 | **Role permissions** | Three lists disagree (backend `[owner, admin, sales_manager]`, central matrix `automation:manage = [owner, admin, marketing_manager]`, UI = matrix). Probe: `sales_manager` POST /api/automation **201** (matrix says no); `marketing_manager` **403** (matrix says yes); the UI's real write path (PATCH tenant config) is owner/admin only → every non-admin gets 403 and the page only `console.error`s. The `automation:*` permissions are **unused** by any route. Delete is a soft *archive* with no separate permission check beyond the same list | `routes/automation.ts:10-11`, `matrix.ts:106-108`, `use-permissions.ts:38`, probe `roles` · **BROKEN** (inconsistent) |
| 4.3 | **Who would a rule run as?** | Undefined. An engine must not run actions with the creating admin's privileges forever (privilege retention) nor as an unbounded superuser. Proposal in §6: a *system actor* restricted to the rule's declared action allow-list. | design gap |
| 4.4 | **Atomicity: lead creation + event** | `emit()` writes `domain_events` inside the business transaction; consumers read only transactions that have finished (`tx_id < pg_snapshot_xmin`), so a rolled-back lead produces no event and a late commit is not skipped | `platform/events/index.ts`; `platform-db.test.ts` ("late commit", "rolled back") · **VERIFIED WORKING** |
| 4.5 | **Durable execution and worker recovery** | Jobs: leases, heartbeat, reaper, ownership-checked completion, dead-letter; event consumers: cursor row lock. All tested **for existing job types**. Automation does not use them. | `platform-db.test.ts` · infrastructure **VERIFIED**, automation **NOT IMPLEMENTED** |
| 4.6 | **Idempotency per action** | No executions exist, so none. Building blocks: notifications have a unique `dedupe_key` ✓; tasks have none (a retried "create task" would duplicate); assignment is naturally idempotent; e-mail/WhatsApp **cannot** be exactly-once (provider semantics) — they must be recorded as *at-least-once, outcome possibly unknown*. | design gap |
| 4.7 | **Bounded retries, backoff, permanent failure** | Platform job runner provides exponential backoff with full jitter, max attempts, `PermanentJobError`, dead-letter, activity-log entry on permanent failure ✓. Not wired to automation. | `platform/jobs/index.ts` |
| 4.8 | **Concurrent workers** | `FOR UPDATE SKIP LOCKED` claims and cursor locks tested (60 jobs × 2 runners exactly once) | `platform-db.test.ts` · **VERIFIED** (infra) |
| 4.9 | **Scheduled execution, time zones, duplicate prevention** | No scheduler for rules. Reusable precedent: `app.dispatch_task_notifications` (set-based, `SKIP LOCKED`, dedupe keys including the due epoch) and DST-safe `addInZone` for recurrence in the workspace zone (`tenants.timezone` column — **not** the `settings.timezone` the Tenant Configuration page writes) | `tasks-units.test.ts` · scheduler **NOT IMPLEMENTED** |
| 4.10 | **Rule disabled while executions are pending** | Undefined (nothing pending). Required rule: re-read the rule at execution time; a pending execution of a paused/archived rule becomes `skipped` with the reason; one already running finishes its current action and stops. | design gap |
| 4.11 | **Rule edited while an older execution runs** | Undefined. Required: immutable rule *versions*; an execution pins the version it started with. The legacy table has no version column. | design gap |
| 4.12 | **Parameter validation** | `actions[].type` is an unconstrained string; `config` is any JSON; **500 actions accepted** in one rule; PATCH accepts `actions: z.array(z.any())` (no validation at all). Nothing prevents unsafe future parameters (URLs, templates). | probe `validate.*` → all **201** |
| 4.13 | **Credentials / sensitive payloads** | Rules hold none today. The sibling legacy Integrations API stores arbitrary `config` and **returns it in clear** (`GET returns the token in clear? true` in privileged mode); `credentials_enc` is never written while the response claims `hasCredentials: true`. Any engine action that calls a provider must take credentials from the encrypted store (`platform/crypto`), never from rule JSON. | `evidence/legacy_privileged.txt` `integrations` section · **BROKEN** |
| 4.14 | **WhatsApp/e-mail consent, templates, provider failure** | None of it exists. Consent *records* exist (`communication_consents`); no code consults them before sending because nothing sends. | NOT IMPLEMENTED |
| 4.15 | **Audit, history, metrics, operational recovery** | `automation_executions` has the right shape (status, `actions_run`, `execution_log`, timestamps) but is **never written**; rule create/update/delete write **no audit entries**; no metrics; no UI. The new Monitor (activity log, job-queue check) would surface engine failures once jobs exist. | `routes/automation.ts` (no `audit()`), probe |
| 4.16 | **Runaway rules, loops, quotas** | None. A self-triggering rule is accepted today (`stage_changed → change_lead_stage` → **201**). Needed: event *causation chain* (`origin_execution_id` + depth), max depth (e.g. 3), per-rule dedupe window, per-workspace executions-per-hour quota, global kill switch. | probe `selfTriggeringRule` · design gap |
| 4.17 | **Exactly-once external delivery** | Not claimed anywhere and must not be. Outbound actions are *at-least-once with idempotency keys where the provider supports them; otherwise "outcome unknown" is a recorded state requiring reconciliation* (`04` §4.3). | policy |

## 5. Tests and evidence

**Executed:** full suite (22 files; 451 tests passed in the final run), typecheck, lint, `audit_automation.mts` in both database-role modes, and a real-browser run of the screen (`audit_ui.cjs`). **No existing test covers the automation feature**; the only automation-named tests are permission-matrix rows in `authz.test.ts` (matrix values, not behaviour).

| # | Scenario required by the brief | Exists? | Test type to add | Where |
|---|---|---|---|---|
| 1 | trigger → action effect (lead created → task exists, owner assigned) | no | database integration (restricted roles + worker) | `server/src/tests/automation.test.ts` |
| 2 | one event matches several rules (deterministic order, independent results) | no | integration | same |
| 3 | duplicate event delivery (consumer replay) → one execution | no | integration | same |
| 4 | concurrent workers on the same event | no | integration (2 runners) | same |
| 5 | temporary vs permanent action failure (retry with backoff vs `failed`, dead-letter, activity-log row) | no | integration with a failing action stub | same |
| 6 | worker crash mid-execution → resumes without duplicating completed actions | no | integration (lease expiry, as `platform-db` does for jobs) | same |
| 7 | scheduled trigger and overdue tasks across a DST change | no | unit (clock) + integration | `automation-units.test.ts`, same |
| 8 | disabled rule with pending executions; rule edited mid-run | no | integration | same |
| 9 | cross-tenant isolation, least privilege (agent cannot manage; rule cannot act on another tenant; system actor limited to declared actions) | no | integration | same |
| 10 | external provider failure and idempotency (timeout with unknown outcome) | no (no provider action yet) | provider-contract test with a fake | with Slice 4 |
| 11 | execution-history accuracy (counts, status, log reconcile with effects) | no | integration | same |
| 12 | browser: create rule → cause event → observe effect and history | partially: my `audit_ui.cjs` proves the **negative** today | browser (repo-resident Playwright) | `e2e/automation.spec.ts` |

Classification: 1–9, 11 integration; 7 also unit; 12 browser; 10 contract (fake provider). **Live-provider tests: none can exist until credentials are supplied (⛔).**

## 6. Smallest safe change to make one internal automation reliable (recommendation; **not started**)

**Target automation:** *"When a lead is created: assign it to the least-loaded salesperson, create a task 'Call within 15 minutes', and notify the owner."* (This is the first thing a real-estate team wants and it exercises event → job → three actions → history.)

Reuse, do not rebuild: `domain_events` + `EventDispatcher`, `jobs`, `LeadsService` assignment, `TasksService`, `notify()`, `audit()`, the existing `automation_rules` / `automation_executions` tables.

1. **Migration 021 (additive):** `automation_rules` += `version int`, `template text`, `params jsonb` (typed, ≤ 4 KB), `deleted_at`; `automation_executions` += `trigger_event_id bigint`, `rule_version int`, `attempts int`, `causation_depth smallint`; **unique `(rule_id, trigger_event_id)`** (the duplicate guard); RLS and grants as for other tenant tables (`REVOKE ALL` then explicit grants — the default-privilege trap).
2. **Event consumer `automation`** (in `worker.ts`): for `lead.created` it finds the workspace's active rules for that trigger and, **inside the cursor transaction and with no external I/O**, enqueues `automation.run` with `dedupe_key = auto:{rule}:{event}`.
3. **Job handler `automation.run`**: in a tenant transaction — re-read the rule (status/version), insert the execution row (`ON CONFLICT DO NOTHING` → already handled → stop), run the typed actions in order with a **system actor** limited to {assign, create task, notify}, give each task and notification a dedupe key derived from `(execution, action index)`, write `execution_log`, mark `completed` / `failed`; transient errors throw (runner retries with backoff); permanent errors mark `failed` with a plain reason and an activity-log entry.
4. **v1 routes** `/api/v1/automations` (zod discriminated union with exactly the supported trigger/action set and parameter schemas; `automation:read|manage` from the central matrix; audit entries; execution history endpoint). Retire `/api/automation` and the blob.
5. **UI:** replace the page with a *template picker* offering this one template (with the parameters it needs: assignment mode, task title, minutes) and a real **execution history** table (status, time, what it did, why it failed, Retry). Remove the blob and the green "active" until a rule has actually executed at least once.
6. **Tests:** scenarios 1, 3, 4, 5, 6, 8, 9, 11 above plus the browser journey.

Acceptance: a lead created by hand, by CSV import and by a Meta/Google/website delivery each produce exactly one execution with its three effects; replaying the event, restarting the worker mid-run, or running two workers produces no duplicate task/notification; pausing the rule stops new executions; another workspace's rules never fire; the execution appears in the UI and in the audit trail.

Size: small–medium (about the size of the Lead sources work). Dependencies: none beyond the legacy-route decision in `07` (the engine must not be built on `pool.query`).
