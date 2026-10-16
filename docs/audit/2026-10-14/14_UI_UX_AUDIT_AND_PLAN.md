# Audit 2026-10-14 · 14 — UI/UX audit and redesign plan

Method: a scripted sweep of **24 routes × light/dark × 1440/390 px** (96 page states) in a real browser against the restricted-role stack, with a believable workspace (properties, leads, a task). For each state: full-page screenshot, axe-core (WCAG 2.0/2.1 A and AA), horizontal overflow, console errors, ellipsised text, wrong-theme surfaces (large near-white surfaces in dark, near-black in light) and the computed font of headings, body, labels and table cells. Screenshots were reviewed by eye. Skills and standards used: the Anthropic *frontend-design* guidance (already installed, reviewed: no scripts), the Vercel *react-best-practices* rules (read, no install needed: nothing to execute; applied for imports, lazy loading and re-renders), and WCAG 2.1 AA. **Not used:** Vercel *web-design-guidelines*. It is on the project's rejected-tools list and, when read, it instructs the agent to fetch its rules from a mutable remote URL before every run, which is exactly why it was rejected. The same accessibility ground is covered by axe and WCAG directly.

## 1. Root cause of the dark-mode and typography failures
The application has **two component systems**. 20 routes use MUI with the CSS-variable theme and are correct in both themes. **Four routes (`/reports`, `/attribution`, `/property-matching`, `/settings/workspace`) are legacy Tailwind pages** built on `src/components/ui/*` and a `MuiBridge`, with hard-coded light utility classes (`bg-white`, `text-surface-900`, `border-surface-200`, blue accent). They never read the theme, so in dark mode they render white panels with dark text on a dark shell. Their page titles are `text-surface-900` on a near-black background, i.e. effectively invisible; they use a 20 px Geist h1 instead of the 28 px Newsreader page title; their accent is a different blue; their form controls are native or Tailwind inputs. Tailwind survives only for these pages (its preflight also resets styles globally). Fixing individual colours would repeat the problem: the fix is to **rebuild the four pages on the MUI theme and remove Tailwind and the legacy kit entirely**.

## 2. Findings by severity

### S1 — broken or misleading (fix first)
| # | Where | Finding |
|---|---|---|
| 1 | Reports, Attribution, Property matching, Workspace settings (dark) | White panels and controls on the dark shell; titles near-invisible (dark text on a near-black background). 36, 7, 8 and 9 oversized wrong-theme surfaces measured on the four pages |
| 2 | Attribution | The page heading reads "Lead sources" (the wrong page's title) |
| 3 | Reports | Pipeline "distribution" repeats the 12 stage counts as 12 near-empty bars (11 at zero), and again as a status grid that repeats the same counts; two different "won" figures with no explanation; no date range, no drill-down; "Estimated value" and recorded sales are mixed in one sentence |
| 4 | Attribution | Counts every lead by the lead's *current* source (no first-touch), no date range, no funnel, no way to open the leads behind a number; source names are raw keys ("google ads") |
| 5 | Property matching | Empty-result panel is a large white block; "Save to their shortlist" text is nearly invisible in dark; budget target is `estimatedValue ± 30 %` (an assumption shown as fact) |
| 6 | Dashboard (built earlier today) | 8 KPI cards in one row truncate their own labels ("Won deal val…", "Visits in the …", "Available pro…") at common widths; lower panels are oversized for one lead; the pipeline chart draws 9 zero-value stages; the inventory donut and visit chart are oversized for the data; one long repetitive scroll |
| 7 | All pages | axe **color-contrast (serious)** on every page: the navigation group headings (`#9A978C` on white = 2.92:1, needs 4.5:1) and the avatar initials (white on `#9A7B6B` = 3.87:1) |

### S2 — structural UX or accessibility
| # | Where | Finding |
|---|---|---|
| 8 | Every page | axe **list (serious)**: the sidebar groups are `<ul>` elements with non-`li` children |
| 9 | Pipeline board, Lead detail | axe **aria-prohibited-attr**: draggable cards carry `aria-label` on a role-less `div` |
| 10 | Pipeline board | axe **scrollable-region-focusable**: the horizontally scrolling stage list cannot be reached by keyboard |
| 11 | Automation | axe **link-in-text-block**: an in-text link is distinguished by colour alone |
| 12 | Workspace settings | Long option text is clipped inside native `<select>`s; four unlabelled-by-hierarchy panels of unequal height; the Save button floats away from the form |
| 13 | Typography | Section titles use `h4` (17) on some pages and `h5` (15) on others; legacy pages differ again. No documented rule for which to use |
| 14 | Charts | No shared categorical or status palette: colours are picked per chart and two series can look identical (seen on the Dashboard source chart) |
| 15 | Reports / Attribution / Matching | Native `<select>`, native checkbox, `confirm`-style patterns instead of the shared form components |

### S3 — cosmetic
Inconsistent spacing between legacy cards and MUI sections; the legacy Export button is a different green; icon sets differ (lucide on legacy pages, MUI icons elsewhere); the legacy "Refresh" button duplicates realtime updates.

### Verified fine in this sweep (96 states)
No horizontal overflow at 390 px on any route in either theme; no console errors or failed requests; page titles in Newsreader 28 px on all 20 MUI routes; reduced-motion honoured (the sweep ran with it on).

## 3. Plan (phases, each committed and verified)
1. **Foundation:** semantic tokens for data visualisation (categorical and status palettes, light and dark, contrast-checked), raise `text.disabled` use for readable labels (nav group headings, avatar tints), fix the sidebar list semantics, board card semantics and scroller focus, document the typography roles and the heading rule in `docs/UI_DESIGN_SYSTEM.md`, add shared components (`Section`, `StatTile`, `MetricHelp`, `RangeBar`, `BarList`, `ChartFrame`) that read only theme tokens.
2. **Rebuild the four legacy routes on the theme** and delete Tailwind, `src/components/ui/*`, `MuiBridge` and their dependencies: Workspace settings first (small), then Property matching.
3. **Dashboard redesign** (hierarchy, labels that fit, compact visuals sized by data, no zero-value clutter, meaningful empty states, everything clickable).
4. **Reports and Attribution** rebuilt as analytical workspaces on real, reconciled data: this needs the first-touch and spend data model from roadmap Slice 5 (migration 026, attribution and reports endpoints with drill-down); no campaign names, spend or return are invented.
5. **Verification:** re-run the sweep in both themes and at 1920/1440/1024/390, axe clean on every route, keyboard and focus checks on the new screens, unit/integration tests for the new endpoints, then this document's findings are re-scored in a route-by-route report.
