# Claude_plan.md — Anibros CRM: Takeover Plan & Live Progress Tracker

**Owner of execution:** Claude (took over from Antigravity/Gemini on 2026-10-13)
**Companion files:** `PROJECT_LOG.md` (chronological evidence ledger — append only), `docs/ARCHITECTURE_V2.md` (target design), `docs/SUBSCRIPTION_DESIGN.md` (deferred billing design), `docs/API_PLATFORM.md` (public API / webhooks / OpenAPI), `docs/SECURITY_MODEL.md`, `docs/FAILURE_MODES.md`, `docs/UI_DESIGN_SYSTEM.md`.
**Rule of this file:** a box is ticked only when there is reproducible evidence (command output, test, or runtime observation). Status words: `PASS · PARTIAL · FAIL · BLOCKED · NOT VERIFIED · DEFERRED`.

---

## 0. Mission (what "done" means)

Build a **2026-grade, multi-tenant real-estate CRM** that Anibros uses internally *and* sells as SaaS:
FAANG-level system design (scale, security, latency, failure handling), industry-grade features, a Material UI front end with Google Fonts, a documented public API + webhooks so customers can connect anything, and honest evidence for every claim.

**Explicit scope decisions from the owner (2026-10-13)**
1. **Subscriptions/billing are REMOVED for now** (UI, API, tables, nav). A design doc (`docs/SUBSCRIPTION_DESIGN.md`) records how to add it later without rework.
2. **UI is rebuilt on Material UI only** (drop Tailwind), Google Fonts (self-hosted via Fontsource — no runtime call to Google).
3. **Skills policy:** use installed design/security/engineering skills. **Never use**: Impeccable, Vercel deploy-to-vercel, Vercel web-design-guidelines/writing-guidelines, UI/UX-Pro-Max stack/design/brand/ui-styling skills, brag, Libraries.dev, publish-project-to-github. GSAP/Lenis/Vanta: default **not used**.
4. No push/merge/deploy/provider-live-change without explicit approval.

---

## 1. Verified ground truth at takeover (HEAD `a9363b9`, branch `feat/native-postgresql-migration`)

Measured on 2026-10-13, not copied from earlier reports.

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | exit 0 |
| `npm run lint` | PASS (0 errors, **86 warnings**) | exit 0 |
| `npm run build` | PASS — but one **839 kB** JS chunk, no code-splitting | vite output |
| `npm test` | **FAIL** — 2 failed, 60 passed, **35 skipped** of 97 | vitest output |
| Clean DB bootstrap | **FAIL** — migration 007 errors `column "changed_at" does not exist` | `native-database-foundation.test.ts` tests 1–2 |
| Dev DB (`anibros`) migrations applied | only **001–006**. 007/008 never applied | `schema_migrations` |
| Tables routes depend on but DB lacks | `login_attempts`, `integrations`, `custom_field_definitions`, `automation_rules`, `tenant_subscriptions`, `branches`, `incidents`, `property_images` | probe |
| **Login at HEAD** | **BROKEN** against dev DB (queries missing `login_attempts` → HTTP 500) | code + probe |
| Runtime DB role | **superuser `anibros` with BYPASSRLS** → every RLS policy is a no-op at runtime; isolation relies only on hand-written `WHERE tenant_id=` | probe |
| Earlier claim "89/89 tests pass" | **FALSE at HEAD** (35 skipped because bootstrap fails) | test output |

### 1.1 Defect register (found by reading the code; IDs are referenced by waves below)

**Critical (data-integrity / security / "feature cannot work")**
| ID | Defect | Where |
|---|---|---|
| C1 | Migration 007 breaks clean bootstrap; "performance indexes" with duplicate names silently no-op | `database/migrations/007` |
| C2 | App runs as superuser → RLS bypassed; no role separation (API vs worker vs migrator) | `.env.native`, `db/pool.ts`, mig 004 |
| C3 | Inbound webhooks **unauthenticated**: hard-coded Meta verify token fallback, no `X-Hub-Signature-256` check, Google body unverified, `Date.now()` in event id defeats idempotency, errors return HTTP 200 (data loss) | `routes/webhooks.ts` |
| C4 | Worker **guesses tenant** (`SELECT … LIMIT 1`) for unmapped events → cross-tenant lead injection | `workers/durable-worker.ts` |
| C5 | Worker writes statuses `processed` / `delivered` that **don't exist** in enums (`completed`) → every job fails; item error inside one TX aborts whole batch; no leases; outbox "delivery" is simulated | worker |
| C6 | `tenant.ts`: selects `u.full_name`, `t.status` (columns don't exist) → audit-log & config endpoints 500; revoke sets `status='revoked'` (not in enum) → member revoke impossible | `routes/tenant.ts` |
| C7 | Operations routes expose/replay rows where `tenant_id IS NULL` to any tenant admin; unscoped logs | `routes/operations.ts` |
| C8 | Password-reset & email-verify tokens consumed with SELECT-then-UPDATE (replay race); signup check-then-insert race → 500; login timing reveals account existence; email-keyed lockout lets anyone lock a victim out | `routes/auth.ts` |
| C9 | Realtime: direct `broadcast` after commit **and** table-NOTIFY triggers → duplicate events; no event cursor/replay; WS binds to *first* membership tenant (ignores switch) | `ws-server.ts`, mig 008 |
| C10 | Hard-coded dev secrets/passwords in code & migrations (`dev-app-password`, cookie secret default); config does not fail-fast in production | `config.ts`, mig 004 |

**High**
| ID | Defect |
|---|---|
| H1 | No service/repository layer; **~90 raw `pool.query` calls** inside route handlers; business rules duplicated; untestable without HTTP+DB |
| H2 | RBAC is a flat role-list per route; no central permission matrix, no ownership scoping (sales_agent should see own leads per masterplan §4), no policy tests |
| H3 | Offset pagination + `ILIKE '%x%'` on unindexed columns; no trigram/FTS indexes; no cursor pagination |
| H4 | No request validation on query/params; dynamic `SET` clauses built by hand; no OpenAPI; no API versioning; no idempotency keys |
| H5 | Single process runs API + WS + worker; worker holds a transaction open during processing |
| H6 | Session validated with 2 queries per request, no cache, no idle timeout, no session list/revoke, no rotation, no MFA |
| H7 | No `/metrics`, no readiness probe, no pool/queue gauges, no graceful drain of in-flight jobs |
| H8 | Frontend: Tailwind (32 files) + MUI (12 files) mixed; 3 realtime hooks (2 are Supabase-era, still shipped); `@supabase/supabase-js` still a dependency and imported; 839 kB bundle; 86 lint warnings |
| H9 | Docs/logs over-claim ("PASS", "89/89", "zero Supabase runtime"); hundreds of KB of stale/duplicated planning docs |
| H10 | Viewing uniqueness index `(property_id, scheduled_at)` only; overlap enforced in function but not by DB constraint (race-proof exclusion constraint missing) |

**Medium:** soft-delete columns exist but routes ignore them; `tenant_role`/`membership_status` enums drifted from masterplan (`revoked` missing); `activities`/`audit_logs`/`operational_logs` unbounded (no partitioning/retention); mailer is an in-memory sink; invitations have no acceptance route; CSV import/export, dedupe/merge, assignment rules, SLA, tags, notes, files, saved views, comms: not built.

### 1.2 Product reality (page-by-page) — from code reading
Pages exist for ~24 routes but most are thin; Operations Center (68 kB single file) is the most complete. Features **absent end-to-end**: lead import/export, dedupe/merge, assignment/round-robin, SLA timers, tags, notes/@mentions, documents, email/WhatsApp/SMS sending, templates/sequences, forecasting, saved views, bulk actions, global search backend, API keys, outbound webhooks, MFA, session management, real integrations (Meta/Google).

---

## 2. Target architecture (summary — full text in `docs/ARCHITECTURE_V2.md`)

```
 Browser SPA (React18+MUI9+TanStack Query)        3rd-party systems / customer integrations
        │ HTTPS (cookie+CSRF)  │ WSS                     │ REST /api/v1 (API key)   ▲ signed webhooks
        ▼                      ▼                         ▼                          │
 ┌──────────────────────── API process (stateless, N replicas) ───────────────────────────┐
 │ requestId → helmet/CORS → rate-limit → authN(session|API key) → tenant → authZ(policy)  │
 │ → zod validate → route → SERVICE (use-case, tx, authz scope) → REPOSITORY (SQL)         │
 │                         └ emits DOMAIN EVENTS in the same TX (transactional outbox)     │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        │ pool (role crm_app, RLS enforced)              ▲ LISTEN crm_events (cursor-based fan-out)
        ▼                                                │
 ┌──────────────── PostgreSQL 17 (primary [+ read replica]) ────────────────┐
 │ RLS by tenant GUC · composite tenant FKs · domain_events (cursor) · jobs   │
 │ webhook_inbox · outbox_events · audit_logs · partitioned logs/activities   │
 └────────────────────────────────────────────────────────────────────────────┘
        ▲ pool (role crm_worker: queue-table policies only)
 ┌──────────────── Worker process (scale by queue depth) ────────────────────┐
 │ lease-based jobs (SKIP LOCKED) · inbound webhook processor · outbound     │
 │ webhook/conversion delivery · automation engine · notifications · email    │
 │ scheduled: SLA, reminders, retention, rollups, stuck-lease recovery        │
 └────────────────────────────────────────────────────────────────────────────┘
```
Key decisions (ADR list in architecture doc): modular monolith · shared-schema multi-tenancy + **enforced RLS** · transactional outbox → one event spine · Postgres LISTEN/NOTIFY first (Redis only when WS > ~5k conns or rate-limit state must be shared) · keyset pagination · MUI+TanStack Query · OpenAPI-first public API.

### 2.1 Scale envelope we design for (assumptions — revisit with real data)
| Tier | Tenants | Users | Leads (total) | Peak API rps | Action |
|---|---|---|---|---|---|
| T1 (now) | ≤ 50 | ≤ 500 | ≤ 1 M | ≤ 50 | single API + worker + 1 PG, PgBouncer optional |
| T2 | ≤ 1 k | ≤ 10 k | ≤ 50 M | ≤ 500 | 3+ API, 2+ workers, PgBouncer, read replica for reports, Redis for rate-limit/cache |
| T3 | 10 k+ | 100 k+ | 500 M+ | 5 k+ | partition by tenant hash / Citus, dedicated DB for enterprise tenants (tenant→DSN router already behind `db` layer), CDN, regional deploy |
Latency budgets: API p95 < 200 ms for lists/reads, < 400 ms writes; realtime commit→UI p95 < 2 s; webhook receipt → lead visible p95 < 10 s. *Targets until measured by load tests (Wave 9).*

---

## 3. Waves — execution order, acceptance criteria, status

Legend: `[ ]` open · `[~]` in progress · `[x]` done with evidence (see PROJECT_LOG entry id in brackets).

### Wave 0 — Stabilize & make truth reproducible  ·  STATUS: `PASS` (2026-10-13, PROJECT_LOG §Session 1)
Goal: green baseline on a clean DB; honest docs.
- [x] 0.1 Fix migration 007 (valid indexes, narrow exception handling) — closes C1
- [x] 0.2 Remove subscription objects from migration 008 (unapplied) — per owner decision
- [x] 0.3 Fix enum drift (`membership_status += revoked`), webhook/outbox status vocabulary — closes part of C5/C6 (new migration 009)
- [x] 0.4 Test harness: disposable DB per run (create → migrate → provision roles), runs as restricted role
- [x] 0.5 `npm test` green on clean DB (no skipped DB suites)
- [x] 0.6 Apply migrations to dev DB; `/api/auth/login` works end-to-end (runtime check)
- [x] 0.7 Truth-ledger: mark stale docs (`docs/*` over-claims) with banner; PROJECT_LOG entry
**Exit:** `npm run typecheck && npm test && npm run build` all pass; zero skipped DB tests.

### Wave 1 — Core platform layer (the "strong core")  ·  STATUS: `PASS` except 1.1 runtime flip (see note)
- [~] 1.1 **DB roles & RLS enforcement** (C2, C10): migrator vs `crm_app` vs `crm_worker`; no passwords in migrations; provision script; RLS policies TO roles; `FORCE RLS` on tenant tables; runtime flips off superuser
- [x] 1.2 `platform/db`: `withTenant(ctx, fn)`, `withSystem(fn)`, read-only fast path (1 round-trip context set), statement/lock timeouts, pool metrics, retry-on-serialization
- [x] 1.3 `platform/config`: zod env schema, **fail-fast in production** (no defaults for secrets), secret redaction
- [x] 1.4 `platform/http`: error taxonomy (`AppError` → RFC 9457 problem+json), `asyncHandler`, `validate({params,query,body})`, uniform envelope, request-timeout, body-size limits, raw-body capture for signed webhooks
- [x] 1.5 `platform/authz`: central **permission matrix** (resource:action → roles + scope `own|team|all`), `requirePermission()`, policy unit tests (role × action table) — closes H2
- [x] 1.6 `platform/pagination` keyset helper; `platform/idempotency` (Idempotency-Key)
- [x] 1.7 `platform/events`: `domain_events` (bigserial cursor), `emit(tx, evt)`, NOTIFY on insert, consumer cursors — closes C9
- [x] 1.8 `platform/jobs`: lease-based queue (`SKIP LOCKED`, visibility timeout, jittered backoff, dead-letter, dedupe key) — closes C5/H5
- [x] 1.9 `platform/audit`: in-TX audit writer (actor, ip, correlation id, before/after)
- [x] 1.10 `platform/observability`: JSON logger w/ redaction, `/healthz` `/readyz` `/metrics` (RED + pool + queue + ws gauges)
- [x] 1.11 `platform/crypto`: AES-256-GCM field encryption w/ key-id rotation (integration credentials)
- [x] 1.12 Process split: `server/src/api.ts` + `server/src/worker.ts`, graceful drain
**Exit:** architecture tests prove (a) a query without tenant context returns 0 rows under `crm_app`; (b) cross-tenant read/write denied by RLS even if `WHERE tenant_id` is deliberately omitted; (c) permission matrix tests pass; (d) event is delivered exactly-once-per-consumer after crash/restart.

### Wave 2 — Identity & access  ·  STATUS: `PASS` (2026-10-14)
- [x] 2.1 Atomic token consumption (verify/reset), signup race, uniform responses, constant-time login (C8)
- [x] 2.2 Throttle by (ip,email) + global IP limit + progressive delay (no victim lock-out DoS)
- [x] 2.3 Single-query session validation (no cache by design: one indexed query per request beats a stale-revocation window); idle + absolute timeout. **Remaining:** session-token rotation on privilege change
- [x] 2.4 Session list/revoke, "sign out everywhere", device labels
- [x] 2.5 MFA (TOTP + recovery codes), step-up for sensitive actions **Remaining:** step-up re-auth for sensitive actions
- [x] 2.6 Invitations: accept flow (token+email bound), revoke, resend; role-change & deactivate with audit **Remaining:** resend-invitation endpoint (re-inviting currently replaces the old link)
- [x] 2.7 Explicit active-tenant switch (server-verified), WS bound to chosen tenant
- [x] 2.8 API keys (hashed, scoped, expiring, last-used, per-key rate limit) **Remaining:** per-key rate limiting (keys are authenticated, scoped, expiring and audited today)
- [x] 2.9 Real mail adapter (SMTP/provider) + mail jobs; dev uses Mailpit
**Exit:** negative-test suite (replay, race, enumeration timing, deactivated user, cross-tenant IDOR).

### Wave 3 — CRM domain (service + repo + tests per module)  ·  `IN PROGRESS (3.1–3.3, 3.5, 3.6 done incl. UI)`
Order: contacts → leads/pipeline → activities/notes/tasks → properties/projects/units → viewings/calendar → matching.
- [x] 3.1 Contacts — DONE 2026-10-14: CRUD, soft-delete/restore, E.164/e-mail normalisation, **race-safe dedupe** (`contact_identifiers` unique index; 8 parallel creates ⇒ 1 contact), merge + 30-day undo, consent grant/revoke with audit, ETag/If-Match (412), keyset list + search (trigram), intake `findOrCreateInTx` for lead capture; MUI page (list, drawer, form, merge, archive/undo, consent). 23 restricted-role tests; browser journey 0 problems (light/dark/mobile). Legacy `/api/contacts` + old page deleted; legacy lead creation now goes through the matcher.
- [x] 3.2 (backend, 2026-10-14) Leads — v1 API: list (keyset, 5 sorts, 12 filters), create (contact match, duplicate-open-lead guard, assignment modes creator/balanced/unassigned, explainable score, first-response SLA), update (ETag), stage move (matrix + required-field gates + loss reason + reopen), assign, archive/restore, bulk (200, per-item savepoints), tags, saved views, CSV export (formula-safe, audited), async CSV import (worker, exactly-once batches, row errors) — 29 integration tests + unit tests. **UI done 2026-10-14:** Leads list (URL-driven filters, saved views, bulk bar, CSV import/export dialogs), Lead 360 (timeline composer, rule-aware stage buttons, loss reason, score breakdown, edit). Original scope: CRUD, ownership scoping, assignment (manual / round-robin / rules), bulk actions, tags, saved views, scoring (configurable), SLA clocks, loss reasons, reopen, CSV import (async job, row errors, idempotent) / export (formula-injection safe)
- [x] 3.3 (backend, 2026-10-14) Pipelines — multi-pipeline CRUD, stage CRUD/reorder/archive-with-move, stage meaning (status + probability), transition matrix editor API, board + weighted forecast endpoints. **UI done 2026-10-14:** kanban board (drag & drop + keyboard menu, optimistic with snap-back, weighted forecast strip) and Settings → Pipelines (stage editor, reorder, remove-with-move, transition matrix + required details). Original scope: multi-pipeline CRUD, stage reorder, transition matrix editor, required-field gates, stage probabilities → **weighted forecast**
- [~] 3.4 (basic backend done: log/list note·call·email·meeting on a lead, first-response + engagement; **pending:** @mentions, attachments, partitioning) Activities timeline (partitioned), notes with @mentions, call/email/meeting logs, attachments (storage adapter local/S3, AV hook, MIME sniffing, size limits)
- [x] 3.5 Tasks + Notifications — DONE 2026-10-14: v1 API (CRUD, complete/reopen, snooze, bulk, summary, keyset list), reminders and overdue alerts through a narrow SECURITY DEFINER dispatcher (SKIP LOCKED, dedupe keys, exactly-once), DST-safe recurrence in the tenant zone, lead follow-up derived from open tasks, personal notifications + bell with realtime; MUI Tasks page (grouped by day, quick add, optimistic complete/undo), lead task panel. 27 tests + browser journey (0 problems, light/dark/mobile). Design: docs/WAVE3_DOMAIN_DESIGN.md §5.
- [x] 3.6 Inventory — DONE 2026-10-14: projects + properties (unit = property in a project), availability state machine with reversal reason, trigger-written append-only status and price history, secure file storage (storage adapter, magic-byte sniffing, AV hook, per-entity dedupe, hardened downloads), summary stats; MUI Properties (grid/table, URL filters, summary), Property detail (gallery, cover, status actions, history, archive/undo), Projects (availability bars, brochures). 24 tests + browser journey (0 problems, light/dark/mobile). Open: thumbnails, orphan-blob sweep, branches. Design: docs/WAVE3_DOMAIN_DESIGN.md §4, §6.
- [ ] 3.7 Viewings: exclusion-constraint for property+agent overlap (H10), reschedule/cancel/no-show, reminders (WhatsApp/email), calendar feed (ICS)
- [ ] 3.8 Property matching: explainable scoring (budget/locality/type/beds/availability), both directions (lead→properties, property→leads), saved search alerts
- [ ] 3.9 Custom fields: typed definitions + validation + indexed JSONB storage + UI rendering
**Exit per module:** API + RLS + permission tests + service tests + OpenAPI entries + realtime events.

### Wave 4 — Integrations, API platform & automation  ·  `IN PROGRESS (4.1, 4.2 done; live providers BLOCKED on credentials)`
- [x] 4.1 DONE 2026-10-14 — Per-tenant **inbound endpoints** `/hooks/{endpointId}` with secret; Meta (`X-Hub-Signature-256` on raw body + Graph lead retrieval), Google lead-form key, website form (public key + honeypot + rate-limit), generic JSON — durable receipt then 2xx (C3, C4). Built: Meta (signature on raw bytes, GET handshake, Graph lead retrieval with appsecret_proof), Google key, website form (origins, honeypot, per-visitor limit), generic signed JSON (replay window, field map); encrypted secrets shown once, rotate/replace; management API + UI (Lead sources: setup guides, Send test lead, delivery log, retry/ignore); 62 tests + browser journey. Live Meta/Google calls need credentials + a public HTTPS address. Design: docs/LEAD_INTAKE_AND_MONITORING_DESIGN.md
- [x] 4.2 DONE 2026-10-14 — Worker processors: tenant resolved **only** from endpoint mapping; dedupe by provider event id; contact match; attribution; quarantine unmapped (never guess) → outcomes created / duplicate / needs_review / failed with plain reasons, owner notification, provenance in leads.source_details
- [ ] 4.3 Outbound conversion feedback (Meta CAPI, Google enhanced conversions) with consent check, hashing, idempotency, circuit breaker (`BLOCKED` for live without credentials; fixtures)
- [ ] 4.4 **Public REST API `/api/v1`** + OpenAPI 3.1 (generated from zod) + docs UI + SDK snippets; Postman export
- [ ] 4.5 **Outbound webhooks** (subscriptions, HMAC-signed `t=,v1=`, retries w/ jitter, delivery log, replay, SSRF guard, secret rotation)
- [ ] 4.6 Automation engine on the event spine (triggers → conditions → actions, execution log, loop guard, dry-run)
- [ ] 4.7 Communications: email (templates, merge fields, tracking opt), WhatsApp Cloud API (templates, 24-h window, status webhooks), SMS adapter; consent & opt-out enforcement
- [ ] 4.8 Notifications: in-app + email digest + (later) web push, per-user preferences
**Exit:** sandbox/fixture tests for every provider; live provider E2E marked `BLOCKED` until credentials.

### Wave 5 — Analytics & operations  ·  `IN PROGRESS (5.3, 5.5 first versions done)`
- [ ] 5.1 Dashboard + reports on indexed aggregates / daily rollups (worker); funnel, source/campaign ROI, agent performance, SLA, pipeline velocity, forecast
- [ ] 5.2 Attribution (first/last/linear), no double counting
- [~] 5.3 (tenant Monitor DONE 2026-10-14: health checks with worker heartbeat, queue, intake, errors; activity log; legacy Operations Center and diagnostics pages removed; pending: platform-operator console, incidents lifecycle, safe replay) Operations Center rewritten on new telemetry (tenant vs platform separation — C7), incidents lifecycle, safe replay
- [ ] 5.4 Retention/archival/partition maintenance jobs; GDPR/DPDP subject export & erasure workflow
- [x] 5.5 DONE 2026-10-14 (explorer, filters, entry detail with before/after, CSV export; hash chain still optional) Audit explorer (immutability: DB privileges + hash chain optional)

### Wave 6 — Frontend rebuild on Material UI  ·  `IN PROGRESS (foundation done)`
Design system, tokens, fonts (see `docs/UI_DESIGN_SYSTEM.md`).
- [~] 6.1 Remove Tailwind, Supabase imports, stale realtime hooks — Supabase gone; new `useRealtime` (push hints → query invalidation) built; legacy `use-realtime-*` hooks + Tailwind remain until legacy pages are rebuilt
- [x] 6.2 MUI v9 theme (light+dark+system, CSS variables, no-flash bootstrap), tokens, Geist/Newsreader/Geist Mono self-hosted, reduced-motion — verified in browser (light, dark, mobile)
- [~] 6.3 App shell: collapsible permission-aware nav, workspace switcher, Cmd+K palette, responsive — done; global search (backend), notifications drawer, breadcrumbs pending
- [~] 6.4 Shared kit: PageHeader/Section/QueryBoundary/Empty/Error/Skeleton/Confirm/Toast/PasswordField/Avatar/RoleChip/RelativeTime/CopyButton/ErrorBoundary done; server-side DataGrid wrapper, saved views, bulk bar pending
- [~] 6.5 Pages rebuilt: Auth (sign in/up, verify, reset, invitation accept, MFA) · Profile/sessions/MFA · Team & invitations · API keys · Contacts · Leads (list + board) · Lead 360 · Pipeline settings — done. Remaining: Dashboard · Inventory · Matching · Tasks · Calendar · Reports · Attribution · Integrations · Automation · Custom fields · Webhooks · Operations
- [~] 6.6 Bundle budget: initial JS ≈ 245 kB gz (budget 250) with vendor split (react 181, mui 386, index 231, query 41 kB raw-ish per build report); LCP / Lighthouse not yet measured
- [ ] 6.7 Playwright E2E for critical flows; axe checks (ad-hoc journeys passed with 0 problems; not yet in repo)

### Wave 7 — 2026 differentiators (after core is solid)  ·  `NOT STARTED`
- [ ] 7.1 AI copilot behind an adapter (lead summary, next-best-action, email/WhatsApp drafts, call-note summarization, NL → filter) — PII redaction, per-tenant opt-in, audit; live calls `BLOCKED` until `ANTHROPIC_API_KEY` provided, fixtures for tests
- [ ] 7.2 Lead-quality prediction (explainable), duplicate-intent detection
- [ ] 7.3 Mobile PWA (install, offline read cache, push), click-to-call/WhatsApp
- [ ] 7.4 Document generation (offer/booking PDF), e-sign adapter
- [ ] 7.5 Portals integrations (99acres/MagicBricks/Housing — adapters, `BLOCKED` on partner access)

### Wave 8 — Subscription & billing (DEFERRED by owner)
See `docs/SUBSCRIPTION_DESIGN.md`. Only the **seam** is built now: `EntitlementService` interface (allow-all default) + `tenant_flags`-ready config. Nothing else.

### Wave 9 — Production readiness  ·  `NOT STARTED`
- [ ] 9.1 Dockerfiles (api, worker, web/nginx), compose for local+staging, healthchecks, non-root, read-only FS
- [ ] 9.2 CI: typecheck, lint, unit, integration on clean PG17, build, migration-from-empty + migration-upgrade test, `npm audit`, secret scan, Supabase-reintroduction guard, license check
- [ ] 9.3 Load tests (autocannon/k6) at T1/T2 volumes with query plans; index review; pool sizing
- [ ] 9.4 Backups (PITR/WAL-G or managed), encryption, **restore drill** with measured RPO/RTO
- [ ] 9.5 Runbooks + alert rules (SLO burn-rate), dashboards (Grafana JSON), on-call guide
- [ ] 9.6 Threat model review, pen-test checklist (OWASP ASVS L2 subset), dependency/SBOM
- [ ] 9.7 Docs: API reference, admin guide, integration guides, data dictionary

---

## 4. Failure-mode catalogue (what will go wrong, and the planned mitigation)
Full table in `docs/FAILURE_MODES.md`. Headlines:
- **Duplicate/reordered webhooks** → unique `(endpoint, provider_event_id)`, idempotent processors.
- **Worker crash mid-job** → lease timeout + `attempts` + idempotent side effects.
- **Poison message** → bounded retries → dead-letter + alert; never blocks the queue (`SKIP LOCKED`).
- **Hot tenant (noisy neighbor)** → per-tenant rate limit + concurrency cap + statement timeout.
- **Pool exhaustion** → bounded queue + 503/Retry-After; separate pools for API/worker/reports.
- **Lost realtime events** → cursor replay from `domain_events`; snapshot refetch on reconnect.
- **Cross-tenant bug in new query** → RLS returns nothing/denies; tests run under restricted role.
- **Migration failure in prod** → transactional DDL, expand→migrate→contract, lock_timeout, backup before.
- **Provider outage** → circuit breaker + backoff + visible degraded state; no data loss (outbox).
- **Clock skew / DST in viewings** → store UTC + IANA tz on tenant/user; interval via `tstzrange`.

## 5. Open risks / decisions needed from owner
| # | Item | Default if no answer |
|---|---|---|
| R1 | Hosting target (own VPS vs cloud)? affects backup/replica plan | Docker compose + managed-PG-compatible design |
| R2 | Email provider (SES/Resend/SMTP) | SMTP adapter; Mailpit in dev |
| R3 | WhatsApp BSP / Meta app credentials | `BLOCKED`, fixtures |
| R4 | AI provider key for Wave 7 | `BLOCKED`, fixtures |
| R5 | File storage (S3-compatible vs local disk) | adapter; local disk in dev |
| R6 | Currency/locale beyond INR | multi-currency fields, INR default |
| R7 | Data residency (India DPDP) | single region, documented |

## 6. Definition of done (every task)
Requirements stated → design noted → implemented in proper layer → authZ + tenant checks → validation → audit/event emitted → loading/empty/error states (UI) → tests incl. one negative/authorization path → typecheck+lint+tests+build run → PROJECT_LOG updated with command output → remaining gaps listed.

## 6.1 Audit gate (2026-10-14) — read before planning anything new

A read-only audit found that several legacy screens look finished but are not, and that legacy routers block a safe production deploy. **The authoritative status and the proposed order of work are in `docs/audit/2026-10-14/`** (`07_REMEDIATION_ROADMAP.md`: Slice 0 safety → Slice 1 one real automation → Slice 2 workspace settings/pipeline → …). Waves 3.7–3.9, 4.6 and the Wave 6 legacy pages are re-scoped there. Waiting on the user's decisions D1–D12 (first: commit the working tree to a branch; approve Slice 0). Dashboard percentages below are item counts and **do not** reflect the legacy pages' real status.

## 6.2 Remediation slices (approved 2026-10-14; order and acceptance in docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md)
| Slice | Status | Evidence |
|---|---|---|
| 0 Safety and truth | **DONE** 2026-10-14 (4 stated deviations, 6 open items) | docs/audit/2026-10-14/08_SLICE0_ACCEPTANCE.md |
| 1 First real automation (D9) | **DONE** 2026-10-14 (limits listed) | docs/audit/2026-10-14/09_SLICE1_ACCEPTANCE.md |
| 2 Workspace settings and pipeline (D4, D7) | **DONE** 2026-10-14 (2 items left out on purpose) | docs/audit/2026-10-14/10_SLICE2_ACCEPTANCE.md |
| 3 Daily work, viewing lifecycle and booking screen | **DONE** 2026-10-14 (6 limits listed) | docs/audit/2026-10-14/11_SLICE3_ACCEPTANCE.md |
| 4 Buyer interest, reservations, deal value (D3) | **DONE** 2026-10-14 (8 limits listed) | docs/audit/2026-10-14/12_SLICE4_ACCEPTANCE.md |
| 5 Attribution, spend, reports (D5, D8, D10) | **DONE** 2026-10-15 (6 limits listed) | docs/audit/2026-10-14/15_UI_UX_AND_ANALYTICS_ACCEPTANCE.md |
| 6 Outbound destinations connector | NEXT | |
| 7 Communications (needs provider accounts) | blocked | |
| 8 Operations and release readiness | not started | |
| 9 AI | not started | |

## 7. Progress dashboard (update after each work session)
| Wave | Status | % (items done / total) | Last update |
|---|---|---|---|
| 0 Stabilize | **PASS** | 7 / 7 | 2026-10-13 |
| 1 Core platform | **PASS** (1.1 partial) | 11 / 12 | 2026-10-14 |
| 2 Identity | **PASS** | 9 / 9 | 2026-10-14 |
| 3 CRM domain | IN PROGRESS | 5 / 9 (3.4 basic) | 2026-10-14 |
| 4 Integrations/API | IN PROGRESS | 2 / 8 | 2026-10-14 |
| 5 Analytics/Ops | IN PROGRESS | 1 / 5 (+5.3 partial) | 2026-10-14 |
| 6 Frontend (MUI) | IN PROGRESS | 1 done + 5 partial / 7 | 2026-10-14 |
| 7 Differentiators | NOT STARTED | 0 / 5 | 2026-10-13 |
| 8 Subscription | DEFERRED | — | 2026-10-13 |
| 9 Production | NOT STARTED | 0 / 7 | 2026-10-13 |

*Percentages are item counts, not effort-weighted.*
