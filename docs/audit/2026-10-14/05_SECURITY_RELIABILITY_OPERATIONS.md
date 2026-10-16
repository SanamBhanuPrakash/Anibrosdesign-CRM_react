# Audit 2026-10-14 · 05 — Security, tenant isolation, reliability, tests, CI, dependencies, documentation

Severity scale: **P0** security / tenant isolation / data loss / critical corruption / severe production blocker · **P1** core workflow failure or material reliability issue · **P2** important capability or operational improvement · **P3** enhancement.
Enforcement layer: **DB** (row-level security, constraints, grants) · **BE** (backend code) · **FE** (frontend — a convenience, never a control) · **INFRA** (outside the repository).

---

## 1. Security findings (reproducible)

All reproductions use `evidence/*.mts` against **disposable databases**; nothing touched the dev database.

| ID | Sev | Finding | Evidence | Layer that should stop it |
|---|---|---|---|---|
| **S-1** | **P0** | **Cross-tenant reference and (privileged role) deletion in custom-field values.** `PUT /api/custom-fields/values` (a) accepts a `fieldId` from **another workspace** and stores a value row tying the foreign field definition to your record (observed in **both** database-role modes: `rows tied to the owner field id from another tenant: [{is_owner_tenant:false, n:1}…]`), and (b) its delete branch (`value: ""`) has **no tenant predicate**: under the privileged role another workspace's call **removed the owner's value** (`owner value still present afterwards: 0`; with the restricted role RLS blocked it: `1`). It also never checks that the entity (`lead`/`contact`/…) exists or belongs to the caller. Exploitation needs the victim's record and field UUIDs (unguessable, but they appear in URLs, exports and logs). | `legacy_privileged.txt`, `legacy_restricted.txt` → `customFields` | DB: composite FK `(field_id, tenant_id)`; BE: ownership checks and tenant predicate; RLS already blocks the delete under the production role |
| **S-2** | **P1** | **Legacy invite forces membership and leaks account existence.** `POST /api/tenant/members/invite`: if the email already has an account **anywhere**, the person is added to the inviting workspace **immediately, with the chosen role, with no acceptance, no e-mail, no audit entry**; the response differs ("Member added" vs "Invitation recorded") so an admin can probe which addresses are registered. For unknown addresses the invitation token is generated, hashed and **discarded**, so the invitation can never be accepted. | `identity.txt` (`membership row created … sales_manager active`, `mail jobs: 0`, `audit rows: 0`) | BE: remove the endpoint (the v1 members module replaces it and is correct) |
| **S-3** | **P1** | **Legacy revoke bypasses the v1 invariants.** No row lock around the last-owner count (the race is **not demonstrated**: my two-owner race ended with one owner left because one revoke removed the other's authority, so the lock-free code remains **UNVERIFIED** as exploitable), no session revocation (membership checks still make the next request 403, so access *is* cut: `[200, 403]`), no audit entry. | `identity.txt`, `routes/tenant.ts:141-195` | BE: remove with S-2 |
| **S-4** | **P1** | **Integration configuration returns secrets in clear and lies about credentials.** `config` is `z.record(any)`, returned verbatim by `GET /api/integrations` (privileged mode: a token placed in `config` came back); `hasCredentials` is hard-coded `true`; `credentials_enc` is never written. The old Integrations *page* does not even use this API (it writes a blob). | `legacy_privileged.txt` → `integrations` | BE: remove the legacy router; secrets only through the encrypted lead-source/destination stores |
| **S-5** | **P1** | **Viewings: weak authorization and integrity.** (a) No role check: an **auditor** and an **executive read-only** user booked viewings (`201`); (b) any role lists **all** viewings with buyers' phone/e-mail (agents are not own-scoped); (c) `agentId` from **another workspace** is accepted and that person's **name and e-mail appear** in the list; (d) booking works on **archived** properties and leads. | `legacy_privileged.txt` `viewings`, `workflow.txt` | BE/DB: permission matrix (`viewings:*`) + scope, validate agent membership and live records inside `app.schedule_viewing` |
| **S-6** | **P1** | **Legacy tenant-config PATCH** accepts arbitrary JSON up to the 1 MB parser limit, and the Tenant Configuration page's Save **replaces** the whole `settings` object (integrity loss, see `03` §3.1). Owner/admin only. | `routes/tenant.ts:253-257`, `TenantConfigPage.tsx:97-106` | BE: typed settings schema; merge not replace; ETag |
| **S-7** | **P1** | **Legacy members list** returns every member's e-mail and role to **every authenticated role including sales agents** (matrix: `members:read` owner/admin/auditor; directory = id + name only). | `legacy_*.txt` `scoping > agent tenant/members: array(4)` | BE: remove (v1 `/members` and `/members/directory` exist) |
| **S-8** | **P1** | **Dashboard shows workspace-wide totals to sales agents** (matrix gives agents *own* leads): an agent saw `total: 2` where only one lead was theirs. | `legacy_privileged.txt` `scoping > agent dashboard` | BE: scope by `leadVisibility` or restrict by permission |
| **S-9** | **P1 (blocker)** | **Legacy routers depend on the privileged DB role.** Production start-up refuses it; under the restricted role lists are empty, dashboards zero, edits 404 (`01` §1 item 3). | `platform/db/index.ts:133-147`, `automation_restricted.txt`, `reports_restricted.txt`, `legacy_restricted.txt` | BE: port to services (`withTenant`) |
| **S-10** | **P2** | **Reports/custom-fields readable by `auditor`**, although the product describes auditors as "no business data" (legacy lists: `REPORT_READERS` includes `auditor`, `FIELD_READERS` too). | `routes/reports.ts:9`, `custom-fields.ts:11` | BE: align with matrix |
| **S-11** | **P2** | **Production dependency advisory: `nodemailer` ^6.10.1 (high, 14 advisories).** Relevant to us: recipient-address parsing/validation bypasses (we send to user-typed addresses for invitations and verification), header-injection classes (our headers are fixed), DoS in address parsing. The "cross-tenant SMTP credential" advisory does not apply (one global transport). Fix is a major upgrade (10.x); regression-test mail. | `evidence/npm_audit_production.txt` | BE: upgrade |
| **S-12** | **P2** | **Development-tool advisories** (2 critical `vitest`/`tinypool`, 22 high, mostly the lint/test/build toolchain): not shipped, but CI's `npm audit` is `continue-on-error`. | `npm_audit.json` | CI |
| **S-13** | **P2** | **CI secret-scan action pinned to `@main`** (moving target) and non-blocking. | `ci.yml` | CI |
| **S-14** | **P2** | **No malware engine behind the upload scan hook**; files are *type-sniffed* and served with `nosniff`, a sandbox CSP and `private, no-cache`; a PDF can still carry active content for a user who opens it locally. | `platform/storage`, `files.service.ts` | BE/INFRA |
| **S-15** | **P2** | **No step-up re-authentication** for sensitive actions, **no session-token rotation on privilege change**, **no per-API-key rate limit**; in-memory rate limits are exact only for one API replica. | `docs/SECURITY_MODEL.md` §4 | BE |
| **S-16** | **P2** | **Unbounded legacy lists** (viewings, custom fields, tenant members, integrations, automation; the legacy audit-log list is capped at 100 rows with no cursor): no pagination; a large workspace returns everything. | routes | BE |
| **S-17** | **P2** | **"Send test lead" data is indistinguishable in legacy metrics** (data integrity, not a leak). | `04` §7 | BE |
| **S-18** | P3 | Dev defaults for the cookie secret and encryption key exist in `platform/config.ts`; production start-up fails fast on them (tested). | `config.ts:20-21, 99` | BE (acceptable) |

### 1.1 Security properties and where each is enforced

| Property | Enforced by | Status |
|---|---|---|
| Tenant isolation (v1 modules) | **DB** RLS with transaction-local context + restricted roles; **BE** service filters; tested as the restricted role | VERIFIED |
| Tenant isolation (legacy routers) | **BE only** (hand-written `WHERE`), RLS only if the restricted role is used (it then breaks the routes) | PARTIAL (S-1) |
| Authorization (v1) | **BE** central matrix + scope; **FE** hides buttons (convenience) | VERIFIED (`authz.test.ts` 69, per-module tests) |
| Authorization (legacy) | **BE** hard-coded role lists that disagree with the matrix | BROKEN (S-2, S-5, S-7, S-8, S-10) |
| CSRF | **BE** origin allow-list + double-submit token on cookie-authenticated mutations; `/hooks` is public by design | VERIFIED (`identity.test.ts`) |
| Secrets at rest | **BE** AES-256-GCM with AAD (lead sources, mail tokens, MFA seeds); hashes for passwords/tokens/keys | VERIFIED for v1; **legacy integrations store plain JSON** (S-4) |
| Input validation | **BE** zod on every v1 route (strict bodies, typed queries); legacy has `z.any()` islands | PARTIAL |
| Rate limiting | **BE** in-memory token buckets (auth, hooks, per IP/endpoint/visitor) | VERIFIED, single replica |
| Audit integrity | **DB** grants (append-only), **BE** in-transaction writer | VERIFIED |
| File upload safety | **BE** magic-byte allow-list, size caps, hardened download headers | VERIFIED; AV engine absent (S-14) |
| TLS, HSTS, DB disk encryption, network policy | **INFRA** | UNVERIFIED (no deployment artefacts) |

### 1.2 OWASP API Security Top 10 (2023) quick map
API1 *Broken object-level authorization*: v1 verified, **legacy S-1/S-5**. API2 *Broken authentication*: verified (identity suite). API3 *Broken object property-level authorization*: v1 strict zod; **legacy settings and integration `config` blobs (S-4, S-6)**. API4 *Unrestricted resource consumption*: body caps (1 MB JSON, 256 KB hooks, 10 MB files), rate limits; **legacy unbounded lists and an unbounded `actions[]` (S-16, `02` §4.12)**. API5 *Broken function-level authorization*: **S-2, S-5, S-7**. API6 *Unrestricted access to sensitive business flows*: sign-up and hooks are rate limited; test-lead abuse bounded by permissions. API7 *SSRF*: only a fixed Graph host today; **required before configurable outbound destinations** (`04` §4.3). API8 *Security misconfiguration*: strict CSP/HSTS/CORS allow-list in code; **deployment unknown**; CI broken. API9 *Improper inventory management*: **duplicate legacy and v1 endpoints (members, automation, integrations, tenant config)**; retired webhook stub answers 410. API10 *Unsafe consumption of APIs*: the Graph client has timeouts, no redirects, typed minimal use of responses.

### 1.3 Route × role matrix
* **v1 (124 routes, 8 roles):** generated from the live route registry and the central permission matrix: `evidence/matrix.md` (✔ allowed, `own` own-scope, – denied, `any` = authenticated + service-level check, `pub` public).
* **Legacy (29 endpoints):**

| Router | Endpoint(s) | Allowed roles in code | Matrix says |
|---|---|---|---|
| viewings | GET /, POST / | **any authenticated** | `viewings:*` (scoped) |
| dashboard | GET /metrics, /attribution | **any authenticated** | `dashboard:read`, `attribution:read` (not agents) |
| tenant | GET /members | **any authenticated** | owner/admin/auditor |
| tenant | POST /members/invite, DELETE /members/:id | owner, admin | owner/admin (but unsafe, S-2/S-3) |
| tenant | GET /audit-logs | owner, admin, auditor | `audit:read` (same) |
| tenant | GET /config | any authenticated | `tenant:read` (not auditor-only) |
| tenant | PATCH /config | owner, admin | `tenant:update` (same) |
| reports | GET /overview, /attribution, /pipeline-velocity | owner, admin, sales_manager, executive_readonly, **auditor** | `reports:read` (differs) |
| integrations | GET, GET /providers | owner, admin, sales_manager, marketing_manager, auditor | `integrations:read` (differs) |
| integrations | POST, PATCH, DELETE | owner, admin | `integrations:manage` includes marketing_manager (differs) |
| custom-fields | GET, GET /values | owner, admin, sales_manager, sales_agent, marketing_manager, auditor, executive_readonly | `custom_fields:read` |
| custom-fields | POST, PATCH, DELETE | owner, admin, **sales_manager** | `custom_fields:manage` = admins only (differs) |
| custom-fields | PUT /values | owner, admin, sales_manager, sales_agent, marketing_manager | — |
| properties | POST /match | owner, admin, sales_manager, sales_agent, marketing_manager | `matching:use` |
| automation | GET, executions | owner, admin, sales_manager, marketing_manager, auditor, executive_readonly | `automation:read` |
| automation | POST, PATCH, DELETE | owner, admin, **sales_manager** | `automation:manage` = owner/admin/marketing_manager (differs) |
| health | GET /live, /ready | public | — |

### 1.4 Negative tests executed (safe, disposable DB)
Cross-tenant: legacy viewings (schedule on foreign lead/property → 404; filter by foreign lead → `[]`), automation (PATCH/DELETE → 404; list/executions → `[]`), integrations (PATCH foreign → 404), custom-field values (**S-1**), `X-Tenant-Id` spoof → 403. In the existing suites (executed, 451 tests): cross-tenant reads/writes/exports/files/jobs/search-less modules for contacts, leads, pipelines, tasks, notifications, inventory, files, lead sources, monitor, audit, realtime, API keys, members. **Not covered by any test:** cross-tenant behaviour of **reports and exports for legacy routes under the restricted role**, integration *execution* (none exists), background-job isolation for the future automation/destination workers.

---

## 2. Reliability and data integrity

| Area | Finding | Status |
|---|---|---|
| Transaction boundaries | v1: one transaction per request with `audit()` and `emit()` inside; mail jobs enqueued in the caller's transaction. Legacy: single statements, `executeInTenantContext` only on writes | VERIFIED (v1) |
| Constraints/FKs | composite tenant FKs for leads/activities/attribution; **missing composite FK for `custom_field_values` (S-1)**; no lead↔property table; viewing overlap enforced in a function only (no exclusion constraint, H10) | PARTIAL |
| Indexes / query plans | keyset indexes, trigram indexes for search; **no `EXPLAIN` review or benchmark exists** | UNVERIFIED |
| Race conditions | tested: concurrent contact creates, balanced assignment, stage moves, viewing slot (6 parallel → 1 accepted), job claims, event cursor, token consumption | VERIFIED |
| Outbox / event consumers | transactional emit, finished-transaction-only cursor, late-commit test | VERIFIED; **no consumer in production use** |
| Jobs | leases, heartbeat, reaper, backoff, dead-letter | VERIFIED |
| Idempotency | `Idempotency-Key` on create endpoints; inbound dedupe | VERIFIED; outbound N/A |
| Migrations | one transaction each, advisory lock, checksum guard, clean-bootstrap test; **forward-only** (no down scripts; `MIGRATION_AND_ROLLBACK_PLAN.md` says so); no zero-downtime/compatibility test | PARTIAL |
| Connection pool / timeouts | pool default 20, role-level `statement_timeout` (api 15 s, worker 60 s), lock and idle-in-transaction timeouts, pool exhaustion → 503 | VERIFIED (mapping) · load behaviour UNVERIFIED |
| Large imports | async, 100-row batches, resumable (`leads.test.ts`) | VERIFIED |
| Realtime reconnect | client back-off with jitter; server hints only | VERIFIED (server) · UNVERIFIED (long-run) |
| Backups, restore, retention objectives | **none exist** (no job, script, runbook with a tested restore, RPO/RTO) | **NOT IMPLEMENTED (P0 for production)** |
| Health, shutdown | `/healthz`, `/readyz` (schema version), graceful drain of API, worker, runner | VERIFIED |
| Monitoring / alerting / tracing | Monitor panel, metrics, request ids; **no alert rules, no log shipping, no distributed tracing** | PARTIAL |

### 2.1 Proposed service-level indicators (targets are hypotheses to calibrate after a baseline run, per the brief)

| Operation | SLI | Initial hypothesis (from `Claude_plan.md` §2.1, **unmeasured**) |
|---|---|---|
| Login | % of valid logins succeeding; p95 duration | p95 < 400 ms (Argon2id is deliberately slow) |
| Lead creation (API) | p95 server time; error rate | < 400 ms |
| Webhook acceptance | p95 receipt time; % acknowledged ≥ 2xx when the database is up | < 100 ms; ≥ 99.9 % |
| Lead visible after receipt | p95 `received_at → created lead` | < 10 s |
| Assignment | % of new leads with an owner within 1 min (when the workspace rule assigns) | ≥ 99 % |
| Task creation/reminder | reminder dispatched within 60 s of `remind_at` (p95) | ≥ 99 % |
| Lists/reads | p95 | < 200 ms |

### 2.2 Load tests to run (explicit initial workload, Tier T1 in the plan)
50 workspaces, 500 users, 1 M leads in total (largest workspace 200 k), peak 50 requests/s. Scenarios: (1) steady mixed read/write for 30 min; (2) 20 webhook deliveries/s to one source for 10 min (hot tenant); (3) 100 k-row CSV import while the API serves traffic; (4) worker kill mid-import and mid-delivery; (5) pool exhaustion; (6) listing at depth with filters on the largest workspace. Record p50/p95/p99, error rate, queue age, pool waiting. **No scalability claim is made until this runs.**

---

## 3. Test inventory and actual results

Command: `npx vitest run` → first run **22 files, 450 tests passed** (`evidence/audit_tests.txt`); after the invite fix the **final full run: 22 files, 451 tests passed** (`evidence/audit_tests_final.txt`). `npm run typecheck` exit 0; `npx eslint .` exit 0 with 75 warnings; `npm run build` passed earlier today (largest chunk 410 kB / 126 kB gzip).

| Category | Files (tests) | Notes |
|---|---|---|
| Unit | `platform-units` (30), `inbound-units` (26), `leads-units` (10), `tasks-units` (5), `authz` (69), `webhook-security` (18), `use-permissions` (7), `telemetry` (3), `utils` (8) | pure logic, permission matrix values |
| Database integration (restricted roles, disposable DB) | `platform-db` (30), `native-database-foundation` (8), `identity` (33), `access-control` (19), `contacts` (23), `leads` (30), `tasks` (22), `inventory` (24), `inbound` (36), `monitor` (19), `realtime` (10) | include concurrency, cross-tenant, role matrix, recovery |
| API / contract | `openapi` (9), `api-crm-workflow` (12, **legacy** viewings/dashboard/match/health/invite) | the only tests touching legacy routes |
| Webhook/provider contract | `inbound` (fake Meta Graph client), `webhook-security` | real providers: none |
| Worker/scheduler | `platform-db` (job leases/recovery), `tasks` (dispatcher), `leads` (import resume) | no automation worker (none exists) |
| **Browser end-to-end** | **none in the repository** | 7 ad hoc Playwright journeys exist outside the repo |
| **Security** (dedicated) | none as a suite; negative tests are embedded in the above | no fuzzing/SAST/DAST |
| **Load / resilience** | **none** | |
| **Backup / restore drill** | **none** | |

**Missing tests (by the brief's list):** duplicate events and concurrent requests for *automation/outbound* (nothing to test yet); worker crash in multi-step workflows; **permission change while a job runs**; migration *from the previous supported schema* (only clean bootstrap is tested); provider timeouts, rate limits and malformed responses beyond the Meta fake; large-CSV export authorisation; scheduled jobs across DST for automation; **report-vs-record reconciliation** (would currently fail: archived/test leads); legacy routes under the restricted role (would currently fail); accessibility (axe) and keyboard flows; phone-width layout regression (the Attribution overflow was found only by hand).

---

## 4. CI and deployment readiness

| Item | Finding |
|---|---|
| Location | the Git root *is* the project folder, but every CI step uses `working-directory: ./project` → the directory does not exist → **jobs fail at `npm ci`** (UNVERIFIED because Actions cannot run here; the path evidence is conclusive) |
| Node version | CI 20.x; development and the runbook use 24 (tests depend on current Node features? **UNVERIFIED**) |
| Migration check | greps `subscription_plans` (table removed by decision) → would fail |
| Tests in CI | `npm test` after `db:migrate` against a superuser `DATABASE_URL`; the suites create their own databases from `DATABASE_TEST_URL` (needs a role allowed to create databases/roles) |
| Security scan | `npm audit` and trufflehog both `continue-on-error`; trufflehog pinned to `@main` |
| Build artefacts | uploaded; no image build, no deploy job, no Dockerfile |
| Browser tests, lint of SQL, license check | none |
| Environment documentation | no `README`; `.env.example` and `.env.native.example` exist; the runbook's ports/DB name/Python requirement differ from `docker-compose.yml` (5442, `anibros`, no Python needed for the app) |

## 5. Dependency health
33 advisories (`evidence/npm_audit.json`): **1 in production code** (`nodemailer`, S-11), 32 in tooling (vitest/vite/esbuild/typescript-eslint/tailwind transitive chain). Tailwind 3 is still a dependency for 19 legacy files; removing the legacy pages (Phase 5 of `06`) removes `tailwindcss`, `postcss`, `tailwind-merge`, `autoprefixer` and some of the advisories that ride with them. Unused-dependency check (e.g. `depcheck`) **not run** (UNVERIFIED).

## 6. Dead code, duplication and undocumented decisions
* **Unrouted dead file:** `src/pages/settings/SettingsPage.tsx` (288 lines).
* **Duplicate implementations:** members (v1 vs legacy), automation (blob vs table), integrations (blob vs table vs lead sources), tenant settings (blob vs columns), dashboards (two).
* **Unused schema:** `integrations`, `integration_webhook_endpoints`, `webhook_inbox`, `outbox_events`, `automation_executions`, `branches`, `lead_scoring_config` (seeded at sign-up, never read; scoring reads `settings.scoring`), `custom_field_values` (written, never read by a screen), `marketing_attribution` (read, never written).
* **Unused permissions:** 26 of 68 (`01` §2).
* **Documented decisions missing:** ADRs: only one exists (`docs/adr/001_postgresql_version_standardization.md`); decisions such as "units are properties", "outbox-only events", "keyset cursors", "DEFINER functions for pre-tenant steps" live in design documents, not ADRs.

## 7. Documentation versus code (discrepancies)

| Document | Claim | Reality |
|---|---|---|
| `docs/RELEASE_READINESS.md` (banner says unverified) | 14 gates PASS, "89 tests / 9 files", "durable-worker.ts" implements the worker, "all CRM modules 100%" | now 22 files / 451 tests; `durable-worker.ts` was deleted; legacy modules are not 100% (this audit). Still carries PASS marks under a banner |
| `docs/LOCAL_AND_PRODUCTION_RUNBOOK.md` | Postgres on 5432 / `crm_dev`, Python 3.10+, `cp .env.example` | compose uses 127.0.0.1:5442 / `anibros`; Python is not needed for the app |
| `docs/ARCHITECTURE.md` (105 KB), `MASTER_CONTEXT.md`, `masterplan.md`, `AI_CONTEXT_BUNDLE.md` (157 KB, generated) | describe Supabase/Edge Functions in places (52 / 16 / 35 / 157 mentions) | the runtime is native PostgreSQL + Express; only two files carry a *STALE* banner |
| `docs/CRM_HANDOUT.md` (written earlier today) | §6 lists **Automation** and **Integrations** as "work, older version" and Dashboard/Reports as working | **over-claimed**: Automation runs nothing, Integrations is a blob, Dashboard/Reports are wrong under the production role. **Corrected in this audit** (see the handout's updated §6) |
| `Claude_plan.md` Wave 6 / dashboard | consistent with this audit except legacy items called "legacy, works" | clarified in `07` |
| No `README.md` | — | first-time developer has no entry point |

## 8. Unknowns that need more investigation
Real-provider behaviour (Meta, Google, SMTP, WhatsApp); performance at the stated workload; backup/restore; GitHub Actions run; screen-reader and contrast of legacy pages; Google lead-form payload details beyond the documented fields I used; whether the `custom_field_values` rows created across tenants are reachable from any read path (none found); exploitability of the legacy last-owner revoke race; whether any customer already uses the legacy endpoints (no usage telemetry).

## 9. Acceptance gates before production release
1. All legacy routers ported or removed; production role (non-superuser, no `BYPASSRLS`) used in staging with the full browser suite passing.
2. P0/P1 items in `07` Slice 0 closed with tests; cross-tenant suite includes every router.
3. Backups running, **a restore performed and timed**, RPO/RTO written down.
4. CI green on a clean checkout (typecheck, lint, tests, build, migration-from-previous-version, audit blocking on high/critical *production* advisories).
5. Dockerfiles/manifests, secrets in a manager, TLS/HSTS and DB-at-rest encryption confirmed.
6. Load test at the stated workload with recorded SLIs; alert rules for SLO burn, queue age, worker heartbeat, dead letters, delivery failures.
7. Browser end-to-end suite in the repository for the core journey; axe scan clean on all routes; phone layouts pass.
8. Documents reconciled (`README`, runbook, ADRs, stale files archived).
9. Provider-live verification (Meta, Google) in a sandbox before announcing those features.
