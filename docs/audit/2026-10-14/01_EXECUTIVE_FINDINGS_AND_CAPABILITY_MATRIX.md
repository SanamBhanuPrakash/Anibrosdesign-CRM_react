# Audit 2026-10-14 · 01 — Executive findings and capability matrix

Status words (used everywhere): **VERIFIED WORKING** (implementation + an executed test or probe) · **PARTIALLY IMPLEMENTED** · **UI ONLY** · **SIMULATED** · **BROKEN** (a demonstrated defect) · **NOT IMPLEMENTED** · **EXTERNAL DEPENDENCY REQUIRED** · **UNVERIFIED**.
"Evidence" names a file, a test, or a probe in `evidence/`. Confidence: H = executed and inspected, M = code read, plus indirect evidence, L = inference.

---

## 1. Executive findings in plain English

1. **The everyday selling loop is real and tested.** A lead can arrive (typed in, CSV, Meta, Google, website form, another system), gets an owner and a score, appears on the list and the board, is followed up with tasks and reminders, is moved through the pipeline with rules, and the buyer's properties and projects are tracked with price and availability history. 451 automated tests pass, and I drove the screens in a real browser.
2. **A second group of screens only *looks* finished.** I tested each one by using it and then checking the database and the outcome:
   * **Automation Rules**: you can create a rule and see it listed, but **nothing ever runs it**. I created "Lead Created → Create Task", then created a lead and waited 20 seconds: zero tasks. The rule is not even saved in the automation table; it sits in a settings blob that nothing reads.
   * **Integrations (the old page)**: saving "Google Ads" shows a green **active** badge with no credentials, no connection and no test. Same blob trick.
   * **Tenant Configuration**: its **Save wipes every other workspace setting** (lead assignment mode, first-reply deadline, scoring weights, default country, the automation and integration blobs), its stage buttons do nothing, and its **Timezone is saved in a place the rest of the system does not read**.
   * **Custom Fields**: you can define fields, but no lead, contact or property screen shows or edits them, and values are not validated.
3. **Biggest release blocker: the nine legacy pages and the eight legacy routers behind them (30 database calls) only work with the developer's all-powerful database login.** With the production-style restricted login (the one the system itself demands in production), I measured: the dashboard shows all zeros, the viewings list is empty, rules and integrations cannot be edited or deleted (404), pipeline-velocity fails. The production start-up refuses the all-powerful login (`platform/db/index.ts: assertRuntimeRoleSafe`), so **the product cannot be deployed safely until these are ported**.
4. **Security is strong where the code was rebuilt and weak in what remains of the old code.** Confirmed with probes: another workspace could **delete** and **link to** a custom-field value in yours (needs your record ids); an admin can **force any registered person into the workspace** with the legacy invite (no consent, no audit, no email, and it reveals whether an address has an account); a viewing can be booked with a **user from another workspace as agent and that person's name and email are then shown**; integration configuration returns whatever you typed, **tokens included**.
5. **Reporting numbers do not reconcile with the records.** The dashboard counts archived leads (6 shown, 5 real; pipeline value 21 M vs 18 M), "Send test lead" leads count as real, and attribution invents campaign names ("`meta_ads Inbound`") from the source.
6. **The site-visit step is thin.** You can book a viewing (double-booking is correctly prevented, tested with six simultaneous requests: 1 accepted, 5 refused), but you cannot cancel, reschedule, complete or mark no-show; booking does **not** move the lead to *Viewing Scheduled*, create a task or notify anyone; booking is allowed on **archived** properties and leads.
7. **Missing entirely:** sending email/WhatsApp to a lead, outbound delivery to a client's CRM (the StrategicERP use case), spend and ROI data, a link between a lead and the unit they want, global search, AI features, backups, deployment packaging.
8. **Operations are not production-ready:** no backup or restore evidence anywhere, no Dockerfile, the CI file points at a directory that does not exist in this repository layout, 33 dependency advisories (1 in production code: `nodemailer`; 32 in development tooling).

**What this means for you:** the foundation is sound; the risk is concentrated in a short, identifiable list of old screens and endpoints. Fixing those is a smaller job than a rewrite, and it should come before more features.

---

## 2. Baseline (what I measured, not what documents say)

| Item | Value | Evidence |
|---|---|---|
| Branch / HEAD | `feat/native-postgresql-migration` / `a9363b98` (2026-10-13 15:14) | `git log -1` |
| Working tree | **181 changed paths, uncommitted** (all work since takeover; migrations 008→020 changes, new modules, deleted legacy files) | `git status --short | wc -l` |
| Stack | Node 24, Express 5, `pg`, PostgreSQL 17 with enforced RLS; React 18 + MUI v9 + TanStack Query; Vite | `package.json`, `docker-compose.yml` |
| Processes | API + worker (one process in dev `server/src/server.ts`, separate in production `api.ts`/`worker.ts`) | code |
| Migrations | 20 (001–020), checksum-guarded, advisory-locked | `server/src/db/migrate.ts` |
| v1 API | **124 routes**, 68 permissions, 8 roles; 26 permissions defined but unused by v1 (they guard legacy modules by hard-coded role lists) | `evidence/matrix.md` |
| Legacy API | **29 endpoints in 8 routers** using 30 `pool.query` calls without tenant context | `grep` in `server/src/routes/*` |
| Typecheck / lint / build | pass / 0 errors, **75 warnings** / pass (largest chunk 410 kB, 126 kB gzip) | `evidence/audit_typecheck.txt`, `audit_lint.txt` |
| Tests | 22 files; first run **450 passed**; **final full run after the invite fix: 451 passed** | `evidence/audit_tests.txt`, `evidence/audit_tests_final.txt` |
| Browser tests in repo | **none** (Playwright is a dev dependency; my journeys live outside the repo) | no `e2e/` folder |
| Dependencies | 33 advisories: 2 critical + 22 high + 6 moderate + 2 low + 1 high-in-production | `evidence/npm_audit_production.txt` |

### 2.1 Earlier findings re-checked against this revision

| Earlier ID | Earlier claim | Now |
|---|---|---|
| C1 migration 007 breaks bootstrap | **Fixed**; clean bootstrap runs in every test |
| C2 superuser runtime role | **Partially fixed**: restricted roles exist, every rebuilt module is tested under them, production refuses a privileged role; **dev still runs privileged** and legacy routes still depend on it |
| C3 unauthenticated webhooks, C4 tenant guessing, C5 broken worker statuses | **Fixed** (legacy webhooks answer 410; new signed receiver; tenant from endpoint row; lease-based jobs) |
| C6 `tenant.ts` wrong columns | Audit-logs/config/members now answer 200; **but** the file still contains the unsafe legacy invite/revoke (see `05` S-3) |
| C7 operations routes exposed other tenants' rows | **Fixed**: legacy Operations removed, replaced by the tenant-scoped Monitor |
| C8 token races / enumeration | **Fixed** in the identity module (tests) |
| C9 realtime duplicates / tenant binding | **Fixed** (realtime tests, 10) |
| C10 hard-coded secrets | **Mostly fixed**: production config fails fast on default secrets; the dev defaults remain in `platform/config.ts` by design; migration 004 once created a login role with a known password and migration 009 removes it (`ALTER ROLE … NOLOGIN PASSWORD NULL`) |
| H1 raw `pool.query` in routes | **Open** for 8 legacy routers (30 calls) |
| H2 central permissions | **Fixed for v1**, legacy uses role lists that **disagree** with the matrix (see `02` §4.2) |
| H3 offset pagination | **Fixed** (keyset everywhere in v1); legacy has no pagination but also no `OFFSET` |
| H8 Tailwind/MUI mix, Supabase | Supabase **gone from code and dependencies**; Tailwind remains in 19 files under `src/pages` and `src/components/ui` |
| H9 documents over-claim | **Partly open** (`05` §8) |
| H10 no exclusion constraint for viewings | **Open** (function-level lock works under test; no DB constraint) |

---

## 3. Capability matrix (module by module)

### 3.1 Platform and identity

| Capability | Status | Evidence | Conf. |
|---|---|---|---|
| Sign-up, e-mail verification, login, logout, reset | VERIFIED WORKING | `identity.test.ts` (33), browser journeys, live verification-link check | H |
| MFA (TOTP + recovery), sessions list/revoke, deactivation effective next request, role change effective next request | VERIFIED WORKING | `identity.test.ts`, `access-control.test.ts`, probe `identity.txt` (`[403, 200, 403]` on role change/revoke) | H |
| Step-up re-auth for sensitive actions, session-token rotation on privilege change | NOT IMPLEMENTED | `Claude_plan.md` Wave 2 "Remaining" | H |
| Members and invitations (v1) | VERIFIED WORKING | `access-control.test.ts` (19) | H |
| Invitations (legacy `/api/tenant/members/invite`) | **BROKEN / UNSAFE** | probe: adds existing users without consent, no mail, no audit; invitations for new addresses cannot be accepted (token discarded) | H |
| API keys (hashed, scoped, expiring, revocable) | VERIFIED WORKING | `access-control.test.ts` | H |
| Per-key rate limits | NOT IMPLEMENTED | `docs/SECURITY_MODEL.md` §4 | H |
| Workspace isolation: RLS under restricted roles | VERIFIED WORKING for all v1 modules | `platform-db.test.ts` (30), every module's cross-tenant tests | H |
| Workspace isolation for the 8 legacy routers | **PARTIALLY IMPLEMENTED**: depends on hand-written `WHERE tenant_id`; one confirmed cross-tenant write | probe `legacy_privileged.txt` (custom fields) | H |
| Audit trail (append-only, in-transaction) + explorer + CSV | VERIFIED WORKING | `monitor.test.ts` (19) | H |
| Activity log, health checks, worker heartbeat | VERIFIED WORKING | `monitor.test.ts`, browser journey | H |
| `/healthz`, `/readyz` | VERIFIED WORKING (`api-crm-workflow`, `identity`, `openapi` tests) | tests | H |
| `/metrics` (Prometheus RED metrics, protected in production-like config) | VERIFIED WORKING (`openapi.test.ts`); **alert rules NOT IMPLEMENTED**, dashboards NOT IMPLEMENTED | `platform/observability/metrics.ts` | H |
| Realtime updates | VERIFIED WORKING | `realtime.test.ts` (10) | H |
| Public API documentation | VERIFIED WORKING | `openapi.test.ts` (9), `/api/v1/openapi.json`, `/api/docs` | H |
| Backups and restore | **NOT IMPLEMENTED** (no script, job, runbook with evidence, or test) | repo-wide search: no `pg_dump`/WAL tooling | H |
| Deployment packaging (Dockerfile, manifests) | NOT IMPLEMENTED | no `Dockerfile*` | H |
| CI | **UNVERIFIED, likely BROKEN**: `working-directory: ./project` does not exist at the repository root (the root *is* the project folder); the migration check greps for a dropped table (`subscription_plans`); Node 20 vs developed on 24; `npm audit` and secret scan are non-blocking | `.github/workflows/ci.yml`; cannot run GitHub Actions locally | M |

### 3.2 Sales

| Capability | Status | Evidence | Conf. |
|---|---|---|---|
| Contacts (dedupe, merge + 30-day undo, consent, ETag) | VERIFIED WORKING | `contacts.test.ts` (23) | H |
| Companies/accounts as an entity | NOT IMPLEMENTED (free-text `company` on a contact only) | schema | H |
| Leads: create, list (keyset, 12 filters), update, assign, archive, bulk, saved views, tags | VERIFIED WORKING | `leads.test.ts` (30), journeys | H |
| Lead scoring (explainable) | VERIFIED WORKING | `leads-units.test.ts`, UI popover | H |
| First-reply clock (SLA) | VERIFIED WORKING (single duration; no business-hours calendar) | `leads.test.ts` | H |
| CSV import (async, row errors, resumable) / export (formula-safe, audited) | VERIFIED WORKING; **dry-run and rollback NOT IMPLEMENTED** | `leads.test.ts` | H |
| Pipelines: multi-pipeline CRUD, stage CRUD/reorder, transition matrix, required fields, loss reason, reopen, board, weighted forecast | VERIFIED WORKING | `leads.test.ts` | H |
| Pipeline defaults usable for a beginner | **PARTIALLY IMPLEMENTED**: *Nurture* has no outgoing transition (a dead end); *New → Lost* and *Contacted → Lost* are not allowed; Invalid and Unqualified are one status | `005_…sql` seed, probe `workflow.txt` | H |
| Forecast reconciles to opportunities | PARTIALLY IMPLEMENTED: probability × `estimated_value` is correct for the board; the legacy dashboard/report formulas are different and do not reconcile | `03` §3, `04` §7 | H |
| Sales targets / quotas / forecast categories | NOT IMPLEMENTED | search | H |
| Sequences (multi-step, waits, exits) | NOT IMPLEMENTED | search | H |
| Tasks: CRUD, reminders (worker), recurrence (DST-safe), overdue alerts, lead follow-up derived | VERIFIED WORKING | `tasks.test.ts` (22), `tasks-units.test.ts` (5) | H |
| Notes with @mentions, attachments on leads | NOT IMPLEMENTED (plain notes/activities work) | `Claude_plan.md` 3.4 | H |
| Calendar | **PARTIALLY IMPLEMENTED**: a read-only list of viewings (no tasks, no create/cancel/reschedule, no ICS) | `src/pages/CalendarPage.tsx` | H |
| Viewings | **PARTIALLY IMPLEMENTED / BROKEN under restricted role** (see §3.3) | probes | H |
| Global search | **NOT IMPLEMENTED**: the ⌘K palette jumps to pages only; permission `search:use` is unused | `CommandPalette.tsx` header comment | H |
| Contacts export | NOT IMPLEMENTED (`contacts:export` unused) | matrix | H |

### 3.3 Real-estate inventory

| Capability | Status | Evidence | Conf. |
|---|---|---|---|
| Projects and properties (unit = property in a project), availability state machine with reversal reason, price and status history, files (sniffing, hardened downloads), summary | VERIFIED WORKING | `inventory.test.ts` (24), journey | H |
| Lead ↔ unit relationship (interest, shortlist, offer, reservation, booking amount) | **NOT IMPLEMENTED**: no table links a lead to a property except a viewing | schema | H |
| Offers, negotiation records, reservations, booking confirmation/cancellation, payment milestones, receipts, commission, approvals | NOT IMPLEMENTED | search | H |
| Viewings: book with property/agent overlap protection | VERIFIED WORKING (concurrency probe 1×201 + 5×409; `api-crm-workflow.test.ts`) | `legacy_privileged.txt` | H |
| Viewings: cancel / reschedule / complete / no-show, ICS, reminders | NOT IMPLEMENTED (statuses exist in the enum, no endpoint) | `routes/viewings.ts` (GET and POST only) | H |
| Viewing booking effects (stage move, task, notification) | NOT IMPLEMENTED (+1 timeline note only) | probe `workflow.txt` | H |
| Viewing integrity: archived property/lead, agent from another workspace | **BROKEN** (all accepted) | probe `workflow.txt` | H |
| Viewings DB-level exclusion constraint (H10) | NOT IMPLEMENTED (function lock only) | migrations 005/007 | H |
| Property matching | **PARTIALLY IMPLEMENTED**: rule-based scoring with reasons; labelled "AI"; includes archived properties; only on demand; no reverse direction, no saved alerts | `routes/properties.ts`, probe | H |
| Project/unit reconciliation reports | NOT IMPLEMENTED | search | H |

### 3.4 Marketing and integrations

| Capability | Status | Evidence | Conf. |
|---|---|---|---|
| Inbound lead sources: Meta, Google, website, generic (signatures, replay window, dedupe, delivery log, retry, test lead, encrypted secrets) | VERIFIED WORKING for simulated deliveries | `inbound.test.ts` (36), `inbound-units.test.ts` (26), journey | H |
| Live Meta and Google deliveries | **EXTERNAL DEPENDENCY REQUIRED** (credentials, public HTTPS URL) | `04` §6 | H |
| Meta Graph retrieval | SIMULATED in tests (fake Graph client); real client implemented, unexercised | `modules/inbound/graph.ts` | M |
| Campaign/ad/form/click-id provenance on the lead | VERIFIED WORKING (`leads.source_details`) | `inbound.test.ts` | H |
| Outbound delivery to a client's CRM / generic connector | **NOT IMPLEMENTED** | search; tables `outbox_events`, `integrations` unused | H |
| Outbound webhooks (subscriptions, HMAC, retries, replay) | NOT IMPLEMENTED | plan 4.5 | H |
| Conversion uploads to Meta/Google | NOT IMPLEMENTED · ⛔ accounts | plan 4.3 | H |
| Legacy Integrations page | **UI ONLY** (misleading: shows "active" with no connection) | browser + code | H |
| Campaign spend, cost per lead, ROI | NOT IMPLEMENTED | search | H |
| Attribution page | **PARTIALLY IMPLEMENTED, misleading** | `04` §7 | H |
| Email/WhatsApp/SMS to leads (templates, status, consent enforcement, replies) | NOT IMPLEMENTED (account e-mails work: VERIFIED against Mailpit; real SMTP provider ⛔) | search | H |
| Consent records | VERIFIED WORKING (recording); **enforcement points do not exist yet** because nothing sends | `contacts.test.ts` | H |

### 3.5 Automation, analytics, administration, AI

| Capability | Status | Evidence | Conf. |
|---|---|---|---|
| Automation rules | **UI ONLY** (detail in `02`) | `evidence/automation_*.txt`, `audit_ui.json` | H |
| Automation execution engine | NOT IMPLEMENTED (no consumer, no job type, `automation_executions` never written) | `worker.ts`: `eventConsumers = []` | H |
| Dashboard | **PARTIALLY IMPLEMENTED / BROKEN under restricted role** (zeros); counts archived leads; statuses do not sum | `reports_*.txt` | H |
| Reports overview | PARTIALLY IMPLEMENTED / zeros under restricted role | `reports_restricted.txt` | H |
| Pipeline velocity report | **BROKEN** (`column lsh2.changed_at does not exist`) | `reports_privileged.txt` | H |
| Custom fields | PARTIALLY IMPLEMENTED (definitions + raw values; never rendered; no validation; cross-tenant link/delete defect) | probe | H |
| Tenant configuration | **BROKEN** (Save replaces all settings; timezone column mismatch; stage buttons are stubs) | `TenantConfigPage.tsx` lines 90–128 | H |
| Branches | NOT IMPLEMENTED beyond a table | search | H |
| Data retention, erasure, subject export | Retention jobs VERIFIED (`platform-db`); **erasure/export workflows NOT IMPLEMENTED** | `maintenance.ts` | H |
| AI features (summaries, next action, drafting, Q&A, agent tools) | **NOT IMPLEMENTED**: only an unused `ANTHROPIC_API_KEY` setting and a feature flag; the page titled "AI Property Matching" uses no AI | `config.ts` | H |
| Billing | DEFERRED by decision | `docs/SUBSCRIPTION_DESIGN.md` | H |

---

## 4. Screens that are confusing or duplicated

| Problem | Screens | Evidence |
|---|---|---|
| **Two places to configure the pipeline** | *Pipelines* (real, tested) and *Tenant Configuration → Pipeline* (a read-only mirror whose add/rename/delete buttons call empty functions) | `TenantConfigPage.tsx:116-128` |
| **Two places for integrations** | *Lead sources* (real) and *Integrations* (stores a list in a settings blob, nothing consumes it) | `IntegrationsPage.tsx:60-125` |
| **Two places for automation** | `/settings/automation` UI (blob) vs `/api/automation` (table, unused by any screen) | probes |
| **Two copies of members logic** | v1 members/invitations (safe) and legacy `/api/tenant/members*` (unsafe) | `routes/tenant.ts` |
| **Two dashboards** | Dashboard ("Executive Dashboard") and Reports ("Executive Dashboard & Reports") show overlapping numbers computed by different formulas | pages |
| **Three roles lists that disagree** about who may manage automation: backend legacy `[owner, admin, sales_manager]`, central matrix `[owner, admin, marketing_manager]`, UI `[owner, admin, marketing_manager]`. Result (probe): sales manager can create rules via the API but the UI hides the button; marketing manager sees the button, but saving fails with 403 (PATCH of tenant config is owner/admin only) and the page only logs to the console | `routes/automation.ts:10`, `matrix.ts:106-108`, `use-permissions.ts:38`, probe `automation_*.txt` |
| "Settings", "Tenant Configuration", "Workspace settings", "Workspace" (nav group) | four names for overlapping ideas | `nav.tsx`, pages |

## 5. Misleading states (look implemented, are not)

| Where | What the user sees | Reality |
|---|---|---|
| Automation Rules | rule listed, **Active** toggle, "When X → Then Y" | nothing executes; stored in a settings blob; action has **no parameters** (who to assign? which task?) |
| Integrations | green **active** after Save | no credentials, no connection, no test; blob |
| Integrations → providers list (`/api/integrations/providers`) | "WhatsApp Business: available — send WhatsApp messages", "Mailgun: send emails" | no sending exists |
| `hasCredentials: true` in `/api/integrations` | hard-coded, even when no credential column is ever written | `routes/integrations.ts:40`, probe `credentials_enc populated: false` |
| Tenant Configuration → Timezone | saved confirmation | the value goes to `settings.timezone`; the system reads the column `tenants.timezone` |
| Tenant Configuration → Pipeline tab | add / edit / delete stage | no-op |
| Attribution → Campaign Performance | campaign names | invented as `<source> Inbound` |
| Attribution → "Attributed Leads" | a count | **all leads**, including direct/other and archived |
| "AI Property Matching" | AI | fixed-weight rules |
| Dashboard / Reports | numbers | zeros under the production role; include archived leads |
| Calendar | "Viewing Calendar" | read-only list of viewings only |
| Custom Fields | define fields | never displayed anywhere |
| Lead sources → "Send test lead" leads | appear as real leads in dashboards/attribution | counted in all legacy metrics |

## 6. Interface sweep (browser, every route, laptop 1440 and phone 390)

Method: `evidence/audit_ui.cjs`. Checked per route: API 4xx/5xx during load, console errors, horizontal overflow, interactive controls without an accessible name, images without `alt`, `main` landmark, stuck skeletons. Raw results: `evidence/audit_ui.json`.

* **No API errors, console errors or stuck loading states on any of 23 routes at either width** (privileged database role; the legacy zero/empty behaviour only appears under the restricted role).
* **Horizontal overflow: 1 — `/attribution` on phone.**
* **Controls without an accessible name** (count of visible controls with no label/text/aria-label): Leads 4, Leads board 3, Lead detail 1, Contacts 1, Properties 5, Matching 1, Team 1, **Pipelines settings 13**, Automation 2, Tenant configuration 1. These are mostly icon-only buttons and selects. Failing WCAG 4.1.2 (Name, Role, Value) until fixed.
* **The Automation dialog is not a dialog**: it has no `role="dialog"` and its inputs are not associated with their labels (a label lookup fails), so keyboard and screen-reader users get no context (`src/components/ui/Dialog.tsx`, `Input.tsx` — the legacy component set).
* Every route has a `main` landmark and no image lacks `alt`.
* I did **not** run an automated axe-core scan or test with a screen reader; contrast and focus order for the legacy pages are therefore **UNVERIFIED**.

## 7. What I could not verify

Live Meta/Google/WhatsApp behaviour (no credentials, by design); real SMTP delivery; load and latency numbers (no load test exists); backup and restore; GitHub Actions execution; screen-reader behaviour; behaviour on a real public HTTPS address; the exact current Google lead-form payload against Google's live documentation (I implemented from the documented field list; see `04` §1).
