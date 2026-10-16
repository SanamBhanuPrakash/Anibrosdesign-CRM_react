# ANIBROS CRM — MASTER DIRECTIVE INTAKE, FULL-CONTEXT COMPREHENSION AND REQUIREMENT TRACEABILITY GATE

## PURPOSE

I am about to provide you with a long, comprehensive engineering directive for Anibros CRM. It defines our architecture, database design, native PostgreSQL migration, authentication, authorization, encryption, security, logging, auditability, integrations, reliability, observability, deployment, recovery, testing and production-readiness requirements.

Your first responsibility is to read, preserve, understand and account for the ENTIRE directive.

Do not skim it. Do not read only the beginning and ending. Do not rely on a summary. Do not implement only the features you happen to remember. Do not silently discard requirements that are difficult, time-consuming or inconvenient.

A short summary is not proof of comprehension.

## 1. INPUT PROTOCOL — DO NOT LOSE PART OF THE SOURCE

After receiving this instruction, wait for me to provide the complete master engineering directive.

I may provide it as one long message, a text file, or several explicitly numbered parts.

If I send multiple parts, maintain a receipt ledger showing which parts you received. Do not assume the source is complete until I explicitly send:

`END OF MASTER ENGINEERING DIRECTIVE`

If the input appears truncated, a part is missing, the message ends unexpectedly, or you cannot access the entire supplied source, report the precise gap and request the missing portion. Never invent the missing text.

Do not begin code changes while I am still supplying the directive.

## 2. PRESERVE THE DIRECTIVE VERBATIM

Once the full directive has arrived, preserve its complete original text without rewriting, summarizing, correcting or removing anything.

Create:

`docs/MASTER_ENGINEERING_DIRECTIVE.md`

The preserved document must contain the original supplied directive, including its headings, numbering, code examples, file paths, warnings, constraints, acceptance criteria and qualifications.

Do not replace the source document with your interpretation or a generated summary.

Record the character count, line count, byte count and SHA-256 digest of the captured UTF-8 file. These checks establish the identity of the captured file; they do not independently prove that the chat input was captured without truncation.

If you cannot faithfully extract the original prompt from the conversation into a file, explain the limitation. Do not fabricate a successful capture or claim a hash proves completeness against a source you cannot compare.

Preserve any additional source parts in their original order. Do not confuse your own wrapper instruction with the master engineering directive.

## 3. USE PYTHON FOR SYSTEMATIC CHUNKING WHEN NEEDED

If the directive is long enough that processing it in one pass risks context loss, use Python to create a deterministic, auditable chunking workflow.

Create a temporary script such as:

`scripts/process_master_directive.py`

The script should:

1. Read the preserved original UTF-8 file.
2. Retain the exact original content and line endings in the source document.
3. Split the directive into manageable, sequential sections.
4. Prefer Markdown headings and section boundaries when feasible.
5. If a section is too long, split it into smaller character ranges without silently deleting text.
6. Record each chunk's sequence number, source character offsets, line range, character count and SHA-256 digest.
7. Keep a manifest identifying every chunk and its position in the original source.
8. If boundary overlap is used for comprehension, explicitly record the overlap so it is not mistaken for additional source content.
9. Validate that every original character belongs to at least one chunk, the ranges are ordered and complete, and reconstructing the source from non-overlapping ranges reproduces the original exactly.
10. Fail visibly if any portion is missing, duplicated in the reconstructed content, reordered or altered.

Use a configurable chunk size appropriate to the available context. For example, start around 8,000–12,000 characters per chunk and reduce it if needed. Character counts are not token counts, so do not assume a fixed number of characters corresponds to a fixed number of model tokens.

Do not split only on spaces or blindly delete Markdown syntax. Preserve code blocks, numbered requirements, headings, lists, negative constraints and technical terminology.

If the directive is already fully accessible and comfortably fits in context, you may process it directly. Do not create unnecessary infrastructure just to appear thorough.

**Important:** Python splitting establishes source coverage, not understanding. You must subsequently interpret every chunk and integrate its requirements into one consistent specification.

## 4. READ IN MULTIPLE PASSES

Perform the following passes in order.

### Pass A — Structural inventory

Read the entire source and build an outline of every section, subsection, numbered item, list, code block, constraint, explicit prohibition, dependency, deliverable and definition of done.

Record each source heading and its source line or chunk range.

Do not infer that a section is unimportant simply because it is short.

### Pass B — Atomic requirement extraction

Review each source section individually.

Extract every actionable or constraining requirement into an atomic requirement ledger. A single paragraph may contain several separate requirements; split them into distinct records where necessary.

Assign stable identifiers such as:

- `ARCH-001`: architecture
- `DB-001`: database and migrations
- `AUTH-001`: authentication and sessions
- `SEC-001`: security and authorization
- `ENC-001`: encryption and key management
- `TEN-001`: multi-tenant isolation
- `INT-001`: integrations and event processing
- `LOG-001`: logs and audit trails
- `OBS-001`: observability
- `REL-001`: reliability and recovery
- `PERF-001`: performance
- `TEST-001`: testing and validation
- `DEP-001`: deployment and operations
- `CRM-001`: CRM business workflows
- `DOC-001`: documentation and governance

These are examples, not a closed list. Introduce other categories when the actual directive requires them.

Each ledger record must contain:

- Requirement ID.
- Exact source section and line or chunk reference.
- Original requirement wording or a concise, faithful representation.
- Requirement type: MUST, MUST NOT, SHOULD, COULD, or explanatory context, consistent with the source's actual force.
- Why it matters.
- Dependencies and related requirements.
- A concrete implementation or verification outcome.
- An acceptance test or evidence needed.
- Initial status: NOT STARTED, IN PROGRESS, PASS, FAIL, BLOCKED or NOT VERIFIED.

Preserve explicit exceptions, qualifications and conditions. Do not turn a conditional requirement into an unconditional one or weaken a MUST into a suggestion.

### Pass C — Independent section-by-section comprehension

For each source section, produce a short interpretation identifying its purpose, mandatory controls, dependencies, expected deliverables and verification conditions.

Compare this interpretation against the original source and atomic requirement ledger.

Check negative instructions particularly carefully, including instructions not to change production, not to expose secrets, not to invent migrations, not to bypass security and not to claim unexecuted tests passed.

A section is not complete merely because you mentioned its heading in a summary.

### Pass D — Cross-section reasoning and system coherence

Build a cross-reference graph connecting related requirements.

Examine whether decisions in one area affect the others. For example:

- PostgreSQL identity and connection pooling affect RLS and tenant isolation.
- Authentication and session design affect API authorization, password recovery and audit identity.
- Encryption affects searching, indexing, key rotation, backups and exports.
- The outbox design affects idempotency, retries, event ordering, logs and recovery.
- Realtime authorization affects tenant isolation, event filtering and reconnect behavior.
- Migration design affects local reproducibility, deployment and rollback.
- Observability affects incident response, privacy and secret redaction.
- Production networking affects TLS, database access, worker connectivity and operations.

Identify contradictions, duplicate requirements, missing dependencies and ambiguous instructions.

Do not silently choose whichever requirement is easiest. Record the conflict, quote both relevant sources, explain the implications and propose the safest resolution. If a decision requires my approval, stop at that decision rather than inventing permission.

### Pass E — Source coverage verification

Compare all source sections and chunks against the requirement ledger.

Verify that every section has been reviewed and that every actionable requirement is accounted for.

Produce a coverage report containing:

- Number of source sections and subsections identified.
- Number of input chunks and receipt status, if chunking was necessary.
- Number of atomic requirements extracted.
- Requirements mapped to implementation and verification evidence.
- Requirements with unresolved dependencies or contradictions.
- Explicit constraints and prohibitions.
- Sections that were inaccessible, truncated or only partially processed.

Do not manufacture reassuring percentages. A 100% count of extracted records is meaningful only if source-to-ledger coverage was actually checked.

Do not say "everything has been understood" merely because no error was encountered. State any remaining uncertainty.

## 5. BUILD THE REQUIREMENT TRACEABILITY SYSTEM

Create:

`docs/MASTER_REQUIREMENTS_LEDGER.md`

This is the canonical implementation tracking record.

For every requirement, connect:

`SOURCE → REQUIREMENT ID → DESIGN DECISION → IMPLEMENTATION → TEST → EVIDENCE → STATUS`

Where applicable, identify exact repository file paths, SQL migrations, backend modules, API endpoints, security policies, tests, CI checks and operations runbooks.

Create these supporting artifacts:

- `docs/SOURCE_COVERAGE_REPORT.md`
- `docs/REQUIREMENT_CONFLICTS_AND_DECISIONS.md`
- `docs/REQUIREMENT_TRACEABILITY_MATRIX.md`
- `docs/MASTER_DIRECTIVE_IMPLEMENTATION_PLAN.md`

The requirement ledger must distinguish:

- Already implemented and independently verified.
- Implemented in source but not runtime-tested.
- Partially implemented.
- Designed but not implemented.
- Blocked by missing access, infrastructure, credentials or approval.
- Unresolved or ambiguous.

Do not label a feature PASS based solely on its presence in the UI, an existing function name, a documentation statement, or a historical model report.

## 6. READ THE CODEBASE AGAINST THE SPECIFICATION

The directive is not the only required input. You must also understand the actual project.

Read the relevant source files, migrations, configurations, tests and documentation. Do not assume the documentation matches the implementation.

Construct a source-of-truth map that identifies:

- Actual current architecture.
- Existing capabilities and their dependencies.
- Supabase-specific runtime dependencies that must be removed.
- Known database/schema mismatches.
- Authorization and tenant-isolation risks.
- Existing test coverage and gaps.
- Missing migrations and deployment ambiguity.
- Existing code that can be retained safely.
- Areas requiring redesign rather than superficial fixes.

Compare actual code with the atomic requirement ledger.

A requirement described in documentation is not automatically implemented. A requirement implemented in code is not automatically correct. A test is useful only if it exercises the intended behavior and its result was actually observed.

## 7. NO PREMATURE IMPLEMENTATION OR SUMMARY-ONLY RESPONSE

After completing the intake and source review, do not immediately rewrite the app, redesign everything, or begin a broad implementation based on memory.

First produce a complete, evidence-based comprehension report with:

1. Source coverage and capture verification.
2. Full requirement inventory and traceability status.
3. Current architecture and actual repository baseline.
4. Security and data-integrity risk findings.
5. Requirement conflicts and assumptions.
6. Dependency-ordered implementation plan.
7. Highest-priority fixes and their acceptance criteria.
8. What can be implemented safely in the immediate delivery window.
9. What remains unverified or cannot reasonably be completed within that window.

The report should be concise enough to act on but detailed enough to audit against the full ledger. The canonical ledger must retain all individual requirements even if the report groups them by area.

Do not make a second copy of the entire directive in your response. Point to the preserved source and traceability artifacts.

## 8. IMPLEMENTATION GOVERNANCE

After the comprehension gate is complete, proceed through the approved dependency order without requiring me to repeat each requirement.

Use small, reviewable changes. Preserve existing work. Run targeted tests after relevant changes, then the available full suite at release gates.

Do not:

- Remove requirements merely to meet the deadline.
- Replace a hard problem with documentation alone.
- Introduce paid infrastructure without explaining and obtaining approval for the cost.
- Modify the hosted Supabase project or real client data without explicit authorization.
- Commit, print or expose secrets.
- Weaken tenant isolation or disable validation.
- fabricate schema history, test results, security properties or successful deployments.
- Treat a successful build as proof of production readiness.
- Claim that zero bugs, perfect security or guaranteed scalability have been achieved.

When a requirement cannot be completed safely, identify it precisely and state the dependency, impact, mitigation and next action.

## 9. FIRST RESPONSE AFTER THE COMPLETE DIRECTIVE ARRIVES

Your first substantive response must report:

- Whether the complete source was captured.
- Whether any source portions are missing or truncated.
- How completeness was checked.
- Where the preserved directive and requirement ledger are stored.
- The source coverage and requirements inventory results.
- The most important cross-section dependencies and contradictions.
- The first implementation steps and release-blocking risks.

Do not claim to have read or tested anything you did not actually inspect or execute.

Your objective is not simply to remember a long prompt. Your objective is to convert the complete specification into an auditable engineering program in which every requirement has a source, owner or component, implementation path, acceptance test, evidence and honest status.

Wait for the complete master engineering directive now.



# ANIBROS CRM — 48-HOUR RELEASE MODE

## Mission

We have a 48-hour delivery target for a genuinely usable Anibros CRM. The codebase contains a broad set of features, but the priority now is proven end-to-end correctness, integration, security, and release readiness.

Act as a Principal Engineer, Application Security Engineer, Database Reliability Engineer, and QA Lead working on a deadline.

Do not perform another broad architecture exercise. Do not spend the first day redesigning the UI. Do not generate a long report and leave implementation untouched. Inspect, prioritize, implement, test, and maintain an evidence ledger.

## 1. Establish the exact baseline first

Before changing files, report:

- Current branch, commit SHA, working-tree changes, and repository root.
- Available package scripts and results for lint, typecheck, tests, and production build.
- All migrations present, missing migrations, duplicate versions, migration dependencies, and actual migration ledger status where authorized.
- Exact intended Supabase project. Compare local environment variable NAMES, hosted frontend configuration, deployment configuration, and remote project identity without exposing secret values.
- Current deployment versions of Edge Functions, if authorized access is available.
- Which reported test results have been independently reproduced and which remain historical claims.

The repository documents contain conflicting historical statuses. The source of truth must be reconciled. Do not claim a deployment, a remote database migration, an integration, or an end-to-end test succeeded unless you have evidence.

## 2. Immediate P0 blockers

At minimum, investigate and resolve these confirmed or previously identified risks against current source:

1. `supabase/migrations/20261012053000_021_leads_search_rpc.sql` references `l.score`; the core leads schema in migration 002 defines `lead_score`. Trace all later migrations and all consumers. Fix the schema/RPC/API contract coherently and add a regression test that executes the authenticated search path.
2. The repository is missing `supabase/migrations/001_organisation_tenant_hierarchy.sql`. Determine whether the current migration chain can safely bootstrap a new environment. Recover and validate the real migration only from an authoritative source. Never invent historical migration contents or blindly repair remote history.
3. Audit every database read/write in `webhook-ingestion`, `process-webhooks`, `process-outbox`, `integration-status`, frontend repositories/hooks, and SQL RPCs. Compare table names, columns, enum values, foreign keys, required fields, return shapes, and actual error handling.
4. Investigate the reported contact lead-source mismatch, attribution inserts, outbox worker fields, and provider response/error handling. Verify each against the current versioned schema; fix all confirmed discrepancies.
5. Review every `SECURITY DEFINER` function, grants, fixed `search_path`, active membership requirements, tenant scoping, caller identity, and cross-tenant operational mutations. UI permission gating is not sufficient.
6. Verify actual notification role/type enums, unread state semantics, and authorization.
7. Reconcile the two Supabase project references in historical records. No migration or function deployment may target an ambiguous project.

For each issue, document the root cause, affected workflow, code/migration change, regression test, and remaining risk.

## 3. Complete the real core CRM workflow

Use the existing React, TypeScript, Supabase, PostgreSQL, RLS, and Edge Function architecture unless a specific verified defect requires a change.

Prove and repair this workflow:

Authentication → workspace/tenant resolution → create or receive lead → deduplicate safely → display and search lead → assign owner → create activity/task → transition pipeline stage → match property → book viewing → update dashboard/report → observe the result from a second authorized session.

Every step must use persistent backend data. Every mutation must handle database errors. Repeated actions must not accidentally create duplicate records. Realtime must recover after reconnect or missed delivery.

Audit all existing pages and integrations for fake data, no-op actions, swallowed errors, inconsistent types, broken navigation, and incomplete loading/empty/error states. Do not make an unimplemented feature appear complete.

## 4. Prove tenant and role boundaries

Create or use two isolated test tenants with separate users and relevant roles.

Test allowed and forbidden reads, inserts, updates, deletes, RPC calls, Realtime subscriptions, reports, exports, queue recovery, and operational diagnostics.

Test both frontend restrictions and direct backend calls. A cross-tenant operation must fail at the trusted server/database boundary, not merely be hidden in the interface.

Do not use destructive tests or synthetic cleanup against live client data.

## 5. Verify external integrations honestly

For Meta and Google lead intake, test authentication/signature validation, trusted tenant mapping, durable receipt, duplicate delivery, processing failure, retries, and final lead creation.

For outbound conversions, verify that the correct event is generated, delivered, and recorded. Do not mistake a successful worker invocation for successful provider delivery.

Use fixtures or mocks for deterministic local testing. Test with real providers only when the required approved configuration is available. If it is not available, explicitly report `BLOCKED — NOT LIVE-VERIFIED`, retain a safe implementation path, and never display a false connected/healthy state.

Do not disclose secrets, expose service-role keys, mutate active ad campaigns, or change production webhook destinations without explicit authorization.

## 6. Tests and release gates

Run and record:

- Lint, TypeScript typecheck, unit tests, and production build.
- SQL/RPC regression tests against a safe database containing the actual migration chain.
- Browser tests for login/session refresh, each core workflow, failed saves, empty states, and reload recovery.
- Two-tenant and role-negative authorization tests.
- Realtime insert/update and reconnection tests in separate sessions.
- Webhook duplicate, invalid signature, processing failure, retry, and recovery tests.
- Dashboard and report reconciliation against known fixture records.
- A post-deployment smoke test only after the environment and migration state are unambiguous.

Do not call a security test passed because an unauthenticated call hit an early auth guard. Reach the actual query/authorization path.

Do not report tests as passed unless they were executed and their results are recorded.

## 7. Delivery protocol

Work in small, reviewable changes on a branch. Preserve existing working behavior. Use forward-only migrations with mitigation notes and appropriate tests. Avoid broad refactors and new feature work unless essential to pass a release gate.

After each meaningful change, run the smallest relevant regression tests. Before declaring the release candidate, rerun the full available suite.

Maintain these current documents from repository evidence:

- `docs/RELEASE_READINESS.md` — every release gate and its evidence/status.
- `docs/BACKEND_FEATURE_MATRIX.md` — page, action, backend operation, permission, error handling, test.
- `docs/SECURITY_REMEDIATION.md` — findings, severity, resolution, verification, residual risk.
- `docs/DEPLOYMENT_STATE.md` — exact target project identity, migration status, deployed function versions, and unverified dependencies; never include secret values.
- `PROJECT_LOG.md` and `plan.md` — update statuses only after evidence changes.

Use `PASS`, `FAIL`, `BLOCKED`, or `NOT VERIFIED`. Keep the complete product roadmap; do not delete features to make progress look better.

## 8. Stop conditions

Stop before production mutation if the target project is ambiguous, migration history is inconsistent, a migration may destroy/change client data, or a security boundary cannot be established.

Do not suppress an error, weaken RLS, disable validation, skip a failing test, hardcode successful status, or label an integration as connected to meet the deadline.

## First response and execution

First return only:

1. The actual current baseline and commands/tests executed.
2. The highest-risk verified findings, including exact file paths and evidence.
3. The first five fixes, in dependency order.
4. Any blocker requiring credentials or approval, without requesting secret values in chat.

Then implement the highest-priority local fix and its regression test immediately. Continue through the release gates, keeping the evidence ledger accurate. The objective is a safe, usable release candidate—not an impressive feature checklist.

# ANIBROS CRM — REMOVE SUPABASE COMPLETELY AND MIGRATE TO NATIVE POSTGRESQL

## 1. Final architecture decision — do not reinterpret

We are discontinuing Supabase as a runtime platform for Anibros CRM.

We want to use standard PostgreSQL locally during development and testing, then run that same architecture on our own production server. We do NOT want to self-host the Supabase platform, use Supabase Auth, retain `supabase-js` for runtime access, or finish the project on hosted Supabase and migrate later.

The target architecture is:

- Existing React + TypeScript + Vite frontend.
- Our own TypeScript backend API.
- Standard PostgreSQL database.
- Secure backend-managed authentication and sessions.
- Tenant and role authorization enforced at the backend and, where appropriate, through PostgreSQL RLS.
- Our own realtime service for authorized live updates.
- Our own background workers and durable job processing.
- Versioned, reproducible PostgreSQL migrations.
- Docker-based local development and a production deployment using the same application architecture.

Assess the existing repository before choosing or adding backend frameworks and packages. Prefer stable, free/open-source dependencies. Avoid introducing paid vendors or infrastructure silently.

## 2. Preserve the existing project

Do not rebuild the CRM from scratch.

Do not destroy, reset, or migrate the current hosted Supabase project. Treat it as a read-only reference until we explicitly authorize any future data export. Do not alter its credentials, webhooks, campaigns, migrations, or configuration.

Preserve the current working directory, Git history, uncommitted changes, UI, design system, and existing business logic. Start a dedicated migration branch and establish a baseline before editing.

Do not expose secrets or copy `.env` values into documents.

## 3. Phase 0 — map every Supabase dependency

Inspect the complete codebase, including:

- Every `supabase-js` import and usage.
- Authentication providers, login, signup, sign-out, session restoration, invitations and password recovery.
- Every table query, mutation, RPC and database type.
- All SQL migrations, policies, triggers, stored procedures, enums, extensions and foreign keys.
- Edge Functions and their callers.
- Realtime hooks, channels, subscriptions and reconnect logic.
- Webhook ingestion and processing, outbox events, retries, dead-letter handling and conversion feedback.
- Dashboard, pipeline, contacts, properties, projects, tasks, viewings, reports, attribution, integrations, notifications and Operations Center.
- Tests, CI configuration, scripts, environment variables and deployment assumptions.

Create `docs/SUPABASE_REMOVAL_MATRIX.md` listing every dependency, its replacement, affected files, implementation status and test requirement.

Do not mark a dependency removed while code can still invoke it in a production path.

## 4. Phase 1 — design our native PostgreSQL backend

Select a maintainable TypeScript API framework and PostgreSQL driver after inspecting the existing project. Document the decision and implement the minimum architecture without unnecessary abstraction.

The design must include:

- A PostgreSQL connection pool with correct transaction handling.
- Versioned schema migrations that work against standard PostgreSQL, not a Supabase-specific runtime.
- Runtime input validation and consistent API errors.
- Secure password hashing using an established password-hashing library.
- Server-managed sessions using secure, HttpOnly cookies with appropriate SameSite and production Secure settings.
- Login throttling, session expiry, logout, password reset and invitation policies.
- CSRF protection and origin validation for cookie-authenticated mutation requests.
- Backend-enforced roles and tenant permissions on every protected operation.
- Tenant-scoped queries and authorization on reads, writes, exports, reports and operational actions.
- PostgreSQL constraints, foreign keys, indexes, transactions and concurrency protection where needed.
- Structured logs, request correlation IDs and redaction of sensitive data.
- A safe mechanism for sending verification and password-recovery emails in production; local development must be testable without a paid email provider.
- A background worker and durable PostgreSQL-backed queue for webhook and conversion jobs, using idempotency, bounded retries and dead-letter handling.
- An authorized realtime mechanism that cannot broadcast one tenant's records to another tenant.

Evaluate PostgreSQL native RLS for defense in depth. Never let an untrusted frontend choose an arbitrary user or tenant identity. Ensure the application database role does not accidentally bypass the required RLS policies. If identity context is set through PostgreSQL session settings, use correctly scoped transactions and reset context safely when connections return to the pool.

Do not store reusable authentication credentials or passwords in plaintext. Never put database credentials in frontend environment variables.

## 5. Phase 2 — recover and port the database schema

The current repository history reports a missing foundational migration:

`supabase/migrations/001_organisation_tenant_hierarchy.sql`

Find the original from an authoritative source or reconstruct the baseline from the actual existing schema with a documented review. Do not invent migration contents or blindly create a fresh schema that omits business relationships.

Classify SQL objects as:

1. Portable PostgreSQL tables, constraints, indexes and SQL logic that can be reused.
2. Supabase-coupled objects requiring changes, such as `auth.uid()`, `auth.users`, Supabase roles, JWT claim helpers, Realtime publication setup and other platform-specific dependencies.
3. Objects whose correctness must be revalidated, including security-definer functions, membership policies, invitations, job recovery, notifications and audit records.

Port the migrations into a new, clearly defined native PostgreSQL migration chain. Do not modify historical migrations in a way that silently corrupts migration history.

Validate from a completely empty local database. All migrations must apply deterministically in order. Add seed fixtures separately from production data.

Investigate known issues such as migration 021 referencing `l.score` when the core schema defines `lead_score`, and verify all other table/function contracts while porting.

## 6. Phase 3 — replace frontend and backend calls

Replace every runtime Supabase Auth, data, RPC, Edge Function and Realtime call with the new backend implementation.

Do not leave a hidden Supabase fallback or use Supabase for selected modules.

Create consistent API contracts and typed frontend service modules. Preserve error/loading/empty states and make sure failed writes do not appear successful.

Implement and test all existing CRM workflows. Maintain a page-to-backend matrix so no existing feature is silently omitted.

Do not disable security or reduce tenant isolation to meet the deadline.

## 7. Phase 4 — local and production parity

Use PostgreSQL and the new backend locally first.

Use Docker Compose or an equivalent reproducible environment for the frontend, API, database and required worker services. Keep ports and environment variables separated from the user's other applications.

Use environment-specific configuration without changing architecture between development and production. Keep the PostgreSQL service private to the internal network rather than exposing the database port publicly.

Prepare the same application containers and migration workflow for a future production server. Production must have TLS, restricted database access, secret management, persistent storage, scheduled backups, tested restore procedures, health checks, monitoring, restart policies and documented upgrade/rollback procedures.

Do not assume the user's laptop is a production server. Do not deploy or expose the production stack without authorization.

## 8. Phase 5 — verification and release gates

Test:

- Clean local database bootstrap and all migrations.
- Signup, login, sign-out, refresh, sessions, invitations and password recovery.
- Every role against allowed and forbidden actions.
- Cross-tenant read/write rejection at the backend and database boundary.
- All core lead, contact, property, project, pipeline, task and viewing workflows.
- Search, pagination, filters, reports and dashboard calculations.
- Transactional viewing scheduling and concurrent booking prevention.
- Realtime delivery between authorized sessions, reconnects and tenant isolation.
- Duplicate webhook delivery, invalid signatures, retry exhaustion, outbox processing and safe recovery.
- Logs and audit history without leaking sensitive data.
- Lint, typecheck, unit tests, integration tests, browser tests and production build.

Use synthetic test records. Do not run destructive cleanup against real client data.

For every test, record the command, actual result and any unresolved defect. Never report unexecuted tests as passed.

## 9. Execution order and deliverables

First create:

- `docs/SUPABASE_REMOVAL_MATRIX.md`
- `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md`
- `docs/LOCAL_AND_PRODUCTION_RUNBOOK.md`
- `docs/MIGRATION_AND_ROLLBACK_PLAN.md`
- `docs/RELEASE_READINESS.md`

Then implement in dependency order, beginning with the database baseline and API authentication before converting all frontend calls.

Maintain `PROJECT_LOG.md` and `plan.md` with statuses `PASS`, `FAIL`, `BLOCKED`, and `NOT VERIFIED`.

Do not stop after creating documents. Continue into implementation after the baseline is recorded. Report concrete progress, changed files, commands, test outcomes and blockers.

If the migration becomes too large to complete safely within 48 hours, state that honestly. Prioritize a small, fully integrated and secure vertical slice first, without pretending full CRM parity has been achieved.

The final objective is a CRM with no runtime dependency on Supabase, using standard PostgreSQL locally and the same architecture on our own production infrastructure.






# ANIBROS CRM — PRINCIPAL ARCHITECTURE, NATIVE POSTGRESQL, SECURITY AND PRODUCTION ENGINEERING MASTER DIRECTIVE

## 0. Mission and non-negotiable decisions

Act as a Principal Software Architect, Principal Database Engineer, Application Security Architect, Site Reliability Engineer, Backend Engineer, Data Engineer and QA Lead.

We are building Anibros CRM as a real multi-tenant real-estate and marketing operations CRM, not a demonstration dashboard.

The current codebase was built around React, TypeScript, Vite and Supabase. Our final architectural decision is to REMOVE SUPABASE AS A RUNTIME DEPENDENCY.

The target platform must use:

- Existing React + TypeScript frontend wherever practical.
- Our own secure TypeScript backend API.
- Native PostgreSQL as the system of record.
- Our own authentication, session management and authorization.
- PostgreSQL migrations that work without Supabase-specific runtime assumptions.
- Database constraints, transactions, indexes and appropriate Row-Level Security.
- Our own authorized realtime service.
- Our own background workers, durable inbox/outbox processing and scheduled jobs.
- Structured logging, security auditing, metrics, health checks and recovery procedures.
- Docker-based local development and a reproducible production deployment architecture.

We want the application to run against PostgreSQL locally first and use the same application architecture on an always-on production server later.

Do not recommend self-hosting the Supabase platform as the final target. Do not keep Supabase Auth, `supabase-js`, hosted Supabase RPCs, Supabase Realtime, or Supabase Edge Functions in the final runtime architecture.

We can retain portable SQL and business logic where justified, but every Supabase-dependent component must be identified and replaced or explicitly documented as a temporary migration dependency.

Do not rewrite the CRM from scratch. Preserve existing UI, business functionality, Git history, useful SQL logic, and working code wherever possible.

The project has a near-term delivery deadline, but do not weaken security, data integrity, or testing to claim completion. Implement in reviewable phases and report the actual achievable release scope. A production-grade migration may require longer than 48 hours.

## 1. Engineering standards and design principles

Use these as measurable engineering requirements:

1. Security and privacy by design.
2. Least privilege and explicit trust boundaries.
3. Defense in depth rather than one security mechanism.
4. Secure defaults and fail-closed authorization.
5. Multi-tenant isolation throughout the entire request and event lifecycle.
6. Transactional data integrity and idempotent processing.
7. Clear service and data contracts.
8. Observable behavior and actionable failures.
9. Reproducible environments and migrations.
10. Automated regression tests at every critical boundary.
11. Reversible, reviewable deployments and tested recovery.
12. Simple, maintainable architecture with no unnecessary microservices.

Use OWASP ASVS 5.0 as the application-security verification reference. Target Level 2 as the working baseline for this business application, then assess stronger controls for particularly sensitive features. Map requirements to actual tests and evidence; do not claim compliance or certification without a suitable assessment.

Use official PostgreSQL documentation for database behavior and OWASP guidance for password storage, cryptographic storage, secrets management, sessions and logging.

## 2. Phase zero: establish repository and environment truth

Before implementation:

- Inspect the current repository root, branch, latest commit and uncommitted changes.
- Read all architecture documents, context files, project logs, plan files, SQL migrations, database types, frontend services, Edge Functions and test files.
- Inspect package scripts, lockfiles, CI workflows, environment configuration and deployment settings.
- Identify all Supabase dependencies through source inspection rather than assumptions.
- Record the current frontend and API workflows and the existing table relationships.
- Identify which test results are actually reproduced and which are historical claims.
- Determine whether Docker, Node.js and PostgreSQL tools are available.
- Inventory current local and remote data dependencies without printing secret values.

Create a baseline report with `PASS`, `FAIL`, `BLOCKED`, and `NOT VERIFIED` statuses.

The repository history reports a missing foundational migration:

`supabase/migrations/001_organisation_tenant_hierarchy.sql`

Find the original migration or an authoritative source for a reviewed reconstruction. Do not invent historical SQL and do not reset or modify the current hosted database.

Do not change any production configuration, advertising campaigns, webhook endpoints, credentials or real client records without explicit authorization.

## 3. Architecture and system design deliverables

Before large structural changes, create:

- `docs/ARCHITECTURE.md`
- `docs/THREAT_MODEL.md`
- `docs/DATABASE_DESIGN.md`
- `docs/SECURITY_ARCHITECTURE.md`
- `docs/OBSERVABILITY_AND_LOGGING.md`
- `docs/BACKUP_AND_DISASTER_RECOVERY.md`
- `docs/API_CONTRACTS.md`
- `docs/DEPLOYMENT_AND_OPERATIONS.md`
- `docs/MIGRATION_AND_ROLLBACK_PLAN.md`
- `docs/RELEASE_READINESS.md`

Architecture documentation must cover:

### Logical architecture

Describe the frontend, API, authentication/session layer, authorization layer, PostgreSQL database, background workers, realtime gateway, email delivery, integration adapters, audit pipeline and observability stack.

### Component boundaries

Define what belongs in each component, which components may access PostgreSQL, how authentication is verified, how tenant identity is derived, how background jobs are scheduled and how realtime messages are authorized.

Avoid distributing business logic inconsistently between React, SQL functions, API handlers and workers.

### Data-flow diagrams

Document at least these flows:

- Signup, email verification and authentication.
- Authenticated CRM read and mutation.
- Tenant membership and authorization.
- Lead ingestion from Google or Meta.
- Lead creation, deduplication, assignment and activity recording.
- Pipeline transition and audit record.
- Property matching and viewing scheduling.
- Outbox event delivery and retry.
- Realtime publication and subscription.
- Backup, restore and disaster recovery.
- Security incident detection and response.

### Architecture decisions

Write lightweight decision records explaining framework choices, database access strategy, tenant isolation, encryption, migration approach, background jobs, realtime implementation and deployment topology.

Prefer the smallest number of components that meet the security and reliability requirements.

## 4. Native PostgreSQL database architecture

Design the schema as a production database, not a collection of loosely related CRUD tables.

### 4.1 Entity and relationship design

Audit all existing domains, including:

- Organisations, tenants, branches and memberships.
- Users and sessions.
- Contacts and leads.
- Pipelines, stages, transitions and lead history.
- Properties, projects, availability and matching.
- Activities, tasks, viewings and assignments.
- Integrations, provider mappings and consent.
- Marketing attribution and campaign events.
- Webhook inbox, outbound outbox and job execution.
- Notifications and per-user notification state.
- Automation rules and execution history.
- Audit logs, incidents, application health and operational logs.

Build an entity-relationship diagram with primary keys, foreign keys, cardinalities, unique constraints, tenant ownership and deletion behavior.

### 4.2 Data integrity

Use:

- Correct primary keys and foreign keys.
- Explicit `NOT NULL`, `CHECK`, `UNIQUE` and exclusion constraints where appropriate.
- Tenant-aware composite foreign keys where needed to prevent cross-tenant relationships.
- Unique idempotency keys for provider deliveries and business operations.
- Normalized transactional entities with carefully justified denormalization for performance.
- Consistent UTC timestamps and explicit user-facing timezone conversion.
- Correct monetary precision, numeric bounds and validation.
- Defined soft-delete and hard-delete semantics.
- Optimistic concurrency or appropriate locking for concurrent updates.
- Database transactions for multi-record business operations.
- Indexes derived from actual filters, joins, sort order and tenant access patterns.

Do not depend exclusively on frontend validation to maintain integrity.

Do not add an index on every column or introduce partitioning without measured benefit. Use `EXPLAIN (ANALYZE, BUFFERS)` against safe, representative data for important query paths.

### 4.3 SQL migrations

Create a standard PostgreSQL migration workflow independent of Supabase.

Every migration must have a deterministic order, be reproducible on an empty database and document its purpose, dependencies, risk and mitigation or rollback procedure.

Test migrations in an isolated local database. Do not change applied production migrations in place without a reviewed migration strategy.

Verify that all SQL functions, types, extensions, triggers and policies can be created without Supabase-specific schemas or roles.

### 4.4 Roles and connections

Use separate database privileges for migration/ownership tasks, application runtime and read-only reporting where appropriate.

The application runtime role must not be a superuser, table owner, replication administrator or unnecessary privileged role.

Protect connection strings. Use connection pooling appropriate to the deployment. Scope transactions carefully and test pool reuse to prevent session identity or tenant context from leaking between requests.

Document connection limits, pool sizing and graceful shutdown.

### 4.5 Native PostgreSQL row-level security

Evaluate and implement RLS as defense in depth where it provides meaningful protection.

- Define trusted identity context and how it is established.
- Do not trust tenant IDs or user IDs submitted by an arbitrary client.
- Derive the authenticated user from the verified backend session.
- Verify active tenant membership and role before every privileged operation.
- Review `USING` and `WITH CHECK` policies, table ownership, role privileges and RLS bypass paths.
- Review security-definer functions, fixed `search_path`, grants and caller authorization.
- Ensure API and worker roles do not bypass policies unnecessarily.
- Test direct database/API operations as well as frontend behavior.

Custom PostgreSQL session settings must not be treated as independently trustworthy merely because they exist. Document the threat boundary: a compromised application database credential can undermine application-enforced identity assumptions unless stronger separation or a suitable database trust model is implemented.

## 5. Authentication and authorization architecture

Replace Supabase Auth with a maintained, well-understood authentication implementation using established libraries and standards. Do not invent cryptographic protocols or implement password storage manually.

Implement and test:

- Signup and email verification.
- Login, logout, session restoration and expiry.
- Password recovery with short-lived, single-use tokens.
- Invitation-based membership and account provisioning.
- Secure account enumeration behavior.
- Login throttling and abuse prevention.
- Privileged-user MFA support and enforcement appropriate to the release requirements.
- Session revocation and administrative session termination.
- Role and tenant membership lifecycle.
- Safe error responses and security-event logging.

### Password and session security

Use a vetted Argon2id implementation with parameters calibrated and documented for the target machine. Never store passwords in plaintext or reversibly encrypted form. Never use a fast general-purpose hash such as plain SHA-256 to store passwords.

Use high-entropy session identifiers. Prefer storing a hash of session tokens server-side, with expiry, revocation and rotation where practical.

For browser authentication, use appropriately configured `HttpOnly`, `Secure` and `SameSite` cookies in production, along with CSRF controls for state-changing requests.

Password reset and verification tokens must be random, short-lived, single-use and stored securely, preferably in hashed form when they are bearer tokens.

Protect login and recovery endpoints with rate limits. Avoid leaking whether accounts exist.

Use local email capture for development. For real production email, choose a provider only after evaluating cost, reliability and operating requirements.

## 6. Application security and threat modelling

Create a threat model before completing the backend.

Consider at least:

- Malicious tenant user attempting to access another tenant.
- Sales agent attempting privileged actions.
- Forged tenant/user identifiers.
- IDOR and broken object-level authorization.
- SQL injection.
- Cross-site scripting and unsafe rendering.
- CSRF and session theft.
- Brute force, credential stuffing and user enumeration.
- SSRF and unsafe outbound URL handling.
- Webhook spoofing and replay.
- Duplicate or out-of-order delivery.
- Privilege escalation through administrative RPCs or job-recovery actions.
- Secrets leaking to the frontend, logs or Git history.
- Database, application host or backup compromise.
- Unauthorized export or disclosure of personal data.
- Malicious or compromised dependencies.
- Denial of service and resource exhaustion.
- Misconfigured production networking.
- Insider misuse and log tampering.

For each material threat, document the trust boundary, attack path, mitigation, residual risk and regression test.

Apply server-side input validation, parameterized SQL, output encoding, safe file handling, restrictive CORS, security headers, rate limiting and request size/time limits.

Review CSP, TLS configuration, security cookies, dependency vulnerabilities, production debug behavior and error redaction.

Never expose database credentials, signing keys or third-party provider secrets through Vite `VITE_*` variables or browser bundles.

## 7. Layered encryption and key management

Do not use the vague requirement “encrypt everything” as a substitute for a concrete cryptographic design.

Create a data-classification inventory. At minimum classify authentication secrets, session tokens, contact personal data, phone/email, provider tokens, webhook signatures, logs, audit data, exports, backups and configuration secrets.

### 7.1 Encryption in transit

For production:

- Enforce HTTPS/TLS between browsers and the API.
- Use appropriately configured TLS for database connections when they cross hosts or networks.
- Secure internal service communications according to the deployment topology.
- Disable insecure production transport and unsafe certificate-validation bypasses.

Local development may use loopback connections, but it must never be exposed as a production network configuration.

### 7.2 Encryption at rest

Document which layers provide encryption at rest: server disk/volume, database storage, backups and any application-level protected fields.

Use operating-system or hosting-volume encryption with proper key and access management. Encrypt backup artefacts independently when the backup location or transfer path warrants it.

Do not claim database files or backups are encrypted unless the configuration and implementation are verified.

### 7.3 Application-level field encryption

Identify fields that require additional protection, such as third-party integration credentials or tokens.

Where application-level encryption is justified:

- Use a vetted authenticated-encryption implementation, such as AES-256-GCM with correct nonce handling, or another appropriately selected established construction.
- Store encryption keys separately from encrypted application data.
- Version ciphertext/key identifiers and support controlled rotation.
- Define how re-encryption works without losing access to older records.
- Restrict decryption to the smallest necessary server-side component.
- Redact decrypted data from logs, errors, diagnostic responses and UI diagnostics.
- Do not create homemade cryptographic schemes.
- Do not blindly encrypt every column where it destroys necessary search, indexing or query behavior; document the trade-off.

For locally operated infrastructure, document a realistic key-protection approach that respects the budget, such as strict file permissions, operating-system protection and controlled off-host backup. For production, evaluate a dedicated key-management service or equivalent protected mechanism against cost and threat model.

An encryption key stored beside the encrypted database under the same unrestricted access path offers limited additional protection. Explain the residual risk explicitly.

### 7.4 Passwords are not encrypted

Use strong one-way password hashing. Do not treat encryption and password hashing as interchangeable.

### 7.5 Secret-management lifecycle

Create a complete secret inventory. Define generation, storage, permissions, use, rotation, revocation and compromise response for:

- Database credentials.
- Session-signing keys.
- Cookie and CSRF secrets where applicable.
- Field-encryption keys.
- Email credentials.
- Google and Meta credentials.
- Webhook verification/signing secrets.
- Other external integration credentials.

Use separate secrets for different environments and purposes. Never commit secrets to Git, print them in logs, copy them into generated context bundles or expose them to the frontend. Scan repository history and CI logs for accidental leaks and rotate exposed values.

## 8. Multi-tenant access-control design

Tenant isolation is a P0 invariant.

The tenant scope must be enforced on every applicable:

- API request and object lookup.
- SQL query and mutation.
- RPC or database function.
- Realtime subscription and published message.
- Background job and retry.
- Webhook mapping.
- Report, search, aggregation and export.
- Notification and operational diagnostic.
- Administrative action.

Never treat an untrusted provider payload's tenant ID as authoritative. Resolve the target tenant using trusted integration configuration and verified provider account identifiers.

Define a role-permission matrix and enforce it in the backend, with database defenses as appropriate. Frontend permission gating is not an authorization boundary.

Create automated negative tests for two tenants and several distinct roles. Attempt direct unauthorized reads, inserts, updates, deletes, export, RPC, job recovery and realtime subscription.

## 9. Webhooks, queues and background workers

Implement durable, observable, idempotent processing.

### Incoming webhooks

- Authenticate providers using their documented signature/key mechanisms.
- Verify HMAC signatures with the correct method and safe comparison.
- Validate event shape and provider account mapping.
- Protect against replay where supported.
- Persist a durable receipt before acknowledging delivery.
- Deduplicate using stable provider event/lead identity.
- Normalize provider-specific formats through adapters.
- Fetch full provider records where the notification contains only an identifier and the provider's API requires it.
- Keep raw payloads only when needed and apply redaction, access controls and retention rules.

### Queue and outbox

Use durable inbox/outbox records, bounded retries, appropriate backoff, dead-letter states and authorized replay.

Use safe claiming semantics to prevent concurrent workers from processing the same work without coordination. Keep external network calls outside long-lived database transactions.

Design for at-least-once delivery and make business side effects idempotent. Do not claim general exactly-once delivery unless the particular guarantee is proven.

Record the event ID, correlation ID, tenant, attempt number, duration, provider status and sanitized failure reason.

### Conversions and notifications

Record intended event, delivery attempt, provider response and final delivery state separately. A successful worker invocation is not proof that the provider accepted the event.

Keep provider adapters isolated from CRM business logic.

## 10. Logging, audit, observability and incident response

Implement three distinct concerns: operational logging, security-event logging and business audit history. They must not be conflated.

### 10.1 Structured application logs

Use structured JSON logs with:

- Timestamp in UTC.
- Severity.
- Service/component and environment.
- Request/correlation ID.
- Safe user and tenant identifiers where justified.
- Operation or event name.
- Duration and result.
- Sanitized error type/code.
- Trace/context identifiers where available.

Implement consistent redaction. Never log passwords, session tokens, cookie values, authorization headers, secret keys, full payment credentials or unnecessary raw personal-data payloads.

Use request IDs consistently from API entry through worker execution and provider callbacks where correlation is possible.

### 10.2 Security logs

Record important events including:

- Authentication success/failure and throttling.
- Session revocation.
- Password recovery completion.
- Role and membership changes.
- Privileged actions and exports.
- Permission denials.
- Repeated suspicious access attempts.
- Security-sensitive integration configuration changes.
- Webhook signature failure and replay rejection.
- Administrative operations and exceptional recovery.
- Backup, restore and migration actions where practicable.

Do not record a secret merely to prove that authentication was attempted.

### 10.3 Business audit trail

Maintain an append-oriented audit model for sensitive business state changes.

Where appropriate capture actor, tenant, action, entity type/ID, timestamp, correlation ID, change summary and a carefully redacted before/after representation.

Use database constraints and grants to prevent ordinary application identities from modifying or deleting audit records. Include system actors and external event sources distinctly.

Do not call an audit table “tamper-proof” just because ordinary updates are blocked. A database owner or server administrator may still be able to alter it. For production, assess independent off-host audit forwarding, restricted access and tamper-evident retention.

### 10.4 Health and metrics

Provide:

- Liveness and readiness checks.
- Database connection and pool health.
- Request volume, latency and error rate.
- Background queue depth, age of oldest job, retries and dead letters.
- Webhook receipt-to-processing latency.
- Integration success/failure rate.
- Realtime connection and reconnection health.
- Backup age and last successful restore verification.
- Resource saturation and worker failures.

Health endpoints must not disclose secrets, tenant records or sensitive internal topology.

Add alerts or an actionable internal operations view for material failures. If no external monitoring service is funded, clearly document the limitations of local metrics/logs and provide the least-cost reliable option.

## 11. Backup, restore and disaster recovery

A real CRM requires recoverability, not simply a backup script.

Define recovery objectives with the product owner. Propose measurable Recovery Point Objective (RPO) and Recovery Time Objective (RTO) targets based on the actual deployment, and distinguish verified capabilities from aspirations.

Implement and document:

- Automated scheduled database backups.
- Backup encryption and restricted access.
- Retention and rotation.
- Off-host or otherwise independent backup storage for production.
- Backup integrity validation.
- A restore-to-new-instance procedure.
- Migration-forward recovery and application version compatibility.
- Recovery of application configuration and required secrets, without putting secrets directly into backup logs.
- Periodic restore drills with evidence and timing.
- Response procedures for accidental deletion, ransomware, corruption, host loss and credential compromise.

Do not treat a copied PostgreSQL data directory as a universally valid backup strategy. Use supported logical or physical backup procedures appropriate to the database and recovery requirements.

Local backup/restore must be verified before real data is considered safe. A successful backup command alone is not proof of recoverability.

## 12. Performance, scalability and capacity planning

Define baseline performance budgets and measure them on representative data.

At minimum test:

- Lead list/search, pagination and sorting.
- Lead detail and related contacts/activities.
- Pipeline queries and dashboard metrics.
- Property matching and viewing availability.
- Reports and attribution aggregates.
- Tenant authorization overhead.
- Database connection pool saturation.
- Concurrent viewing-booking attempts.
- Queue processing throughput and lag.
- Realtime fan-out and tenant subscription isolation.

Use query plans, realistic fixture sizes and repeatable load tests. Check for N+1 queries, unbounded result sets, over-fetching, repeated full-table scans and expensive per-request aggregation.

Do not promise specific p95 latency or concurrency without measurements. Establish initial targets, report actual results, and distinguish pilot targets from future scale targets.

Use indexes, caching, pagination, background computation or partitioning only when supported by measured workload and correctness requirements. Ensure cached results are tenant-scoped and invalidated correctly.

## 13. API and application architecture

Create typed backend contracts with versioning strategy, consistent response/error shapes, request validation and explicit authorization.

Keep business operations in testable service/domain modules rather than duplicating logic across pages.

Use parameterized SQL. Define transaction boundaries and idempotency behavior for mutations.

Enforce request limits, rate limits and safe timeouts. Prevent mass assignment by explicitly validating allowed mutable fields.

Use secure defaults for CORS, cookies, security headers and error reporting. Avoid exposing stack traces, SQL or secret-bearing provider errors to end users.

Define graceful shutdown and startup validation. The service must fail clearly when a required environment variable or dependency is missing rather than silently reporting a healthy state.

## 14. Reliability and operational engineering

Implement:

- Predictable startup/shutdown.
- Health checks and dependency checks.
- Process supervision and restart policy.
- Bounded retries with jitter where appropriate.
- Timeouts and safe handling of partial failure.
- Graceful database failure behavior.
- Reconciliation for interrupted or missed jobs.
- Idempotent migrations and application operations.
- An explicit deployment/rollback process.
- Configuration validation and environment separation.
- Runbooks for the most important incidents.

Do not retry permanent errors indefinitely. Do not swallow database or provider errors. Do not mark an integration connected until a meaningful test has succeeded.

## 15. Supply chain and CI/CD

Strengthen CI to include:

- Formatting/linting and type checks.
- Unit, integration, migration and browser tests.
- Authorization and cross-tenant negative tests.
- Dependency vulnerability checks.
- Secret scanning, including preventing credential files from entering the repository.
- Production build verification.
- Container image review/scanning where feasible.
- Dependency lockfile and reproducible builds.
- Migration validation from an empty PostgreSQL database.
- Deployment approval gates for production changes.

Use supported versions and review dependency choices. Do not disable failing quality or security checks just to make CI green.

Build production containers with minimal privileges, non-root runtime users where practical, explicit health checks and no embedded secrets.

## 16. Complete existing CRM workflows

Preserve and validate all current CRM modules:

- Authentication and onboarding.
- Dashboard.
- Leads and lead details.
- Contacts.
- Pipeline and stage transitions.
- Properties and projects.
- Property matching.
- Tasks and activities.
- Viewings and calendar.
- Reports and attribution.
- Integrations and consent.
- Automation rules.
- Notifications.
- Webhook diagnostics.
- Outbox diagnostics.
- Operations Center.
- User, tenant and role administration.

For each page, map every control to its backend operation, permission rule, loading state, error state, success behavior and regression test.

Do not drop existing scope silently. If a feature is unfinished, document it as such rather than making a nonfunctional control appear ready.

## 17. Required security and functional tests

Build a repeatable release suite for:

- Unauthorized and cross-tenant direct API operations.
- Every role's allowed and forbidden actions.
- SQL injection and input-validation boundaries.
- Cookie, CSRF and session lifecycle behavior.
- Password reset token expiry and reuse rejection.
- Authentication rate limiting.
- Secret and PII redaction in logs.
- Webhook authentication, replay, duplication and retries.
- Background job concurrency and crash recovery.
- Tenant-scoped realtime events.
- Concurrent transactions and viewing booking.
- Audit attribution and mutation restrictions.
- Migration bootstrap and upgrade.
- Backup restore and data reconciliation.
- Rate limits, large result sets and failure scenarios.
- Frontend-to-database end-to-end workflows.

Test with synthetic data in an isolated local environment. Never use destructive cleanup or load-test scripts against live client systems.

Do not mark a test passed because a request returned 401 before reaching the operation being tested. Tests must reach the actual relevant authorization and query path.

## 18. Local PostgreSQL and future production parity

Develop against native PostgreSQL locally with a reproducible environment. Keep the API, database schema and worker architecture the same across development, staging and production.

Use environment-specific configuration and separate credentials. Never put database connection strings or server secrets in frontend variables.

PostgreSQL must not be publicly exposed without a designed network security boundary. Production requires TLS, firewall restrictions, a private database network, protected secrets, backups, monitoring and a documented restore procedure.

Do not treat the developer's Windows laptop or Vite development server as a production hosting plan.

Create an operational runbook that another engineer can follow to build, start, migrate, test, back up, restore, upgrade and recover the stack without relying on undocumented manual steps.

## 19. Delivery process and definition of done

Implement through small, reviewable phases:

Phase 0: repository/environment baseline and dependency inventory.

Phase 1: threat model, native PostgreSQL architecture and schema recovery.

Phase 2: database migration foundation, authentication, session and authorization architecture.

Phase 3: core lead-to-viewing workflow end to end.

Phase 4: remaining CRM modules and integration/worker replacements.

Phase 5: structured logs, audits, security controls, backup/restore and observability.

Phase 6: complete testing, performance validation, release review and production runbooks.

After each phase, run the relevant regression suite and record evidence. Do not perform a broad rewrite without preserving tested functionality.

Maintain:

- `PROJECT_LOG.md`
- `plan.md`
- `docs/SUPABASE_REMOVAL_MATRIX.md`
- `docs/DATABASE_DESIGN.md`
- `docs/SECURITY_ARCHITECTURE.md`
- `docs/OBSERVABILITY_AND_LOGGING.md`
- `docs/BACKUP_AND_DISASTER_RECOVERY.md`
- `docs/RELEASE_READINESS.md`

For every important task, report the changed files, root cause, implementation details, command/test results and remaining risks.

Use `PASS`, `FAIL`, `BLOCKED`, and `NOT VERIFIED` accurately.

Do not claim “zero bugs”, “fully secure”, “unhackable”, “FAANG compliant” or “production ready” without evidence. Report the concrete controls and tested results instead.

## 20. Immediate action

Start by inspecting the actual current project. Produce the dependency inventory, architecture/threat-model baseline, migration risk report and prioritized implementation order. Then begin the first safely unblocked implementation step rather than stopping after writing documents.

Do not mutate the hosted Supabase environment or real client data.

The intended result is a well-designed native PostgreSQL-backed CRM, with its own controlled backend, authentication, authorization, encryption and key management, audit and operational logging, observable background processing, tested recovery, reproducible migrations, meaningful security tests, and the same deployable architecture locally and on our eventual production server.