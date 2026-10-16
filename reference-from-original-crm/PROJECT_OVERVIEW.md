# ANIBROS CRM — MASTER PROJECT OVERVIEW & AI HANDOFF

**Document type:** Persistent project overview, architecture charter, execution contract, and cross-model handoff  
**Last compiled:** 13 October 2026 (Asia/Kolkata)  
**Project repository:** `SanamBhanuPrakash/Anibros-CRM_bolt`  
**Current architectural decision:** Native PostgreSQL + our own TypeScript backend; Supabase must not remain a runtime dependency in the final system.  
**Time policy:** No artificial deadline, no “Day 1/Day 2” completion plan. Continue safely in dependency order until the agreed project scope is built and verified.

> **Evidence warning:** This file consolidates the user's durable goals, repository documentation, and recent Antigravity/Gemini execution reports. Those reports include claims that could not be independently verified against the local workspace from this document-authoring session. Every coding agent must inspect the actual local checkout, run the relevant checks, and update evidence-based status. This document is a handoff—not proof that the implementation is complete.

---

## 1. Purpose of this file

This file exists so the user can switch between Gemini, Claude, Antigravity, or another coding model when a model quota ends without repeatedly explaining the project, architecture, history, standards, scope, or current risks.

A new model must read this file together with the living project records listed below, inspect the actual repository, and continue implementation. It must not restart the project, discard previous work, or treat a previous model's report as unquestionable truth.

### Read these files at the start of every new model/session

Read the current local versions in this order when present:

1. `PROJECT_OVERVIEW.md` — this file: mission, architecture, standards, broad scope, handoff contract.
2. `MASTER_CONTEXT.md` — historical/current product context, user preferences, major requirements and known risks.
3. `AI_AGENT_MASTER_PROMPT.md` — coding-agent working contract, evidence rules, task workflow.
4. `masterplan.md` — exhaustive original product and feature plan; reconcile legacy assumptions with the final native architecture.
5. `plan.md` — current prioritized implementation backlog.
6. `PROJECT_LOG.md` — chronological implementation history and evidence ledger; read the latest entries first, then prior entries relevant to the task.
7. `AI_CONTEXT_BUNDLE.md` — generated repository snapshot. Regenerate only using the current project script when canonical files have been updated; do not treat a stale bundle as truth.
8. `docs/ARCHITECTURE.md` — original/high-level system design, product workflows, data model, threat model, reliability, deployment and rollout decisions.
9. `docs/MASTER_ENGINEERING_DIRECTIVE.md`, `docs/MASTER_REQUIREMENTS_LEDGER.md`, `docs/REQUIREMENT_TRACEABILITY_MATRIX.md`, source-coverage reports, native schema maps, security review, migration/rollback plan, and release-readiness files where present.
10. Actual code, SQL migrations, API routes, UI pages, tests, package scripts, CI configuration and Git state related to the current task.

If files are missing locally, record the missing file and continue from available canonical sources. Do not invent their contents. If an important file exists only in GitHub or a previous handoff, inspect/recover it safely without overwriting user changes.

---

## 2. Source-of-truth and evidence hierarchy

When documents conflict, follow this order:

1. The user's latest explicit instruction and non-negotiable safety constraints.
2. Actual current local source code, migration files, configuration, Git state and reproducible runtime/test evidence.
3. Actual repository/CI state on the verified branch/commit being discussed.
4. Canonical project docs and requirements ledger after checking when they were last generated.
5. Historical project logs and previous AI-generated reports.
6. A model's recollection or assumptions.

A previous report saying “implemented,” “passed,” “secure,” “zero runtime dependency,” or “production ready” is a claim—not independent verification. Establish what code is actually running, which branch is checked out, which files are committed, which tests were executed, and what those tests truly assert.

### Required evidence vocabulary

Use these statuses consistently:

- **PASS** — the stated acceptance criteria were executed and satisfied with reproducible evidence.
- **PARTIAL** — some behavior works, but a defined portion remains incomplete or unverified.
- **FAIL** — an acceptance criterion failed or a defect remains.
- **BLOCKED** — work cannot safely proceed because of an identified external dependency, permission, credential or environment constraint.
- **NOT VERIFIED** — implementation may exist, but adequate evidence is missing.
- **DEFERRED** — intentionally left for a later phase; the reason and dependency are documented.
- **NOT APPLICABLE** — requirement is genuinely outside this product/approved scope, with rationale.

“File exists,” “typechecks,” “migration applies,” “endpoint returns some response,” “WebSocket subscribes,” or “page renders” do not independently prove the feature is correct.

### Evidence that must accompany important claims

For each significant requirement, maintain this chain:

`Requirement ID → design/decision → schema/API/UI implementation → test(s) → test output/runtime observation → status → remaining gaps`.

Do not manually edit recorded test counts to make logs look current. Counts must come from actual test-run output. Keep test assertions meaningful and ensure they fail when expected behavior is wrong.

---

## 3. Mission and product vision

Build **Anibros CRM**, a comprehensive, multi-tenant real-estate CRM and marketing operations SaaS platform for Anibros Design, its real-estate clients, and potentially other agencies/developers.

The product must manage the whole path from lead capture and attribution through qualification, property matching, follow-up, viewing, negotiation, conversion, and operational analysis. It is not simply a dashboard or attractive front-end. It should provide trustworthy workflows, accurate data, tenant-isolated operations, traceable decisions and recoverable integrations.

### Target users/personas

- **Sales agent:** works assigned/authorized leads, contacts, follow-up tasks, activity history, properties and viewings.
- **Sales manager:** manages team assignment, lead pipeline, viewing coordination, stale leads, stage progression and operational performance.
- **Marketing manager:** configures integrations and automations, understands acquisition sources/campaigns, evaluates lead quality and conversion outcomes.
- **Marketing analyst:** reads permitted marketing and funnel data without performing prohibited writes.
- **Tenant owner/admin:** administers workspace configuration, members, roles, permissions, integrations and authorized diagnostic operations.
- **Executive/read-only user:** views permitted dashboards/reports without mutation capability.
- **Auditor:** can inspect the allowed audit/operational records without changing business data.
- **Anibros/agency operator:** manages multiple client workspaces only through explicitly authorized, scoped access; must not receive blanket access to every client's individual records.
- **Platform operator:** manages platform-level health and provisioning through a separate, strongly controlled administrative boundary.

### Core differentiator

The differentiator is **reliable and traceable lead-to-deal workflows**, not feature count:

- Every lead has an identifiable source where applicable.
- Every meaningful mutation is authorized, validated, audited and transactional where needed.
- Every pipeline transition follows an explicit allowed-transition state machine.
- Every external event is durably recorded and idempotently processed.
- Every integration status reflects actual checks/deliveries rather than a UI toggle.
- Every report has a defensible definition and accurate query semantics.
- Every open authorized view receives relevant updates and recovers correctly after a disconnect.
- Failures explain what happened, what is affected and the next safe action.

---

## 4. Quality ambition: “FAANG-level” engineering, not a marketing label

The user's non-negotiable expectation is that every change—even a small type fix—is handled with disciplined software-engineering, security, testing, design, architecture and operational review. There is **no compromise on correctness, security, maintainability or evidence**.

This does not mean overengineering every feature or copying a large company's organizational bureaucracy. Use the appropriate depth for the risk. A small UI change still needs a focused regression/accessibility review; a schema/authentication/tenant change needs a rigorous design, negative tests, migration analysis and security review.

### Required engineering roles to simulate for each meaningful change

Before coding, consider the change from these roles. They can be mental review lenses or actual agents/tools if available; do not pretend separate agents were used if they were not.

1. **Product/domain engineer:** Does the behavior match the real-estate CRM workflow, user permissions, business states and product terminology?
2. **Principal/staff engineer:** Is the design simple, modular, durable, extensible and consistent with the target architecture? Are dependencies and trade-offs explicit?
3. **Database architect:** Are schema constraints, transaction boundaries, isolation, indexes, migrations, data ownership and deletion behavior correct?
4. **Application security engineer:** What is the threat model? Can an untrusted user bypass auth, switch tenant context, elevate roles, replay a token, inject SQL or cause data leakage?
5. **Reliability/distributed-systems engineer:** What happens on duplicate delivery, concurrent requests, timeout, partial failure, reconnect, worker crash or retry?
6. **Test/quality engineer:** Do tests assert behavior rather than implementation existence? Are negative, boundary, concurrency and regression cases covered?
7. **Frontend/design-system engineer:** Is the interaction understandable, accessible, consistent, responsive and faithful to the design system?
8. **Accessibility reviewer:** Do keyboard navigation, screen readers, focus, labels, error associations, contrast, zoom and touch targets work?
9. **Performance engineer:** Are query volume, indexes, pagination, N+1 queries, rendering, caching and concurrency sensible for realistic data?
10. **Operations/SRE engineer:** Can it be logged, monitored, diagnosed, rolled out, rolled back, restored and supported by a non-developer operator?
11. **Privacy/data-governance reviewer:** Are PII, consent, retention, exports, deletion and provider payloads handled deliberately?
12. **Code reviewer:** Is the diff focused? Are abstractions necessary? Are names, types, errors and documentation maintainable? Did unrelated functionality regress?

### Definition of a well-engineered change

A meaningful change is not complete until applicable items below are satisfied:

- Requirements and acceptance criteria are explicit.
- Existing implementation and consumers were inspected before editing.
- Design and alternatives were considered for risky changes.
- Input validation and server-side authorization are correct.
- Database state is transactionally correct where required.
- Failure, timeout, retry and rollback behavior are defined.
- Logs/audits are appropriately added and sensitive information is redacted.
- Loading, empty, success and error UI states are handled.
- Accessibility and responsive behavior are reviewed for UI changes.
- Unit/integration/browser/negative tests are added as appropriate.
- Relevant existing tests, type checks, lint and build are run.
- Changed files and the full diff are reviewed for unintended effects.
- Architecture docs, plan and project log are updated with evidence.
- Remaining work and untested assumptions remain visible.

---

## 5. Time and execution policy

There is **no fixed completion date and no artificial model-imposed time limit**. Previous prompts temporarily framed a core implementation around a 48-hour window; the user's current instruction supersedes that framing. Do not plan around “Day 1” and “Day 2,” do not prematurely cut features just to meet an invented deadline, and do not use time pressure as justification for reduced security or testing.

Continue in an incremental dependency order:

`inspect → define acceptance criteria → design → implement → test → review → fix → document evidence → next task`.

The model should autonomously continue to the next safe, highest-priority task without asking the user to repeat context. Ask the user only when an actual product decision is necessary or an action has external/irreversible consequences, such as production deploy, push/merge, live provider changes, destructive data operation or real-data cutover.

If a credential or external service is unavailable, mark the real integration test `BLOCKED`, create safe fixtures/mocks for deterministic tests, continue other work, and do not pretend the external integration was verified.

---

## 6. Final architecture decision

### Required target

- **Frontend:** React 18 + TypeScript + Vite, with React Router and coherent Material UI design system.
- **Backend:** Our own TypeScript HTTP API, currently reported as Express-based.
- **Database:** Standard native PostgreSQL, current local report says PostgreSQL 17. The chosen major version must be recorded in an ADR and consistent across local, CI, tests and production target.
- **Database driver:** Standard PostgreSQL client/pool with safe transaction handling.
- **Authentication:** Application-owned accounts, password hashing, email verification, server-side sessions, session revocation and password reset.
- **Authorization:** Server-enforced roles/permissions; trusted tenant membership lookup; database constraints and RLS as defense in depth where designed correctly.
- **Realtime:** Our own authenticated server-side realtime mechanism, reported as WebSocket plus PostgreSQL `LISTEN`/`NOTIFY` or equivalent, with snapshot reconciliation/fallback.
- **Async work:** Our own durable inbox/outbox/worker execution with leases/locks, idempotency, retries and dead-letter handling.
- **Observability:** Structured logs, correlation IDs, audit history, health/dependency checks, queue diagnostics, incident state and safe operational actions.
- **Deployment target:** Same core architecture locally and on infrastructure under our control. Development and production configuration remain separate.

### Explicitly prohibited final-state dependencies

Supabase may remain as a historical reference or migration baseline where justified, but it must not be used by the final runtime application. This excludes:

- Supabase Auth as the account/session provider.
- Supabase JavaScript client calls for database access or RPC.
- Supabase Channels/Realtime.
- Supabase Edge Functions as active workers/API handlers.
- Runtime reliance on `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `auth.uid()`, `auth.users` or Supabase-specific deployment roles/schemas.
- A hidden fallback that silently uses Supabase when the native API fails.

Do not self-host Supabase as a workaround. The chosen goal is standard PostgreSQL plus our own backend and services.

### Recommended architecture style

Begin with a **modular monolith**, not microservices by default. Keep clear domain boundaries within the backend, shared contracts where appropriate, transactions at business consistency boundaries, and separate workers/processes where operational needs demand them. Extract services only when justified by scale, reliability, deployment isolation or team boundaries—not for appearance.

### High-level request flow

`Browser → Native API client → HTTPS/API security middleware → session authentication → membership/role authorization → validated domain service → transaction + native PostgreSQL → audit/outbox → response and authorized realtime update`.

External event flow:

`Provider → authenticated webhook adapter → durable inbox/idempotency record → queue worker → normalized contact/lead/attribution transaction → audit/outbox → authorized realtime → subscribed CRM views`.

Outbound event flow:

`Business transaction → transactional outbox record → worker lease/claim → consent/policy check → provider adapter → bounded retry or terminal/dead-letter state → operational visibility`.

---

## 7. Security architecture and trust boundaries

Security must be designed as layers. No individual UI guard, API middleware, database policy, or test proves the entire boundary on its own.

### Identity and sessions

- Passwords are hashed with Argon2id; they are not reversibly encrypted.
- Password hashing parameters are calibrated and hashing concurrency is bounded to mitigate resource exhaustion.
- Use cryptographically random opaque session tokens. Persist only the token hash.
- Enforce expiry, revocation, logout, rotation and password-reset invalidation on the server.
- Use HttpOnly cookies and appropriate SameSite/Secure/path settings. Apply `__Host-` constraints correctly in HTTPS production.
- Protect cookie-authenticated state changes with CSRF and trusted-origin controls.
- Prevent account enumeration on login/reset/verification flows.
- Email verification and reset tokens are random, hashed at rest, short-lived, single-use, bound to the intended identity, and atomically consumed.
- Never accept `autoVerify` or any similar client-supplied bypass as authority.

### Tenant isolation

- Determine user identity from a verified server-side session.
- Resolve the tenant from verified memberships and authorization policy, not merely a browser-supplied tenant ID.
- Enforce per-route role capabilities on the server.
- Use tenant-aware foreign keys/composite constraints where appropriate.
- If RLS uses transaction-local settings, only the trusted backend may establish context after authentication and membership verification. A transaction setting by itself is not a cryptographically authenticated identity.
- Runtime DB role must not be a superuser, table owner or `BYPASSRLS` role; avoid unnecessary DDL privileges.
- Test policies using actual non-owner runtime roles. PostgreSQL table owners and privileged roles can bypass ordinary RLS protections.
- Ensure pooled connection context cannot bleed from one request/tenant into another.
- Return safe 404/403 responses that do not reveal other tenants' existence or data.

### Secrets and encryption

- No secrets in Git, frontend bundles, documentation bundles, generated context files or logs.
- No SMTP/API secrets in Vite variables.
- Use TLS in transit and an explicit at-rest encryption strategy for database volumes/backups.
- Encrypt sensitive integration credentials/tokens using a documented key-management, access, rotation and recovery approach. Do not keep keys alongside ciphertext in the same database.
- Redact passwords, cookies, session/reset/verification tokens, provider tokens, HMAC secrets, connection strings and sensitive PII from logs.
- Avoid persisting full raw provider payloads unless required; define redaction, access control, size limits and retention.

### Role/permission model

Use a central, documented role-permission matrix. Historical roles include tenant owner/admin, sales manager/agent, marketing manager/analyst, executive read-only, auditor, plus separately controlled platform/agency roles where product requirements justify them. Do not grant platform-wide agency-owner access automatically to every signup. Enforce privileges on the server and, where appropriate, in DB policy/function privileges.

### Security references

Use relevant OWASP ASVS 5.0.0 controls and OWASP cheat sheets as testable guidance. State which controls are in scope and which are verified. Never claim blanket ASVS compliance from a handful of controls or successful tests.

---

## 8. Data model and database engineering

The native schema must preserve the full existing CRM business model and correct legacy defects. It must not be simplified until features cannot work, nor expanded with empty placeholder tables just to increase a completion count.

### Required core domain groups

**Identity and tenancy:** users, credentials/security state, sessions, verification/reset tokens, organizations, tenants/workspaces, branches if needed, memberships, invitations, role/permission model, tenant configuration.

**CRM entities:** contacts, leads, source/provider identity, pipeline, stages, allowed stage transitions, transition history, assignment history as required, activities, tasks, viewing/appointments.

**Property and sales:** projects/developments, properties/units, property status/availability history, property matching criteria/results where persistence is needed, deals/opportunities/offers if required by masterplan.

**Marketing:** source/campaign/ad identifiers, attribution touchpoints/records, consent and opt-out history, custom field definitions/values, automation rules/executions.

**Integrations:** integrations, provider credential references, webhook endpoint/configuration, durable webhook inbox, idempotency keys, outbox events, worker attempts, retry/DLQ state.

**Operations/security:** audit events, structured operational logs, health observations, incidents, notification records and per-user read receipts, export/deletion audit, security events.

**SaaS readiness:** plan/entitlement/subscription schema and billing integration only to the extent approved; schema-only billing must be explicitly called out as incomplete.

### Database design requirements

For every table, document ownership, primary key, foreign keys, composite tenant constraints, unique/check constraints, indexes, sensitivity, deletion policy, audit behavior, permissions and important query patterns.

- Keep migrations forward-only and versioned; do not silently edit applied history.
- Use a dedicated migration role separate from application runtime.
- Make migrations deterministic, locked against concurrent runners, checksum-verified, failure-aware and tested from an empty database.
- Use transactions for multi-entity operations.
- Establish correct concurrency control, not only happy-path validation.
- Use bounded pagination, appropriate indexes and measured query behavior.
- Treat audit and event records deliberately; define mutation restrictions and retention rather than asserting absolute immutability without a clear trust model.
- Ensure table constraints reflect actual product invariants.
- Map every legacy table, enum, function, trigger, policy and workflow to its native replacement or a documented, approved deferral/removal.

### Specific legacy issues to verify during migration

- Legacy role checks and overlapping/permissive RLS policies.
- Old global queue-recovery function signatures in addition to newer tenant-scoped overloads.
- Helpers that accept arbitrary user IDs for membership/administrative checks.
- Invitation role elevation and missing acceptance/revocation semantics.
- Signup privilege escalation.
- SQL functions whose security-definer execution context differs from assumed caller identity.
- Search/pagination/filtering correctness.
- Notification read receipts scoped to both user and tenant/notification relationship.
- Queue worker idempotency and partial writes.
- Provider secret/PII in persisted raw webhook payloads.
- Property matching with missing locality and unavailable/sold properties.
- Any count/analytics built from a limited sample instead of a real aggregate.

---

## 9. Complete product scope — no silent omissions

The project covers the following workstreams. A module is delivered only when its real workflow is implemented, authorized, persisted, synchronized, tested, and documented.

### A. Application foundation and experience

- Responsive application shell, routes, navigation, workspace selector, user menu and error boundaries.
- One coherent MUI theme, shared component library, design tokens, typography, states and responsive layout.
- Accessible mobile, tablet, laptop and desktop experiences.
- Search, filtering, pagination, loading/empty/error states, notifications and global feedback.
- Appropriate role-aware navigation and screen-level capabilities, backed by actual API enforcement.

### B. Identity, authentication and workspace lifecycle

- Signup, sign-in, email verification, resend, forgot/reset/change password, session listing/revocation as scoped, logout, expiry handling and disabled-account handling.
- Safe user onboarding, organization/workspace/tenant provisioning, default pipeline seeding, membership roles and invitation acceptance.
- Role changes, deactivation, access revocation, audit history, abuse/rate-limiting controls and account security.
- No client-controlled admin, tenant, verification or platform role bypass.

### C. Leads and contacts

- Create/read/update/archive and permitted delete flows.
- Search, filters, pagination, deduplication, associations, assignment, ownership, history and source/provider identity.
- Import/export with validation, size limits, row-level errors, idempotency and tenant-safe filtering.
- Activity timelines and relevant notification/realtime updates.

### D. Sales pipeline and deals

- Pipeline board, stages, allowed transition matrix, stage configuration where authorized, stage history and invalid-transition handling.
- Assignment and sales-manager workflows.
- Deals/opportunities/offers if established by the product masterplan.
- Transactional writes with audit history and required outbox/automation events.

### E. Projects, inventory, properties and matching

- Project/development lifecycle and property/unit inventory.
- Property CRUD, location, type, pricing, images/documents as scoped, listing state and archival.
- Availability state transitions and history; protection against recommending sold, unavailable, archived or otherwise unsuitable inventory.
- Lead preference capture and explainable matching scores/reasons.
- Regression tests for budget, location/locality, transaction type, property type, bedrooms, empty/missing fields and availability.

### F. Tasks, activities, viewings and calendar

- Tasks, priority, assignment, due dates, completion and relevant reminders.
- Activities and timeline history.
- Viewing scheduling, reschedule/cancel/confirm/complete workflows, feedback and valid status transitions.
- Correct date/time/time-zone interpretation, availability checks and range queries.
- Atomic scheduling and race-safe agent/property interval conflict prevention. Different start times that overlap must conflict when business rules say the resource is exclusive.

### G. Dashboard, reports and attribution

- Correct server-side aggregates with documented metric definitions.
- Accurate date filters/time boundaries; avoid inconsistent filters between live inbox and reports.
- Agent, pipeline, source, campaign and conversion reporting with explainable definitions.
- Attribution relationships/models, stable provider identifiers, consent and opt-out handling, no duplicate counting.
- Tenant-safe CSV exports and other approved data extracts.
- Bounded queries, query/index tests and plausible performance under representative data volumes.

### H. Marketing/provider integrations

- Google Ads lead-form ingestion and related supported workflow.
- Meta Lead Ads verification, lead-detail retrieval, durable processing and tenant resolution.
- Website/manual/CSV lead intake where applicable.
- Meta Conversions API and Google Enhanced Conversions for Leads outbox workflows where approved.
- WhatsApp Cloud API and email-provider integration where approved, including template/delivery/status events and consent/policy behavior.
- Per-tenant integration configuration, server-only credentials, connection-health checks and accurate state transitions.
- Sandbox/fixture tests. Real-provider E2E is separately labelled and remains blocked without credentials/permission.

### I. Durable event processing and workers

- Inbound webhook inbox: signature validation, payload validation, idempotency, acknowledgement only after durable receipt.
- Worker execution: safe claims/leases, `FOR UPDATE SKIP LOCKED` or sound equivalent, bounded processing, transaction boundaries, retries/backoff, terminal failure/DLQ and controlled replay.
- Outbox created transactionally with relevant business events.
- Idempotent provider requests and handling of ambiguous timeouts.
- Worker scheduling/lifecycle, concurrency, graceful shutdown, visibility and recovery.
- No dependency on manually clicking a diagnostics button to make normal processing happen.

### J. Notifications and automation

- Targeted/broadcast notifications, user-specific read receipts, correct ownership and tenant validation.
- Automation rule configuration, supported trigger/action catalogue, execution logs, idempotency and retries.
- UI must never advertise an automation action the execution engine does not implement.

### K. Tenant administration, custom fields and commercial readiness

- Workspace settings, authorized member/invitation management, custom fields/values, tenant configuration, audit access and permitted system settings.
- Server-enforced entitlements/permissions where subscription plans are in scope.
- Billing integration only when approved and actually implemented; never imply billing is active merely because plans/subscription tables exist.
- Data export, retention and deletion workflows with approval/audit where required.

### L. Operations Center and observability

- Structured event/log explorer with correlation/trace IDs and safe payload views.
- Audit trail with precise actor/resource/action/time data.
- Health checks based on real dependency probes and freshness rules.
- Integration health from actual connectivity/delivery signals.
- Webhook inbox/outbox state, queue depth/age, retries, dead letters and worker heartbeat.
- Incident create/acknowledge/resolve lifecycle and next-action guidance.
- Safe authorized replay/recovery actions with reason, audit and idempotency controls.
- Accurate database counts and pagination; never use a limited sample as if it were total system state.
- PII/secret redaction, retention, archival and access policies.

### M. Platform operations and production readiness

- Environment separation, config validation and secret management.
- Native database provisioning and migration rollout/rollback strategy.
- Automated CI and dependency/security scanning.
- Structured logs, metrics, alerts, runbooks and incident response.
- Encrypted backups, retention policy, off-site copies where appropriate and verified restore drills.
- Performance, concurrency, failure-injection and realistic-volume tests.
- Controlled pilot/cutover, monitoring, rollback and data reconciliation.
- Privacy, consent, data lifecycle and India DPDP/legal review where applicable; legal compliance claims require qualified review.

---

## 10. Realtime and data consistency rules

Realtime is a delivery acceleration layer, not the source of truth. PostgreSQL remains authoritative.

- Realtime must require a valid session and authorize each tenant/topic subscription.
- Avoid putting sensitive full row payloads in `NOTIFY` messages; notifications should identify a safe event/resource/cursor, with authorized data loaded by the backend.
- Handle the initial-fetch/subscription race.
- Handle duplicate messages, missed messages, reconnect and backoff.
- On reconnect, reconcile against a database snapshot/event cursor so the UI converges to current state.
- Use fallback polling with bounds/backoff when realtime is unavailable.
- Propagate create/update/assignment/stage/availability/task/viewing/notification changes to relevant active pages.
- Never equate `WebSocket SUBSCRIBED` with an end-to-end event being delivered.
- Measure latency targets and describe them as targets until measured.

---

## 11. Material UI and design-system policy

MUI being installed is not the same as an application-wide Material UI migration. The repository historically used a mixture of a centralized MUI theme/bridge and custom Tailwind-based primitives. Recent local reports claim broader migration; verify current source and runtime.

The design reference supplied by the user is `https://ai-web-scraper-gilt.vercel.app/`. Inspect it in a real browser if available. Measure its actual computed typography, weights, layout, spacing, color and details. Do not guess a specific font family when it cannot be inspected; document the limitation.

- Keep one source of truth for colors, spacing, typography, radii, elevation, breakpoints and component state.
- Prefer shared MUI-based primitives and consistent component APIs.
- Keep button, field, dialog, menu, table, chip, alert/snackbar, skeleton, empty state and form behaviors consistent.
- Design for 320–1920px widths, keyboard operation, touch, high zoom and meaningful responsive alternatives for dense tables.
- Meet accessible labels, error associations, focus behavior, color contrast and reduced-motion preferences where animations exist.
- Avoid visual bloat. Premium quality comes from hierarchy, typography, rhythm, spacing, alignment, restrained color and dependable interaction.
- Use loading/error/success/empty/disabled states as first-class design states.
- Never substitute an image/mock screen for an actual working interactive page.

---

## 12. Quality-engineering strategy

Tests should be layered and complementary.

### Unit tests

Password policy, token behavior, validators, role-capability functions, state transitions, normalization, matching score calculations, attribution rules, formatters and error mapping.

### PostgreSQL integration tests

Fresh database bootstrap, migration ordering/idempotency/checksum, transaction rollback, constraints, composite tenant relationships, runtime grants, RLS under actual non-owner role, pool context reuse, concurrency, unique/idempotency behavior and query semantics.

All destructive setup must identify a dedicated disposable test database and assert its name/target before cleanup. Never run test cleanup against the user development DB, hosted Supabase or real client data.

### API integration tests

Authentication, validation, authorization, tenant isolation, CRUD, transaction boundaries, error responses, rate limits, idempotency, retries and all high-risk routes. Assert state in PostgreSQL and expected response semantics—not merely “some error other than 404.”

### Browser/E2E tests

Signup through native backend, email verification test flow, login/session/refresh/logout, lead CRUD, valid/invalid stage transitions, property matching, booking conflicts, tasks/calendar, notifications, integration configuration and operations diagnostics. Use isolated test tenants and test accounts. Confirm browser network has no Supabase runtime calls.

### Realtime/worker tests

Actual event generation and observation, cross-tenant non-delivery, reconnect reconciliation, duplicate delivery, worker restart, stale lease recovery, dead-letter behavior and replay authorization.

### Accessibility/responsive tests

Test key pages at mobile/tablet/desktop sizes, keyboard-only use, labels, errors, focus, contrast, zoom and responsive data interaction.

### CI/production checks

- Full frontend and backend type checking.
- Lint (report both errors and warnings honestly).
- Unit/integration test suites.
- Production build.
- Migration validation on a clean PostgreSQL instance.
- Dependency and secret scanning.
- Guard against reintroduction of Supabase runtime imports/endpoints/env dependencies.

A green build is not proof that database access, signup, security, realtime, integrations or workflows are correct. A test suite count alone is not a coverage or correctness metric.

---

## 13. Current known state and reconciliation caveats

This section is a snapshot based on the user's recent Antigravity/Gemini logs and the remote GitHub review available when this document was compiled. Recheck local state every session.

### Remote repository state independently observed

- Repository: `SanamBhanuPrakash/Anibros-CRM_bolt`.
- The accessible remote `main` revision was `1b0fd3375652d7bd19e7cf13fe201695f7c57fa3`, message: `feat(p0-remediation): reconcile schema contracts, harden tenant recovery, and deploy migration 026`.
- The remote branch list did not include `feat/native-postgresql-migration` at the time of review.
- The remote `main` tree still contained Supabase-era files and dependencies, including `@supabase/supabase-js`, the legacy `src/lib/supabase.ts`, Supabase-auth-connected versions of signup/sign-in/password reset, 27 timestamped migration files numbered 001–026 (with two files using the number 018), four Supabase Edge Functions and test scripts targeting the hosted project.
- A successful GitHub CI run existed for remote `main` at that SHA. It tested the remote code at that SHA—not the unpushed local native branch.

### Latest local implementation claims reported by Gemini

The most recent user-shared log reports the following local work on `feat/native-postgresql-migration`:

- Native PostgreSQL 17, migrations 001–006, a migration runner and connection pool.
- Express/TypeScript native API and route modules.
- Argon2id password hashing, session token hashing, HttpOnly cookies, CSRF checks, rate limiting and password-reset/email-verification records.
- Native lead/contact/project/property/task/viewing/notification/tenant/operations/webhook endpoints.
- A durable worker and an authorized WebSocket path.
- Frontend work to remove Supabase-backed paths, connect native routes and unify components with MUI.
- A native verification/signup flow and a local browser/API check.
- Reported `npm run typecheck`, `npm test` at 89/89, `npm run build` and a local commit named `d411c16` for the latest middleware import/type fix.

These are **reported local results**. Independent confirmation of the final source and commit is still required. An earlier local report also cited commits `d3d8f0f` and `1d38f9c6`; commit references have changed across successive runs. Always inspect actual `git rev-parse HEAD` and the actual files rather than copying a SHA from this snapshot.

### Specific issues to verify immediately

1. **Latest middleware cleanup:** the latest report says old `auth.ts` and `tenant-context.ts` shims were removed and consumers now import `auth-guard.ts`. Confirm no stale imports, missing runtime modules or duplicate authorization implementations remain.
2. **Native signup:** a previous screenshot showed a Supabase Auth confirmation email. The later local logs claim native signup. Reproduce signup in the actual browser and inspect the network request, database state and mail delivery mechanism.
3. **`autoVerify`:** a prior test request included an `autoVerify` field. Ensure no untrusted browser request can bypass email verification. Any test-only bypass must be impossible to enable in production and cannot depend on client input.
4. **Outbound email:** a deterministic development sink is not proof of real email delivery. Check whether a real SMTP/transactional mail adapter is configured, and test only when credentials and permission exist.
5. **Full Supabase removal:** search all `src/`, server, package scripts, lockfile, CI, route imports, realtime, environment and deployment configuration. A proxy shim or unused page hidden behind a gate is not full removal if the final requirement demands complete native coverage.
6. **MUI parity:** MUI theme/bridge existed before full migration; verify every current routed screen uses the coherent design system and the supplied font reference was actually inspected.
7. **Test evidence:** execute test commands and use output. Historical logs have shown manual edits to recorded test counts; never treat a manually edited count as evidence.
8. **Route quality:** new APIs may compile but still have incorrect permissions, tenant-scoping, SQL projections, stale UI, incomplete update methods or ignored database errors. Test behavior and database state.
9. **Schema parity:** earlier native work began with fewer entities/enums than the legacy product model and deferred several domains. Reconcile all of them rather than silently dropping capability.
10. **Production readiness:** local successful requests do not establish deployment, TLS, backups, mail delivery, provider access, restore recovery or safe real-data migration.

### Honest status rule

Do not estimate a project completion percentage unless the requirement ledger has a transparent, stable weighting/formula. Describe which workflows are verified, which are partial, and which are deferred. The goal is the complete CRM; the current phase is not the final product by definition.

---

## 14. Dependency-ordered roadmap — continue until complete

This roadmap has no time boxes. Work on the earliest unsatisfied dependencies, but do not pause unrelated safe work if an external dependency blocks one track.

### Track 0 — Repository and runtime truth

- Confirm branch, HEAD, clean/dirty state, local paths, changed files and remote relation.
- Reproduce scripts and identify which database they target.
- Verify which frontend/API process serves the user-visible port.
- Check tests and CI against the exact source being worked on.
- Regenerate context bundle from current canonical docs only after changes are recorded.

### Track 1 — Auth and migration safety

- Audit current middleware/auth cleanup and all consumers.
- Prove native signup, email verification, sign-in, session lifecycle, logout, reset and actual mail transport status.
- Close any bypass, privilege escalation, enumeration, CSRF or session rotation gaps.
- Verify migration runner, runtime role, RLS, foreign keys and tenant context.
- Add regression tests before building on the auth contract.

### Track 2 — Native runtime consistency

- Remove residual Supabase runtime access from auth, hooks, components, background jobs, config, CI and packages in controlled dependency order.
- Establish a typed API client, shared request/response contracts, centralized errors and server validation.
- Add contract tests to prevent drift between frontend and backend.
- Ensure native mode does not depend on Supabase variables or hidden fallback behavior.

### Track 3 — CRM business modules

- Complete contacts and lead lifecycle.
- Complete pipeline state machine and deal/opportunity model required by scope.
- Complete projects, property lifecycle, availability history and matching.
- Complete tasks, activities, viewing/calendar workflows and reminders.
- Complete notifications/read receipts.
- Complete dashboard/report/attribution definitions, exports and query performance.
- Complete tenant settings, memberships, invitations, custom fields and automation.
- Complete subscriptions/entitlements only to the approved product scope.

For each module: API + DB transaction/constraints + auth/tenant/role checks + UI + audit + realtime/cache invalidation + positive/negative tests.

### Track 4 — Realtime and reliable integration/event processing

- Native authorized WebSocket service, tenant scope, reconnect, event cursor/snapshot reconciliation and fallback polling.
- Provider webhook adapters with actual authentication/payload semantics.
- Durable idempotent inbox and transactional outbox.
- Worker scheduling/lifecycle, queue claims, timeouts, retries, terminal/dead-letter state and replay.
- Provider credential security, consent/opt-out and delivery telemetry.
- Controlled provider fixtures/sandbox testing and explicitly blocked live checks where access is absent.

### Track 5 — Operations Center and platform support

- Accurate logs, audit, health, incidents, integrations, queues, worker status and safe recovery.
- Structured logs with correlation IDs, redaction and useful error taxonomy.
- Pagination/indexes, retention, archival, privacy and tenant-scoped diagnostics.
- Alerts/runbooks and restore/recovery instructions.

### Track 6 — Consistent MUI UX and accessibility

- Inspect the user-provided reference site and record findings.
- Standardize typography/tokens/components/theme.
- Migrate all pages and shared controls, eliminate inconsistent styling.
- Test every screen size, keyboard path, focus/error/loading/empty behavior and higher zoom.
- Verify forms/password visibility, tables, dialogs, navigation and notifications in real browser interactions.

### Track 7 — Quality, performance and production readiness

- Full automated tests in CI against native PostgreSQL.
- Security/threat-model and tenant-negative review.
- Performance/load/concurrency checks on realistic data.
- Dependency/security scanning and secret scanning.
- Encrypted backup, restore drill, retention, RPO/RTO and failure-recovery evidence.
- Production environment separation, TLS/reverse-proxy/trusted-forwarding setup, secret rotation, migration/rollback plan.
- Staged data migration/cutover/reconciliation plan from the historic system if needed.
- Controlled pilot and production sign-off only after critical gates pass.

### Track 8 — Final Supabase elimination gate

When every needed native replacement works:

- Remove `@supabase/supabase-js` and all Supabase runtime imports/calls.
- Remove `VITE_SUPABASE_*` configuration and CI injections that exist only for runtime use.
- Remove/replace auth/database/RPC/channel dependencies, Edge Function runtime and hosted-only job orchestration.
- Retain historical migrations/reference code only when deliberately classified as archival and not in runtime/build paths.
- Add automated repository/CI guards against reintroduction of Supabase runtime references.
- Prove all required workflows work with Supabase variables absent and no network requests to Supabase domains.

---

## 15. Production release gates

Do not call the CRM production-ready until relevant gates are `PASS` with evidence.

### Functional correctness

- Every routed product feature has an implemented backend and real data persistence.
- No fake/static success states or inaccessible hidden capabilities.
- Business workflows and state machines match product requirements.
- Data exports/reports match documented definitions.

### Security

- Auth/session lifecycle and verification work in browser and API.
- Backend permissions, tenant isolation and DB constraints block negative cases.
- Secrets/PII are protected and logs are redacted.
- Sensitive integration/admin operations are authorized and audited.
- Appropriate security scanning and scoped ASVS review completed.

### Reliability

- Migrations/bootstrap are reproducible.
- Concurrency/idempotency/retry/recovery cases pass.
- Realtime recovers from disconnect/missed events.
- Graceful shutdown and failure modes work.
- Queue dead letters and replay are operationally safe.

### Operations/data protection

- Structured logs, health, alerts/runbooks and incident workflows exist.
- Backup encryption/retention and restore drills are demonstrated.
- RPO/RTO are documented and evidence-based.
- Data retention/export/delete and consent rules are documented/enforced.

### Experience/accessibility

- MUI design system consistently applied.
- Mobile/tablet/desktop layouts work.
- Keyboard, focus, labels, contrast and error accessibility are checked.
- Authentication and core business workflows tested in a browser.

### Deployment and transition

- Local, test, staging and production configuration separation is clear.
- Secrets and reverse-proxy settings are correct.
- Migration/rollback/cutover plans have been reviewed.
- Real client data and provider systems remain untouched until explicitly authorized.
- CI is green for the actual candidate commit, not just an older remote `main`.

---

## 16. Git, environment, and production safety rules

- Work on the intended feature branch; do not modify `main` directly.
- Preserve user modifications and untracked files.
- Never use `git reset --hard`, `git clean`, destructive schema resets or broad overwrites as routine cleanup.
- Before committing, inspect the complete `git diff`, run `git diff --check`, and run appropriate tests.
- Commit only coherent, tested changes with descriptive messages. Do not push/merge without approval.
- Never expose `.env.native`, `.env`, database URLs, cookies, passwords, OAuth tokens, SMTP/API secrets, service keys or signing material.
- Use ignored local environment files and safe `.env.example` templates containing placeholders only.
- Keep local, test, staging and production databases distinct. Every destructive test must assert that its target is the intended disposable database.
- Do not run old Supabase/live-provider scripts against the hosted project or client data as part of native tests.
- Do not deploy, modify DNS, change live campaigns/provider configurations, perform real-data cutover or delete production data without explicit approval.
- Do not kill arbitrary processes. Identify executable, command line, working directory and port ownership before restarting a development server.

---

## 17. Documentation and handoff maintenance

Update these files as relevant, without duplicating conflicting sources of truth:

- `PROJECT_OVERVIEW.md` — durable architecture, mission and process; update current-state caveats only when evidence changes materially.
- `plan.md` — concise current prioritized backlog, with clear statuses and dependencies.
- `PROJECT_LOG.md` — chronological changes, exact commands/results and decisions.
- `MASTER_CONTEXT.md` — persistent product, user requirements, known history and key decisions.
- `masterplan.md` — complete product scope and long-horizon requirements; keep its final architecture aligned with native PostgreSQL.
- `AI_CONTEXT_BUNDLE.md` — generated snapshot, rebuilt from current canonical files.
- `docs/ARCHITECTURE.md` — target architecture and architectural decisions.
- `docs/MASTER_REQUIREMENTS_LEDGER.md` and traceability matrix — atomic requirement status with evidence.
- Native schema map, migration/rollback plan, security/threat model and release-readiness docs.
- ADRs when architecture decisions change.

Keep historical entries as history. Do not rewrite a previous failed status into a passing status; append the new evidence and update current-state summaries. Generated bundles must not contain secrets or stale Git-state claims.

A final response to the user must distinguish: implemented, test-verified, runtime-verified, provider-verified, blocked, deferred and not verified. Include the exact next action already being undertaken; do not merely give a roadmap and stop.

---

## 18. How a new model should start — mandatory checklist

At the beginning of every model switch/session:

1. Read this file and the latest project log/plan/context bundle.
2. Inspect the actual local repository state and latest commit.
3. Verify the active branch and ensure no user work is at risk.
4. Identify the most recent completed work and any reported fixes needing verification.
5. Run the narrowest relevant regression tests before new changes.
6. Choose the highest-priority unmet requirement based on dependency and risk—not personal preference.
7. Make an implementation change, not another audit-only report.
8. Test success, failure and authorization denial.
9. Inspect the full diff and any downstream consumers.
10. Update the project records and continue to the next safe task.

The model must not ask the user to repeat the project vision, restate the native PostgreSQL decision, re-explain the desired quality bar, or choose a task when the next safe dependency-ordered task is clear.

---

## 19. Immediate starting priorities from the latest reports

These are priorities to verify—not assumptions of current failure or success:

1. Verify actual local HEAD and the reported latest middleware cleanup (`d411c16` was the latest reported fix commit in the most recent error-resolution summary).
2. Confirm `auth-guard.ts` is the only canonical middleware contract and all imports, route behaviors and tests are consistent.
3. Run the actual full typecheck/tests/build/lint against the exact local HEAD. Capture raw output; do not manually alter reported counts.
4. Reproduce signup in the browser: native endpoint, PostgreSQL row, verification state, no Supabase request, and accurate mailer behavior.
5. Verify no client-controlled `autoVerify` or other privileged test bypass exists in production code.
6. Audit all routes and frontend claims from the latest local completion report. Ensure features are truly implemented, not replaced by simplified shells or fixtures.
7. Verify application-wide Material UI adoption, actual reference-site typography investigation and responsive interaction.
8. Reconcile the entire native schema with the product masterplan and original migrations; account for every deferred domain.
9. Continue through realtime, durable workers, integrations, Operations Center, complete CRM workflows, testing and production readiness.

Do not stop after these nine items if other required scope remains. They are the next starting priorities, not the whole backlog.

---

## 20. Final principle

Build the whole product with the rigor expected of a principal/staff engineering team: correct architecture, explicit trade-offs, secure defaults, robust data integrity, disciplined testing, accessible design, observability, operational recovery and trustworthy evidence.

Move fast by reducing rework and detecting defects early—not by skipping design reviews, tests, security or verification.

**There is no artificial deadline. The task is complete only when the agreed CRM scope has been implemented and appropriately verified, the final runtime has no Supabase dependency, production-readiness evidence exists, and every remaining limitation is explicit and accepted.**
