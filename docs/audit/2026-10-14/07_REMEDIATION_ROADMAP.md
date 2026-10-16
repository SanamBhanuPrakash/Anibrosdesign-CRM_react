# Audit 2026-10-14 · 07 — Prioritised remediation plan, decisions and approval gates

Nothing here has been started. Each slice ends with working, tested software, so you can stop after any slice and have something coherent. Effort is relative (S ≈ a day or two of focused work, M ≈ a week, L ≈ two weeks or more) and is an estimate, not a measurement.

## 1. The ten highest-risk findings (by severity, then blast radius)

| # | Finding | Sev | Document |
|---|---|---|---|
| 1 | Nine legacy pages / eight routers only work with the all-powerful DB login; production refuses that login, so **the product cannot be deployed safely** | P1 blocker | `05` S-9 |
| 2 | Cross-tenant reference (and, with the privileged role, deletion) in custom-field values | **P0** | `05` S-1 |
| 3 | No backups, no tested restore, no deployment packaging | **P0 for production** | `05` §2 |
| 4 | Legacy invite force-adds registered people to a workspace, leaks account existence, no audit | P1 | `05` S-2 |
| 5 | Automation, Integrations and Tenant Configuration look finished but do nothing / wipe settings | P1 (trust, data loss) | `01`, `02`, `03` |
| 6 | Viewings: no role check, buyer PII to every role, foreign agent id disclosed, archived records bookable | P1 | `05` S-5 |
| 7 | Reports/attribution do not reconcile (archived and test leads, invented campaigns, zeros under the production role, one report fails) | P1 | `04` §7, `01` |
| 8 | Integration config returns secrets in clear; `hasCredentials` is hard-coded | P1 | `05` S-4 |
| 9 | CI cannot run on a clean checkout; no browser tests; production advisory in `nodemailer` | P2 | `05` §4–5 |
| 10 | No lead↔unit record, so "Booking" and revenue cannot be defined or reported | P1 (product) | `03` §4 |

## 2. Slices

### Slice 0 — Safety and truth (P0/P1; no new features) · size M · **needs approval G-1**
| Step | Action | Files / DB objects | Acceptance | Tests |
|---|---|---|---|---|
| 0.1 | **Commit the current work** to a new branch in logical chunks (G-0) | whole tree | `git status` clean; branch pushed only on your word | — |
| 0.2 | Remove legacy `invite` and `revoke` and the legacy members list; point the one legacy test at v1 | `server/src/routes/tenant.ts` (members section), `api-crm-workflow.test.ts` | endpoints return 404; v1 flows unchanged | existing `access-control` + updated test |
| 0.3 | Fix custom-field values: migration 021 adds composite FK `(field_id, tenant_id)` on `custom_field_values` (after a check/cleanup query that **reports** cross-tenant rows first), `PUT` validates entity ownership and field ownership, delete gets the tenant predicate, **type/regex/required/options validation** | `custom_field_values`, `routes/custom-fields.ts` (port to a service), migration 021 | cross-workspace link/delete impossible under **both** DB roles; invalid values refused | new cross-tenant + validation tests (the probe becomes a test) |
| 0.4 | Viewings: permission checks (`viewings:*` + scope), agent must be an active member, property and lead must be live, status policy per decision D6; replace `app.schedule_viewing` (new migration, not an edit) | `routes/viewings.ts` → service, migration 021/022 | auditor/exec refused; foreign agent refused; archived refused; agents see own viewings | tests incl. 6-way race |
| 0.5 | Remove the legacy Integrations router and page (redirect to Lead sources); remove `/api/automation` router (Slice 1 replaces it) | `routes/integrations.ts`, `routes/automation.ts`, `IntegrationsPage.tsx` | no endpoint stores or returns secrets in clear | routes 404 test |
| 0.6 | **Port the remaining legacy reads/writes to `db.withTenant/readTenant`** (dashboard, reports, properties match, tenant config, health): a mechanical swap that makes them correct under the restricted role; exclude archived and test leads; fix the pipeline-velocity query; scope the dashboard by `leadVisibility`; remove `auditor` from business reports | `routes/dashboard.ts`, `reports.ts`, `properties.ts`, `tenant.ts` | **the same responses under the restricted and privileged roles**; dashboard numbers equal the lead list for the same filters | the audit probes converted to a permanent *"legacy endpoints under the restricted role"* test + reconciliation test |
| 0.7 | **Workspace settings stop destroying data:** Tenant Configuration saves only the fields it owns (merge), timezone writes the **column**, the stage no-op controls are removed, the page is hidden until Slice 2 replaces it | `TenantConfigPage.tsx`, `routes/tenant.ts` | saving branding never removes `leadAssignment`, `sla`, `scoring`, `defaultCountry`; timezone affects reminders | test: save then assert other keys intact |
| 0.8 | Honesty in the UI (no schema): *AI Property Matching* → *Property matching*; matching excludes archived; Automation page read-only "coming soon"; Attribution drops invented campaign names and shows only real sources until Slice 5 | pages | no feature claims more than it does | browser sweep |
| 0.9 | CI: fix the working directory, drop the `subscription_plans` check, Node 24, make high/critical **production** advisories blocking, pin actions | `.github/workflows/ci.yml` | green on a clean checkout | CI run |
| 0.10 | Upgrade `nodemailer` (major), re-run the mail tests | `package.json`, `platform/mail` | `npm audit --omit=dev` clean | `identity`, `monitor` suites |
| 0.11 | Documents: `README.md`, runbook fixed, stale documents moved to `archive/`, ADRs for the main decisions | docs | a new developer can run the project from the README | — |

Dependencies: 0.1 first; 0.6 before Slice 1.

### Slice 1 — One real automation (P1) · size S–M · needs G-2
Exactly as `02` §6 (new lead → assign → follow-up task → notify; migration, consumer, job handler, v1 routes, template UI, execution history, 8 tests + browser journey). **Acceptance:** replay/restart/two workers produce no duplicates; pause stops it; cross-workspace isolation; visible in the UI and audit.

### Slice 2 — Workspace settings and the pipeline (P1) · size M · needs G-3 and decisions D4, D7
Typed **Workspace settings** (one page; assignment rule, first-reply minutes, scoring weights, default country, timezone, currency, branding) with ETag; **beginner default pipeline** for **new** workspaces only (`03` §3.5), "Reset to recommended transitions" for existing ones (explicit, audited); fix the *Nurture* dead end for existing workspaces via an additive migration; **Basic/Advanced** pipeline settings; **reason codes** for *Not a fit* / *Lost*; `lead_stage_history` snapshots (stage name, probability) so renames and probability changes stop rewriting history; retire Tenant Configuration and the dead `SettingsPage`. **Acceptance:** one writer of `tenants.settings`; rename a stage → historical report unchanged; default pipeline walkthrough completes without a refused move. **Tests:** settings merge, rename-history, transition-matrix tests, default-pipeline journey.

### Slice 3 — Daily work (P1) · size M–L
**Viewing lifecycle** (reschedule, cancel, complete, no-show, outcome note, ICS export, reminders as real tasks/notifications, events), **Tasks & calendar** merged page, **Home** (My day, Get started), **Next step** banner on leads, **global search** (leads, contacts, properties, tasks; permission-filtered). **Acceptance:** completing a visit offers the stage move and creates the follow-up; calendar items are persisted records; searching returns only permitted records. **Tests:** lifecycle integration, DST, search permission/cross-tenant, browser.

### Slice 4 — Buyer interest, reservations and deal value (P1, product) · size L · needs D3
New `lead_properties` (interest/shortlist), `offers`/`reservations` (token amount, agreed price, status, who, when), `deal_value` on won leads tied to a unit; **no double reservation** (partial unique index), state transitions drive unit status and lead stage; Matching saves shortlists. **Acceptance:** two simultaneous reservations: one wins; Won requires a recorded deal value; the unit shows who holds it. **Tests:** concurrency, state machine, permissions, reconciliation with reports.

### Slice 5 — Attribution, Reports, spend (P2) · size M–L · needs D5, D8
First/last-touch stamping at lead creation (use the existing `marketing_attribution` table), manual spend entry and CSV import, channel mapping, v1 attribution and report endpoints with date ranges and the workspace timezone, the pages in `04` §8 and `06` §6.9. **Acceptance and tests:** `04` §8.5–8.6.

### Slice 6 — Destinations: outbound connector (P2) · size L · prerequisites: Slice 0, SSRF module
`04` §4: tables, mapping language, dry run, test connection, deliveries with `unknown_outcome`, retries, circuit breaker, health, UI; StrategicERP as a *template*. **Acceptance and tests:** `04` §5 (14 scenarios).

### Slice 7 — Communications (P2) · size L · ⛔ needs provider accounts
Email (templates, merge fields, bounces, unsubscribe), WhatsApp (templates, 24-hour window, status webhooks), consent and quiet-hours enforcement, inbound replies on the timeline, duplicate-send prevention (idempotency/`sent_unknown`), then expose *Send email/WhatsApp* actions in automation. Not started until accounts exist; sandbox first.

### Slice 8 — Operations and release readiness (P0 for production) · size M–L
Backups with PITR or scheduled dumps, **a performed and timed restore drill**, RPO/RTO; Dockerfiles and deployment manifests; secrets manager; TLS/HSTS; alert rules (SLO burn, worker heartbeat, queue age, dead letters, delivery failures, disk); log shipping; OpenTelemetry tracing; **load test** at the stated workload; **Playwright suite + axe in CI**; remove Tailwind and the legacy components; `npm audit` gate. **Acceptance:** `05` §9.

### Slice 9 — AI (P3) · only after Slices 3, 4, 5 and an evaluation set
Concrete workflows with measurable value: lead summary from the timeline, suggested next step with its evidence, reply drafts **with human approval**, question-answering over permitted records. Requires: tenant-scoped retrieval, prompt-injection handling for imported text and e-mails, structured tool calls with schema validation and permission checks, audit of every tool call, provider abstraction with timeouts/budgets, regression evaluation set. Not started; no "AI" labels until real.

## 3. Prioritised list (P0–P3) with exact objects

| Pri | Items (ID → files / objects) |
|---|---|
| **P0** | S-1 → `custom_field_values`, `routes/custom-fields.ts` · backups/restore → none exist · production role compatibility (S-9) → `routes/{dashboard,reports,viewings,custom-fields,integrations,automation,properties}.ts`, `middleware/auth-guard.ts` |
| **P1** | S-2, S-3, S-7 → `routes/tenant.ts` · S-4 → `routes/integrations.ts` · S-5 → `routes/viewings.ts`, `app.schedule_viewing` · S-6, S-8 → `routes/tenant.ts`, `routes/dashboard.ts`, `TenantConfigPage.tsx` · automation/integration blobs (UI only) → `AutomationRulesPage.tsx`, `IntegrationsPage.tsx` · reconciliation defects → `routes/dashboard.ts`, `reports.ts` · lead↔unit missing → schema · viewing lifecycle missing → `routes/viewings.ts` |
| **P2** | engine, destinations, attribution, spend, communications, CI (`ci.yml`), `nodemailer`, per-key rate limits, step-up auth, AV engine, unbounded legacy lists, `Dockerfile`s, alerting, tracing |
| **P3** | AI features, visual-builder, multi-pipeline lead move, company entity, branches, SMS, advanced forecasting |

## 4. Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| **D1** | Commit the working tree to a new branch in logical chunks now? | **Yes.** 181 uncommitted paths are one disk failure from loss |
| **D2** | Approve Slice 0 (it removes legacy endpoints, i.e. a breaking change for anyone calling them: members invite/revoke/list, integrations, automation) | Yes. No customer-facing screen uses them; the API docs list v1 only |
| **D3** | Revenue event | **Won**, with a recorded deal value tied to a unit; *Booked* is reported as a separate milestone |
| **D4** | Invalid vs Unqualified | one outcome **Not a fit** with reason codes, replacing both for new workspaces (existing data keeps both; reports group them) |
| **D5** | Spend data | manual entry/CSV first; API sync later (needs OAuth and accounts) |
| **D6** | May a viewing be booked for a unit that is *under offer*? | **Yes for under offer**, no for reserved/sold/rented/inactive/archived |
| **D7** | New default pipeline | **new workspaces only**; offer an explicit "apply recommended pipeline" action for existing ones |
| **D8** | Test leads in reports | **excluded by default**, with a visible "include test leads" switch |
| **D9** | Engine first, builder later (conflict C3) | Yes |
| **D10** | Chart library | MUI X Charts (same family, no new design language) |
| **D11** | `nodemailer` major upgrade | Yes, in Slice 0 |
| **D12** | Keep the already rebuilt MUI screens (conflict C2) | Yes |

## 5. Safe to start immediately on your word, without a schema change
CI path fix and action pinning · `README.md` and runbook fixes · accessibility names for unlabeled controls and the Automation dialog role · the honesty fixes in Slice 0.8 · the Tenant Configuration merge fix (0.7) · removal of the dead `SettingsPage.tsx` · converting my probe scripts into permanent tests (they only add tests).

## 6. The five most valuable next actions, and the evidence needed to approve each

| # | Action | What I need from you | What I will show when done |
|---|---|---|---|
| 1 | **Commit and branch** (D1) | a yes, and the branch name you want | clean tree, commit list, tests green on the branch |
| 2 | **Slice 0 safety** (D2, D6, D8, D11) | yes/no on each decision | restricted-role test of every legacy endpoint passing; cross-tenant custom-field test; zero secrets in API output; CI green; `npm audit --omit=dev` clean |
| 3 | **Slice 1: one real automation** (D9) | confirm the target automation (new lead → assign → task → notify) or name another | browser run: create lead (manual, CSV, Meta/Google/website test) → one execution each with three effects; restart/two-worker/duplicate tests |
| 4 | **Slice 2: workspace settings and the beginner pipeline** (D4, D7) | choose D4 and D7 | one settings page; default-pipeline walkthrough with no refused move; rename-history test |
| 5 | **Slice 8a: backups, restore drill, Dockerfiles, alert rules** | where production will run (provider, region) | a timed restore of a real backup into a clean database; images that start; alert rules firing in a drill |

Everything beyond these five (Slices 3–7, 9) can be reprioritised after you see Slices 1–2 working.
