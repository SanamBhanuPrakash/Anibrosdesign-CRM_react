# Audit 2026-10-14 · 09 — Slice 1 acceptance (first real automation)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Scope: decision D9, `02_AUTOMATION_AUDIT.md` §6. Design record: `docs/adr/004_automation_engine.md`.
Result: **delivered.** E-mail and WhatsApp actions were not built or enabled (no accounts, no real implementations).

## What was built

"Follow up every new lead", a code-defined template a workspace admin turns on or off:
when a lead is created (by hand, CSV import or a lead source) it keeps an explicitly assigned owner or applies the workspace assignment rule when there is none,
creates exactly one call task due within the workspace first-reply time, and notifies the assigned salesperson.
Migration 022, `server/src/modules/automation/` (templates, engine, service, routes, jobs), `/api/v1/automations`, a real Automation page with run history and Retry, and two new fields on Workspace settings (who gets a new lead; first-reply minutes) that the template reads.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors), `npm run build`, `npm run api:check` | pass |
| `npm test` | **26 files, 538 tests pass** (499 before this slice) |
| New suites | `automation.test.ts` 32 tests (restricted API and worker roles, real consumer and job runner); `upgrade-slice1.test.ts` 7 tests (021 to 022 with data in place) |
| Stability | `automation.test.ts` run 3 times in a row, identical results |
| Browser journey 9 (restricted-role stack) | all checks pass, no console errors or HTTP 5xx; screenshots reviewed |
| Dev database | backed up, migration 022 applied; your API answers `/api/v1/automations` (401 unauthenticated) |

## D9 requirement by requirement

| D9 requirement | Evidence |
| --- | --- |
| Preserve an explicitly assigned owner | "a manager assigns the lead to someone explicitly": owner kept, task and the single notification go to that owner; "created on purpose without an owner": stays unassigned |
| Apply the configured assignment rule when necessary | "when nobody was available at arrival": the engine applies the balanced rule later and notifies; "leave unassigned" rule respected; lead-source and CSV-import leads (owner chosen at arrival) are kept |
| Exactly one follow-up task using workspace settings | one task per lead in every scenario; due = created + first-reply minutes (default 30; tested 30 and 90, and that 90 sets a 5-minute reminder); `UNIQUE (tenant_id, dedupe_key)` on tasks |
| Notify the assigned salesperson | one notification with a link to the lead; none for a lead the owner created themselves; none when the lead source already notified (no double notification) |
| Durable | work rides the transactional outbox and the lease-based job queue; "worker died after committing but before finishing": lease reaped, re-run duplicates nothing |
| Idempotent | replaying every event from zero (cursor reset, job rows gone) changes no counts; `UNIQUE (rule_id, trigger_event_id)` is the guarantee, not the job dedupe |
| Tenant-isolated | another workspace's rule never fires for this workspace and vice versa; its history, retry and detail answer 404; a job carrying another workspace's event id cannot make the engine act on it |
| Observable | run history API and UI (what was done, why it failed, Retry); audit entries for every run and every on/off; a permanent failure writes to the workspace activity log (Monitor); Prometheus counter `anibros_automation_executions_total` |
| Retries | a temporary failure (injected database fault) rolls the whole run back (no owner assigned, no task, no notification), is recorded as waiting to retry with the reason, and the later retry completes exactly once; a permanent failure is recorded as failed, is not retried forever, and a person can retry it after the cause is fixed |
| Duplicate events | replay test; six simultaneous handlers for one event produce one execution and one task |
| Process restarts | atomic rollback test and the lease-expiry test (see limits below) |
| Multiple workers | two job runners draining 24 leads concurrently: each lead exactly one task and one execution, zero dead jobs; six concurrent handlers |
| Pause and resume | pause stops new leads; a run queued before the pause is skipped; resume covers only leads created after it; events that predate activation are never processed |
| No e-mail or WhatsApp | none exist in the template, the API or the UI |

## Defects found by the tests and fixed in this slice

1. **Deadlock between concurrent runs.** Each run held a shared lock on the rule row and then updated the same row for a run counter; two runs deadlocked. Fix: runs only share the rule row; counts are derived from history.
2. **"From now on" was not true.** The browser journey showed a lead created a moment before turning the automation on was still processed, because the worker's timing decided. Fix: `active_since`; earlier events are never processed.
3. **Deadlock and serialization errors were classified as permanent** (they map to HTTP 409 for API callers). Fix: they retry.
4. The run summary showed times in UTC; it now uses the workspace time zone.

## Behaviour to be aware of

- **Off by default.** Nothing changes for any workspace until an owner, admin or marketing manager turns it on. It covers only leads created afterwards.
- A lead created by someone for themselves produces a task but no notification.
- With the assignment rule "whoever adds it", leads from imports and lead sources still go to the least busy salesperson (this is how lead creation already worked; the engine keeps that choice).
- Salespeople and auditors do not see the Automation page (permission matrix: `automation:read`).

## Limits and open items (stated, not hidden)

1. **Multi-worker and restart evidence is in-process.** Two job runners, six concurrent handlers and a simulated lost lease prove the logic and the database guarantees; a test that kills a real OS process mid-run, and a multi-process soak, belong to the operations slice.
2. **No per-workspace execution quota, global kill switch or causation-depth limit yet.** Not needed while the only template creates no events another automation listens to; mandatory before the next template that can trigger another.
3. **No alert rules** on automation failures yet (the metric and the activity-log entry exist); alerting is Slice 8.
4. **Run history has no retention policy** (the application role cannot delete it; operators can). To be set with the data-retention work.
5. **One job per lead event** even where a workspace has no rule: cheap now, to be revisited at large lead volumes.
6. The UI refreshes by polling (6 to 8 seconds); the `automation.updated` event exists for realtime refresh when the realtime layer adopts it.
7. CI has still not run remotely (no push authorised).
