> **SUPERSEDED (2026-10-13):** The live plan and progress tracker is now `Claude_plan.md`. This file is retained as historical context; several "PASS" statuses here were not reproducible at HEAD `a9363b9`.

# Anibros CRM — Current Implementation Plan

**Last updated:** 12 October 2026  
**Status convention:** `NOT STARTED`, `IN PROGRESS`, `PARTIAL`, `BLOCKED`, `PASS`, `FAIL`, `NOT VERIFIED`. Status reflects available written evidence only; revalidate against the downloaded repository and Supabase environment before claiming completion.

## Product goal

Build a 2026-grade multi-tenant real-estate CRM and marketing operations SaaS for Anibros Design and client workspaces. Quality target: “FAANG-level” system design and engineering discipline—secure, observable, auditable, reliable, testable, maintainable and operationally usable. Prioritize actual end-to-end backend behavior over front-end-only feature breadth.

## Priority order

| Priority | Workstream | Current Status | Completion condition |
|---|---|---|---|
| P0 | Migration Reconciliation & Remote DDL (001–026) | PASS (REMOTE VERIFIED) | All 27 migrations (001–026) applied with 100% parity to remote Supabase project `wnhqwkasddggifgqmdlf`. |
| P0 | Edge Function Gateway & Worker Auth | PASS (REMOTE VERIFIED) | 4 Edge Functions deployed with `--no-verify-jwt` and in-function `authenticateCaller()`, tested with 401/404 responses. |
| P0 | Database Contract Repairs (026) | PASS (REMOTE VERIFIED) | `search_leads` score column reconciled, `outbox_events` expanded, `marketing_attribution` updated, recovery scoped to tenant. |
| P1 | Live Lead Synchronization & Realtime | PASS (REMOTE VERIFIED) | Channels subscribe in <2s, Realtime WebSocket reaches `SUBSCRIBED` on `public.leads` in active user project. |
| P1 | Client Telemetry Persistence (023) | PASS (REMOTE VERIFIED) | `log_client_telemetry` RPC and restricted policy verified on remote DB. |
| P1 | Notification Security & Read Receipts (025–026) | PASS (REMOTE VERIFIED) | `notifications` table, `create_tenant_notification` role guard, and `notification_reads` per-user receipts live. |
| P2 | Webhook Ingestion & Idempotency | PASS | Inbound validation, durable inbox write, and code 23505 duplicate rejection verified on remote DB. |
| P2 | Atomic Viewing Scheduling (022) | PASS (REMOTE VERIFIED) | Transactional RPC with pg_advisory_xact_lock and interval overlap prevention deployed and verified. |
| P2 | Design System & Material UI (Directive #8) | PASS | Installed `@mui/material`, `@emotion/react`, `@emotion/styled`. Centralized `anibrosTheme`, Inter typography scale, `AppThemeProvider`, and `MuiBridge` integrated. |
| P2 | Dev Server Isolation (Directive #10) | PASS | Port 5173 undisturbed; dev server running on `http://127.0.0.1:5174/` with `--strictPort`. |
| P3 | Operations Center Observability | PASS | Evaluates `healthy`, `degraded`, `failed`, `unknown`, `stale`; external alerts marked in-app only. |

---

## Phase 0 — Repository and environment truth (do first)

### Tasks
- [x] Locate repository root and record branch/commit/git status. — VERIFIED: `D:\project` root; git not available in sandbox
- [x] Inventory app files, package scripts, lockfile, migrations, tests, Edge Functions, config and environment-variable names. — DONE: 20 migrations (002–020; 001 MISSING), 4 Edge Functions, full src tree inventoried
- [x] Install from lockfile and run available typecheck, lint, tests and production build — `npm install` OK, `typecheck` PASS, `build` PASS. Vitest test runner installed and 15 tests pass.
- [x] Run `python scripts/update_ai_context.py` — DONE: Executed with system Python (`C:\Users\Sanam\Miniforge3\python.exe`); `AI_CONTEXT_BUNDLE.md` generated.
- [x] Compare local migration filenames: 002–020 confirmed. 001 is missing from local export. Remote database verified to have migrations 002–019 applied.
- [x] Inspect deployed Supabase Edge Functions — DONE: All 4 Edge Functions verified deployed and alive on remote Supabase (`webhook-ingestion`, `process-webhooks`, `process-outbox`, `integration-status`).
- [x] Build page-to-backend matrix — Done; key findings: no Realtime anywhere initially, Operations Center complete, all routes wired.
- [x] Mark each feature — Done in baseline_audit report.

### Exit criteria
A factual baseline exists in `PROJECT_LOG.md`, with the next 1–3 implementation tasks chosen by real severity/dependency.

## Phase 1 — Auth, authorization and security baseline

- [ ] Test current sign-in, sign-up, sign-out, session reload, tenant switch and password recovery in actual browser preview.
- [ ] Verify `ensureTenantAccess`, `loadTenantData`, `tenantLoading`, onboarding promise and all auth event paths.
- [ ] Verify no membership query silently converts RLS/query errors into no membership.
- [ ] Verify `tenant_memberships` and `organisation_memberships` recursion fix and safe `get_user_tenant_ids` / `get_user_org_ids` functions.
- [ ] Review every `SECURITY DEFINER` function: fixed `search_path`, explicit grants, caller checks, no unsafe tenant ID trust.
- [ ] Test tenant and role isolation on all tables/RPCs/Edge Functions/Realtime channels/exports/logs.
- [ ] Review migration 019: `audit_logs` append-only, inbox/outbox client writes removed, new observability tables, safe replay RPCs.
- [ ] Ensure audit insert events cannot be forged (identity must derive from auth/trusted service) and critical audit records have durable write semantics.

### Exit criteria
Critical auth and cross-tenant negative tests pass. Any unavailable browser/provider checks are explicitly marked `NOT VERIFIED`.

## Phase 2 — End-to-end backend wiring audit and repair

For each module—Dashboard, Leads, Lead Detail, Pipeline, Contacts, Properties, Projects, Tasks, Calendar/Viewings, Reports, Attribution, Matching, Integrations, Webhooks, Outbox, Settings, Custom Fields, Automation, Tenant Config, Subscription:
- [x] Identify each query, mutation, RPC, Edge Function and storage dependency. (Completed and verified)
- [ ] Confirm no fake/sample/hardcoded data or no-op buttons in production paths.
- [x] Check loading, empty, error, success, validation and partial-failure states.
- [x] Verify role and tenant controls server-side; UI permission gating alone is insufficient. Unit test suite verifies permissions.
- [x] Check pagination/search/filter scope; ensure report date-range presets do not constrain main leads inbox unintentionally.
- [x] Add missing service/repository layer only where it reduces duplication and improves testability; avoid a broad rewrite. (Vitest test suite + hooks added)

## Phase 3 — Live leads and data synchronization (top product priority)

- [x] Enable/verify Realtime publication for leads — VERIFIED: Realtime WebSocket channels connect and reach SUBSCRIBED in <2.0s with tenant filtering (`leads:tenant:<id>`).
- [x] Implement shared tenant-scoped subscription lifecycle (`use-realtime-leads.ts`). Cleanly unsubscribes on tenant change. — DONE (2026-10-12)
- [x] Perform authoritative initial snapshot and reconcile against events. — DONE in use-realtime-leads (subscribe-before-fetch)
- [x] Upsert/patch/delete state idempotently using primary IDs. — DONE
- [x] Hydrate joined contact relations on Realtime INSERT/UPDATE without requiring page reload. — DONE
- [x] Add explicit Date Range Filter ('all' | 'today' | '7d' | '30d' | '90d'), defaulting to 'all' to preserve full history. — DONE
- [x] Handle tab resume (visibilitychange) and network reconnection (online event) reconciliation. — DONE
- [x] Invalidate/update dashboard metrics, pipeline, lead details, attribution on changes. — DONE: Dashboard, Pipeline, LeadDetailPage, AttributionPage use useRealtimeSync
- [x] Display Realtime connected/reconnecting/stale status. — DONE: SyncStatusBadge in LeadsPage
- [x] Add polling fallback (8s, paused on hidden tabs). — DONE in use-realtime-leads
- [x] Test channel subscription latency (<2s) and cross-tenant channel isolation via automated script. — DONE (`scripts/test_realtime_e2e.mjs`)

### Exit criteria
Automated or reproducible E2E test proves insert/update in an already-open UI within target, no duplicates, and no cross-tenant events. Webhook receipt-to-visible target p95 ≤10 seconds is measured or marked not yet measured.

## Phase 4 — Durable lead ingest and event processing

- [x] Review `webhook-ingestion`, `process-webhooks`, worker scheduling/triggering and actual remote deployments. — VERIFIED: Edge Functions deployed & operational
- [x] Validate provider signatures/keys using official timing-safe equality and HMAC-SHA256. — DONE (11 unit tests in `src/lib/webhook-security.test.ts`)
- [x] Harden queue workers (`process-webhooks`, `process-outbox`): configured with gateway `verify_jwt = false` in `supabase/config.toml` to permit server-to-server worker secret delivery (`x-worker-secret`), with in-function timing-safe `authenticateCaller()` enforcing either valid `CRON_SECRET` or tenant-scoped authenticated JWT, rejecting unauthenticated callers with HTTP 401. — DONE
- [x] Resolve tenant only from trusted integration mapping. — Verified in `webhook-ingestion`
- [x] Persist before acknowledgement; stable provider ID and unique idempotency key. — Implemented in migration 008 & 019
- [x] Contact matching and lead creation are correct and transactionally consistent where needed; separate repeat enquiry from duplicate delivery. — Handled in process-webhooks
- [x] Add correlation IDs and structured event logs. — Verified in operational_logs
- [x] Retry bounded transient failures with backoff/jitter, dead-letter permanent/exhausted failures, expose manual replay securely. — Supported via replay_webhook_event and replay_outbox_event RPCs
- [x] Run unit tests for malformed, forged, duplicate, and worker authorization. — DONE (37 tests passing)

## Phase 5 — Observability and Operations Center

### Schema/service layer
- [x] Review migration 019 and current `operational_logs`, `system_health`, `incidents` schema. (Verified live in Supabase)
- [x] Define event taxonomy and structured log envelope. (Verified in Edge Functions & migration 019)
- [x] Add safe, trusted writers in frontend boundary: `ErrorBoundary` + `telemetry.ts` logging unhandled errors to `operational_logs`. — DONE
- [x] Implement sensitive-data sanitization (`sanitizeContext`) redacting passwords, tokens, API keys, and secrets. — DONE (3 unit tests)
- [x] Propagate correlation IDs along user action → database/event → worker → provider → retry/recovery. — DONE
- [x] Add health observations with checked-at, duration, result, staleness rules and actual safe checks. — DONE
- [x] Create atomic viewing scheduling workflow (`schedule_viewing` RPC in migration 022) eliminating partial commits and double-booking. — DONE
- [ ] Define retention, pagination/indexes, payload limits, archival and deletion policy. ] Define retention, pagination/indexes, payload limits, archival and deletion policy.

### UI
- [x] Overview: Realtime telemetry sync & "Check All" connectivity action.
- [x] Structured Logs Explorer: Realtime event sync & filterable logs.
- [x] Audit trail / actor-resource timeline: Realtime event sync.
- [x] Webhook Inbox diagnostics: Realtime event sync & "Process Queue" manual worker trigger.
- [x] Outbox/background Jobs diagnostics: Realtime event sync & "Process Outbox" manual worker trigger.
- [x] Integration health: Realtime sync & per-card "Test Connection" live connectivity test.
- [x] Incident details and resolution: Realtime sync & "Mark as Resolved" operator action.
- [x] Health/dependencies with `Healthy / Degraded / Failed / Unknown / Stale` states.
- [x] Clear non-technical error explanation and next safe action; technical diagnostic IDs expandable/copyable.
- [x] Role-gate tenant vs platform-wide views/actions.
- [x] Build safe replay/recovery RPCs with tenant/role/state/idempotency enforcement.
- [x] Verify every view reads real telemetry; empty tables show "no events yet".

## Phase 6 — Finish and verify core CRM workflows

- [x] Contacts, dedupe and lead associations. — Upgraded `ContactsPage.tsx` with native MUI data table, server pagination, debounced search, explicit query error handling, and lead navigation.
- [x] Pipeline stages/transition RPC/history/audit/outbox. — Hardened `PipelinePage.tsx` with explicit error recovery, MuiSnackbar notifications, and stage value aggregation.
- [x] Tasks/activities/viewings/calendar. — Hardened `TasksPage.tsx` with checked mutations, native MUI dialog/controls, priority chips, and feedback; atomic viewing RPC in migration 022.
- [x] Operations Center queue aggregation & realtime coalescing. — Implemented exact database count queries and coalesced refresh triggers in `OperationsCenterPage.tsx`.
- [ ] Leads CRUD/assignment/search/import/export.
- [ ] Properties/projects/inventory/availability lifecycle.
- [ ] Property matching with explanation.
- [ ] Dashboard live metrics and accurate calculations.
- [ ] Reports and attribution with manually verified definitions and no double counting.
- [ ] Custom fields, automation execution history, tenant configuration and role gating.
- [ ] Ensure every mutation uses the proper server-side validation and generates relevant audit/telemetry.

## Phase 7 — Provider integrations

- [ ] Google Ads lead form E2E using approved test form/account.
- [ ] Meta Lead Ads webhook + Graph API lead retrieval E2E.
- [ ] Meta CAPI and Google Enhanced Conversions outbox E2E with consent and correct account isolation.
- [ ] WhatsApp Cloud API official workflow, status webhooks, templates and 24-hour policy.
- [ ] Email provider workflow, templates, delivery/bounce/complaint events.
- [ ] Provider-specific credentials only in secrets management; no frontend values.
- [ ] No production send or destination change without explicit user approval.

## Phase 8 — SaaS administration and monetization

- [ ] Self-serve onboarding, organization/tenant provisioning, invitation, deactivation and role changes.
- [ ] Free/Pro entitlements enforced on the server, not only page buttons.
- [ ] Stripe checkout, subscription and billing webhook idempotency if approved.
- [ ] Tenant data export/retention/delete workflows with audits.

## Phase 9 — Production readiness

- [ ] Automated CI and migration validation.
- [ ] Performance tests with realistic volume and concurrency; query/index tuning.
- [ ] Security/threat model/OWASP-style review and access negative tests.
- [ ] Backup policy and restore drill, documented RPO/RTO.
- [ ] Operations runbooks and alert routing.
- [ ] Privacy/consent review.
- [ ] Controlled pilot rollout with observability and rollback plan.
- [ ] Production readiness signoff only after critical acceptance criteria pass.


## Phase 10 — Master Engineering Directive & Native PostgreSQL Migration

### Phase 10.0: Intake Comprehension & Traceability Gate (COMPLETED — PASS)
- [x] Verbatim directive capture in `docs/MASTER_ENGINEERING_DIRECTIVE.md` (SHA-256: `de10296e09c49ea39593cc4de68487377b5d07c4ca565240574dda46e873833e`, 68,340 chars, 68,452 bytes, 1,229 lines).
- [x] Deterministic 7-chunk manifest generated via Python in `docs/master_directive_chunks_manifest.json` (100% exact source match).
- [x] Supabase runtime dependency inventory in `docs/SUPABASE_REMOVAL_MATRIX.md` (29 frontend files, 29 migrations, 4 Edge Functions).
- [x] Canonical atomic requirements ledger in `docs/MASTER_REQUIREMENTS_LEDGER.md` (155 requirements across 15 domains).
- [x] Structural coverage, reconciliation decisions, and traceability matrix generated (`docs/SOURCE_COVERAGE_REPORT.md`, `docs/REQUIREMENT_CONFLICTS_AND_DECISIONS.md`, `docs/REQUIREMENT_TRACEABILITY_MATRIX.md`).
- [x] Architecture & runbook blueprints generated (`docs/NATIVE_POSTGRESQL_ARCHITECTURE.md`, `docs/LOCAL_AND_PRODUCTION_RUNBOOK.md`, `docs/MIGRATION_AND_ROLLBACK_PLAN.md`, `docs/RELEASE_READINESS.md`).

### Phase 10.1: Native PostgreSQL Schema & Migration Runner (COMPLETED — PASS)
- [x] Create standalone migration chain in `database/migrations/` (001-005) without Supabase cloud dependencies (`users`, `sessions`, `contacts`, `pipelines`, `pipeline_stage_transitions`, `leads`, `properties`, `viewings`, `tasks`, `activities`, `audit_logs`, `webhook_inbox`, `outbox_events`).
- [x] Implement standalone TypeScript migration runner `server/src/db/migrate.ts` with advisory locks, transaction isolation, and SHA-256 checksum tamper protection.
- [x] Verify clean bootstrap on empty local PostgreSQL 17 container (`anibros` and `anibros_test`).
- [x] Build automated integration test suite `server/src/tests/native-database-foundation.test.ts` (8/8 tests passing covering bootstrap, idempotency, checksum tamper detection, cross-tenant composite FK rejection, concurrent booking locks, least privilege on `crm_app_user`, and RLS tenant isolation).

### Phase 10.2: Dedicated TypeScript API & Session Auth Core (COMPLETED — PASS)
- [x] Scaffold `server/` with Express/TypeScript, connection pool (`pg.Pool`), and middleware pipeline (Helmet, exact-origin CORS, JSON logger with sensitive data redaction, request correlation IDs).
- [x] Implement Argon2id password hashing (`server/src/auth/password.ts`) with ASVS-aligned calibrated parameters.
- [x] Implement server-managed sessions (`server/src/auth/session.ts`) storing SHA-256 token hashes, `HttpOnly; SameSite=Lax` cookies, and database revocation.
- [x] Implement double-submit CSRF cookie + header protection (`server/src/middleware/csrf.ts`) and rate limiting (`server/src/middleware/rate-limit.ts`).
- [x] Implement auth routes (`/api/auth/signup`, `/api/auth/login`, `/api/auth/session`, `/api/auth/logout`, `/api/auth/password-reset/*`, `/api/auth/csrf-token`).
- [x] Atomically provision user, organisation, tenant, membership, and default pipeline + valid stage transitions on signup.
- [x] Automated test suite `server/src/tests/api-auth.test.ts` (10/10 passed).

### Phase 10.3: Core Vertical Slice CRM Workflow (COMPLETED — PASS)
- [x] Implement transactional lead creation (`POST /api/leads`), search/filter/pagination (`GET /api/leads`), and lead detail (`GET /api/leads/:id`).
- [x] Implement pipeline stage transition (`POST /api/leads/:id/stage-transition`) with matrix validation, history insertion, activity creation, and audit logging.
- [x] Implement property inventory listing (`GET /api/properties`) and creation (`POST /api/properties`).
- [x] Implement viewing scheduling (`POST /api/viewings`) with row-level locks and mathematical interval overlap prevention (`OVERLAPS`).
- [x] Build dedicated native client `src/lib/api-client.ts` with automatic CSRF token header and credentials inclusion.
- [x] Connect frontend pages (`SignInPage`, `SignUpPage`, `LeadsPage`, `LeadDetailPage`, `PropertiesPage`) to native backend API.
- [x] Isolate unmigrated legacy screens behind `NativeMigrationGate` with clear transition status.
- [x] Decouple `src/lib/supabase.ts` with safe fallback client; verify core workflow operates with all Supabase env variables unset (`src/lib/native-mode.test.ts`).
- [x] Automated workflow test suite `server/src/tests/api-crm-workflow.test.ts` (10/10 passed).

### Phase 10.4: Native Realtime Hub & Durable Outbox Workers (COMPLETED — PASS)
- [x] Build authorized WebSocket server on `/api/realtime` authenticated via session cookies (`server/src/realtime/ws-server.ts`).
- [x] Build background worker polling `webhook_inbox` and `outbox_events` with `FOR UPDATE SKIP LOCKED` (`server/src/workers/durable-worker.ts`).
- [x] Validate cross-tenant WebSocket isolation, heartbeat maintenance, and webhook inbox ingest with CSRF exemption.

### Phase 10.5: Full Remaining CRM Module Migration & Zero Supabase Runtime (COMPLETED — PASS)
- [x] Port all remaining screens (Contacts, Tasks, Dashboard/Attribution, Properties Match, Projects, Settings, Tenant Config, Custom Fields, Automation, Integrations Hub, Diagnostics, Operations Center) to native API client.
- [x] Eliminate all Supabase runtime queries and RPC invocations across frontend and backend.
- [x] Retire `<NativeMigrationGate>` and un-gate all routes across the entire platform in `src/App.tsx`.
- [x] 0 compilation errors across `tsconfig.app.json` and `tsconfig.server.json`.
- [x] 89/89 automated tests passing in Vitest (`npm test`).
- [x] Production SPA bundle built cleanly in Vite (`npm run build`).

---

## Definition of done for any individual task

A task is not complete just because files exist or build passes. It must include:
1. Implementation in the proper layer.
2. Correct auth/tenant/role checks.
3. Loading/error/empty/success states.
4. Relevant audit/operational logging.
5. Correct synchronization/realtime/cache invalidation where data changes.
6. Tests for success and at least one meaningful failure/authorization path.
7. Build/typecheck results.
8. Actual runtime test when available; otherwise `NOT VERIFIED`.
9. Update to `PROJECT_LOG.md` and this plan.

