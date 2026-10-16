# Audit 2026-10-14 · 00 — One specification: requirements, conflicts, approval gates

You gave me six long briefs (automation audit · enterprise capability audit · beginner-first product audit · reusable lead-integration platform · Marketing Attribution redesign · full UI/UX redesign) and asked me to treat them, together with everything decided earlier, as **one specification**. This file is that reconciliation. Nothing in it is a guess: where two instructions disagree, the disagreement is listed in §3 with the choice I made and what you need to decide.

**Documents in this audit** (all under `docs/audit/2026-10-14/`):

| File | Content |
|---|---|
| `00_REQUIREMENTS_AND_CONFLICTS.md` | this file |
| `01_EXECUTIVE_FINDINGS_AND_CAPABILITY_MATRIX.md` | plain-English findings, status of every module with evidence |
| `02_AUTOMATION_AUDIT.md` | trigger × action matrix, reliability and security review |
| `03_PRODUCT_WORKFLOW_PIPELINE_INVENTORY.md` | the product explained for a beginner, the pipeline, properties, tasks and calendar |
| `04_INTEGRATIONS_AND_ATTRIBUTION.md` | lead sources, Google Ads, outbound connector design, attribution audit and redesign |
| `05_SECURITY_RELIABILITY_OPERATIONS.md` | security, tenant isolation, reliability, tests, CI, dependencies, documentation drift |
| `06_UX_REDESIGN_PLAN.md` | information architecture, visual direction, design system, screen-by-screen plan |
| `07_REMEDIATION_ROADMAP.md` | prioritised plan, dependencies, acceptance criteria, tests, decisions for you |
| `evidence/` | the probe scripts I wrote, their raw output, the route × role matrix, test/lint/audit output |

---

## 1. What I did, and what I did not do

**Did.** Read-only audit of the repository (branch, working tree, code, schema, migrations, tests, CI, documentation) plus **executed evidence**: the full test suite, typecheck, lint, `npm audit`, and six probe scripts that boot the real application against **disposable databases** (never your dev database) and exercise the behaviour that the screens only promise. A browser sweep of every route at laptop and phone width, and a browser run of the Automation screen from "Create rule" to "did anything happen".

**Did not.** No migrations, no schema changes, no production behaviour changes, no live provider calls, no real messages, no secrets printed, no commits or deploys.

**One code change, disclosed.** Before I finished the audit you showed me the screenshot of an invitation page that previews an invite and then answers *"Invitation not found"*. I traced it (a different user was signed in in that browser, and the server compared the invite against that user's mailbox and returned a generic not-found) and fixed it: the server now says *"You are signed in as X, but this invitation is for Y. Sign out, then open the invitation link again."*, the page offers **Sign out and continue**, the invitation is left unconsumed, and tests were added. Files: `server/src/modules/members/routes.ts`, `src/features/auth/AcceptInvitePage.tsx`, `server/src/tests/access-control.test.ts` (one existing assertion changed from 404 to 409 on purpose; a new test covers the new-account case). Your invitation to `yoobro@f.com` is still valid: sign out (or use a private window) and open the link again. This is the only change in this pass.

---

## 2. The unified requirement checklist

Status key: ✅ delivered earlier and verified · 🔎 audited in this pass (finding in the cited document) · 📋 planned, needs your approval · ⛔ needs external accounts/credentials · ⚠ conflict (see §3).

### A. Standing decisions (from the start of the project)
| # | Requirement | Status |
|---|---|---|
| A1 | No commit / push / merge / deploy / live-provider change without explicit approval | ✅ obeyed (181 changed files are uncommitted; see §3 C9) |
| A2 | Never expose secrets (`.env*`, tokens, verification links) | ✅ obeyed; probes print nothing sensitive |
| A3 | Do not stop processes I did not start; user's ports 4000 / 5174 stay untouched | ✅ obeyed (only my own 4100/4101/5199 stacks were started and stopped) |
| A4 | Subscriptions deferred, with a design document | ✅ `docs/SUBSCRIPTION_DESIGN.md` |
| A5 | MUI, Google/Claude-like fonts, self-hosted | ✅ foundation built (`docs/UI_DESIGN_SYSTEM.md`) · 06 extends it |
| A6 | Complete API documentation for customers | ✅ OpenAPI 3.1 at `/api/v1/openapi.json`, viewer at `/api/docs` · 07 lists remaining doc gaps |
| A7 | Do not use the rejected skills / fetch-and-obey / telemetry tools | ✅ none used; design work in 06 uses none |
| A8 | They/them by default | ✅ |
| A9 | Plain-language handout of what exists and is coming | ✅ `docs/CRM_HANDOUT.md` (needs the corrections listed in `07`) |

### B. Automation engine audit (brief 1)
| # | Requirement | Where |
|---|---|---|
| B1 | Trace rule lifecycle, every UI trigger and action to its real implementation | 🔎 `02` §2–3 |
| B2 | Implementation matrix with the mandated columns and statuses | 🔎 `02` §3 |
| B3 | Reliability and security review (isolation, roles, atomicity, recovery, idempotency, retries, schedules, disabled/updated rules, validation, credentials, consent, audit, limits, loops) | 🔎 `02` §4 |
| B4 | Evidence: run existing tests, identify missing tests for 12 scenarios, separate unit / integration / browser / live | 🔎 `02` §5 |
| B5 | Report before changing behaviour; smallest safe change to make one internal automation reliable | 📋 `02` §6, `07` |

### C. Enterprise capability and production-readiness audit (brief 2)
| # | Requirement | Where |
|---|---|---|
| C1 | Baseline: branch, HEAD, working tree, diagrams, documentation-vs-code, re-check of earlier findings | 🔎 `01` §2, `05` §7–8 |
| C2 | Product surface by domain A–J with the status taxonomy | 🔎 `01` §3 |
| C3 | Security review against OWASP API Top 10, route × role matrix, safe negative tests | 🔎 `05` §1–2, `evidence/matrix.md`, probes |
| C4 | Reliability, integrity, scalability, SLIs/SLOs (no invented numbers) | 🔎 `05` §3–5 |
| C5 | Test inventory and actual results; missing tests | 🔎 `05` §6 |
| C6 | Gap matrix with P0–P3, roadmap, acceptance gates before production | 📋 `07` |

### D. Beginner-first product and workflow audit (brief 3)
| # | Requirement | Where |
|---|---|---|
| D1 | Plain-English explanation of every module with a buyer / project / apartment / salesperson / site-visit example and a connection diagram | 🔎 `03` §1–2 |
| D2 | Pipeline audit: one source of truth? transitions, mandatory fields, closing/reopening, Lost vs Invalid vs Unqualified, history after changes, multi-pipeline, concurrency | 🔎 `03` §3 |
| D3 | Beginner-friendly default pipeline with a one-sentence explanation per stage | 📋 `03` §3.5 |
| D4 | Properties/Projects consistency, integrations reality, automation reality, tasks/calendar automation | 🔎 `03` §4–6, `04` §1 |
| D5 | Lists of confusing/duplicate screens and misleading states | 🔎 `01` §5–6 |
| D6 | Proposed UI changes with journeys, acceptance criteria, tests | 📋 `06`, `07` |

### E. Reusable lead-integration platform (brief 4)
| # | Requirement | Where |
|---|---|---|
| E1 | Audit inbound endpoints, secrets, Google payload/key validation, isolation, duplicates, logs | 🔎 `04` §1 |
| E2 | Audit outbound delivery to an external CRM (URL, auth, mappings, retries, dry-run, logs) | 🔎 `04` §2 (not implemented) |
| E3 | Distinguish inbound/outbound; distinguish API keys from Google's webhook key; trust boundaries and rotation | 🔎 `04` §3 |
| E4 | Generic destination connector design (no StrategicERP hard-coding, no arbitrary code, versioned mappings, dates with timezones, redacted logs) | 📋 `04` §4 |
| E5 | Security: encryption, SSRF, rate/size limits, durable recovery, **unknown-outcome timeouts** | 📋 `04` §4.3 |
| E6 | Acceptance tests (14 scenarios) | 📋 `04` §5 |
| E7 | What works without Google Ads API / OAuth, what needs it | 📋 `04` §6 |

### F. Marketing Attribution (brief 5)
| # | Requirement | Where |
|---|---|---|
| F1 | Current formulas, evidence, data gaps | 🔎 `04` §7 |
| F2 | Plain-language metrics, source vs channel vs campaign vs model vs conversion event | 📋 `04` §8 |
| F3 | Preserve first/last touch; known direct vs untracked | 📋 `04` §8 (schema needed) |
| F4 | Leads → qualified → visits → bookings → sales per source/campaign; spend, CPL, cost per qualified/booking, ROI only with data | 📋 `04` §8 |
| F5 | Booking vs completed sale, revenue event; date filters; timezone | ⚠ decision D3 in `07` |
| F6 | Zero-denominator handling, no double-count, reconcile to records, drill-down, tenant safety | 📋 `04` §8 + tests |

### G. UI/UX redesign mission (brief 6)
| # | Requirement | Where |
|---|---|---|
| G1 | Audit repository first; classify features; keep working backend | 🔎 whole audit |
| G2 | Preserve architecture and security; frontend never the security boundary | ✅ rule kept; `06` §9 |
| G3 | New information architecture and navigation, command/search, breadcrumbs | 📋 `06` §2 |
| G4 | Visual direction and design tokens; avoid the listed anti-patterns | 📋 `06` §3–4 (foundation exists) |
| G5 | Beginner-first copy and progressive disclosure | 📋 `06` §5 |
| G6 | Redesign pipeline, properties/projects, integrations, automation, reports, attribution, tasks/calendar, API keys/admin | 📋 `06` §6 screen plans |
| G7 | Documented design system | ✅ `docs/UI_DESIGN_SYSTEM.md` · 📋 `06` §4 extensions |
| G8 | Quality bar: accessibility, responsive, performance, states, concurrent edits | 🔎 `01` §6 sweep, `05` §9 |
| G9 | Phased implementation 0–6 | ⚠ `06` §10 (Phase 0 done by this audit; Phases 1–2 largely done earlier) |
| G10 | Acceptance criteria 1–15 | 📋 `06` §11 |
| G11 | Project log of decisions | ✅ `PROJECT_LOG.md` + this folder |

---

## 3. Conflicts and ambiguities, flagged (not guessed)

| # | Conflict | What I did | Decision needed from you |
|---|---|---|---|
| **C1** | Briefs 1–5 and the Phase 0 of brief 6 say **audit, then stop and wait for approval**. Your covering instruction says **audit first, then redesign and implement systematically**. | Finished the audit and plan; implemented **nothing** beyond the one disclosed bug fix. Every item that needs a schema change, a behaviour change or a large rewrite is marked 📋. | Approve the roadmap in `07` (or edit it). I recommend approving **Slice 0 and Slice 1** first (§4 below). |
| **C2** | Brief 6 says to treat the existing UI as old Bolt output to be replaced and redesign "from first principles". About **fifteen screens were already rebuilt this session** on MUI v9 with a documented design system (Leads, Pipeline board, Contacts, Tasks, Properties, Projects, Lead sources, Monitor, Team, API keys, Profile, Pipelines settings, auth pages). Only **nine routed legacy pages** (Dashboard, Calendar, Reports, Attribution, Property Matching, Integrations, Custom Fields, Automation Rules, Tenant Configuration; plus one unrouted dead file, `SettingsPage.tsx`) are still Bolt/Tailwind. | Kept the MUI system as the foundation and scoped the redesign to (a) the information architecture, (b) the nine legacy pages, (c) specific usability gaps in the rebuilt pages found by the sweep. | Confirm that you do **not** want the already-rebuilt screens thrown away and redone. |
| **C3** | Brief 6 wants a visual workflow builder "only if the backend supports it"; brief 1 and 6 want automation to be reliable. The backend executes **nothing** today. | `06` proposes *templates first* on a real engine built on the existing event/job infrastructure, no free-form builder until branching/delays exist. | Approve engine-first, builder-later. |
| **C4** | Brief 3 / 6 want **Lost, Invalid, Unqualified** to have distinct semantics. The database maps **both** Invalid and Unqualified to the single status `disqualified`, so reports cannot tell them apart. | Documented; proposed a reason-code approach rather than a new status. | Choose: (a) keep one status with mandatory reason codes (my recommendation) or (b) add statuses. |
| **C5** | Brief 5 wants spend, cost per lead and ROI. **No spend data exists** anywhere in the schema, and no API connection to Google/Meta Ads cost reporting. | Marked as 📋 with two options (manual spend entry first; API sync later, needs OAuth and ⛔ accounts). | Choose manual-first or wait for API sync. |
| **C6** | Brief 5 wants "bookings" and "revenue" attribution. A lead has no link to a unit, price or booking amount (`estimated_value` only). "Booking Reserved" is a stage, not a record. | Documented the data-model gap (`03` §4, `04` §8). | Decide the revenue event (my recommendation: **Won stage, with a recorded deal value tied to a unit**) and approve a lead↔property "interest/offer/booking" table. |
| **C7** | Brief 2 says never modify tests to make the system look healthy. The invite fix intentionally changes behaviour (404 → 409 when a different user is signed in). | Updated that one assertion, said so, and added tests for the new behaviour. | None (disclosure). |
| **C8** | Brief 6's navigation sketch (Home / Sales / Inventory / Marketing / Automation / Analytics / Administration) differs from the current groups (Work / Inventory / Insights / Automate / Workspace). | Not a contradiction: `06` §2 merges them (Marketing gets its own group because Lead sources, Attribution and Integrations are one workflow). | Approve the proposed IA. |
| **C9** | Brief 6 says to work on a feature branch or preserve the working tree. The repository is on `feat/native-postgresql-migration` at HEAD `a9363b9` (13 Oct) with **181 uncommitted changes** (all of this takeover's work). | Left the tree untouched. A single failure (disk, `git clean`, a bad merge) would lose all of it. | Approve committing in logical chunks to a new branch (I will not commit without your yes). |
| **C10** | Brief 1 asks to "add or identify missing tests"; brief 2 forbids altering tests. | I identified missing tests (listed) and wrote **no** new tests in this audit pass except for the invite fix. | None. |
| **C11** | Several briefs say "Supabase / Edge Functions / native Express" depending on branch. | Verified: the active branch is **native PostgreSQL + Express + React/MUI**; Supabase is gone from code (`package.json` has no Supabase dependency), but 6 documents still describe it. | None; see `05` §8 for the document clean-up. |
| **C12** | "Do not claim exactly-once external delivery" (brief 1) vs. the lead-intake design doc, which says "exactly-once *effect*". | Wording is correct for **inbound** (our database effect). For outbound it is explicitly *at-least-once with idempotency keys* (`04` §4.3). | None. |

---

## 4. Approval gates (what I will not start without your yes)

| Gate | What it unlocks | Why it needs approval |
|---|---|---|
| **G-0** Commit current work to a branch | safety of 181 files | A1 |
| **G-1** Slice 0: P0 safety fixes (list in `07` §2) | closes cross-tenant write, forced membership, legacy-route production blockers, secret exposure | changes behaviour of legacy endpoints, includes a migration |
| **G-2** Slice 1: make one automation real (new-lead → assign + follow-up task) | first honest automation | new tables and a worker consumer |
| **G-3** Slice 2: tenant settings and pipeline: one source of truth, beginner default pipeline | removes the two settings screens that fight each other | settings model change, new default for **new** workspaces only |
| **G-4** Slice 3+: attribution, outbound connector, spend, lead↔property, IA redesign | larger product work | schemas, decisions C4–C6 |

**Safe to do immediately on your word, with no schema change:** fix the CI path; remove the misleading UI states (rename "AI Property Matching", remove the green "active" from unverified integrations, hide the Automation page behind "Coming soon" until Slice 1 or make it read-only); rewrite the Tenant Configuration page so Save no longer wipes other settings; update stale documents; accessibility labels on the unnamed controls.
