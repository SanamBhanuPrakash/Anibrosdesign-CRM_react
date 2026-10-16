# ADR 004: Automation engine: templates, one transaction per run, database-enforced exactly-once

## Status
Accepted and implemented in Slice 1 (decision D9: engine first, templates first, visual builder later).

## Context
The old Automation screen stored rules in a settings blob and nothing ever ran them. The platform already had a transactional
outbox (`domain_events`), a cursor-based event dispatcher, a lease-based job queue and a notification helper. The first
automation must be durable, idempotent, tenant-isolated and observable, and must not pretend to do things that do not exist
(no e-mail or WhatsApp until real accounts and implementations exist).

## Decision
1. **Templates, not free-form rules.** A template is code: one trigger, a fixed list of steps, the workspace settings it reads.
   A workspace can turn it on or off; it cannot alter what the steps do. First template: `new_lead_follow_up`
   (keep an explicit owner, otherwise apply the assignment rule; create one call task due within the first-reply time; notify the owner).
2. **Flow.** `lead.created` event, then the worker's `automation` consumer enqueues one `automation.dispatch` job per event
   (dedupe key = event id). The consumer reads no rules (rules are tenant data and the worker has no cross-tenant read). The job runs in
   the event's tenant context, so row-level security applies, and executes every active rule of that workspace.
3. **One transaction per run.** All steps are internal database writes, so claiming the execution, assigning, creating the task,
   notifying and recording the result commit together or not at all. A crash, restart or lost lease leaves nothing half-done.
4. **Exactly-once is a database fact.** `UNIQUE (rule_id, trigger_event_id)` on executions and `UNIQUE (tenant_id, dedupe_key)` on tasks;
   notifications already had a dedupe key. Job-level dedupe is an optimisation; correctness does not depend on it.
5. **Runs only share the rule row.** An early version updated `run_count` on the rule inside the run; two concurrent runs of the same rule
   deadlocked (shared lock upgraded to exclusive). Counts and "last run" are now derived from the history, so concurrent runs never contend.
6. **Only events after activation.** `active_since` is set when a rule is (re)enabled; events that happened before it are never processed,
   however late the worker gets to them. Found by the browser journey: the UI promised "from now on" but the worker's timing decided.
7. **Failure model.** Permanent (validation, missing record, constraint) is recorded as `failed` with a plain reason, logged to the
   workspace activity log, and can be retried by a person. Transient (connection, timeout, deadlock) is recorded as `pending`
   and retried by the job runner with backoff, then `failed` after the last attempt. Retrying goes through the same claim, so it cannot duplicate.
8. **Acting identity.** A system actor limited to what the template's steps do; never the privileges of whoever turned it on.
9. **Pause semantics.** Pausing stops new events; a run already in progress finishes (it holds a shared lock the pause waits for);
   a run queued but not started is not executed.
10. **Legacy rows.** Rules written by the retired editor have no template, are never executed and never shown.

## Consequences
- Adding a template means writing code, tests and a migration if it needs one: slower than a rule builder, but safe to run unattended.
- Steps that call an outside provider (e-mail, WhatsApp, webhooks) cannot use the single-transaction design. They will need an
  at-least-once outbox with provider idempotency keys and an explicit "outcome unknown" state (Slices 6 and 7).
- One job per lead event even in workspaces with no rules: cheap at current scale; batch or pre-filter if lead volume grows by orders of magnitude.
- Not yet built (and not needed for this template): per-workspace execution quotas, a global kill switch, causation-depth limits for
  automations that create events other automations listen to. They must exist before any template can trigger another.
