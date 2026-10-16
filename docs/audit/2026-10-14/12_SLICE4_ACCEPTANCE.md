# Audit 2026-10-14 · 12 — Slice 4 acceptance (buyer interest, reservations, deal value)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Scope: `07_REMEDIATION_ROADMAP.md` Slice 4; decision D3 (completed sale = Won AND a recorded deal value tied to a unit; booking is separate; the figure is "won deal value"). Design record: `docs/adr/007_deals_and_deal_value.md`.
Result: **delivered**, with the limits listed at the end.

## What was built

- **Shortlist** (`lead_properties`): add from the lead page or from Matching ("Save to their shortlist", keeps the match score), mark interested / not for them, remove.
- **Offers, reservations, sales** (`reservations`): `offered → reserved → completed`, or `closed` with a reason. Unit status and lead stage follow the deal; the response and the screen say what moved.
- **No double reservation**, enforced by partial unique indexes plus lock order lead → property → reservation.
- **Won needs a recorded sale** where `pipelines.deal_value_required` is on (recommended pipeline); a visible switch under Pipelines, Advanced.
- **Reversal** by reopening a won lead (managers and up): unit available again, sale stops counting.
- **Reports** read recorded sales: `wonDealValue`, `wonWithoutDealValue` on the dashboard; `won.dealValue` on the board forecast. The typed estimate stays, labelled as an estimate.
- **Screens:** "Properties and offers" on the lead; "Offers and reservation" (who holds it) on the property; **Offers and bookings** page; sale dialog when a lead is moved to Won; deals-aware property status explanation.
- Migration 025, `server/src/modules/deals/` (catalog, ledger, service, shortlist, routes), `/api/v1/reservations`, `/api/v1/shortlist`, permissions `reservations:read|create|update`, events `reservation.*`, `shortlist.changed`.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (0 errors; 64 style warnings, 4 more than before, all "fast refresh" notes in the new shared file and two unused imports in the old matching page I did not touch), `npm run build`, `npm run api:check` | pass |
| `npm test` | **33 files, 663 tests pass** (618 before this slice) |
| New suites | `deals.test.ts` 30 tests (restricted role, includes a parallel stress test); `upgrade-slice4.test.ts` 6 tests (024 to 025 with data in place); 9 permission rows added to `authz.test.ts` |
| Browser journey 12 (restricted-role stack) | shortlist, offer, competing offer, reserve, refused second reservation, Matching save, sale dialog, Won, Deals page, board figure, settings switch, 390px (3 screens): all pass, no console errors or HTTP 5xx; screenshots reviewed |
| Dev database | backed up, migration 025 applied. It holds 24 pipelines from the old seed (none recommended), 0 won leads: nothing was changed, no flag switched on |

## Acceptance criteria (roadmap) and decisions

| Criterion | Evidence |
| --- | --- |
| Two simultaneous reservations: one wins | "two simultaneous reservations": six buyers, six parallel reserves on one unit: exactly one 200, five 409 `already_reserved`; one `reserved` row; the unit is reserved. "guaranteed by the database too": a direct SQL second reserve fails on `uq_reservation_one_holder`, a duplicate open row on `uq_reservation_one_open_each` |
| No deadlocks or split state | four rounds of five conflicting operations in parallel on one unit (complete, reserve, offer, close, stage move): no 5xx, unit sold, exactly one completed deal, nothing left open |
| Won requires a recorded deal value (D3) | moving to Won without a deal: 422 `deal_value_required`, nothing changes; with a deal: unit sold, lead Won, one completed row; zero or missing value refused; bulk moves to Won are skipped with the reason; all-or-nothing when the unit is held by someone else, when the pipeline's own rule (Won only from Booked) refuses, and for rentals (rented, not sold) |
| The unit shows who holds it | `GET /reservations/by-property/:id`: managers see buyer, token and agreed price; a colleague sees only that it is held and by which agent; browser: "Reserved for Meera Nair (agent) at ₹82 L" |
| Booking is separate from the sale (D3) | a reserved deal has no deal value and is not in won deal value (checked in the reports test: a booked-only deal adds nothing) |
| State machine | offer → reserve → complete; closed deals stay closed; completed cannot be closed or completed again; reserve only from an offer; close reasons are a fixed list ("other" needs words; system reasons cannot be chosen) |
| Unit status and lead stage follow the deal | offer: under offer + lead to Negotiating; reserve: reserved + lead to Booked; sale: sold/rented + lead Won + rivals closed (`unit_taken`) and their agents notified; release: back to available or under offer while others are open; the lead is never moved backwards and is not moved by closing a deal |
| Permissions and isolation | salesperson works own buyers (404 for a colleague's); auditor, marketing and executive roles cannot create or change deals; auditors cannot read them (they cannot read leads either); another workspace gets 404/400; stale `If-Match` gets 412; reversing a sale needs manager scope (salesperson gets 403 and nothing changes) |
| Reconciliation with reports | the dashboard's `wonDealValue` and the forecast's `won.dealValue` equal the database sum of completed deals; the typed estimate (`wonValue`) is unchanged; won leads without a sale are counted as `wonWithoutDealValue`; reversal removes the sale from the figures; browser: board shows "Won deal value ₹83.5 L" and the Deals page total agrees |
| D2 (backward compatibility, upgrades) | pipelines made before this feature keep working until an admin switches the requirement on (tested, and the switch is audited like any pipeline update); upgrade test: existing pipelines untouched, existing leads and units untouched, only the recommended template's flag is on, a recommended pipeline created later gets it through the trigger |
| Shortlist | add/dedupe/un-reject, own-scope, cannot remove while an open deal exists, Matching saves with source and score |
| Unit and deal stay in step | manual status changes and archiving refused while a deal is open (409 `open_deal`); a sold unit with a recorded sale cannot be hand-reverted (409 `recorded_sale`); the unit page replaces the status buttons with the reason |

## Defects found while building this

1. A deadlock was possible between "complete" (lead, reservation, then unit) and "reserve" (reservation, then unit) on the same unit; found by reasoning about the lock order before the stress test, fixed by locking lead → property → reservation everywhere, then proven by the parallel test.
2. The first screenshot review showed an open offer on a reserved unit still offering **Reserve** and **Record sale** (both would be refused). The server now returns only the actions that can work (`allowed`), tested.
3. The deal row's text collapsed to one character per line in the narrow lead sidebar; the layout now wraps the buttons instead.
4. The journey's first run clicked the wrong buyer's Reserve button (the selector matched both rows); the journey now targets one row. The UI itself was correct.
5. Four existing tests won leads without a deal; under D3 that is now refused in the recommended pipeline, so they supply one (`slice0`, `slice2`).

## Left out on purpose or not done (stated, not hidden)

1. **Hold dates do not expire anything.** The page and the Deals tab warn when a hold date has passed; a person releases or completes. An automatic release (with a notification) would be a separate, explicit automation.
2. **Leads imported straight into a Won stage, or won before this slice, have no recorded sale.** They are counted as "won without a recorded sale"; nothing invents a value.
3. **Multi-currency totals** still add numbers across currencies like the other reports; real conversion belongs with the Slice 5 reports.
4. **A deal cannot be moved to another unit.** Close it and make a new offer.
5. **Home does not yet show expired holds** (the Deals page and unit page do).
6. **Matching still ranks by the fixed rules** (budget, area, bedrooms, type); it saves shortlists but does not learn from outcomes.
7. Browser-side behaviour for roles other than the owner was verified through the API tests (restricted database role), not clicked through as each role.
8. CI still has not run remotely (no push authorised).
