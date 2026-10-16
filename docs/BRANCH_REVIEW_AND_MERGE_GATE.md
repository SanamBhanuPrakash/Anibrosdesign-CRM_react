> **HISTORICAL — NOT CURRENT.** It reviewed the branch as of 2026-10-13, before the remediation work. Current status lives in docs/audit/2026-10-14/ (audit and roadmap), PROJECT_LOG.md and the code. Do not treat statuses or PASS marks below as verified.

# Native PostgreSQL Branch Review — Merge Gate

**Review date:** 2026-10-13  
**Repository:** `SanamBhanuPrakash/Anibros-CRM_bolt`  
**Reviewed ref:** `feat/native-postgresql-migration`  
**Code review SHA:** `69ac1197ad7b8e95fdfadc9da42c5251d00bccdb`  
**Base SHA:** `1b0fd3375652d7bd19e7cf13fe201695f7c57fa3`  
**Decision:** **Do not merge until P0 gates below pass.** Keep the branch in a draft PR, run CI on the exact head, close security/correctness findings, then review and merge. This is not a production-readiness approval.

## Scope and evidence rules

This is a source-level review of selected files at the SHA above, informed by the attached `ANIBROS_CRM_DEEP_DIVE_ANALYSIS.md` (whose original HEAD was `a45d5f4`). The branch has since changed, so earlier claims are not automatically current. A source construct is not treated as proof of a passing end-to-end workflow. CI is still running for the PR at the time of this review; no claim is made here that it passes. The older green CI run was for `main`, SHA `1b0fd337`, not this branch. No hosted Supabase project, live database, credentials, production client records, campaigns, or third-party integrations were modified.

## Current branch snapshot

Compared with `main`, the feature branch is **6 commits ahead, 0 behind** at the reviewed SHA. The PR currently changes approximately 112 files, with a large native migration surface. The branch has materially advanced beyond the attached audit: it now contains seven native migration files; a native Express/TypeScript API; Argon2id password hashing, hashed sessions, CSRF controls, email verification, login-attempt/lockout work; MUI pages; route-level RBAC in several modules; a WebSocket server; worker scaffolding; Docker Compose; and requirements/architecture docs.

The direction—native PostgreSQL as the system of record, with a backend the project controls—is consistent with the stated goal. The current implementation is still a development/integration candidate, not a production-ready CRM.

## Critical review findings

### P0 — before merge

1. **Supabase decoupling is incomplete.** `package.json` still includes `@supabase/supabase-js`; `src/lib/supabase.ts` imports it and constructs a client using placeholder Supabase URL/key defaults; the CI workflow injects `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Even if current native hooks are used, those artifacts contradict a strict “zero Supabase runtime/dependency” requirement. Remove them only after a source-consumer audit, then add a CI guard proving no imports/calls/env injections remain and verify a clean run with Supabase environment variables absent.

2. **Route-level RBAC is not complete.** `leads.ts`, `contacts.ts`, `properties.ts`, and `tasks.ts` guard key mutations. However, `server/src/routes/projects.ts` applies router-level `requireAuth` and its POST/PATCH/DELETE handlers do not apply `requireRoles`. `server/src/routes/tenant.ts` member/config reads also use authentication without a route-level role restriction. Define a centralized role-to-action matrix and apply it to every route; add explicit 403 tests for roles that must not read sensitive administration data or mutate protected entities.

3. **Inbound webhook authentication and routing are not production-safe.** `server/src/routes/webhooks.ts` uses a hard-coded fallback Meta verification token (`anibros_meta_verify_2026`), the Meta POST handler does not verify `X-Hub-Signature-256` over the raw body, and the Google endpoint accepts an unverified JSON body. Missing provider IDs are replaced by random UUIDs and the event key includes `Date.now()`, defeating stable idempotency. Catch blocks return HTTP 200 even after a database persistence error. Remove fallbacks and fail closed; validate the provider's supported signature/auth mechanism; resolve tenant only from a trusted provider/page/account-to-tenant mapping; reject malformed payloads; use stable delivery IDs; acknowledge success only after durable receipt commit. For Meta Lead Ads, the notification usually contains a leadgen ID, so the worker must securely retrieve/full-normalize the lead rather than assuming the notification includes contact fields.

4. **Worker can misroute a webhook to the wrong tenant.** `server/src/workers/durable-worker.ts` falls back to `SELECT id FROM tenants WHERE is_active = true LIMIT 1` when the inbox record has no tenant. That is not a safe routing strategy for multi-tenancy. Unmapped events must be quarantined/rejected; never guess a tenant. Also review its per-item error handling: it catches item errors while continuing inside the batch transaction. A SQL error can abort the PostgreSQL transaction, so implement safe per-item transaction/savepoint semantics, durable claims/leases, idempotent processing and retry/dead-letter behavior, then test concurrent workers and partial failure.

5. **Migration 007 is not covered by the bootstrap test contract.** `database/migrations/007_schema_hardening_and_rbac_support.sql` now exists, while `server/src/tests/native-database-foundation.test.ts` hard-codes six discovered/applied/skipped migrations and checks only 001–006. Unless that test deliberately uses a six-file fixture (the currently fetched version points at the full `database/migrations` directory), it is inconsistent with the seventh migration and should fail. Update the test to assert all current migrations and run it on a truly empty, disposable PostgreSQL instance. The migration also uses broad `EXCEPTION WHEN others THEN NULL` around enum alterations, which can hide failures; narrow exception handling and assert the final enum labels.

6. **Default credentials and secrets must be removed.** Migration 004 contains `CREATE ROLE crm_app_user WITH LOGIN PASSWORD 'dev-app-password'`; runtime config and DB pool supply fallback database credentials and a default cookie secret. Development conveniences must not silently become deployable defaults. Fail fast for missing production secrets/URLs, require explicit local development setup, and prove the production configuration cannot start with known defaults.

### P1 — before describing this as a credible SaaS core

7. **RLS provides tenant isolation, not complete role authorization.** Migration 004 contains permissive tenant `FOR ALL` policies. This is defense-in-depth for tenant boundaries, not a replacement for an explicit permission model. Ensure direct SQL under the least-privilege runtime role cannot bypass tenant context, and verify all HTTP reads/mutations/export/replay actions against role policy tests.

8. **The previous deep-dive report contains findings that are now stale.** In the native branch, migrations 003 already create `marketing_attribution`, `notifications`, and `notification_reads`; migration 007 adds the listed tenant role values, login attempt tracking, soft-delete columns and indexes; session validation checks `u.is_active = true`; WebSocket upgrade checks active users; CSP is enabled; and overlap logic has been added. Do not repeat the older report’s claim that notifications or marketing attribution are absent. Re-run the full audit at the current SHA and label every finding as fixed, still open, not applicable, or not verified.

9. **The schema/product surface is incomplete.** The current native migrations do not establish complete domain schemas for integrations/provider endpoints, communication consent, custom-field definitions/values, automation rules/executions, SaaS subscription/entitlements, branch/location concepts and property-availability history. The exact list should be reconciled against the master requirements ledger. Existing UI routes or API client methods alone do not mean those workflows are implemented. Add one canonical page → API contract → schema → authorization → test matrix, with honest partial/blocked states.

10. **Realtime is single-process and not durable.** The WebSocket service keeps connected clients in an in-memory map and application routes call its broadcast method directly. No PostgreSQL `LISTEN/NOTIFY` pipeline or durable realtime event cursor was found in the files reviewed. This can be sufficient for a local vertical slice, but process restarts and horizontal scaling can lose events. Use a transactional outbox for state-changing events, a durable consumer/notification path and client snapshot/reconnect reconciliation before claiming reliable realtime.

11. **Email delivery is not real external delivery yet.** `server/src/services/mailer.ts` is a deterministic in-memory sink whose methods return `true`. Useful for tests, but it does not establish that users receive verification or password-reset emails. Implement a configured SMTP/provider adapter and a durable outbound mail queue, expose accurate delivery/configuration status, and keep test-only token access isolated from production.

12. **Password-reset race safety needs direct verification.** Ensure consuming a reset token, changing the password and revoking sessions occur atomically with a conditional single-use update; concurrent token replays must result in exactly one success.

13. **Avoid silent multi-tenant selection.** Session validation orders memberships and picks the first one as `activeTenant`. This makes the default tenant depend on membership ordering and can surprise multi-workspace users. Make tenant selection explicit and ensure each request’s selected tenant is a verified active membership. WebSocket authorization must bind to the intended active tenant, not whichever membership sorts first.

14. **Operations diagnostics require platform-versus-tenant separation.** Queries that expose rows where `tenant_id IS NULL` can expose platform-wide health/log details to tenant-scoped viewers. Define a separate platform-operator capability and never expose global infrastructure secrets/details to ordinary tenant admins or auditors by default. Redact raw provider payloads, tokens, PII, cookies and credential-bearing error bodies.

15. **Service-layer and contract quality remain immature.** Route handlers contain inline SQL/business rules. This is not automatically wrong for a first vertical slice, but before expanding the feature surface extract testable services where logic is reused, validate all params/query/body with schemas, whitelist dynamic SQL update fields, and publish an API contract (for example OpenAPI) used by tests.

16. **Production operations are not complete.** A Docker Compose development database and health endpoints are good foundations, not a deployment plan. Remaining evidence should include TLS/reverse proxy, secret management and rotation, encrypted backups and a tested restore drill, RPO/RTO, retention/PII lifecycle, metrics and alerting, migration/rollback discipline, graceful shutdown, load tests with query plans and capacity assumptions, and an incident runbook. These should be staged against actual expected scale; do not add Redis, microservices or multi-region infrastructure prematurely.

## Strengths to preserve

- Native PostgreSQL and a controllable TypeScript backend.
- Argon2id password hashing and opaque session tokens stored as hashes.
- HttpOnly/SameSite cookies and CSRF checks.
- Transaction-scoped tenant context and tenant-aware foreign keys.
- Explicit pipeline transition rules and interval-aware viewing safeguards.
- `FOR UPDATE SKIP LOCKED` as a primitive when paired with correct claim/lease and transaction semantics.
- Versioned migrations, checksums and advisory locking.
- MUI design-system foundation, Docker Compose and a requirements/traceability approach.

Do not rewrite these foundations gratuitously. Harden them with verified tests and documented contracts.

## Required merge sequence

1. Keep this as a **draft PR**; do not merge directly or force-merge.
2. Wait for CI on the exact PR HEAD; fix all failures. Add/verify a native PostgreSQL service container and ensure migrations 001–007 bootstrap cleanly on an empty disposable test DB and pass on rerun.
3. Close P0 findings above: full RBAC route matrix, webhook fail-closed/authenticated tenant routing, worker tenant isolation/transaction safety, removal of runtime Supabase artefacts and default credentials, accurate migration tests.
4. Add negative tests for each role × privileged operation; cross-tenant IDOR tests; deactivated user/session/WS tests; webhook invalid signature, duplicate, missing tenant mapping and DB failure; worker concurrent claim/rollback/idempotency; password reset double-use; property/agent overlapping booking.
5. Reconcile each UI page with real API + schema + error/loading/empty states. Mark integrations, reports, custom fields, automations, subscriptions and unsupported actions as incomplete until they work end-to-end.
6. Require a human review of the large diff and latest green PR checks. Only then merge using GitHub PR workflow and the chosen merge policy.
7. After merge, keep production deployment blocked until separate deployment, privacy, backup/restore, observability and live-provider acceptance gates pass.

“FAANG-level” is demonstrated by repeatable correctness, least privilege, realistic tests, operational recovery and disciplined changes—not branch naming, large diffs, architecture terminology or a passing frontend build.
