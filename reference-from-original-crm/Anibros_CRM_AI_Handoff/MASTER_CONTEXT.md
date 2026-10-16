# ANIBROS CRM — MASTER PROJECT CONTEXT & HANDOFF

**Purpose:** This document is the canonical handoff for Gemini, Claude, Antigravity, or any other coding agent continuing the Anibros CRM after the project was downloaded from Bolt. Read it before changing code.  
**Context snapshot date:** 12 October 2026 (India Standard Time).  
**Important evidence rule:** This document combines prior project documents, user requirements, and statements reported by Bolt. It is not a substitute for inspecting the downloaded repository and connected Supabase project. Treat any state described as “Bolt reported” as unverified until independently checked against source code, migrations, database, and runtime.

---

## 0. THE MISSION — DO NOT LOSE THIS

Build **Anibros CRM**, a 2026-grade, professionally engineered, multi-tenant real-estate CRM and marketing operations platform. The ambition is “FAANG-level” engineering quality: secure by default, modular, reliable, observable, testable, scalable, auditable, maintainable, and usable by both technical and non-technical staff. Do not interpret this as a claim that current code is already at that standard. It is the quality target and acceptance bar.

The platform begins as an internal system for Anibros Design to manage multiple real-estate clients, but its architecture should support a commercial SaaS product later. It must not become a collection of attractive pages backed by disconnected or mocked data. Every feature advertised in the UI must have a real, secure, correctly scoped end-to-end implementation, or be clearly marked as not implemented.

### The user's key requirements, in plain language

1. **Complete project context must survive across AI sessions.** The coding agent must create and maintain `plan.md`, `PROJECT_LOG.md`, architecture documentation, and a Python script that regenerates a concise context bundle from the project every time work resumes. Do not rely on chat history or model memory.
2. **Leads must be live.** New leads should appear within seconds without manual page refresh. Lead details and status changes must stay current too, not only the dashboard count. Supabase Realtime should be the preferred mechanism if correctly configured and secured; implement a safe fallback (bounded polling with backoff/reconnect) if Realtime is unavailable. A report filter of 7/30/90 days must never mean the live Leads inbox only fetches seven days of data unless the user explicitly applies such a filter.
3. **Live updates must work end to end.** When a website, Google Ads, Meta Lead Ads, or other enabled source generates a lead, the event must be received securely, durably recorded, processed/idempotently normalized, linked to a contact and attribution, committed to the correct tenant, and then appear in the CRM within the latency target. Realtime only broadcasts data after it exists; it does not replace backend ingestion or processing.
4. **Real backend, not just frontend.** The downloaded app may have pages, forms, and UI that are not properly connected to backend functions/database state or do not synchronize. Treat every page/API/function as unverified until traced through the real database and tested. A component existing in the source tree is not proof a feature works.
5. **Unified logs, monitoring, and audit.** Every important action and critical failure should be traceable. Build a user-friendly Operations Center with real telemetry, clear causes, impact, actions, and technical detail/correlation IDs. Maintain operational logs, security/audit events, webhook inbox/outbox history, health/dependency status, incident history, queue/job status, retries, dead letters, and safe recovery actions.
6. **Multi-tenant isolation is non-negotiable.** Every tenant-owned read, write, export, Realtime subscription, report, file, queue event, diagnostic, and integration credential must be properly scoped and authorized. The browser-supplied tenant ID is never proof of authorization.
7. **Do not stop after audits.** Audit, fix, test, document, then continue the next highest-priority implementation item. Make incremental progress rather than repeatedly re-explaining the architecture.
8. **Keep documentation factual.** Distinguish `PASS`, `FAIL`, `PARTIAL`, `BLOCKED`, and `NOT VERIFIED`. Never call a build pass evidence that runtime, integrations, auth, or security works.
9. **Work carefully around live systems.** Do not change live ad campaigns, production credentials, or existing production webhook endpoints/destinations without explicit approval. Never ask the user to put secrets in chat. Do not log raw secrets.
10. **Cost constraint.** Prefer the current React/Supabase stack and free/open-source or already available tooling until real needs justify cost. Do not introduce paid vendors or infrastructure silently. Explain trade-offs and recurring costs before adding services.

---

## 1. PRODUCT VISION AND USERS

### Product vision

A multi-tenant real-estate CRM and marketing operations system that centralizes lead capture, contact management, real-estate inventory, property matching, pipeline/deal processes, viewings, tasks, attribution, communications, conversion feedback, operations monitoring, and auditability.

The differentiator is **reliable, traceable lead-to-deal workflows**, not feature count:
- Every external lead has a known source and stable provider identity.
- Every important lead mutation is authorized, atomic where appropriate, and audited.
- Every pipeline transition is server validated against an allowed state machine.
- Every integration connection status is based on real checks and observed deliveries, not a badge set by the UI.
- Every inbound webhook and outbound conversion event is durably tracked, deduplicated, retryable, and recoverable.
- Every business data view updates when the underlying data changes.
- Operational failures explain what happened, why, what was affected, and the next safe action.

### Intended customers and stages

- **Internal:** Anibros Design staff operate CRM for client accounts.
- **Pilot:** Selected real estate businesses use tenant-isolated workspaces.
- **SaaS:** Real-estate agencies, developers, brokers, and related businesses can be onboarded and billed.

### Main personas

- Sales agent: quick access to assigned/authorized leads, follow-up tasks, viewing calendar, activities, contact history, and messaging.
- Sales manager: pipeline, assignment, stale leads, SLA and agent performance.
- Marketing manager: lead-source/campaign attribution, quality/conversion outcomes, integration health, conversion feedback.
- Tenant admin/owner: members, roles, tenant configuration, integrations, custom fields, audit/operations access.
- Anibros/agency operator: scoped cross-tenant operations and delegated oversight, not unrestricted access to every customer's individual records.
- Platform operator: platform-wide health, incident response, provisioning and controlled administration.
- Auditor/read-only user: authorized immutable audit visibility.

---

## 2. REPOSITORY AND TOOLING CONTEXT

### Expected/previously reported technology stack

- React 18, TypeScript, Vite.
- Tailwind CSS 3 with custom design-system tokens (primary/accent/success/warning/error/surface colour ramps).
- Supabase: PostgreSQL, Auth, RLS, Edge Functions, Realtime (Realtime must be verified in actual configuration and code).
- React Router DOM 7, Zustand 5, `clsx`, `tailwind-merge`, `date-fns`, `lucide-react`.
- Vite path alias `@/` → `src/`.
- Edge Functions use Deno/TypeScript.
- PostgreSQL RPCs/functions for atomic workflows and trusted server-side decisions.
- Existing table-backed webhook inbox/outbox; a scheduled worker/fallback was proposed via `pg_cron`, with Edge Functions for processing. Exact current deployment and scheduling must be inspected.

**Source of truth is the downloaded repository plus its connected Supabase project.** The above stack is copied from a previous Bolt project log and may not match every file in the downloaded snapshot. Verify `package.json`, lock file, migrations, `supabase/functions`, route structure, git status, and environment configuration before assuming.

### User's working environment

- Project was built in Bolt, but the user ran out of Bolt credits and downloaded the project.
- Current coding environment is **Antigravity** using Gemini and/or Claude.
- User expects strong continuity across model/tool changes.
- The user is specifically worried Gemini may lose or misunderstand context; be very explicit, structured, repetitive around critical constraints, and keep files updated with a Python context-bundle script.

### Repository rules

- Never rewrite from scratch merely because inherited code is messy.
- Do a baseline audit and preserve working functionality.
- Before migrations, inspect existing policies/grants/triggers/RPCs/consumers and write a forward-only migration with rollback/mitigation notes.
- Never blindly apply migration files to a production database. Compare local migrations against the actual remote migration state first.
- Never copy `.env` secrets into documentation/context files. Include variable names only, redact values.
- If a real API/provider credential is missing, implement a safe mock/fixture path for deterministic tests, but label real provider E2E as `BLOCKED`.
- Keep the user informed with meaningful progress; do not report generic updates without concrete work.

---

## 3. CURRENT STATUS SNAPSHOT — EVIDENCE MUST BE RECHECKED

The items below are a consolidated state from previous project logs and Bolt messages. They describe reported state, **not independently re-verified state in the newly downloaded folder**.

### 3.1 Reported core database and backend work

Bolt's earlier project log recorded 12 migrations applied:
1. `001_organisation_tenant_hierarchy` — organisations, tenants, branches, organisation memberships, tenant memberships, RLS, helper functions including platform/agency role checks and tenant-ID lookup.
2. `002_crm_domain_tables` — pipelines/stages/transitions, contacts, leads, lead stage history, marketing attribution, projects, properties, property availability history, activities, tasks, viewings, audit logs, webhook inbox, outbox events; tenant IDs and RLS policies.
3. `003_seed_pipeline_and_transition_function` — `transition_lead_stage()` with allowed transition validation and related history/audit/activity work; `seed_default_pipeline()` with 13 real-estate pipeline stages and 30+ permitted transitions.
4. `004_fix_security_advisor_warnings` — fixed search paths for helpers.
5. `005_fix_function_grants` — revoked public execute access on `SECURITY DEFINER` functions and granted explicit access.
6. `006_auto_onboarding_function` — `create_default_tenant()` creates organisation, tenant, memberships, and default pipeline for new accounts.
7. `007_lead_scoring_function` — rule-based lead score from source, budget, timeline, engagement.
8. `008_integrations_consent_customfields_automation_subscriptions` — integrations, webhook endpoints, communication consent, custom fields, automation rules/executions, subscription plans and subscriptions.
9. `009_user_invitation_function` — `invite_user_to_tenant()` with role checks and audit intent.
10. `010_role_based_permission_enforcement` — role-aware database write permissions across numerous tables; configuration restricted to appropriate roles.
11. `011_database_integrity_composite_fks` — composite tenant/id uniqueness and foreign keys to stop cross-tenant child references; indexes.
12. `012_stuck_job_recovery` — reset stuck webhook and outbox processing records after a threshold.

Later Bolt messages referred to **18 migrations before migration 019**, then said **migration 019 was already applied successfully**. Exact names/content for migrations 013–018 and migration 019 have not been supplied in the chat. Do not invent their names. Inspect the downloaded `supabase/migrations` directory and the remote database's migration table. Reconcile actual migration filenames, applied state, and content.

### 3.2 Reported deployed Edge Functions

A prior project log claimed four deployed/active functions:

1. `webhook-ingestion`: Google Ads and Meta Lead Ads webhook handler. Google payload key validation; Meta `X-Hub-Signature-256` HMAC-SHA256 over raw request body and GET verification challenge; resolves tenant from integration configuration, not user-supplied payload; stores inbox event with idempotency.
2. `process-webhooks`: normalizes inbound events, deduplicates contacts/leads by normalized email/phone, creates attribution, retries with backoff, dead-letters after max retries.
3. `process-outbox`: handles outbound conversion events; uses per-tenant credential references; reports for Google Enhanced Conversions for Leads and Meta Conversions API; fails closed if missing config.
4. `integration-status`: checks configuration/connectivity without deliberately sending live conversion events; sanitizes errors.

**Critical caveat:** this is a claim in an earlier log. Inspect local function source and remote deployment. Do not assume they are present, current, secure, reachable, or correctly wired in the downloaded repository. A frontend-only export may not contain deployed backend assets or deployment secrets even if Bolt previously deployed them.

### 3.3 Reported frontend modules/pages

Previously listed as built:
- Infrastructure: `src/lib/supabase.ts`, `src/lib/utils.ts`, `src/types/index.ts`, Zustand `src/stores/auth-store.ts`, tenant-scoped hooks `src/hooks/use-tenant-data.ts`.
- Shared UI: Button, Input/Textarea/Select, Card, Badge, Avatar, Spinner, EmptyState, Dialog, Table/DataTable.
- Auth: Sign in, Sign up, AuthProvider, ProtectedRoute, password recovery pages added later.
- Layout: app sidebar, top bar, tenant selector, search, notifications/profile.
- Dashboard: 8 metric cards (total/new/qualified/won leads, pipeline value, unassigned, stale, tasks due), recent leads.
- Leads list/detail: search, filters, create lead, CSV import/export; detail stage transition through RPC, activity timeline, tasks, assignment.
- Pipeline Kanban with drag/drop stage transitions.
- Contacts list.
- Properties list/detail; create/edit; type and availability filters.
- Projects.
- Tasks.
- Calendar/viewings.
- Reports with 7/30/90/365/all date filter, export, metrics, sources/stages/agent performance.
- Integration configuration UI.
- Webhook inbox diagnostics and replay/recovery UI.
- Outbox diagnostics and retries/recovery UI.
- Settings: tenant/member management/invites/audit log.
- Custom fields, automation rules, tenant configuration/branding/pipeline, subscription page.
- Explainable property matching engine.

Later in the chat, Bolt began additional work on:
- Dashboard stats via a server-side RPC, with tenant scoping and error handling.
- Better error handling for `LeadsPage` and `PropertiesPage` (previously they silently ignored fetch errors; search dependency was reportedly corrected).
- Marketing attribution analytics via a server-side RPC and a new frontend page/route/navigation item.
- Operations Center page/tabs and types after migration 019.

**These latest features are incomplete until actual files/routes are checked.** The last message from Bolt ended in the middle of adding the Operations Center to routing/navigation and adding a permission flag. Do not assume it finished.

### 3.4 Current known state around migration 019 / Operations Center

Bolt said migration 019 was applied successfully and verified this permissions picture:

| Table | SELECT (as reported) | INSERT (as reported) | UPDATE (as reported) | DELETE (as reported) |
|---|---|---|---|---|
| `audit_logs` | authenticated, tenant-scoped | authenticated, tenant-scoped | dropped | dropped |
| `webhook_inbox` | authenticated, tenant-scoped | dropped / trusted service-side only | dropped / trusted service-side only | dropped / trusted service-side only |
| `outbox_events` | authenticated, tenant-scoped | dropped / trusted service-side only | dropped / trusted service-side only | dropped / trusted service-side only |
| `operational_logs` | authenticated, tenant-scoped | no client insert policy reported | no client update policy reported | no client delete policy reported |
| `system_health` | authenticated, tenant-scoped | no client insert policy reported | no client update policy reported | no client delete policy reported |
| `incidents` | authenticated, tenant-scoped | no client insert policy reported | no client update policy reported | no client delete policy reported |

Reported intent: Edge Functions use the service-role key and can write to inbox/outbox while browser clients cannot forge processing state. This needs a critical real-code/security review because service-role bypasses RLS, and only trusted server-side code may possess it.

Known remaining work from the very latest Bolt transcript:
- Inspect all consumers of changed policies and grants.
- Replace diagnostics pages' direct inbox/outbox table writes with authorized RPCs for replay/recovery.
- Ensure replay RPCs independently validate caller identity, tenant, role, event state, and idempotency.
- Add TypeScript types for `operational_logs`, `system_health`, and `incidents`.
- Build Operations Center tabs/views.
- Add route, navigation item, permission flag.
- Ensure real logs/health/incidents get written and are not empty tables with a frontend shell.
- Test all legit inbound/outbound processing and recovery paths after migration.

### 3.5 Authentication / onboarding history and unresolved verification

The workspace screen previously showed:
> Workspace Setup Required — Your account is not associated with any workspace yet. You can retry the setup or sign out and contact your administrator.

Several changes were reported:
- Fixed truncated braces/file structure in `auth-store.ts`.
- Fixed an incorrect `loadTenantData` access from `AuthProvider` scope.
- Added recoverable setup error screen with Retry/Sign Out.
- Added `tenantLoading` and `onboardingError`.
- Addressed a race between `getSession()` and `onAuthStateChange(INITIAL_SESSION)`; skip duplicate initialization when the same user already loaded.
- Split memberships and tenants into separate queries rather than one joined query.
- Added `onboardingPromise` to await in-flight tenant provisioning.
- Signup page handles both immediate session and email-confirmation/no-session path.
- Added forgot/reset-password routes using `resetPasswordForEmail` and `updateUser`.

Then the investigation found **infinite RLS recursion** in both `tenant_memberships` and `organisation_memberships`: policies queried their own table again. The reported fix was to use `SECURITY DEFINER` helper functions `get_user_tenant_ids()` and new `get_user_org_ids()` instead of self-referencing subqueries. The functions were described as having fixed `search_path=public, auth`.

Bolt reported six database RLS tests passing:
1. User A reads own tenant memberships: 1 row.
2. User A cannot see User B's tenant: 0 rows.
3. User A cannot see User B's leads: 0 rows.
4. User B reads own tenant memberships: 1 row.
5. User A reads own organisation memberships: 1 row.
6. User A reads own tenant: 1 row.

Bolt also reported that `create_default_tenant()` returned an existing tenant ID idempotently, and each test user still had one tenant/membership, without duplicates.

**Actual browser runtime verification was explicitly not performed in earlier logs.** The user later showed screenshots of the authenticated dashboard, proving at least one authenticated session rendered the dashboard at that later point, but does not prove new-user signup, password recovery, refresh/session restoration, all roles, or every auth path. Re-run these tests in the downloaded app against the intended Supabase project.

### 3.6 Dashboard and attribution work in progress

- Bolt added a dashboard stats RPC to aggregate dashboard metrics server-side and reported it worked, with cross-tenant caller access rejected.
- User wants current/live data, not only date-ranged snapshots.
- Bolt fixed an ambiguous `utm_medium` column by intending to use qualified aliases in the attribution query.
- Attribution RPC returned valid empty results.
- Bolt attempted to insert temporary test leads/attribution records, reported calculations manually correct (3 attributed leads across Google Ads, Meta Lead Ads and manual; campaign/channel/stage breakdowns), then reported test data cleaned up.
- A frontend attribution dashboard page was then being created and the last state was “Now add the route and nav item.” Check whether route/nav were ever completed.
- Dashboard/Leads/Properties previously had silent error-handling weaknesses. Bolt reported improvements to LeadsPage and PropertiesPage and fixed search effect dependencies. Verify exact code and runtime.

### 3.7 User’s assessment about frontend/backend gap

The user explicitly worries that the downloaded project has a lot of frontend but weak/incomplete backend wiring and no reliable live synchronization. Treat this as a top-level risk. Do not argue from the fact that old logs list tables/functions/pages. Conduct a proof-based audit of every path: UI event → service/repository call → auth/RLS/RPC/Edge Function → database transaction → response/error → UI state update → Realtime propagation/refresh → audit/operational event.

---

## 4. LIVE LEADS AND TRUE DATA SYNCHRONIZATION — P0 REQUIREMENT

This is a non-negotiable acceptance requirement, not a future enhancement.

### User-visible behavior

- When a new lead is committed to the correct tenant database, every authorized active CRM view should reflect it within seconds, without a manual refresh.
- Lead list, dashboard counters, pipeline Kanban, lead details, contacts, tasks/activities affected by a change, reports and notification indicators should remain consistent.
- Edits to stage, assignment, value, priority, contact details, attribution, and other fields should propagate to other open sessions.
- Deletions/merges/archival should update correctly according to the product's soft-delete/archive policy.
- Switching tenant/workspace must stop old tenant subscriptions and subscribe to the new tenant safely.
- Reconnection, token refresh, browser sleep/wake, and network interruptions must recover without duplicate rows or stale data.
- Date filtering in Reports is separate from live synchronization. Leads should not silently stop loading older records just because the dashboard/report defaults to the last 7 days.

### Recommended technical approach

1. Use Supabase Realtime Postgres Changes or a carefully designed Broadcast flow for `leads` and other high-value tables, if supported and configured correctly. Verify table publication, RLS/realtime authorization, subscription filters, and connection limits.
2. On page load or tenant switch, fetch the authoritative initial snapshot. Then subscribe to changes; handle race conditions between initial fetch and subscription establishment (subscribe first or reconcile by refetching after subscription is ready).
3. Filter subscriptions by active tenant only as an optimization; rely on RLS/authorization as the security boundary. Do not treat client-side filters as security.
4. On `INSERT`, upsert by primary key; on `UPDATE`, merge/replace the record using consistent ordering; on `DELETE`, remove or invalidate it. Avoid duplicate insertions when a realtime event races with mutation response/refetch.
5. When a mutation succeeds from the current client, update cache/state immediately or invalidate/refetch; the event may also reach the same client, so all updates must be idempotent.
6. Recompute or invalidate dashboard/report aggregates when their underlying entities change. Avoid fetching all tenant rows into the browser to calculate business-critical metrics.
7. If Realtime channel disconnects/errors or isn't available, show state, attempt reconnection with bounded backoff and use polling fallback (e.g. 5–10 seconds only while tab is active; slower when hidden) with cleanup. Use a configurable interval and avoid hammering Supabase.
8. Expose `lastSyncedAt`, connection status, last error and stale-data indication in developer/operations diagnostics. Do not display “Live” while disconnected or stale.
9. Use one shared subscription manager/hook per tenant/resource where appropriate rather than creating duplicate subscriptions in every component.
10. Include a deterministic integration test: insert/update a lead using another authenticated session or test webhook, verify it appears/updates in an already-open browser tab without reload. Also test tenant A never receives tenant B events.

### Proposed live sync targets (targets to measure, not claims)

- Database commit → authorized active UI becomes current: target p95 ≤ 3 seconds when Realtime is connected.
- External webhook receipt → lead visible in CRM: target p95 ≤ 10 seconds under normal conditions, while durable receipt prevents data loss during slow processing.
- Realtime reconnect after a short network interruption: target ≤ 15 seconds, followed by snapshot reconciliation.
- Every target must be measured in logs/metrics, with latency derived from timestamps. Do not claim SLO compliance without tests/measurements.

### External source ingestion pipeline

`Google/Meta/website/provider event → authenticated webhook validation → resolve integration/tenant from server-side configuration → durably write webhook_inbox/idempotency key → acknowledge only after durable receipt → process/normalize → deduplicate provider event → upsert contact → create/update lead + attribution + activity/audit as appropriate, transactionally → mark inbox complete or retry/dead-letter → commit DB → Realtime notification/refetch → UI refresh`

Rules:
- Do not create leads directly from a webhook handler before durable receipt/idempotency is established.
- Distinguish duplicate deliveries from a new enquiry by the same person. A repeat enquiry can be a separate lead linked to the same contact.
- Inbound lead webhooks are not automatically available just because a frontend “Integrations” form exists.
- Test with safe fixtures/test payloads first. Do not send test conversions to live ad accounts or change a production webhook endpoint without explicit approval.

---

## 5. CORE DOMAIN WORKFLOWS THAT MUST ACTUALLY WORK

### Leads and contacts
- Create, read, edit, assign, filter, search, paginate, import/export with validation and role checks.
- Server-side duplicate handling: normalized email/phone for contact matching; stable external event IDs for duplicate webhook detection; do not silently merge separate enquiries.
- Full lead details and history should show source/campaign, contact, stage history, owner/assignment, activities, tasks, viewings, property matches, consent, and relevant audit timeline.
- List search/filter/pagination should handle all relevant data, not arbitrary sample or default 7-day limits. Infinite scroll or pagination is fine if total data access is truthful and consistent.
- Lead stage change must use server-side RPC/state machine, not directly patch stage column from browser.
- Every list/detail fetch needs loading, error, empty, and populated states. A request failure must not be shown as “no leads.”

### Pipeline
- 13 standard real-estate stages were reported; 30+ valid transitions.
- Validate transitions server-side, including required loss reason/assignment/fields, timestamps, lead stage history, activity and audit/outbox events.
- Drag/drop cannot bypass permitted transitions.
- Pipeline and list/detail must reconcile after mutations and in realtime.

### Properties, projects and matching
- Real CRUD backed by DB; tenant-scoped; real filters and validation.
- Matching engine is explainable, rule-based as originally implemented: budget (30 pts), location (25), property type (20), bedrooms (15), transaction intent (10), with per-match reasons and sorted suggestions. Verify actual code/schema before preserving weights.
- Property availability lifecycle may need more than available/sold: reserved, blocked, soft-hold, under-negotiation with expiry.

### Tasks, activities, viewings/calendar
- Tasks need correct assignment, due dates, completion, permissions, and real links to leads/contacts.
- Activities capture calls, emails, notes and other interactions with user/timestamp and linked entity.
- Viewing calendar should prevent invalid/conflicting schedules as requirements evolve, and sync when records change.

### Dashboard and reporting
- Stats should be from real, tenant-scoped server-side queries/RPCs; aggregate totals should be correct and not leak data.
- Show timestamps/ranges and explain definitions of qualified, won, stale, unassigned, pipeline value, response time and conversion.
- Live dashboard metrics should refresh after changes, even where report history uses a user-selected date range.
- Empty data must be a valid empty state, not an error or fabricated sample.
- CSV import/export must validate field names/types, avoid formula injection, apply permissions, audit exports/bulk changes, handle partial failures and show row-level errors.

### Marketing attribution
- Campaign/source/medium/channel attribution should connect to actual lead records; handle missing UTM data; dedupe events; avoid double counting when multiple attribution records exist.
- Distinguish raw enquiries from qualified/won outcomes. The goal is campaign quality and business results, not only lead volume.
- The attribution RPC was reported to calculate three temporary sample cases correctly, but the frontend page/route/nav was incomplete at the last transcript point. Re-test query counts manually from seeded fixtures and confirm cleanup.

### Multi-tenant roles and permissions
Roles in prior architecture: platform owner, agency admin, tenant owner/admin, sales manager, sales agent, marketing manager, auditor/read-only, analyst/read-only as applicable. Verify actual enum and rules in code/schema rather than assuming every role exists.
- DB/RPC/Edge Function is the authorization boundary; frontend gating is UX only.
- Agency access must be delegated/scoped and audited; not unrestricted access to individual data across tenants.
- Realtime channels, signed URLs, logs, exports and diagnostics need the same isolation standards as normal CRUD.

---

## 6. INTEGRATIONS AND RELIABLE EVENT PROCESSING

### Google Ads lead forms
- Webhook payload includes a provider event/lead identifier, field data, and a configured verification key. Resolve tenant from the registered integration mapping, not arbitrary request body.
- Stable unique event identity per integration, idempotent retries, tolerant unknown-field handling, explicit handling of provider test leads.
- Verify current Google docs/API lifecycle before implementation; an older architecture document references the September 2026 developer-token policy, but vendor facts can change.

### Meta Lead Ads
- Webhook verification challenge for subscription setup; HMAC-SHA256 check of raw request body/signature for POSTs.
- Leadgen webhook may carry `leadgen_id` and require authenticated Graph API fetch for full fields.
- Use correct app secret/page access tokens and current Graph API version, store secrets only server-side, redact error/log output.

### Meta Conversions API / Google Enhanced Conversions for Leads
- Outbound conversion events must be generated from valid lifecycle milestones and the current integration mapping.
- Use per-tenant credentials, correct account routing, consent checks, normalized/hashed identifiers as required, idempotency/event IDs, retry policy, sanitized provider response.
- Never send conversion events to a wrong customer's ad account. Never make real provider calls during tests without explicit approval.

### WhatsApp and CRM email
- Planned, previously blocked by credentials/provider accounts. Use official WhatsApp Cloud API and an email provider adapter (Resend/SES/SendGrid are candidates, not chosen by this handoff).
- Respect messaging windows/templates, consent, opt-out, delivery/bounce/status events, message audit and outbox durability.
- Do not assume this has been implemented.

### CRM SaaS subscriptions
- Subscription plans/free/pro schema was reported; Stripe integration and self-serve onboarding remained incomplete/blocked.
- Do not make billing functional claims until checkout/webhooks/subscriptions/entitlements are implemented and tested.

### Queue state machines and worker behavior

Inbound inbox (conceptual statuses): `received → processing → completed`; transient error → `retrying` with `next_attempt_at`; max failures → `dead_letter`; invalid signature or unresolved integration → `rejected`.

Outbound outbox: `pending → processing → sent`; transient error → `retrying`; max failures → `dead_letter`; an outdated/superseded event may be marked `superseded` if implemented.

Requirements:
- Claim rows safely with concurrency controls (`FOR UPDATE SKIP LOCKED` or equivalent), leases/claimed-at, bounded attempts and backoff/jitter.
- Recover abandoned `processing` rows and expose why they were recovered.
- Retry only operations safe to retry, with provider idempotency where available.
- Manual replay requires role/tenant checks, valid states, idempotency and audit history.
- Track attempts, duration, provider/status/error, next retry time, final state and who initiated manual recovery.
- Do not allow browser clients to write arbitrary queue rows or fake delivery success.

---

## 7. OPERATIONS CENTER, OBSERVABILITY, LOGGING, AND AUDIT

A unified Operations Center is a core product requirement. It must have real data and be understandable by a non-technical user while retaining technical diagnostic details for developers.

### Main views
1. **Overview:** current/stale/unknown health, recent incidents, webhook failures, queue lag, integration connectivity/last delivery, Edge Function/backend error trends, recent recovery.
2. **Logs Explorer:** structured logs with date/severity/component/tenant/correlation ID/error code filters, pagination, search, sanitized details.
3. **Audit Trail:** actor, action, target resource, tenant, timestamp, outcome, permitted change diff, filters and resource/user timeline. Normal users cannot modify/delete history.
4. **Webhook Inbox:** event source, received time, signature validation result, dedup result, status/stage, attempt count, sanitized payload metadata, latest error, processing duration, safe replay when authorized.
5. **Outbox & Jobs:** pending/processing/retrying/sent/dead-letter, oldest pending age, attempts, next retry, provider response, manual retry/recovery controls with confirmation.
6. **Integrations:** per tenant/provider connection/configuration state, last successful safe check, last accepted delivery, last error, token/config expiration if safely available, no secret display.
7. **Incidents:** evidence-based issue, severity, first/last seen, impacted tenant/component, linked correlation/event IDs, timeline, status/assignee/resolution and recovery audit.
8. **Health/Dependencies:** DB/app/Auth/Realtime/Edge Function/job/provider health where measurable, checked-at, latency, stale-data status and last successful observation.

### Non-technical incident explanation
Each incident should answer:
- What failed?
- When did it fail?
- Which tenant, integration, lead, or job was affected (only to authorized users)?
- What is the actual observed reason, HTTP/status/provider error, or exception code?
- Is data missing, delayed, or safely queued?
- Has retry been scheduled? How many attempts remain?
- What should the user do next?
- Can this be retried safely?
- Where is the technical detail/correlation ID?

Do not infer a cause beyond evidence. Use wording such as “likely cause” only when labelled as a hypothesis. Never display fake green/healthy status because the page loaded.

### Distinguish storage types
- **Audit events:** authoritative business/security accountability; actor and action history.
- **Operational logs:** diagnostic records from frontend/server/database/edge processes.
- **Integration event history:** inbound/outbound provider lifecycle.
- **Job execution history:** each attempt, claim, retry, result and duration.
- **Health observations:** periodic/triggered check result, timestamp, latency, details.
- **Incidents/alerts:** lifecycle summary aggregating signals, acknowledgement, recovery and resolution.
These can share correlation IDs but should not be indiscriminately collapsed into a single generic logs table.

### Minimum structured log envelope
`timestamp`, `severity`, `environment`, `component`, `event_name`, `request_id`/`correlation_id`, `trace_id` where feasible, `tenant_id` only where appropriate, `actor_id` when relevant, `operation`, `duration_ms`, `outcome`, stable `error_code`, sanitized message/context, deployment/version.

### Correlation/traceability
Use one correlation ID across a chain where possible:
user action/request → database/RPC → outbox/inbox → Edge Function/worker → provider API call → retry/recovery → audit/incident. Keep provider event IDs and internal row IDs; do not use PII as correlation IDs.

### Security and integrity
- Redact tokens, secrets, passwords, authentication headers, unnecessary PII and sensitive payload fields recursively.
- Do not log raw authorization headers. Be careful with raw webhook bodies.
- Audit identity must be derived from `auth.uid()` or trusted server context, not a client-supplied actor ID.
- Ordinary tenant members must not forge events for other users, impersonate system events, rewrite or delete audit history.
- Audit append-only policies are necessary but not equivalent to cryptographic tamper proof; privileged database operators remain a separate trust boundary. Document the guarantee honestly.
- If an operation requires durable audit recording, define transaction behavior when audit persistence fails. Do not silently report full success if mandatory audit failed.
- Logs must have appropriate RLS/RBAC and platform-wide diagnostics require a platform operator role. Tenant admins should only see their own tenant diagnostic records unless explicitly authorized otherwise.
- Set retention, pagination, indexes, payload-size limits and archival/deletion policy; do not keep all debug logs indefinitely in core PostgreSQL by default.

### Migration 019 reported changes — review before trusting
Migration 019 was said to make `audit_logs` append-only for normal roles, remove browser-client write policies from `webhook_inbox`/`outbox_events`, and add `operational_logs`, `system_health`, `incidents`. New server-side RPCs were needed for replay/recovery instead of direct frontend queue writes. Inspect all use sites and function permissions. Do not assume migration correctness just because Bolt says it applied.

---

## 8. SECURITY, RELIABILITY, AND QUALITY BAR

### Security
- RLS on every tenant-owned table and correct policies for SELECT/INSERT/UPDATE/DELETE.
- Avoid self-referencing RLS recursion. Use safe fixed-search-path `SECURITY DEFINER` helper functions only with explicit grants and narrowly scoped behavior.
- No service-role key or provider secret in frontend, source-controlled `.env`, logs, generated AI context bundle, or user-facing error.
- Restrict function/table grants to minimum requirements. Review every `SECURITY DEFINER` function.
- Use composite tenant foreign keys for child/parent relationships where required.
- Validate input server-side; protect against SQL injection, XSS, CSV formula injection, over-posting, IDOR/BOLA, privilege escalation and forged audit events.
- CORS is not authorization.
- Use explicit retention/consent/opt-out controls; privacy requirements should be reviewed against relevant laws (including India's DPDP framework) rather than claimed complete from schema presence.
- MFA was previously noted as not implemented; verify current state.

### Reliability
- Durable webhook receipt before successful acknowledgement.
- Idempotency across retries and provider duplicates.
- Bounded retries, exponential backoff with jitter, retry schedule and dead-letter queue.
- Concurrency-safe worker claims and stuck job recovery.
- Health check staleness and failure states.
- Reconciliation between inbox, lead/contact records, outbox and external-provider outcomes.
- Error states visible to users; no silent catch/empty fallback.
- Defined backup/restore plan and restoration drills.

### Engineering quality
- Clear boundaries: UI components, services/repositories, domain logic, DB RPC/functions, Edge Function handlers, provider adapters.
- Runtime validation of external payloads and environment configuration; typed return DTOs.
- No magic sample numbers; no fake integration statuses.
- Unit tests for pure logic; integration tests for database/RPC/auth/RLS; end-to-end tests for critical user paths; negative tests for security; synthetic integration tests for webhook failures/retries.
- CI should run install/lockfile validation, typecheck, lint, unit/integration tests where configured, build, and security/migration checks.
- Loading/error/empty/success/partial-failure states for all data-heavy pages.
- Avoid N+1 queries and unbounded full table reads; inspect indexes and query plans for critical lists.
- Keep the UI consistent, accessible, responsive, and useful to non-technical operators.

### Previous architecture SLO proposals (not yet proven)
- API/list performance: p95 < 300 ms for list views where practical.
- Webhook receipt → lead visible: p95 < 10 seconds.
- Live DB commit → active authorized UI update: proposed p95 ≤ 3 seconds.
- Network interruption → reconnect/reconciliation: proposed ≤ 15 seconds.
- All need measurement under a defined workload; do not advertise as achieved until tested.

---

## 9. HISTORICAL DECISIONS, FIXES, AND USER PROMPTS/INTENT

This section preserves the important decisions and prompts from the prior Bolt work, including why each exists.

### 9.1 General engineering direction
The user repeatedly requested:
- Deep, accurate implementation rather than surface-level screens.
- Audit first before production-risking changes.
- Step-by-step safe changes to live systems.
- Never claim success from a build alone.
- Maintain `PROJECT_LOG.md` and `plan.md` continuously.
- Keep implementing after an audit rather than stop at reports.
- Use current repository/database evidence, not speculative fixes.
- A multi-tenant real-estate CRM with reliable Google/Meta webhooks, safe per-tenant credentials, role enforcement, and operational visibility.
- “FAANG-level”/2026-standard system design, high quality, complete logs/monitoring, and diagnostics for non-technical users.
- A single place to see which component is broken, why a webhook/API is failing, and whether frontend/backend/integrations are healthy.
- Track each important user/admin action and the end-to-end outcome.

### 9.2 Auth incident history
Original screen: “Workspace Setup Required — Your account is not associated with any workspace yet.” Initial hypotheses included stale preview/build, `tenantLoading` being cleared too early, an auth-store race, and finally a real RLS-recursion bug in membership policies. The investigation reported an actual self-referencing policy recursion and corrected it using `SECURITY DEFINER` helper functions for tenant/org IDs. Six role/RLS query checks were reported passing, plus tenant provisioning idempotency. Earlier browser runtime verification was missing. A later screenshot showed the dashboard rendered under an authenticated session. New signup/forgot-password still needs a fresh runtime test.

### 9.3 Database/tenant isolation prompt intent
The user instructed the coding agent to verify migration state, examine the real database, test as `authenticated` rather than assuming SQL Editor superuser tests exercise RLS, prevent cross-tenant reads, preserve existing tenant data, check idempotency, test both user A and user B, and avoid weakening RLS to make UI work.

### 9.4 Dashboard / Leads / Properties / attribution prompt intent
Bolt was instructed to:
- Replace silent `if (!error) setLeads(...)`-style failures with explicit error state and UI errors.
- Fix missing effect dependencies such as search.
- Preserve correct loading/empty/success/error behavior.
- Move important dashboard metrics into a server-side tenant-validated RPC.
- Qualify ambiguous `utm_medium` and other columns in attribution joins.
- Manually verify attribution totals and breakdowns against fixtures, clean test data, then create the frontend page and routing/navigation.
- Treat an empty dataset separately from a failed request.

### 9.5 Operations Center design prompt intent — consolidated requirements
The user asked for a complete observability architecture and interface, not only tables:
- Audit all current logging/instrumentation and report gaps before schema change.
- Separate audit, operational logs, integration/job events, health observations, and incident lifecycle.
- Add correlation IDs from frontend requests across RPC/Edge Function/webhook/jobs/provider requests.
- Ensure normal application users cannot update/delete audit history or forge actor identity/system events.
- Ensure browser users cannot create or mutate webhook/outbox process state; trusted server-side workers must retain legitimate capabilities.
- Add safe, role-authorized replay/recovery RPCs rather than letting UI update queues directly.
- Add a structured logs explorer, audit trail, integration status, webhook inbox, outbox/jobs, incidents, health/dependency checks and non-technical explanations.
- Ensure real health observations, timestamps and stale indicators—not hardcoded “healthy”.
- Redact secrets, avoid logging raw auth headers, keep RLS/tenant isolation, and maintain docs.
- Test legitimate successful and failed processing paths after permission changes.

### 9.6 Important Operations Center prompt (copyable full requirement)

> Continue from the exact current state. Do not restart the project.
>
> Before applying the Operations Center migration, inspect every existing RLS policy, grant, trigger, RPC, Edge Function, frontend query, and worker that uses `audit_logs`, `webhook_inbox`, and `outbox_events`. Produce a table of current permissions, proposed permissions, legitimate write paths, and potential regressions. Confirm trusted Edge Functions can still ingest webhooks, process events, retry failures, recover dead-letter jobs, and deliver outbox events. Make audit records append-only for ordinary application roles, preserving legitimate audit creation and defining durable audit behavior. Design `operational_logs`, `system_health`, and `incidents` with tenant isolation, indexes, retention, redaction, and least privilege. Add correlation IDs to request, webhook, job, and external API workflows without logging credentials. Apply changes after dependency review. Test actual permissions, authenticated isolation, and trusted processing. Build the unified Operations Center using real telemetry: searchable logs, audit history, health, integration diagnostics, webhook lifecycle, retry history, incident details, and actionable explanations. Run build and relevant runtime tests, update `PROJECT_LOG.md`, `plan.md`, architecture docs. Do not claim success from migration/build alone. Mark browser/provider tests NOT VERIFIED if unavailable, then continue next unfinished implementation item.

### 9.7 Current implementation priorities expressed by the user
- The project has been downloaded because Bolt credits ran out; continue in Antigravity.
- Provide full detailed context to Gemini/Claude so they do not misunderstand or discard previous work.
- Create a fresh `plan.md` and `PROJECT_LOG.md` from current downloaded code and preserve history.
- Add a Python context-preservation script, so each coding session can regenerate context, inventory code/migrations/functions/tests, and carry forward open work.
- The system must be more than “frontend only”; verify actual backend execution, data persistence, and sync for every feature.
- Leads and related data must be live/current, update within seconds, and not be accidentally limited to date-filter presets.
- Build complete monitoring/logging/incident/audit/health capabilities and keep work moving toward the long-term architecture.

---

## 10. KNOWN GAPS, RISKS, AND BLOCKERS

### Highest risks to verify immediately
1. **Downloaded repo completeness:** Are migrations, Edge Functions, tests, and backend code actually in the exported source? Are deployment configurations/cron jobs present? Are they wired to this Supabase project?
2. **Live data synchronization:** Supabase Realtime could be absent/not enabled/not published/subscription unauthorized/unsubscribed on tenant change. No evidence yet that new leads appear within seconds.
3. **Backend/UI mismatch:** UI forms may write directly to tables or no-op; some pages may use mocked/stale data; errors may be swallowed; page-level CRUD may be incomplete.
4. **Migration history discrepancy:** old log lists 12; later Bolt said 18 then migration 019; exact migration files for 13–18 and 019 must be verified.
5. **Audit forgery/durability:** migration 019 reportedly leaves tenant-scoped authenticated INSERT on `audit_logs`; determine whether clients can forge actor/source/outcome and whether trusted mutations write audit atomically.
6. **Operations Center incomplete:** last transcript was adding types/page/routes/navigation/permission. UI may be unfinished; no evidence all tables are populated with actual logs.
7. **Webhook/outbox replay permissions:** UI was being changed to RPCs; verify server-side caller/tenant/role/event-state checks and idempotency.
8. **Integrations not end-to-end tested:** Google/Meta credentials needed; previous log said code deployed but real credentials and live account flow blocked. Provider API changes must be checked in official docs when implementation begins.
9. **Email/password recovery:** earlier flow was created, but email redirect and actual recovery were unverified.
10. **SaaS/production readiness:** Stripe billing/self-serve onboarding incomplete; MFA was noted missing; backup/restore drills, performance tests, deployment/runbooks/production audit were not done.
11. **UI can lie:** Connected/healthy counts and 0-metrics screens must be based on real query results. Query error must not be reported as empty state.
12. **Logging privacy/cost:** avoid logging raw lead payloads or secrets; define retention/indexing and growth costs.

### Previously listed blockers (must recheck current truth)
- Google Ads OAuth client/secret/refresh token and the required account/customer setup.
- Meta App Secret, Page access token/permissions, relevant CAPI token/config.
- WhatsApp Cloud API phone number ID/access token and approved templates.
- Email provider credentials (provider not finalized).
- Stripe keys/configuration for SaaS billing.
- Supabase plan capability for point-in-time recovery/backups/Realtime limits.
- Separate staging project and test accounts/provider test payloads.

Credentials must be provisioned via secure environment/secret management outside chat and source control.

---

## 11. IMPLEMENTATION ORDER — DO NOT JUMP RANDOMLY BETWEEN FEATURES

### P0: establish truth and reproduce the current state
- Inspect downloaded repository, `git status`, package scripts, dependencies, migration directory, functions directory, tests, config, `.env.example` (never print values), and routing.
- Run install according to lockfile, typecheck/lint/tests/build; record raw outcomes.
- Inventory migrations 001–019 and compare with actual Supabase migration tracking/schema state. Do not blindly run migrations.
- Map each frontend page to actual data operations and server paths; label real/mock/partial/unwired.
- Confirm current user sees dashboard, and test existing login/new signup/tenant setup/password recovery if credentials and browser are available.

### P1: security and backend correctness baseline
- Inspect tenant RLS for all tables and helper functions; negative tests across users/roles/tenants.
- Verify all `SECURITY DEFINER` functions: fixed search path, minimal grants, caller auth, tenant/role ownership.
- Review migration 019 and audit write trustworthiness, inbox/outbox write paths, replay RPCs.
- Ensure runtime errors aren't swallowed; all critical screens have explicit error state.

### P2: live leads and synchronization
- Trace a lead from source to UI.
- Fix database schema/Edge Function/UI wiring gaps found in audit.
- Implement/test Supabase Realtime and snapshot reconciliation for leads, pipeline and related modules.
- Implement polling fallback only as a resilient fallback, not as a substitute for working Realtime where available.
- Instrument timestamps/latency and expose connection/stale indicators.
- Build automated test proving lead visible in an already-open browser without refresh within target.

### P3: reliable event pipeline
- Webhook verification, tenant resolution, durable inbox, stable idempotency, contact/lead/attribution creation, audit events, bounded retry, dead-letter, replay and recovery.
- Worker/pg_cron/immediate processing path and schedule must actually exist and be monitored.
- Outbox conversion path must be isolated per tenant and require consent/config.

### P4: Operations Center and trustworthy audit
- Complete tables, trusted writers, correlated event IDs, logs, health, incidents.
- Complete tabs and usable filters/actions.
- Live status/lag, last-checked timestamps, stale states, safe diagnostic tests, incident timeline and recovery.
- Role-gated platform-wide versus tenant-level views.

### P5: finish core CRM end-to-end
- Leads, contacts, pipeline, properties, projects, matching, tasks, viewings, activities, reports and attribution fully connected, validated, live and permission-tested.
- Search all relevant historical data, correct pagination, filters, accurate metrics and CSV behavior.
- No feature should be marked complete merely because it has a page.

### P6: tests, CI, operational safety
- Unit, DB/RLS/RPC, Edge Function integration, browser E2E, realtime, failure/retry, tenant isolation, role negative tests.
- Logs redaction tests and audit completeness tests.
- Backup/restore drill, migration dry run, rollback/forward-fix plan, observability alert testing.
- Runbooks: webhook failure, outbox stuck, auth/tenant provisioning, Realtime down, provider API failure, database restore.

### P7: integrations and commercial SaaS
- Real provider E2E only with approved credentials and test accounts.
- WhatsApp/email workflows with consent/template/status handling.
- SaaS onboarding, subscription enforcement, Stripe billing.
- Production deployment, security/privacy/performance review.

Do not wait to “finish every architecture document” before fixing an obvious live lead bug. Follow dependency order, keep scope incremental and test each change.

---

## 12. ACCEPTANCE CRITERIA FOR “REAL AND WORKING”

Every feature is tracked across these layers:

1. UI exists and renders.
2. UI action invokes real service/data operation.
3. Supabase query/RPC/Edge Function is present and connected.
4. Database schema, grants, RLS and constraints enforce tenant/role rules.
5. Success data persists durably.
6. Errors are surfaced and not represented as empty/success.
7. Audit/log/trace is emitted at appropriate point.
8. Other views/sessions update through Realtime/cache invalidation/refetch.
9. Retry/idempotency/recovery works where relevant.
10. Tests prove successful and denied/failing paths.
11. Docs reflect what is actually true.

### Explicit live-lead acceptance test
- Open the CRM Leads page in browser session A for tenant A.
- From an approved test webhook or authenticated session B, create a new lead in tenant A without reloading session A.
- Show durable webhook receipt time, processing timestamps, lead committed timestamp and UI-observed timestamp.
- Verify the new lead appears in session A ≤ 3 seconds after database commit (target), with no duplicate row.
- Update the lead stage/assignment from session B; verify session A and dashboard/pipeline update without manual reload.
- Disconnect/reconnect network; verify stale status is shown and data reconciles after reconnect.
- Verify tenant B does not see tenant A’s events/records and vice versa.
- Verify historical lead pagination/filtering includes older records when filters permit; default date range does not silently omit data from the Leads module.
- Repeat with a webhook-processing delay or transient failure; show queued/retrying state and subsequent recovery, without losing the lead.

### Operations Center acceptance test
- Simulate invalid webhook signature, duplicate event, unknown integration, transient DB/provider error, retry exhaustion, and successful recovery in isolated tests.
- Each scenario produces the correct event/log/incident where applicable with correlation IDs and sanitized diagnostics.
- UI describes actual failure and shows state/timestamp/next action.
- Unauthorized user cannot inspect another tenant’s details or trigger replay.
- Dashboard status becomes Unknown/Stale when no recent health observation exists, not falsely Healthy.

---

## 13. INSTRUCTIONS TO THE NEXT AI CODING AGENT

You are not being asked to merely advise. You are the coding agent responsible for continuing the implementation in the checked-out Antigravity workspace.

1. Read this file, `plan.md`, `PROJECT_LOG.md`, and `ARCHITECTURE_BASELINE_ORIGINAL.md` before changing code.
2. Run `python scripts/update_ai_context.py` before starting, and inspect its generated `AI_CONTEXT_BUNDLE.md` (if installed in the project repository). If the script doesn't exist in the checked-out app yet, copy it from this handoff package and adapt it carefully.
3. First send a short baseline report containing repository inventory, scripts/build status, migrations and deployed function inventory, high-risk gaps, and next task. Avoid speculation.
4. Do not treat this written context as verified code truth. Verify every item. Clearly distinguish `FROM PRIOR LOG`, `VERIFIED IN LOCAL SOURCE`, `VERIFIED AGAINST REMOTE DATABASE`, and `RUNTIME TESTED`.
5. Select the highest-priority task from `plan.md`, implement it, test it, update the log/plan, and continue. Do not stop after an audit unless blocked by permissions or missing inputs.
6. Before risky changes, make a small plan, inspect affected files/dependencies and migration history; avoid broad refactors without evidence.
7. Preserve all real user/project data. Never expose secrets or log them.
8. Never claim a browser/runtime/provider test was performed unless it actually was.
9. Maintain a work ledger in `PROJECT_LOG.md`: date/time, task, exact files/migrations, change, tests, outcomes, unresolved issues, next actions.
10. Update `plan.md` statuses with evidence and link decisions to architecture docs. Do not silently delete old decisions; mark them superseded with a reason.
11. The top user priorities are live lead synchronization, actual backend functionality, comprehensive observability/audit, and multi-tenant security. Do not get distracted by cosmetic polishing before these are real.

---

## 14. REFERENCE DOCUMENT INCLUDED IN THIS HANDOFF

`ARCHITECTURE_BASELINE_ORIGINAL.md` is the full original 2,100+ line architecture and implementation roadmap from 9 October 2026, preserved as supplied. It contains detailed proposed schemas, sequence diagrams, state machines, security review, reliability SLOs, cost options and the original Phase 0–9 roadmap. It says “awaiting review before implementation,” which is historically accurate for that file but stale now. Use it as design context, not current execution status. This new master context and `PROJECT_LOG.md` capture later progress and later issues; if any conflict, inspect the repository and record a decision instead of assuming.

