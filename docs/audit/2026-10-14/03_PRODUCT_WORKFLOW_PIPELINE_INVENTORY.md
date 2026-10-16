# Audit 2026-10-14 · 03 — The product explained, the pipeline, inventory, tasks and calendar

## 1. The product in plain English

**The running example.** *Priya* sees an Instagram ad for **Skyline Heights**, a new apartment project in Whitefield, and fills in the form. *Arjun* is a salesperson at the agency. Unit **A-1204** is a 3-bedroom apartment for ₹1.2 crore in that project. Arjun calls Priya, learns her budget, books a **site visit** on Saturday, shows her A-1204 and one other unit, negotiates, and she reserves A-1204 with a token payment. Weeks later the sale completes. The owner wants to know which ad paid for it.

Each module below answers: *what problem · who · when · goes in · comes out · depends on · journey · what can fail · what is genuinely built*.

| Module | Problem it solves | Who / when | In → out | Depends on | What is genuinely built (status) | What can fail today |
|---|---|---|---|---|---|---|
| **Lead sources** | Enquiries arrive in many places and get lost | Marketing manager / admin, once at setup; then automatic | ad/form submissions → a **lead** with its campaign, ad and form ids | Pipeline (starting stage), Team (owner rule) | Meta, Google, website, generic: **VERIFIED** with simulated deliveries; live **needs your accounts** | Missing Meta page token (waits in "needs attention"); person with no phone/email; no public URL in local dev |
| **Contacts** | The same buyer appears several times | Everyone; on every enquiry | person details → one clean person record, duplicates merged | — | **VERIFIED** | A merge is reversible for 30 days only |
| **Leads** | Know who is interested in what, who owns them, what to do next | Salesperson daily; manager for assignment | buyer, budget, source → owner, score, reply deadline, timeline | Contacts, Pipeline | **VERIFIED** | A lead can exist only in one pipeline (no move between pipelines) |
| **Pipeline (board)** | See every buyer at a glance and move them forward with rules | Salesperson daily; owner weekly | drag a card → stage change with required details → history, forecast | Leads, Pipeline settings | **VERIFIED** | Default transitions are strict (see §3) |
| **Pipeline settings** | Match the stages to how the agency sells | Admin, rarely | stages, probabilities, allowed moves → what the board allows | — | **VERIFIED** | Renaming rewrites old history labels (§3.3) |
| **Properties & Projects** | Know what is for sale, at what price, in what state | Inventory manager; salesperson to look up | units with price/size/state, pictures, PDFs → availability and price history | — | **VERIFIED** | Nothing links a unit to the buyer who wants it (§4) |
| **Matching** | Suggest units for a buyer's budget and needs | Salesperson, on demand | budget, location, bedrooms → scored list with reasons | Properties, Leads | **PARTIALLY**: rules, not AI; includes archived units | Archived properties appear; nothing is saved |
| **Calendar / viewings** | Book site visits without double-booking | Salesperson | lead + unit + time → a booking | Leads, Properties | **PARTIALLY**: book and list; no cancel/reschedule/complete | Books archived units/leads; no effect on pipeline or tasks |
| **Tasks** | Never forget a follow-up | Everyone daily | title, due, reminder → bell alert, overdue alert, next repeat | Leads | **VERIFIED** | Time-zone grouping in the UI uses the browser's day |
| **Automation** | Repetitive actions happen on their own | Manager | rule → automatic assignment/tasks/messages | Events, jobs | **UI ONLY** (`02`) | Nothing runs |
| **Reports** | How is the business doing? | Owner, manager | records → funnel, source and agent numbers | everything | **PARTIALLY / BROKEN under the production role** | Zeros; archived leads counted |
| **Attribution** | Which marketing produced customers? | Owner, marketing | lead source/campaign → conversions | Lead sources | **PARTIALLY, misleading** (`04` §7) | Invented campaign names; no spend |
| **Monitor** | Is it running, what went wrong, who changed what | Owner/admin/auditor | system activity → health, log, audit trail | all | **VERIFIED** | — |

## 2. How the pieces connect

### 2.1 What the system does today

```
 Meta / Google / website / other ──► LEAD SOURCES ──(signature, dedupe)──► LEAD ◄── manual entry / CSV
                                                                            │  owner by workspace rule
                                                                            ▼
        TASKS ◄── (you create them) ──── LEAD ────► PIPELINE stage changes (rules, history, forecast)
          │                                │                         │
   reminders + bell                        │ (you book)              ✗ nothing creates tasks or moves stages by itself
                                           ▼
   MATCHING (on demand) ──► you pick units     CALENDAR / VIEWINGS (book only) ─ no effect on the lead
                                                                            
   AUTOMATION ─ saves a rule ─ ✗ never executes          REPORTS / ATTRIBUTION ─ read leads directly (some numbers wrong)
```

### 2.2 Recommended beginner-friendly flow (target; see `06`/`07`)

```
 1 Set up workspace ─► 2 Accept default pipeline ─► 3 Add project + units ─► 4 Connect a source (guided, with Send test)
                                                                                     │
                                                                                     ▼
                         ┌──────────────────────────── NEW LEAD ────────────────────────────┐
                         │ assigned by rule · first-reply timer · "Call now" task created   │ ◄─ automation (real)
                         └───────────────┬──────────────────────────────────────────────────┘
                                         ▼
                     Contact ─► Qualify ─► Book site visit ──────────► Visit done ──► Negotiate ──► Booked ──► Won
                          │          │       (calendar slot, task,        (outcome      (offer on a   (unit
                          │          │        reminder to buyer)           note)         specific unit) reserved)
                          ▼          ▼
                      Follow up later · Not a fit (reason) · Lost (reason)
                                         │
              every step records source/campaign once (first touch) ─► REPORTS (business) and ATTRIBUTION (marketing)
```

## 3. Pipeline audit

### 3.1 Do "Pipelines" and "Tenant Configuration" change the same thing?
* **Pipelines** (`src/features/settings/PipelineSettingsPage.tsx`, `/api/v1/pipelines`) is the only editor of stages, probabilities, move rules and required details. **VERIFIED** (`leads.test.ts`).
* **Tenant Configuration → Pipeline tab** (`src/pages/settings/TenantConfigPage.tsx`) *reads* the same stages through a legacy adapter, then offers add / rename / delete that call **empty functions** (`handleStageUpdate`, `handleAddStage`, `handleDeleteStage` only refetch). So there is **one source of truth for stages, plus one screen that pretends to edit it**. Recommendation: delete that tab.
* A *real* second source of truth exists for **workspace behaviour**: `tenants.settings` JSON keys read by the server (`leadAssignment`, `sla.firstResponseMinutes`, `scoring.sourceWeights`, `defaultCountry`) and the **column** `tenants.timezone`. **No screen edits the JSON keys**, and the Tenant Configuration **Save replaces the whole JSON** with `{primary_color, accent_color, timezone, currency}`, deleting them (and the automation/integration blobs). Its Timezone field writes `settings.timezone`, but tasks and reminders read the **column** → the saved time zone has no effect. (`TenantConfigPage.tsx:97-106`, `leads/service.ts:163-175`, `tasks/service.ts:397-400`.) **BROKEN.**

### 3.2 Meanings, probabilities, reports
* Each stage has `maps_to_status` and `probability`. The **board forecast** multiplies `estimated_value × probability` (tested). The legacy dashboard and reports ignore probability and count raw `status` strings (`open, contacted, qualified, won, lost`), **omitting `viewing_scheduled`, `negotiation` and `disqualified`**, so the buckets do not add up to the total.
* The seeded probabilities (5, 8, 15, 30, 45, 55, 70, 90, 100 %) are **assumptions, not measured conversion rates**; the UI should label forecasts as such until real history exists.

### 3.3 Transitions, required fields, closing, reopening, history
| Question | Answer | Evidence |
|---|---|---|
| Transitions enforced server-side? | **Yes**, in the single stage-change method; the UI only hides buttons. | `leads.test.ts`; probe `workflow.txt` (409 "does not allow moving…") |
| Mandatory fields server-side? | **Yes** (required details per transition + a reason when closing as Lost/Invalid/Unqualified). The seeded matrix defines **0** required-field gates; the reason rule comes from the service. | probe: Invalid/Unqualified without reason → 400, with → 200 |
| Closing and reopening | Closing sets `closed_at` and a closed status; reopening to any open stage is always allowed; tested. | `leads.test.ts` |
| Lost vs Invalid vs Unqualified | **Lost → `lost`; Invalid and Unqualified → the same status `disqualified`.** Reports by status cannot separate them; only the free-text reason differs. | probe `workflow.txt` (`statusAfter: disqualified` for both) · decision C4 |
| History after changes | History stores **stage ids**; names are resolved when read, so **renaming a stage relabels history**; changing a stage's probability or meaning changes past forecasts (no snapshot). Archiving a stage forces moving its leads first (tested) and keeps the row. | `014_pipelines_and_leads_v2.sql`; `leads.test.ts` |
| What if a stage is deactivated/deleted? | Archive-with-move: leads are moved to a chosen open stage; history rows remain. Hard delete is not offered. | tests |
| Multiple pipelines | Supported: create, list, board per pipeline, default pipeline, a lead source can target one. **A lead cannot be moved to another pipeline** (the patch schema omits it). | `pipelines.service.ts`, `LeadPatch` type |
| Concurrency, authorization, isolation | `If-Match`/ETag with 412, row locks, balanced-assignment serialisation, permission matrix, RLS: all tested. | `leads.test.ts` (30), `access-control.test.ts` |

**Usability defects in the seeded rules (probe `workflow.txt`, source `005_pipeline_transitions_and_viewing_hardening.sql:121-150`):**
* **Nurture is a dead end**: no transition leaves it.
* A brand-new lead can only go to *Contact Attempted*, *Invalid* or *Unqualified*: **New → Contacted is refused**, and **New → Lost / Contacted → Lost are refused** (Lost is reachable only from Qualified onward).
* *Contacted → Contact Attempted* (a normal step back) is refused; *Qualified → Won* directly is refused (correct for a strict funnel, surprising to a beginner).

### 3.4 Pipeline-change risks for history
Renaming and re-probability are retroactive (see above). **Recommendation:** store `to_stage_name` and `probability` snapshots in `lead_stage_history` at write time (additive migration) so reports describe what was true then.

### 3.5 Recommended beginner default (applies to **new** workspaces only; existing data untouched)

Open stages, in order (one sentence each, in the words a salesperson uses):
1. **New enquiry**: a buyer arrived and nobody has spoken to them yet.
2. **Trying to reach**: we called or messaged but have not connected.
3. **In conversation**: we have spoken and are learning what they want.
4. **Qualified**: we know budget, area and timing, and they are a genuine prospect.
5. **Site visit booked**: a visit is on the calendar.
6. **Site visit done**: they have seen at least one unit.
7. **Negotiating**: price or terms are being discussed.
8. **Booked**: a specific unit is reserved with a token amount. *Not yet a completed sale.*
9. **Won**: the sale is completed (revenue is recognised here — decision D3).

Outcomes: **Lost** (they bought elsewhere, changed their mind, price — reason required) · **Not a fit** (spam, wrong number, duplicate, not a buyer — reason code required; replaces the Invalid/Unqualified split with a reason code) · **Follow up later** (a date is required; the lead returns to the pipeline and a reminder is created).

Rules: any open stage can go to any other open stage and to any outcome (a beginner should never be told "not allowed"); only **Won** requires Booked first. Advanced settings (probabilities, strict transitions, required fields, extra pipelines) live in a separate **Advanced** tab of Pipeline settings, collapsed by default.

## 4. Properties, projects and buyer interest

| Question | Finding | Evidence |
|---|---|---|
| Project ↔ unit relationship obvious? | Properties carry a project, tower, floor and unit number; project cards show live availability counts; unique unit per project/tower. | `inventory.test.ts`, journey |
| Availability states consistent? | One vocabulary (available, under offer, reserved, sold, rented, inactive) with a state machine and reversal reasons, enforced in the service and recorded by triggers. | `inventory.test.ts` |
| Price/availability history? | Yes, append-only, trigger-written. | tests |
| **Buyer interest** | **Not represented.** There is no table linking a lead to a unit (interest, shortlist, offer, reservation, token amount, agreed price). The only lead–unit link is a **viewing**. "Reserved" is a property state with no record of *who* reserved it or *for how much*. | schema; no such table in migrations 001–020 |
| Viewing schedule vs availability | The booking function requires `status = 'available'` (so a unit *under offer* cannot be shown) and **ignores archived properties and archived leads**; the agent id is not checked to belong to the workspace. | `005_…sql:277-345`; probe `workflow.txt` (all three accepted) |
| Don't imply a booking happened | Moving a lead to *Booking Reserved* neither reserves a unit nor changes any property; marking a property *sold* does not tie it to a lead or mark the lead Won. Two unlinked records can disagree. | probe, code |
| Forms | The rebuilt property form uses grouped sections and parses "1.2 cr"; location is text (city/locality/address); no map or coordinates. | `PropertyDialog.tsx` |

## 5. Tasks, calendar and daily work

| Question | Answer | Evidence |
|---|---|---|
| Does creating a lead create a task? | **No.** (A new lead gets a timeline entry and an owner; the first-reply clock starts; no task.) | probe `afterLeadCreated: tasks 0` |
| Does moving a lead through stages create tasks or appointments? | **No.** Five stage moves later, zero tasks. | probe `stageMoves` (and the tests) |
| Does booking a viewing change the lead, create a task, or notify the owner? | **No.** Stage stays *New*; tasks 0; notifications 0; one timeline note. | probe `afterViewingScheduled` |
| What drives a lead's "next follow-up"? | The earliest open task on the lead (derived). | `tasks.test.ts` |
| Does the Calendar show tasks? | **No**, viewings only, read-only. | `CalendarPage.tsx` |
| Reminders | Real: worker dispatches reminders and overdue alerts with de-duplication; bell updates live. | `tasks.test.ts` |
| Timeline distinction user vs system | Activities carry a type and a null user for system events (e.g. lead-source capture). Whether the lead timeline visually marks system-generated entries differently from user entries is UNVERIFIED (not checked in the browser). | `lead` page, inbound processor |

**Expected behaviour (from the briefs) that does not exist:** a new lead creates a "call within N minutes" task; entering *Site visit booked* requires/creates a visit; visit completion prompts an outcome and moves the lead; overdue follow-ups notify the manager. These are exactly what the first automations (`02` §6, `07` Slice 1) would provide **once an engine exists**.
