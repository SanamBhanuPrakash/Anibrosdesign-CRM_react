# Audit 2026-10-14 · 10 — Slice 2 acceptance (workspace settings and the pipeline)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Scope: `07_REMEDIATION_ROADMAP.md` Slice 2; decisions D4 (Not a fit, reason codes) and D7 (recommended pipeline for new workspaces only, explicit audited apply). Design record: `docs/adr/005_pipeline_clarity.md`.
Result: **delivered.** Two roadmap items were deliberately left out and are stated below.

## What was built

- **Recommended pipeline for new workspaces** (twelve plain stages, free movement, Won only from Booked, Follow up later needs a date, one Not a fit outcome).
- **Reason codes** for Lost and Not a fit (fixed lists, "other" needs words), mandatory in the recommended pipeline, a visible switch elsewhere; reports count by reason.
- **Point-in-time history:** every move stores the stage name, meaning and probability as they were; renames and re-weighting no longer rewrite the past.
- **Explicit, audited "add the recommended pipeline"** for existing workspaces (adds a second pipeline; never replaces; never moves a lead).
- **Nurture dead end fixed** additively for existing restricted pipelines.
- **Pipelines page with Basic and Advanced levels**; **Workspace settings** now also holds the phone country, and the old address redirects.
- Migration 023, `reason-codes.ts`, `PipelinesService.applyRecommended`, `GET /pipelines/reason-codes`, `POST /pipelines/apply-recommended`, `reasonCode` on stage moves and bulk moves, `outcomeReasons` on the dashboard metrics, `ReasonDialog`.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors), `npm run build`, `npm run api:check` | pass |
| `npm test` | **28 files, 571 tests pass** (538 before this slice) |
| New suites | `slice2.test.ts` 24 tests (restricted role); `upgrade-slice2.test.ts` 9 tests (022 to 023 with data in place) |
| Browser journey 10 (restricted-role stack) | all 20 checks pass, no console errors or HTTP 5xx; screenshots reviewed |
| Dev database | backed up; migration 023 applied to 24 pipelines and 7 history rows: 7 rows back-filled and flagged, 24 Nurture dead ends each gained 11 exits (264 rows); nothing else changed |

## Acceptance criteria (roadmap) and decisions

| Criterion | Evidence |
| --- | --- |
| One writer of `tenants.settings` | Slice 0 merge-style API is the only writer; `slice2.test.ts` "one writer" scans the server source and fails if any other file updates the tenants table; the settings page uses that API |
| Rename a stage, the historical record is unchanged | "shows each move with the stage name and weight it had at that time": renamed Negotiating to Price talks and changed its chance 70 to 40; history reads "Qualified > Negotiating" and the stored probability stays 70; the live stage shows the new values; archiving a stage keeps history readable; the trigger fills the snapshot for raw SQL inserts too |
| Default pipeline walkthrough completes without a refused move | "a beginner can walk a lead from enquiry to won without ever being refused": skips steps, goes backwards, ends Won; "only Won needs Booked first"; offered moves are every open stage plus both outcomes, never Won before Booked |
| D4 one "Not a fit" with mandatory reason codes (new workspaces) | exactly one disqualified stage; code mandatory (400 without one, also when only free text is given); unknown code, a code from the other list, "other" without words and a code on a non-closing stage are all refused; code stored on the lead and on history; reopening clears it; bulk moves are skipped without a code |
| D4 preserve existing history, group in reports, never rewrite | old pipelines keep the written-reason rule (tested); the requirement can be switched on and off (audited); reports group by code, old leads appear as "No reason recorded"; migration back-fills snapshots **flagged** as back-filled instead of pretending |
| D7 new workspaces only; never silently replace; explicit audited apply | signup seeds the recommended pipeline; migration changes no existing pipeline (asserted: names, default flags, reason switch, template untouched); "apply" adds a second pipeline, leaves the default and every lead untouched, is idempotent, audited, permission-checked (manager and agent refused), and "make it the default" is a separate explicit choice |
| Fix the Nurture dead end for existing workspaces additively | upgrade test: 11 exits added in a restricted pipeline; none in a free-movement pipeline; a hand-made exit is kept exactly; re-run is a no-op |
| Basic / Advanced | browser: Basic shows plain types and no Means/Chance; Advanced shows meaning, chance, move rules and the reason switch; Basic cannot change what a stage means |

## Defects and gaps found while building this

1. The recommended pipeline changed which stage keys a signed-up workspace has; eight tests had assumed the old seed. They now request the old pipeline explicitly where they test the original rules, which also keeps those rules covered.
2. `slice0.test.ts` helpers moved leads to Lost with free text; under mandatory codes that is correctly refused, so they pass a code.
3. Writing the test for the Slice 1 migration showed it counted migrations; it now builds its own directory so later migrations cannot break it.

## Left out on purpose (stated, not hidden)

1. **Lead-scoring weights are not editable** (the roadmap listed them). Changing a weight would silently disagree with every stored score until leads are re-scored, and re-scoring on demand is not built. Adding the control without that would mislead.
2. **Brand colours were removed** from settings: nothing in the product used them. If branding is wanted, it should come with a theme that applies it.
3. **Cross-pipeline moves** of existing leads are still unsupported, so adopting the recommendation for existing leads means finishing them in the old pipeline; the page says the old pipeline and its leads stay as they are.
4. Reports by stage over time (funnel, conversion between stages) are Slice 5. The data they need (snapshots) now exists.
5. CI still has not run remotely (no push authorised).
