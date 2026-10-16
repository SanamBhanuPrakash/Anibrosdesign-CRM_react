# Anibros CRM: metric definitions

One definition per number, used by the Dashboard, Reports and Attribution and by the lists they open. If a screen disagrees with this file, the screen is wrong.

## Common rules
- **Which leads count:** live (not archived), visible to the viewer (salespeople see only their own), and not tagged `test` unless **Include test leads** is on (decision D8).
- **Dates:** whole local days in the workspace time zone (a daylight-saving day is 23 or 25 hours). A range is `from` to `to` inclusive, at most 366 days; the default is the 30 days ending today.
- **Rates:** shown as "—" when the denominator is zero. Never 0 % and never NaN.
- **Estimates vs sales:** pipeline value and a lead's value are **estimates typed on leads**. **Won deal value / revenue** is only the sum of **recorded sales** (completed deals tied to a property, decision D3). A won lead with no recorded sale is counted and listed as such, never valued.
- **Booking** (a property reserved) is a milestone, not revenue.

## The funnel (leads created in the period)
Each step counts a lead if it **ever reached** that step, so every step is a subset of the one before it: won ⊆ booked ⊆ site visit ⊆ qualified ⊆ leads.
| Step | A lead counts when |
|---|---|
| Leads | created in the period |
| Qualified or further | it ever entered Qualified, a site-visit stage, a negotiation or Won (from the stage history), or is in one now |
| Reached a site visit | it has a completed visit, or ever entered the "Site visit done" stage, or went on to a booking or a sale |
| Reached a booking | it has a reservation made (token received), or went on to a sale |
| Won | it is currently in a Won stage |

## Attribution
- Each lead is credited to **one touch**: the **first touch** (default; written when the lead is created and never editable, enforced in the database) or the **last touch** (the newest touch; a buyer who enquires again through another door adds a later touch). Editing a lead's source later does not change its first touch.
- Leads created before touches existed have a first touch **reconstructed** from the lead's source and campaign at migration time; they are flagged and counted ("reconstructed").
- A **source** is where one enquiry came from. A **channel** is the kind of marketing; each source maps to a channel (visible table, per-workspace overrides). "Not recorded" is untracked, never a marketing channel.
- **Campaigns** appear only when a lead carries a campaign name. None are invented. Names compare without regard to case.
- This shows where buyers came from. It does not prove which ad caused a sale.

## Spend, cost and return
- Spend is entered by hand or by CSV (source, optional campaign, from, to, amount). One figure per source, campaign and exact period; periods for the same source and campaign cannot overlap; an exact repeat is skipped on import.
- An entry is **spread evenly over its own days**; a report counts the share that falls inside its range.
- Cost per lead / qualified / visit / booking / sale = spend ÷ the count (blank when the count is 0). Return = (recorded sales − spend) ÷ spend (blank when there is no spend). It compares spend with the period's leads; sales that close later are not yet included.
- With no spend entered for the range there is no cost or return, and none is estimated.

## Reports
- **Pipeline now:** open leads by stage in the default pipeline (other pipelines are counted in the totals and named). Open value is an estimate; weighted value = value × the stage's chance.
- **Time in stage:** for stages left during the period, the median and average days between entering and leaving, from the stage history (the stage name as it was then).
- **Win rate:** won ÷ leads created in the period (rises as recent leads mature). **Days to win:** average creation-to-won time of won leads in the cohort.
- **Why leads were lost:** leads in the cohort that are lost or not a fit, grouped by the reason chosen when closed; older leads show "No reason recorded".
- **First reply:** of leads in the cohort with a reply deadline, the share replied to in time; median time from creation to first reply.
- **Follow-ups:** open leads whose next follow-up date has passed; open tasks past their due time.

## Dashboard
Same definitions as above for the chosen days, plus snapshots of right now (open pipeline, tasks, visits to come, stock). Every figure links to the list it counts.
