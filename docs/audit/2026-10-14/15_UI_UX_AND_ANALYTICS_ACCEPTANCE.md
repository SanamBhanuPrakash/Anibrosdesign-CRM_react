# Audit 2026-10-14 · 15 — UI/UX redesign and analytics (Slice 5) acceptance

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-15. Plan and findings: `14_UI_UX_AUDIT_AND_PLAN.md`. Definitions: `docs/METRICS.md`. Design system: `docs/UI_DESIGN_SYSTEM.md` (updated: one styling system, token rules, typography roles).

## What changed
1. **One styling system.** The four legacy Tailwind routes (`/reports`, `/attribution`, `/property-matching`, `/settings/workspace`) were rebuilt on the MUI theme. Tailwind, its config, the legacy component kit (`src/components/ui`, `MuiBridge`), the dead hooks and the dependencies (`tailwindcss`, `tailwind-merge`, `clsx`, `lucide-react`) were removed. A page now gets both colour schemes from the theme with no per-page code; this removes the root cause of the white-on-dark panels and invisible titles.
2. **Tokens and typography.** Chart colour tokens (`chart.s1…s6`, `muted`, `grid`), readable `text.disabled` in both schemes, darker light-scheme warning colour, avatar tints that keep white initials at 4.5:1. Typography roles and the heading rule are documented; every rebuilt page uses the 28 px Newsreader page title (the legacy pages used a 20 px sans title, and Attribution carried the wrong title).
3. **Accessibility fixes found by axe** on every route: sidebar groups (`list`), avatar and heading contrast, `aria-prohibited-attr` on board cards, keyboard-focusable board scroller, in-text link underline, tooltips that describe instead of relabelling.
4. **Dashboard redesigned** (hero figures with full labels, needs-attention list, one trend chart with a metric switch, pipeline rows only for stages that hold leads, ranked bar lists sized to the data, supporting rail, team table; everything clickable, nothing empty drawn).
5. **Reports rebuilt by business question:** how leads become sales (nested funnel with drill-down), why leads do not convert (lost and not-a-fit reasons), where the pipeline is now (stage counts add up; time in stage from the history), whether we are following up (visits, first-reply performance, overdue), what there is to sell, how each person is doing. Date range, definitions on every figure, CSV export, drill-down drawer listing the exact leads.
6. **Attribution rebuilt** around "which sources and campaigns bring buyers and what became of them": first or last touch, tracking quality, source / channel / campaign tables with Leads → Qualified → Site visit → Booked → Won and won deal value, drill-down on every count, cost and return only where spend exists, spend entry and CSV import (preview, all-or-nothing, idempotent), channel mapping.
7. **Property matching rebuilt:** starts from the lead's own recorded requirements (editable without changing the lead), explains every score, saves to the shortlist, and has real empty states (no leads; none fit; nothing available) instead of a blank panel. The old page guessed a budget from the estimated value; this one does not.
8. **Workspace settings rebuilt:** themed form, short option labels with the explanation in helper text (no clipped options), a save bar that stays with the form, discard, version-checked saves.
9. **Server (roadmap Slice 5):** migration 026 (immutable first touch with flagged back-fill, `marketing_spend`, `channel_mappings`), `/api/v1/attribution`, `/api/v1/spend`, `/api/v1/reports` with drill-down and export, later touches from repeat enquiries, permission `attribution:manage`.

## Gate results
| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors), `npm run build`, `npm run api:check`, `npm audit --omit=dev` (0) | pass |
| `npm test` | **35 files, 710 tests pass** (`analytics.test.ts` 28, `upgrade-slice5.test.ts` 6, `dashboard-overview.test.ts` 16, plus extended `inbound` and `authz`) |
| Browser sweep: 24 routes × light/dark × 1440/390 px (96 states) with axe WCAG 2.1 A/AA | see the table below |
| Dev database | backed up, migration 026 applied (4 leads each got one flagged, reconstructed first touch) |

### Sweep results (axe serious violations, per page state)
| | Before | After |
| --- | --- | --- |
| Pages with a colour-contrast violation | 96 of 96 | 0 of 96 (final sweep found 6 on Calendar and Properties; fixed and re-verified on those routes in both themes) |
| `list`, `aria-prohibited-attr`, `scrollable-region-focusable`, `link-in-text-block` | 48 + 9 + 2 + 4 states | 0 |
| Wrong-theme surfaces on the four legacy routes (dark) | 36, 7, 8, 9 | 0 |
| Horizontal overflow at 390 px | 0 | 0 |
| Console errors / failed requests | 0 | 0 |
| "Wrong-theme surface" heuristic still flags 2-3 elements on Calendar and Properties | n/a | false positives: translucent hover and focus overlays that the script reads as opaque; verified by screenshot |
| Text clipped by ellipsis | not measured | 1 (the "Partial match" chip label on Property matching at desktop width, in the sweep's data) |

## Route-by-route (state after this work)
Verified by the sweep (both themes, desktop and mobile) and by screenshot review. "Clean" = no axe violation, no overflow, no console error, no wrong-theme surface.
| Route | Result |
| --- | --- |
| Home, Dashboard, Leads, Pipeline, Lead detail, Contacts, Tasks, Calendar, Offers and bookings, Properties, Property detail, Projects, Lead sources, Automation, API keys, Team, Pipelines, Custom fields, Profile, Monitor | clean (0 axe violations) in both themes at 1440 and 390 px |
| Dashboard | redesigned; 20 browser checks (every figure opens the matching list; labels not clipped at 1920/1440/1024/390) |
| Reports, Attribution | rebuilt; clean in both themes; numbers reconcile with their drill-down lists (server tests) |
| Property matching, Workspace settings | rebuilt; clean in both themes |

## Not done / limits (stated, not hidden)
1. **Keyboard and screen-reader testing was by axe and by semantics (roles, names, focus order), not with a physical screen reader.** Charts (the Dashboard trend) are SVG: they have a text summary and the same figures are available as links and tables, but the bars themselves are pointer-only.
2. The remaining routes (Leads, Contacts, Tasks, Properties and so on) were audited and fixed for the global defects; their individual layouts were **not** redesigned in this pass.
3. Attribution "Last touch" differs from "First touch" only for buyers who enquired again through a lead source; manual re-enquiries are not yet recorded as later touches.
4. Spend can be entered by hand or CSV; automatic sync from Meta and Google needs provider accounts (decision D5).
5. Cost and return compare spend with the period's leads; sales that close later are not yet included (stated on the page).
6. Visual-regression snapshots and axe in CI (roadmap Slice 8) are not set up; the sweep script lives in the session scratchpad, not the repository.
7. CI has not run remotely (no push authorised).
