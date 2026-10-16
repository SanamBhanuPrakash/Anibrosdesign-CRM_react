# Agency model: one agency, many isolated clients, one shared team

Status: core built 2026-10-15 (backend + tests). The simplified UI comes next (see "UI direction").

## The idea

Anibros Design is a marketing agency. It runs lead generation for many clients at the same time (a clinic, a restaurant, a bank, a shop...).
Each **client** needs its own sealed space: its own leads, ad spend, lead sources, webhooks and API keys, and its own pipeline.
The **employees are shared**: the same person can call leads for the clinic in the morning and the restaurant in the afternoon.
The **admin** sees every client and every lead.

## Mapping onto the existing platform (no new isolation mechanism)

| Business word | Platform object | Why |
|---|---|---|
| Agency | `organisations` row | already the parent of tenants |
| Client | `tenants` row with `kind = 'client'` | every table with a `tenant_id` has a Postgres row-level-security policy tied to the current tenant. A client's leads, spend, sources, keys and webhooks are therefore isolated **by the database**, not only by application code |
| Agency HQ | the organisation's one `tenants` row with `kind = 'agency_hq'` | created at signup; it is the agency's own workspace (its own sales leads) and the staff directory. Every signed-in user must have a tenant, so HQ also gives the admin a home when there are zero clients |
| Employee | a `users` row with an **active membership in HQ** | one login for everything |
| Assigned to a client | a `tenant_memberships` row in that client with a role | revoking it removes all access to that client at once |
| Agency admin | HQ role `tenant_owner` or `tenant_admin` | derived, there is no second permission system |

Adding a client = one transaction: tenant row, a membership for every agency admin, the recommended pipeline (stage names adapted to the
industry), lead-scoring config, automatic lead assignment, an audit entry. Archiving a client sets `archived_at` and `is_active = false`:
everyone loses access immediately, API keys stop working, nothing is deleted, and it can be restored.

## Who can do what

* **Agency admin** (HQ owner/admin): create/edit/archive clients, see all clients and all leads, assign employees to clients, change an employee's role per client, export.
* **Employee** (HQ member): sees only the clients they are assigned to. Inside a client the role decides:
  * `sales_agent` (caller): sees and works only the leads **assigned to them**
  * `sales_manager` (team lead): sees and works **all** of that client's leads, can assign
  * `marketing_manager`, `marketing_analyst`, `executive_readonly`: reporting and marketing roles
* Admins cannot be assigned/unassigned per client (they are in every client by definition). Employees can never grant themselves access: assignment is admin-only.

## Cross-client reads: fan out, never bypass

"All leads" for the admin crosses tenants, and row-level security deliberately prevents that in one query. We do **not** weaken the policies.
Instead the agency layer runs the same lead query once per client the caller belongs to, each inside that client's own RLS-scoped transaction,
using the caller's own role in that client (so an employee gets `own`/`all` exactly as in the client's workspace). Results are merged by the sort key.
Consequences, accepted on purpose:

* the isolation guarantee is unchanged: a bug in the merge cannot read a client the caller is not a member of;
* pages are numbered (`page`, `pageSize` up to 100) and the window is capped at 5,000 rows; beyond that, narrow by client or date or export;
* with dozens of clients it is a few parallel indexed queries (concurrency-limited).

## Logging work on a lead

An employee logs a **call, WhatsApp, SMS, e-mail, meeting or note** on a lead: direction (outbound/inbound), outcome (connected, no answer,
busy, voicemail, wrong number, call back, interested, not interested, appointment booked, sent, replied), duration, free text, and optionally the next follow-up.
These are real columns (not JSON) so they can be counted per employee and per client. An outbound touch stops the first-response clock; an inbound message does not.
(The CRM records what staff did. It does not place the call or send the WhatsApp itself.)

## Downloads

`GET /api/v1/agency/leads/export` with the same filters as the on-screen list:

* `format=xlsx` (default): one workbook with sheets **Leads**, **Activity log**, **Clients**.
* `format=csv&dataset=leads` or `dataset=activities`: one CSV (UTF-8 with BOM so Excel opens it correctly; cells that could be read as formulas are neutralised).
* Admins may export all clients or one (`clientId`); an employee's export contains only what they may see. Dates are written in the exporting user's time zone, labelled in the header.
* Each client's part of an export is written to that client's audit trail. Limit: 20,000 leads and 100,000 activities per file.
* The `.xlsx` is written by a small in-repo writer (no third-party dependency).

## Custom lead fields (per client)

Every client defines its own fields for its leads (a clinic: service needed, preferred time; a restaurant: party size, occasion; a bank: product, income). Nothing is shared between clients.

* **Types:** text, number, date, yes/no, dropdown, multi-select, web link, e-mail. Keys never change; labels, options and order can.
* **Storage:** the definitions are the client's schema (`custom_field_definitions`, row-level security like everything else); values live on the lead as JSON. Fast to list, filter and download.
* **Checked on every save:** unknown keys, wrong types, bad dates, options that do not exist and (for people saving a lead) missing required fields are all refused with a message naming the field. Automatic intake (ad forms, imports) is never held to "required", so a real lead is never lost.
* **Edits merge:** changing one field never touches the others, so two employees editing different fields of one lead at the same moment both keep their change.
* **Fields are hidden, never deleted:** hiding keeps every saved value, shows it in downloads and frees the name. Removing a dropdown option that leads still use is refused.
* **Starter fields:** a new client gets the fields its industry usually needs (editable like any other); `POST /agency/clients/:id/custom-fields/copy` copies one client's field definitions to another (definitions only, never lead data).
* **Filter and download:** `field=<key>&fieldValue=<v>` on the lead list (per client or across clients); downloads carry one column per field name ("Custom: Service needed") with readable values (labels, Yes/No), merged by name across the clients in the file, plus a column for values that no longer have a definition.
* A client can have 50 visible fields. Regular-expression validation is deliberately not offered (a user-supplied pattern run on every save is a denial-of-service risk).

## Working in several clients at once (what the UI will do)

The top of the screen will have a client switcher, or browser-style tabs, one per open client. The server already supports this properly:
**every request names the client it is for** (`X-Tenant-Id`), and the client is verified against the caller's memberships on every request. The server never keeps a single "current client" for the whole login that two tabs could fight over. Each tab keeps its own cache. The scale test proves that one employee with five clients open at once is never shown another client's data.

## Capacity and what was checked

`server/src/tests/scale.test.ts` runs 10 clients with 10 employees each (20 employees, each working in 5 clients) all working at once against the restricted database role: ~400 leads added concurrently, ~800 calls/WhatsApp messages logged, concurrent edits to one lead, the admin's cross-client list, overview, activity summary and an Excel download. It then audits the database: nothing lost or doubled, nothing in the wrong client, leads shared fairly among callers, every employee seeing exactly their own leads, no server errors.
Operational settings: `DB_POOL_MAX` (default 20 connections per API process), `LOGIN_IP_LIMIT` (default 600 sign-ins per IP per 15 minutes: a whole office shares one address; guessing one account is still limited to 5 per IP and 50 per hour).

## API at a glance (`/api/v1/agency`, interactive docs at `/api/docs`)

| Call | Who | What |
|---|---|---|
| `GET /overview` | any agency member | how many clients, staff, leads (what the caller may see) |
| `GET/POST /clients`, `GET/PATCH /clients/:id` | list/get: members; write: admins | the client list with lead numbers, lead-source and API-key status, spend this month |
| `POST /clients/:id/archive`, `/restore` | admins | lock everyone out / bring back; nothing deleted |
| `GET /clients/:id/team`, `PUT/DELETE /clients/:id/team/:userId` | admins | assign an employee to a client with a role / take them off (their open leads become unassigned) |
| `GET /staff`, `POST /staff/invitations`, `PATCH/DELETE /staff/:userId` | admins (role change: owner) | employees and their clients, invite, promote/demote, offboard |
| `GET /leads` | any agency member | all leads across the caller's clients, numbered pages, `clientId` and the usual filters |
| `GET /leads/export` | members with export rights | Excel / CSV, fully detailed |
| `GET /activity` | any agency member | calls/messages/meetings per employee per client for a period |
| `POST /leads/:id/activities` (+ `X-Tenant-Id: <client>`) | employees | log a call, WhatsApp, SMS, e-mail, meeting or note |

## Safety nets

* **Access is derived, then reconciled.** Agency admin = HQ owner/admin; an employee = only what is assigned, never an admin role inside a client. If the generic Team screen changes someone's HQ role directly, the next agency request repairs their client memberships (and logs a warning), so drift cannot leave stale admin rights or an admin locked out of a client.
* **404, not 403, for clients you cannot see**, so staff cannot probe which clients exist.
* **Archived clients accept nothing**: workspace sessions, API keys and lead-capture webhooks all check that the client is active (database functions `app.resolve_api_key`, `app.inbound_endpoint_lookup`, `app.inbound_receive`).
* **Offboarding leaves no orphans**: removing an employee (or taking them off a client) unassigns their open leads in the same transaction; their logged history stays.
* **Every mutation is audited inside the affected client** (`client.create`, `client.update`, `client.archive`, `client.member_assign`, `client.member_unassign`, `lead.export`, ...), HQ-level ones in HQ.

## What this slice deliberately does not do yet

* The UI. Today the existing screens still work (switch client with the workspace switcher). The new UI is planned below.
* Per-client custom lead fields and industry-specific pipelines beyond stage names.
* Real-estate objects (properties, projects, viewings, offers) are untouched and will be hidden for non-real-estate clients, then generalised.
* Agency-wide ad-spend roll-ups per client are shown as a figure in the client list; deeper reporting comes with the UI.

## The UI (built)

* **Top bar:** browser-style tabs: "All clients" plus one tab per open client. Each tab remembers the page you were on; two browser windows can be in two clients at once.
* **All clients:** Clients (numbers that link to the exact leads, "Needs you today", Add client), All leads (client filter, quick views, filters, Excel/CSV download, Log call), Activity, Team.
* **Inside a client:** Overview, Leads (list/board), Tasks, Contacts, Reports, Settings (details, team, lead fields, pipeline, sources, API keys).
* **Everything is connected:** a client chip jumps to that client's leads, every KPI opens the list it counts, every lead row has "Log a call or message".
* Real-estate objects only appear for real-estate clients.
## Taking leads, the pool, and who sees what (wave 2)

* **Assigning:** team leads and admins assign any lead (one by one, in bulk, or from the owner cell in any list). A caller sees only the leads that are theirs.
* **The pool:** open leads nobody owns yet. Callers see them through `pool=true` (the "Not assigned" quick view) and can **Take it** (`POST /leads/:id/claim`, permission `leads:claim`). The lead is locked while it is claimed, so two people clicking at once is safe: one wins, the other gets 409 `already_claimed`. A caller can only open a lead after taking it. A new lead that nobody owns notifies the callers, team leads and admins of that client.
* **From anywhere:** the agency-wide All leads list has Take it / Assign…, Call and WhatsApp (both open the Log form), a source tag with an icon (Meta, Google, website, referral…) and the client on every row, so the owner can work every client's leads from one place.
* **My tasks across clients:** `GET /agency/tasks` lists the caller's own overdue and due-today tasks in every client; they appear in "Needs you today". `GET /agency/unread` counts unread notifications per client; each client tab shows a badge.

## Reports and calendar (wave 2)

* **Reports** is one page with four tabs: Overview (key figures with change vs the period before, leads over time, from lead to won, sources, pipeline right now, why leads are lost), Team (per person), Sources (by source, campaign or channel, first or last touch, every number opens its leads) and Ad spend. `/dashboard` and `/attribution` redirect to it.
* **Calendar** shows the whole month (or one week) with a colour per kind of task, a day panel and "add to this day". Tasks can be tied to a lead from the task form.

## Answers to an outside audit

| Finding | Status |
|---|---|
| Invitation API returns the raw token | Not the case: the response carries only id, e-mail, role and expiry; the token travels only in the e-mail and only its hash is stored (tested). |
| Client creation / invitation not atomic | Client creation is one transaction (client, memberships, pipeline, fields, audit); a failure leaves nothing behind (tested). |
| Archived workspaces can still be changed | Every request into an archived client is refused (sessions only resolve active clients); the agency screens that touch an archived client (edit, unassign, assign) now answer 409 until it is restored (tested). |
| Invitation token race | `app.consume_invitation` is a single `UPDATE … WHERE accepted_at IS NULL RETURNING`; three simultaneous accepts yield exactly one account (tested). |
## Specialists, shared leads and routing (wave 3)

* **What a person handles.** Per client, each employee can be set to *Everything* (the default) or a short list: calls, WhatsApp, texts, e-mail, Instagram messages, visits and meetings. The server enforces it: someone set up for WhatsApp only gets a 403 if they try to log a call, and the log form shows only their kinds of work (notes are always allowed). Admins and team leads can always do everything. Stored on the client membership (`work_channels`, migration 030).
* **People on a lead.** A lead has one owner (accountable) and any number of **handlers** (`lead_handlers`). A team lead or admin adds them from the lead page ("Working on this lead"). A handler sees the lead, logs the work their channels allow and gets a notification; they cannot edit, move or reassign it. Handlers count once in their own numbers, and are removed from a client's leads when they are taken off the client.
* **Routing rules.** *Settings → Lead handling → Send leads to specific people*: "leads from Meta go to Divya and Arjun, from Google to Ravi". Each new lead goes to the least busy person on the rule, overriding the client's assignment mode for that source (including "leave unassigned"); an explicit owner always wins; a person adding a lead by hand in "whoever adds it" mode keeps it.
* **The owner does not have to work leads.** New leads go to the pool, to a rule, or to the least busy caller; admins triage from All leads (Assign…), callers take from the pool (Take it).

## Compare clients (wave 3)

`GET /agency/report` and the screen *All clients → Reports*: your clients side by side for the same two calendar dates. It reuses the dashboard, reports and attribution services of each client, inside that client's own authorization and with the caller's role there, so there is one definition per metric and nothing a client's own Reports page would hide. Clients where the caller sees only their own leads are flagged `own` (the figures are partial). Money is totalled per currency, never across. Tested against the underlying records: totals, a client with no data, mixed permissions, time-zone date boundaries and spend counted once.

## Getting leads in, safely (wave 3)

See `docs/INTEGRATION_GUIDE.md`. Each lead source offers *Copy for client* / *Download* (address, proof method, fields read, answers, examples in curl, Node and Python); API keys offer the same for developers. New: the whole API is rate limited per API key and per person, and repeated wrong API keys from one address get a 429 (valid keys are never held up by someone else's mistakes).

## Visual language and infographics (wave 4)

The product keeps one quiet typeface (Geist) and one accent, but surfaces are now lifted cards (a hairline ring and a whisper of shadow, no hard borders) on a warm paper canvas. Colour carries meaning only: sources keep one hue everywhere (Meta blue, Google amber, WhatsApp green, Instagram magenta, referral teal, walk-in orange), stages run cool to warm to done, clients have ten deep hues.

Hand-built SVG components (`src/ui/viz.tsx`, composed in `features/insights/visuals.tsx`): lead-flow Sankey (source to stage group; click a ribbon to open exactly those leads), arrival heat-map (7 days x 24 hours in the client's time zone), reply-speed histogram, tapered funnel with drop-off, donut, sparkline, ring, split bars, and a squarified client treemap (tile size = open leads, amber corner = waiting for a reply). Every picture has a text alternative and hover/focus values. The numbers come from one new endpoint, `GET /reports/flow`, which uses the same cohort, visibility and time-zone rules as the other reports, so a figure always matches the list behind it.

Pages rebuilt on it: the client Overview (right-now strip, pulse, flow, arrivals, reply speed, queue, pipeline, team), the agency home (portfolio treemap and "where to look first"), Reports (flow, funnel, arrivals, speed, lost reasons), Team activity (who did what, split by kind). Select labels that overlapped their value, clipped first-field labels in dialogs, and the bulk bar covering its own menu are fixed globally in the theme and the shared kit.
