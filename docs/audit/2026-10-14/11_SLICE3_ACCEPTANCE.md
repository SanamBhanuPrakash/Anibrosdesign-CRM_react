# Audit 2026-10-14 · 11 — Slice 3 acceptance (daily work: visits, Home, search)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Scope: `07_REMEDIATION_ROADMAP.md` Slice 3; decisions D6 (visit eligibility), D12 (job-oriented navigation, no invented data). Design record: `docs/adr/006_viewings_home_search.md`.
Result: **delivered**, with the limits listed at the end.

## What was built

- **Visit lifecycle**: book (from a lead, a property or Tasks and calendar), reschedule, cancel (reason), no-show, complete with outcome and note, calendar file (.ics). Versioned with ETag/If-Match; audited; events emitted.
- **Real reminder task** behind every visit (moved on reschedule, closed on cancel/complete), shown once on Home as a visit.
- **Completing a visit** creates at most one follow-up task and *offers* "Site visit done"; the lead is not moved automatically.
- **Tasks and calendar**: one page, List or Calendar (week) view; old `/calendar` redirects.
- **Home** replaces the dashboard: my day, team problems, pipeline snapshot, needs attention, get started. Old `/dashboard` redirects.
- **Next-step banner** on every lead, derived from the lead's own rows.
- **Global search** (leads, contacts, properties, projects, tasks) in the command palette, permission-filtered.
- **Navigation** regrouped to Home / Sales / Inventory / Marketing / Automation / Analytics / Administration.
- Migration 024; `/api/v1/viewings` rewritten; `/api/v1/home`; `/api/v1/search`; `dueFrom`/`dueTo` on task lists; OpenAPI and TypeScript schema regenerated.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors, 60 pre-existing style warnings), `npm run build`, `npm run api:check` | pass |
| `npm test` | **31 files, 618 tests pass** (571 before this slice) |
| New suites | `viewings-lifecycle.test.ts` 25, `home-search.test.ts` 17, `upgrade-slice3.test.ts` 5 (restricted database role throughout) |
| Browser journey 11 (restricted-role stack, run twice) | book from lead and property, reschedule, conflict message, record visit with follow-up, suggested stage, calendar week, Home sections, search, redirects; no console errors or HTTP 5xx; 390px width has no horizontal overflow; screenshots reviewed |
| Dev database | backed up, migration 024 applied (existing visits become version 1 with no outcome and no reminder) |

## Acceptance criteria (roadmap) and decisions

| Criterion | Evidence |
| --- | --- |
| Completing a visit offers the stage move and creates the follow-up | "records the outcome, closes the reminder, creates exactly one follow-up, and OFFERS the next stage without moving the lead"; completing twice creates no second follow-up; no suggestion when the lead is already beyond the stage; a manager's follow-up goes to the lead's owner |
| Calendar items are persisted records | the calendar reads `GET /viewings` and `GET /tasks?dueFrom&dueTo`; each visit has a stored reminder task (`reminder_task_id`, composite tenant FK); "tasks by due-date range" test; browser: week view shows the booked visit after reload |
| Search returns only permitted records | a salesperson finds only own leads and tasks; kinds the role cannot read are absent; an auditor cannot search (`search:use`); another workspace finds nothing; archived records never returned; `%` and `_` are literal |
| D6 eligibility | booking and rescheduling are refused (422) for reserved, sold, rented, inactive or archived units and archived leads; allowed for available and under-offer units; "applies the same availability rule as booking" |
| Double booking | six simultaneous moves into one slot: exactly one wins; property and agent overlap both give 409 `SLOT_UNAVAILABLE`; a freed slot can be taken |
| Lost-update protection | stale `If-Match` gives 412 and nothing is overwritten |
| Tenant and role isolation | own-scope visit is a 404 for a colleague's visit; another workspace's visit is a 404; handover to another agent is manager-only; Home sections are `null` for roles without the permission |
| Calendar file safety | valid iCalendar with the right UTC time; no phone number or e-mail; separators and line breaks in notes cannot add properties; folded at 75 octets without splitting a multi-byte character; cancellation shows as cancelled |
| DST (roadmap test list) | Home's day bounds, computed in the workspace zone: 23-hour day (New York, 8 March 2026), 25-hour day (1 November 2026), 24 hours elsewhere, correct local midnight instants; same instant is a different day in different zones; the 8-day boundary lands on local midnight across a change |
| Upgrade safety | `upgrade-slice3.test.ts`: 023 to 024 with data in place; existing visits keep everything; reminder must be a task of the same workspace; deleting the reminder task keeps the visit; re-run is a no-op |
| D12 no invented data | every Home number is the length of the list under it (tested); the weighted forecast is labelled as the owner's own estimate; "get started" ticks come from data; the next step is derived, never typed |

## Defects found while building this

1. A visit appeared twice on Home (once as a visit, once as its overdue reminder task). Reminder tasks are now excluded from my-day lists and the team overdue count; managers get a separate "visits not recorded" count.
2. The calendar's status chip overflowed a narrow day cell; it now wraps.
3. Several places still sent people to the removed dashboard after sign-in; all now go to Home.
4. The `.ics` control-character regex tripped `no-control-regex`; the lint directive was moved to the right line.
5. A shadowed `setMinutes` in the visit dialog; renamed on import.

## Limits (stated, not hidden)

1. **Browser times** in the calendar and dialogs use the viewer's browser zone, while Home's "today" uses the workspace zone. Near midnight, in a browser whose zone differs from the workspace's, an item can sit on a different day in the two places. Not fixed; stored times are UTC and correct.
2. **Search is not benchmarked**: it uses `ILIKE` without trigram indexes. Fine for the current data sizes; benchmark and add `pg_trgm` before large tenants (Slice 8 load test).
3. **Marketing route renames** (`/marketing/*`) were in the roadmap's navigation line; only the grouping changed.
4. The browser-side DST behaviour relies on the platform zone database and has no separate test.
5. Visit reminders go to the agent as tasks and in-app notifications only; reminders to the buyer need provider accounts (Slice 7).
6. CI still has not run remotely (no push authorised).
