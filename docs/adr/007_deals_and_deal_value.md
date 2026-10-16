# ADR 007: Buyer interest, offers, reservations and recorded deal value

## Status
Accepted and implemented in Slice 4 (decision D3; findings in `docs/audit/2026-10-14/` where the dashboard's "won value" was an estimate typed on the lead).

## Context
A unit's status was a free setting: nothing tied a buyer to it, two people could "reserve" the same unit, a lead could be Won with no property and no
price, and reports called an estimate "won value". Matching suggested properties but could not keep them. Decision D3: a completed sale is **Won AND a
recorded deal value tied to a specific unit**; booking/reservation is a separate milestone; the figure is called "won deal value".

## Decision
1. **`lead_properties`** is the shortlist (interest only: `shortlisted | interested | rejected`, source `manual | matching | viewing | offer`, optional match
   score). Unique per buyer and property. It never changes a unit.
2. **`reservations`** is one row per buyer-and-unit deal attempt with a four-state machine: `offered → reserved → completed`, or `closed` (with a reason code;
   a completed deal that is reversed also becomes `closed / deal_reversed`). Each state carries the facts that make it true (CHECK constraints: reserved has
   token and agreed price; completed has a positive deal value; closed has a time and a reason). Rows are never deleted (the role has no DELETE).
3. **No double reservation is a database guarantee**: partial unique indexes allow at most one `reserved` row per unit and at most one open
   (`offered`/`reserved`) row per buyer and unit. The service also takes row locks so the loser gets a clean 409 `already_reserved`, not a unique-violation 500.
4. **Lock order is lead → property → reservation** in every path (offer, reserve, complete, close, stage move to Won, reopen). A test runs five conflicting
   operations on one unit in parallel, four times, and asserts no 5xx and a consistent end state.
5. **The ledger (`deals/ledger.ts`) is the only code that records or reverses a sale.** `LeadsService.moveInTx` calls it when the target stage means Won
   and the move carries a `deal`; `DealsService.complete` goes through the same move. So "Won" and "a recorded deal value on a unit" are written in one
   transaction and cannot drift apart. If the unit cannot be sold (held by someone else, inactive, archived) nothing changes, including the lead.
6. **`pipelines.deal_value_required`**: Won without a deal is refused (422 `deal_value_required`) where it is on. It is on for the recommended pipeline
   (a trigger on `pipelines` for template `beginner_v1`, so migration 023's seed function is not edited) and off for existing pipelines until an admin
   switches it on (same approach as reason codes). Bulk moves to Won are skipped with the reason.
7. **Unit status follows the deal; the deal is not edited through the unit.** Offer → `under_offer`; reserve → `reserved`; sale → `sold`/`rented`; closing
   restores `available` (or `under_offer` while other offers are open). While an open deal or a recorded sale exists, manual status changes and archiving
   are refused (409 `open_deal` / `recorded_sale`) and the unit page says why. Property history gets plain reasons ("Offer received", "Sale recorded"), never a buyer's name.
8. **Lead stage follows the deal, forward only.** Offer moves the lead to `negotiation`, reserve to `booking_reserved`, if the pipeline has those keys and the
   lead is behind them; a pipeline rule that refuses the move does not fail the deal, and the response says what happened (`leadStage`). Closing a deal never
   moves the lead.
9. **A recorded sale is taken back by reopening the lead** (`deal_reversed`): the unit becomes available and the sale stops counting. This needs
   `reservations:update` and `properties:update` at "all" scope (managers and up); a salesperson gets a 403 that says to ask a manager.
10. **Reports:** `wonDealValue` (sum of completed deals of won leads) and `wonWithoutDealValue` (won leads with no recorded sale) are added to the dashboard
    metrics; the forecast's `won` gets `dealValue` and `withoutDealValue`. `wonValue` keeps its meaning (the typed estimate) for compatibility and is labelled as an estimate.
11. **Visibility:** salespeople see and act on deals of their own leads (own scope, 404 otherwise); the unit page shows THAT a unit is held and by which
    agent to anyone who can read inventory, and the buyer and amounts only to people who may see that lead. Events carry ids only.

## Consequences
- Tests that win a lead in the recommended pipeline now supply a deal (`slice0`, `slice2`); tests of the old rules keep using the legacy pipeline.
- Leads that were Won earlier, or are imported straight into a Won stage, have no recorded sale. They are counted and shown as such, never given a value.
- Hold dates are advisory. Nothing expires automatically: a person decides (an auto-release job can be added later, with notification, if the business wants it).
- Currency: amounts carry the unit's currency, but totals still add numbers across currencies as the rest of the reports do; multi-currency reporting is a Slice 5 concern.
- A lead that was moved back behind Booked after reserving (for example to Negotiating) is moved forward to Booked when the sale is recorded. One that sits at a step beyond Booked (for example Follow up later) gets the pipeline's own refusal (Won only from Booked) and nothing changes: move it to Booked first.
