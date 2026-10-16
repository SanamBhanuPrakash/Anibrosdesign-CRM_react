# Audit 2026-10-14 · 13 — Executive Dashboard restored (user request after Slice 4)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Scope: the user's correction that Slice 3's Home had replaced the whole-business overview: **keep Home as the personal "my day" and restore a separate Dashboard / Executive Overview**. Only the Dashboard and its navigation entry were redesigned; the additions to other screens are URL filters needed so clicks can open properly filtered lists (listed below).

## Audit of what existed
- Server: `GET /api/v1/dashboard/metrics` (lead status buckets, stages, viewing/task/property counts, recent leads, loss reasons) is intact and untouched; its `wonValue` is the typed estimate and was already labelled so. The old Dashboard page (Tailwind, polling every 10 s) was removed in Slice 3 and `/dashboard` redirected to Home.
- Gaps against the request: no date range, no recorded-sales revenue, no trend, no inventory/visit/team/marketing sections, nothing clickable, no way to open a list that matched a number (the Leads page had no date, status or test-lead URL filter; Tasks and Deals pages did not read the URL).

## What was built
- **`GET /api/v1/dashboard/overview?from&to&includeTest`** (permission `dashboard:read`): leads, pipeline by stage (default pipeline, plus a count of open leads in other pipelines), sources, recorded sales (completed deals), tasks, visits, inventory, trend buckets (day, week or month by range length), team (managers). Sections the caller may not see are `null`. Whole local days in the workspace time zone (`analytics/range.ts`, shared with the coming Attribution and Reports).
- **Dashboard page** (`/dashboard`, menu entry under Home next to Home): 8 compact key-figure cards, "Needs attention", 7 charts (MUI X Charts, free package only, decision D10), team table, "how to read this" footnote, period presets plus exact dates, "Include test leads" switch (URL-held, shareable). Responsive from 390 px; every chart has a keyboard-reachable row of links under it.
- **Filtered destinations** (additive, URL-driven): Leads accept `status`, `from`, `to`, `test=exclude` (and show a removable chip for each); the leads API accepts `test=exclude` and treats a date without a time as whole days in the workspace time zone; Tasks accept `tab`, `due`, `assignee`; Deals accept `tab`, `from`, `to`, `test`, `only`; the deals API accepts `completedFrom`, `completedTo`, `test`.
- Realtime: visits and property changes also refresh the dashboard.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors), `npm run build`, `npm run api:check`, `npm audit --omit=dev` (0 vulnerabilities after adding `@mui/x-charts@9.15.0`) | pass |
| `npm test` | **34 files, 679 tests pass** |
| New suite | `dashboard-overview.test.ts`, 16 tests (restricted role) |
| Browser journey 13 (restricted-role stack) | all checks pass, no console errors or HTTP 5xx; screenshots reviewed at 1440, 1024 and 390 px (no horizontal overflow) |

## Reconciliation evidence (the request's central demand)
Server tests compare each figure with the rows of the list it links to:
leads total, open, created in the period, won of those, unassigned, late first replies and overdue follow-ups equal the Leads lists with the same filters; stage counts and values equal the lists by stage; leads per source equal the lists by source and add up to the leads created; recorded deal value equals the sum over the Sold list for the same days (and ignores the 9,999,999 typed on the lead); reserved count equals the Reserved list; open, overdue, due-today and unassigned tasks equal the Tasks lists; inventory counts equal the property lists and add up to the total, available value equals the sum over the available list; visits come from visit records; team open leads plus unassigned open leads equal all open leads and team deal value equals the sale; trend buckets add up to leads created and to deal value, and a bucket's own dates reproduce its count; the previous period's lead count equals the list for those days. A lead at 23:30 workspace time on the last day is inside the range and one just after midnight is not.
Browser: Total leads opens exactly 4 rows (matching the API), New leads exactly the period's leads, Overdue tasks only the overdue tasks, Available properties exactly the available units, Won deal value the sold deals; chart bars and slices (pipeline, sources, inventory) and a team row navigate to filtered lists; "Include test leads" adds exactly the test lead.

## Security and roles
Same permission model as every other endpoint: `dashboard:read` (auditors get 403), salespeople are scoped to their own leads, tasks and visits and get no team table, marketing sees leads, tasks and sales but no team table (it cannot assign), another workspace sees none of this one's data (tests). No backend capability was removed; `/dashboard/metrics` and `/dashboard/attribution` remain.

## Defects found while building this
1. A first draft passed more parameters than a statement used (Postgres refuses that); found by the tests, each query now builds its own parameters.
2. The KPI tooltip replaced each card's accessible name with its hint, so assistive technology would not read the figure; the tooltip now only describes the card.
3. The source chart's two series (new, won) were nearly the same colour and the all-zero visits chart showed a "0.00" axis; the first became one series with the won count in the link labels, the second an explanatory sentence.
4. Chart x-axis labels overlapped on a phone; fewer labels are shown on narrow screens.
5. The chart cursor styles targeted class names from an older chart version; fixed to the installed one.

## Limits (stated, not hidden)
1. **Visit figures link to the calendar** (this week), which has no date-range deep link; the counts are verified against the visit records, not against a list with the same window.
2. **Marketing spend, cost per lead and return** are not shown: that data arrives with Slice 5. Sources are by the lead's recorded source; first-touch attribution comes with Slice 5.
3. **Pipeline by stage covers the default pipeline** only; open leads in other pipelines are counted in the totals and the page says how many.
4. `createdTo` as a date without a time now includes that whole day in the workspace time zone (previously midnight UTC, exclusive); there were no known callers.
5. The old `/dashboard/metrics` numbers shown on Reports are unchanged until the Slice 5 rebuild.
6. CI still has not run remotely (no push authorised).
