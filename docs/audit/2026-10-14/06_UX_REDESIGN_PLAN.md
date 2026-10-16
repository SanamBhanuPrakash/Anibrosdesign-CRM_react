# Audit 2026-10-14 · 06 — Information architecture, visual direction, design system and screen plan

Scope decision (conflict C2, `00` §3): the MUI v9 design system documented in `docs/UI_DESIGN_SYSTEM.md` is **kept as the foundation**; this plan redesigns the **information architecture**, the **nine legacy pages**, and specific usability gaps found in the already rebuilt screens. It does not propose re-skinning screens that already meet the bar.

## 1. What is wrong today (evidence)

* **Navigation is organised by software modules, not by jobs.** Groups are *Work · Inventory · Insights · Automate · Workspace*; *Integrations* and *Lead sources* sit under "Automate" although they are marketing capture; *Monitor* sits under "Workspace"; *Pipelines* (configuration) is next to *Team*.
* **Two design languages** coexist: nine legacy pages (Tailwind, lucide icons, `src/components/ui/*`) and the MUI system everywhere else. Legacy pages differ in heading size, density, empty states, error handling (console-only errors) and accessibility (no dialog role, unlabeled inputs, 1–13 unnamed controls per page).
* **Four overlapping "settings"** (Settings, Tenant Configuration, Workspace settings, Workspace group) and two screens that fight over the pipeline.
* **Misleading states** (`01` §5): green "active", rules that never run, charts with invented labels.
* **No guided start.** A new workspace lands on a legacy dashboard of zeros; nothing says "add a project, connect a source, invite your team".
* **Global search finds pages only**, not leads, contacts or properties.
* **Observations on the rebuilt screens** (from screenshots and the sweep): page titles at 36 px serif consume vertical space on dense list pages; filter rows wrap leaving a single orphaned control (Properties at 1440 px); several icon-only controls have no accessible name (Leads 4, Properties 5, Pipelines 13); **no automated accessibility test or in-repo browser test exists**, although `UI_DESIGN_SYSTEM.md` §8 names axe and Lighthouse ≥ 95 as gates (not met or measured).

## 2. Proposed information architecture

Principle: *the sidebar answers "what am I here to do?"*. Everyday work first, setup and administration last and visually quieter. Role-aware (items disappear for roles without the permission; the server still enforces).

```
HOME            Overview (Home)                         ← replaces Dashboard; personal "My day" + guided setup
SALES           Leads · Pipeline (board) · Contacts · Tasks & calendar ("My day" is its default tab)
INVENTORY       Properties · Projects · Buyer interest (shortlists, offers, reservations) · Matching
MARKETING       Lead sources · Destinations (outbound) · Attribution
AUTOMATION      Automations (templates) · Execution history
ANALYTICS       Reports (business) · Team performance · Forecast
────────────────  (quieter section)
ADMINISTRATION  Team & roles · Pipeline settings (Basic / Advanced) · Custom fields · Workspace settings (ONE page) · API keys · Audit trail · Monitor
```

| Change | Why |
|---|---|
| **Marketing becomes its own group** (Lead sources, Destinations, Attribution; the legacy *Integrations* page disappears) | one workflow: capture → send onward → measure |
| **Tasks and Calendar merge into one destination** ("Tasks & calendar": list, today, week; viewings and tasks together) | a salesperson plans a day, not two modules |
| **Reports** (what is the *business* doing) and **Attribution** (what is *marketing* doing) stay separate, in different groups | brief 5 and 6 |
| **Pipeline** (board, daily) vs **Pipeline settings** (configuration, Administration) | everyday vs admin |
| **One Workspace settings page** with tabs *General · Time zone & currency · Lead handling (assignment rule, first-reply minutes) · Branding* backed by a typed settings model; Tenant Configuration and SettingsPage retire | fixes S-6 and the timezone defect |
| **Monitor and Audit trail** live in Administration, with an alert badge on the nav when health needs attention | already built |
| **Buyer interest** (new) | the missing lead↔unit relationship; hidden until the schema exists |
| **Global search** (⌘K) searches leads, contacts, properties, projects, tasks with `search:use`, permission-filtered, ≤ 5 per type (design already in `ARCHITECTURE_V2` §3.4) | brief 5 |
| **Breadcrumbs** only on detail pages (Lead, Property, Source); list pages rely on the nav highlight | no clutter |

Route mapping (old → new): `/dashboard`→`/` (Home) · `/leads`, `/leads?view=board` unchanged · `/calendar` → `/tasks?view=calendar` · `/integrations` → `/marketing/sources` · `/integrations/lead-sources` → `/marketing/sources` · `/attribution` → `/marketing/attribution` · `/settings/tenant`, `/settings/*` → `/admin/*` · `/operations` → `/admin/monitor`. Redirects keep old links working.

## 3. Visual direction (refine, do not replace)

Keep: warm paper neutrals, one deep green-teal accent, Geist (UI), Newsreader (display), Geist Mono (ids), muted semantic colours, light/dark/system, 8 px spacing, calm 150 ms transitions, `prefers-reduced-motion`.

Refine:
1. **Heading scale by page type.** Landing/overview pages 32 px serif; **list and settings pages 24 px**; detail pages use the record name at 28 px. Reclaims about 24 px of vertical space on the pages used all day.
2. **Density control** for tables (comfortable / compact, remembered per user) — rows ≥ 40 px comfortable, 32 px compact.
3. **Filter bars** collapse to a single row with a "More filters" popover instead of wrapping.
4. **Cards only where elevation means something** (a draggable pipeline card, a source with its own controls); everything else is flat sections with hairlines.
5. **Status vocabulary** (one component, one mapping): *Working · Waiting · Needs attention · Failed · Paused · Not verified*. Colour is never the only signal (icon + text).
6. **Charts** (MUI X Charts — same family as MUI, no second chart library): always titled with the question they answer, labelled axes/units, a definition tooltip, a table view toggle, and a "no data" state that says why. No decorative charts, no gradients, no fake sparklines.
7. **Copy:** sentence case, concrete verbs, one idea per sentence; every empty state says *what this is, why it is empty, the one next action*.
8. **Avoid** (explicit list from the brief): giant headings, nested bordered containers, badge noise, decorative icons, unexplained numbers, modals for multi-step work (use a full page or side panel with a stepper for source setup, mapping editor, and rule creation).

## 4. Design-system extensions (build once, reuse everywhere)

| Component | Purpose / contract |
|---|---|
| `DataTable` | keyset infinite loading, sticky header, column visibility, sort, row actions menu, selection + bulk bar, density, saved views, keyboard row navigation, URL-synced state, empty/error/loading built in (replaces the three hand-rolled tables) |
| `FilterBar` | chips + "More filters"; clear all; URL-driven |
| `MetricCard` | number, label, **definition tooltip with formula**, optional drill-down link, "—" for undefined (never `0%`, never `NaN`) |
| `StatusPill` | the status vocabulary above |
| `ConnectionStatus` | *Not verified / Verified (time) / Failing (reason) / Paused* with the last successful delivery |
| `HelpTip` | accessible tooltip + "Learn more" drawer content |
| `SetupChecklist` | the guided start on Home (add a project, add units, connect a source, invite the team, send a test lead) with per-item completion detected from data, dismissible |
| `FormSection` | titled group with description, two-column on wide screens, progressive disclosure for advanced fields |
| `UnsavedChangesGuard` | route/blur protection for forms |
| `CodeBlock` | copyable, labelled, scrollable with focus |
| `DrillLink` | consistent "see the 12 leads behind this number" |
| `ConfirmTyped` | for irreversible actions (type the name) |

All accessible by construction: labelled controls, `role`/`aria-*`, visible focus, keyboard-complete, announced status changes; documented in `UI_DESIGN_SYSTEM.md` v3.

## 5. Making it understandable to a first-time user

* **Home → "Get started" checklist** appears until the five setup items are done: *Check your pipeline (default is ready) · Add your first project and units · Connect a lead source and send a test · Invite a teammate · Create your first lead by hand*.
* **Every page header** carries a one-line purpose and, where the concept is new, a *What's this?* HelpTip (Pipeline, Lead source, Attribution, Forecast…).
* **Plain terms** with the old term in a tooltip: *Lead source* ("where buyers come from"), *Destination* ("another system we send leads to"), *Automation* ("do this automatically when…").
* **Progressive disclosure:** basic fields first; advanced (probabilities, transition rules, field mapping transforms) behind "Advanced".
* **The first-run journey must work without help:** create lead → it is assigned → record a call → book a viewing → see the next step on the lead ("Next: record the visit outcome").

## 6. Screen-by-screen plan (journey · key elements · states · acceptance · tests)

Notation: 🆕 new · ♻ rebuild legacy · ✎ refine existing. "A" = acceptance, "T" = tests.

### 6.1 Home ♻ (replaces Dashboard)
Journey: sign in → see *what needs me today* → act. Elements: **My day** (overdue tasks, today's tasks and viewings, leads waiting for a first reply with countdown), **New leads** (assigned to me, unassigned for managers), **Pipeline snapshot** (count and value per stage; forecast labelled "assumption-based"), **Needs attention** (source or integration problems, failed deliveries — from Monitor), **Get started** checklist. Role variants: salesperson (own work), manager (team + unassigned), owner (adds health), executive (read-only numbers), auditor (health only).
A: every number reconciles with its list; salespeople never see others' leads; empty workspace shows only *Get started*. T: reconciliation integration tests (restricted roles), role-variant tests, browser smoke at 390/1440.

### 6.2 Leads ✎ and Lead detail ✎
Add: **Next step** banner on the lead ("Call within 12 min", "Record the visit outcome"), system-event markers in the timeline, **interest panel** (units this buyer is considering, from the new interest table), first-touch/last-touch source chip, and accessible names for all icon controls. A: a new user can create a lead, assign, log a call, book a viewing, and read the next step without help (usability test with 3 people). T: browser journey; axe clean.

### 6.3 Pipeline ✎ (+ settings ♻)
Board: card shows owner, days in stage, next task, value; column header shows count and weighted value; **Lost/Not a fit/Follow up later** drop zone with reason dialog; forecast labelled with its assumptions. Settings: **Basic** (names, order, colours, the beginner default) and **Advanced** (probabilities, transition rules, required details) tabs; renaming shows "history will show the new name" warning (or snapshots, `07` S2). A: server enforces everything shown; no screen offers an action the server refuses without explanation. T: existing suite + rename-history test.

### 6.4 Contacts ✎
Add company grouping later; keep. Accessibility names.

### 6.5 Tasks & calendar ♻ (merge)
One page: *Today · Overdue · Upcoming · Calendar (week)*; viewings and tasks in one list; create a task or book a viewing from the same "+"; **viewing detail** with Reschedule / Cancel / Complete / No-show (needs the endpoints, `07`), ICS download, reminders. Calendar events are persisted records only (no UI-only reminders). A: completing a viewing prompts the outcome and offers the stage move; double-booking is refused with the conflicting booking named. T: viewing lifecycle integration tests; DST; browser.

### 6.6 Inventory ✎ + 🆕
*Projects* and *Properties* keep their pages; add **Buyer interest** (shortlist from Matching, offer, reservation with token amount and agreed price, cancellation) so "Booked" is a record, not just a stage; **Matching** relabelled (no "AI"), excludes archived, shows "why it matched", saves a shortlist to the lead. A: a unit cannot be reserved by two leads; a reservation moves the unit to *Reserved* and the lead to *Booked*; sold → Won with deal value. T: concurrency (two reservations), state-machine tests.

### 6.7 Marketing 🆕/♻
* **Lead sources** ✎: add a **"Not verified → Verified"** state (verified after the first real delivery or a test), health summary, and setup as a full-page stepper (provider → details → copy values → send test → done) instead of two dialogs.
* **Destinations** 🆕 (outbound): list with `ConnectionStatus`, setup stepper (URL/auth → **test connection with explicit confirmation** → mapping editor with live preview and validation → **dry run** → activate), mapping versions with diff, delivery history with *Unconfirmed delivery* handling.
* **Attribution** ♻: layout in `04` §8.2; A and T in `04` §8.5–8.6.
* Legacy *Integrations* page removed.

### 6.8 Automation ♻
Templates first (*Assign every new lead and create a follow-up task*, *Remind about an overdue lead*, *Tell a manager about a high-value lead*, *Follow up after a completed site visit*, *Tell the team when a lead enters negotiation*), each with the parameters it needs, a **plain-language preview** ("When a lead is created → assign to the least busy salesperson → create a task 'Call within 15 minutes' → notify the owner"), **Active/Paused** that reflects reality, and **Execution history** (status, what it did, why it failed, Retry). Only triggers/actions that execute are shown; others are listed under "Coming soon" with no switch. No free-form builder until branching/delays exist (conflict C3). A: `02` §6. T: `02` §5.

### 6.9 Reports ♻
Business questions only: open leads, overdue follow-ups, site visits completed, bookings, sales, pipeline value, **stage durations** (needs the history snapshot), team performance. Each metric with a definition tooltip and drill-down; date range and workspace timezone visible. A: each total equals its drill-down list. T: reconciliation tests.

### 6.10 Administration ♻/✎
Team & roles (✎; plain-language role descriptions exist), **Workspace settings** (one page, typed settings, merge-not-replace, ETag), Pipeline settings (above), Custom fields (♻ and actually rendered on lead/contact/property forms with validation, otherwise hide), API keys (✎: show "what this key can do" in plain words, last used, expiry; revoke confirms), Audit trail and Monitor (✓ built).

## 7. Accessibility and responsive plan
* Replace every legacy `Dialog`/`Input` with MUI equivalents (role, labels, focus trap, return focus).
* Name every icon button; add a CI check (axe via Playwright) on all routes at 1440 and 390 px; fail on serious/critical violations.
* Keyboard: every list row reachable and activatable; command palette traps focus; board has the existing keyboard move menu.
* Responsive: tables become stacked cards below 600 px for *Leads/Properties/Tasks*; filter bars collapse; no horizontal page scroll (the Attribution overflow is the one known failure).
* Contrast verified for both themes with a script over the token pairs (not asserted by eye).

## 8. Performance
Route-level lazy loading exists. `UI_DESIGN_SYSTEM.md` sets an initial budget of ≤ 250 kB gzip; today's build shows the shared chunks at roughly index 77 kB + react 60 kB + mui 126 kB + query 12 kB (gzip), i.e. **the budget must be re-measured** (UNVERIFIED which chunks load on first paint). Virtualise tables over 200 rows; debounce search; keep keyset pagination; measure with Lighthouse and the load test in `05` §2.2.

## 9. Security notes for the UI work
The UI never becomes a control: hiding is cosmetic; every new screen's endpoint gets a permission-matrix entry and a cross-tenant test **before** the screen ships. Secrets are displayed once, never put in URLs or logs, never in client state after the dialog closes (verified for Lead sources by the browser journey: the page source no longer contains the key after reload).

## 10. Phasing (reconciling brief 6 with what already exists)

| Brief 6 phase | State |
|---|---|
| 0 Audit and plan | **this audit** |
| 1 Design foundation | ✅ tokens, shell, states, forms exist; **add** the §4 components and §3 refinements |
| 2 Core sales workflow | ✅ Leads, Pipeline, Contacts, Tasks rebuilt; **remaining:** Home, merged Tasks & calendar, next-step banner |
| 3 Inventory | ✅ Properties/Projects rebuilt; **remaining:** Buyer interest, viewing lifecycle, Matching |
| 4 Marketing and integrations | ✅ Lead sources, API keys; **remaining:** Destinations, Attribution, Reports |
| 5 Automation and administration | ✅ Team, Monitor, Audit; **remaining:** Automation, Workspace settings, Custom fields, Pipeline Basic/Advanced |
| 6 Quality and consistency | not started: axe + Playwright in CI, legacy deletion, Tailwind removal |

Order I recommend (dependencies in `07`): **legacy safety → workspace settings → one real automation → Home + Tasks & calendar → viewing lifecycle + Buyer interest → Attribution + Reports → Destinations → polish and legacy deletion.**

## 11. Acceptance criteria (brief 6 §18, made checkable)

| # | Criterion | How it is checked |
|---|---|---|
| 1 | Coherent documented IA | §2 approved; route map implemented with redirects; nav test per role |
| 2 | One visual language | no Tailwind/legacy component imports remain (lint rule + `grep` gate); one design system doc |
| 3 | Beginner-friendly labels | copy review against the glossary; 3-person first-run test completes the journey in §5 unaided |
| 4 | Operational vs advanced separated | Pipeline Basic/Advanced; Administration group; no admin controls on daily pages |
| 5 | No duplicate settings | one Workspace settings page; legacy pages deleted; `grep` finds no second writer of `tenants.settings` |
| 6 | Buttons connected to real backend behaviour | every action has an integration test; no UI-only state (lint: no blob-writing pages) |
| 7 | Accurate, defined metrics | `MetricCard` requires a definition; reconciliation tests pass |
| 8 | Configured ≠ connected ≠ verified ≠ failed | `ConnectionStatus` only shows *Verified* after a recorded successful delivery/test |
| 9 | Correct role behaviour, server authorisation | route × role matrix test generated from the registry (every route denied for every role without the permission) |
| 10 | Workspace isolation and integrity | cross-tenant suite covers **every** router |
| 11 | Useful states | per-screen state tests (loading/empty/error/success) in the browser suite |
| 12 | Keyboard and responsive | axe clean on all routes at 1440 and 390; no horizontal overflow |
| 13 | typecheck, lint, build, tests pass | CI green on a clean checkout |
| 14 | No unintended regressions or destructive DB changes | migration-from-previous-version test; additive migrations only |
| 15 | Evidence-backed reporting | each release note cites the tests and journeys executed |
