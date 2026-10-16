# Audit 2026-10-14 · 04 — Lead integrations (inbound and outbound) and Marketing Attribution

Design background for what already exists: `docs/LEAD_INTAKE_AND_MONITORING_DESIGN.md`. This document audits it against the briefs and plans what is missing.

---

## 1. Inbound (Google Ads / Meta / website / generic → Anibros): audit

| Capability (from the brief) | Status | Evidence |
|---|---|---|
| Create and manage inbound endpoints | **VERIFIED WORKING** | `modules/inbound/service.ts`, `routes.ts`; `inbound.test.ts` ("managing lead sources" 4 tests); journey |
| Generate and rotate integration-specific secrets | **VERIFIED WORKING** for Google and generic (generated, shown once, rotation cuts the old one off immediately); **Meta**: the customer's own app secret (replace, not rotate) | `inbound.test.ts` ("rotating the secret…", "cannot rotate a Meta secret") |
| Receive Google Ads lead-form webhook POST | **VERIFIED WORKING** with simulated deliveries (JSON body, 200 `{status:received}`) | `inbound.test.ts` (Google, 7 tests); `audit_ui`/journey 6 through the Vite proxy |
| Validate the configured Google key | **VERIFIED WORKING**: key compared in constant time with the stored (encrypted) key; wrong/missing key → 401; key never stored in the delivery | `providers.ts verifyGoogleKey`; tests |
| Parse Google's documented payload | **PARTIALLY IMPLEMENTED**: reads `lead_id`, `form_id`, `campaign_id`, `adgroup_id`, `creative_id`, `gcl_id`, `api_version`, `is_test`, `user_column_data[]`. Name/e-mail/phone come from the standard column ids (`FULL_NAME`, `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `PHONE_NUMBER`, plus common aliases) | `providers.ts normalizeLead('google')` |
| Custom answers | **PARTIALLY IMPLEMENTED / gap**: the field key is `column_id ?? column_name`; for custom questions the opaque id becomes the label shown on the timeline. Should prefer `column_name` when the id is not a standard one | code |
| Submission time | **NOT IMPLEMENTED / UNVERIFIED**: I do not extract a Google submission timestamp (the lead's time is our receipt time). Whether Google's payload carries one must be verified against Google's current documentation before relying on it | code |
| Workspace isolation | **VERIFIED WORKING** (tenant from the endpoint row only; RLS; API role cannot read endpoints without context; DEFINER functions return one endpoint) | `inbound.test.ts` (isolation, database sections) |
| Duplicate prevention | **VERIFIED WORKING** at two levels: provider event id (`unique(endpoint, provider_event_id)`) and person-level (open-lead guard turns a repeat enquiry into a timeline note) | tests |
| Delivery and processing outcomes recorded | **VERIFIED WORKING** (`received / created / duplicate / needs_review / ignored / failed`, with plain reasons) | tests, UI |
| Send leads to external CRMs over HTTP | **NOT IMPLEMENTED** (§2) | — |
| Configure destination URL, headers, method, mappings; fixed/dynamic values; date transforms | **NOT IMPLEMENTED**. The *inbound* generic channel has a `fieldMap` that only **renames** sender fields to ours; no fixed values, no formats | `EndpointConfig.fieldMap` |
| Timeouts, retries, dead-letter, safe replay | **VERIFIED WORKING for inbound processing** (backoff with jitter, `needs_review`/`failed`, Retry/Ignore, Meta transient vs permanent). **None for outbound.** | tests |
| Dry-run / test-data workflow | **PARTIALLY IMPLEMENTED**: "Send test lead" runs the *real* pipeline and creates a real lead tagged `test` (it is **not** side-effect free; and test leads are counted by the legacy reports, `01` §5). There is no dry-run that produces nothing. | `service.ts sendTest`; probe `attributionTotals` |
| Actionable integration logs in the UI | **VERIFIED WORKING** (delivery log, reasons, retry); no export of the log, no per-source health state beyond counts | UI |
| Live Google delivery | **EXTERNAL DEPENDENCY REQUIRED** (Google Ads account with a lead-form asset, a public HTTPS URL) | — |

Additional behaviour to be aware of: a paused source answers **503** so providers retry later; an unknown, deleted or suspended source answers **404** (indistinguishable by design).

## 2. Outbound (Anibros → a client's CRM): audit

**Status: NOT IMPLEMENTED.** There is no outbound delivery code, no destination configuration, no mapping model and no delivery log.

Existing pieces that **can be reused** (nothing here is wasted):

| Component | Reuse |
|---|---|
| `jobs` queue (leases, `SKIP LOCKED`, jittered backoff, dead-letter, dedupe keys, ownership-checked completion) | the delivery worker; **no second queue** |
| `domain_events` + `EventDispatcher` | trigger deliveries on `lead.created` (and later `lead.updated`, `lead.stage_changed`) |
| `platform/crypto/field-encryption.ts` (AES-256-GCM, AAD, rotation) | destination credentials |
| `audit()`, `recordEvent()` activity log, Monitor health checks | audit trail and health |
| Inbound delivery-log UI and API pattern (`/lead-sources/events`, retry/ignore) | the outbound delivery log UI |
| `platform/http/rate-limit.ts` | per-workspace quotas |
| Retention job (`maintenance.ts`) | log retention |
| Legacy tables `integrations`, `integration_webhook_endpoints`, `outbox_events`, `webhook_inbox` | **unused**; a new, narrower schema is cleaner than reviving them (see §4) |
| **SSRF protection** | none exists for configurable URLs (the only outbound call, the Meta Graph client, uses a fixed host). Must be built before the first configurable destination ships. |

## 3. Two directions, and the different credentials (do not confuse them)

| Credential | Direction / purpose | Trust boundary | Stored how | Rotation | Permission to manage |
|---|---|---|---|---|---|
| **API key** (`Settings → API keys`) | A customer's *own system calls the Anibros API* (read/write CRM data) | Bearer token; acts with a role ceiling and scopes the creator already holds | hashed (SHA-256); shown once | revoke and create a new key | `api_keys:manage` (owner/admin) |
| **Lead-source secret** (Google *key*, generic *signing secret*, Meta *app secret*) | **Inbound**: proves a delivery came from the configured sender; grants *only* the ability to submit leads to **one** source | per source; cannot read anything | AES-256-GCM (AAD = source id); last four characters shown | Google/generic: **Rotate secret** (old one stops at once); Meta: paste the new app secret | `integrations:manage` (owner/admin/marketing manager) |
| **Meta page access token** | **Outbound call from Anibros to Meta** to read the answers of a lead | grants Meta access, held server-side only | AES-256-GCM, never returned | replace in Settings | `integrations:manage` |
| **Destination credentials** (future) | **Outbound** to a client's CRM | used only by the delivery worker | AES-256-GCM, never returned or logged | replace; versioned | `integrations:manage` |
| **Session cookie / CSRF token** | A person using the app | browser | opaque 256-bit, SHA-256 at rest | sign out / revoke devices | the user |

The API key and the Google webhook key must never be interchangeable: different tables, different verifiers, different scopes, different UI.

## 4. Proposed generic destination connector (plan; **not started**)

### 4.1 Data model (additive migration, RLS on every table, `REVOKE ALL` then explicit grants)

* `destinations` — `id, tenant_id, name, status (draft|verified|paused|failing), base_url, method, auth_type (none|bearer|header|basic), auth_enc, header_template jsonb (non-secret), timeout_ms ≤ 15 000, created_by, deleted_at`. `status = verified` only after a successful, **user-confirmed** connection test; *saved ≠ verified* (UI shows "Not verified").
* `destination_mappings` — immutable **versions**: `id, destination_id, version, trigger ('lead.created'|…), body_format (json|form), fields jsonb, dedupe_template, active`. `fields[]` items: `{ target, kind: source|fixed|derived, path|value|fn, required, sensitive, transform }`.
* `destination_deliveries` — `id, tenant_id, destination_id, mapping_version, lead_id, source_event_id, idempotency_key, status (pending|sending|delivered|retrying|failed_permanent|unknown_outcome|dead|cancelled), attempts, next_attempt_at, request_redacted jsonb, response_status, response_excerpt (redacted, ≤ 2 KB), error, created_at, delivered_at`. **Unique `(destination_id, lead_id, trigger)`** = duplicate guard.

### 4.2 Mapping language (no code execution)

* **Sources** are an allow-listed set of paths (`lead.contact.firstName`, `lead.contact.phone`, `lead.campaign`, `lead.sourceDetails.gclid`, `lead.sourceDetails.answers['…']`, `lead.createdAt`, …), **fixed values**, and **derived** values from a closed list of pure functions: `concat`, `trim`, `upper`, `lower`, `default(value, fallback)`, `coalesce`, `split_name`, `phone_e164`, `map(table)`, `format_date(fromTz → toTz, pattern)`.
* **Dates:** explicit source timezone (default: workspace zone), explicit destination timezone and pattern (whitelisted tokens, e.g. `dd-MM-yyyy HH:mm`); the preview shows the converted value; DST handled by the same zone library used for recurrence.
* **Validation on save:** required targets present, types sensible, no unknown function, no path outside the allow-list, size limits; *dry run* renders against a sample or a chosen real lead and shows the exact redacted request without sending anything.
* The **StrategicERP spreadsheet** becomes *data*: a template where the user enters the destination field ids and fixed values; nothing StrategicERP-specific is in code.

### 4.3 Reliability and security design

* **SSRF:** `https` only (plain `http` only behind a development flag); resolve DNS, **reject** loopback, private (RFC 1918), link-local, carrier-grade NAT, unique-local and cloud-metadata addresses for IPv4 and IPv6 (including IPv4-mapped); **connect to the resolved address** (prevents DNS rebinding); **no redirects** (or re-validate each hop); port allow-list (default 443); response body cap; total timeout; no credentials in the URL; host deny-list for internal names.
* **Quotas / isolation:** per-workspace destination count, deliveries per minute, concurrency per destination; per-destination **circuit breaker** (open after consecutive failures, half-open probe) so one customer's dead endpoint cannot starve the shared queue; surfaced as a Monitor check and an alert row.
* **Credentials and PII in logs:** destination secrets never logged; `sensitive` mapping fields masked in stored request/response; log retention 30 days; read access limited to `integrations:manage`.
* **Unknown outcome (the timeout problem):** the delivery row is committed as `sending` (with attempt id and idempotency key) **before** the request. If the request **times out or the connection drops after bytes were sent**, the state is **`unknown_outcome`, not `failed`**. Policy per destination: (a) if the destination supports an idempotency key or de-duplicates on a reference field (we send our delivery id in a configured field/header) the retry is safe and automatic; (b) if a lookup endpoint exists, reconcile first, then retry; (c) otherwise **no automatic retry**: the UI says *"Delivery unconfirmed — it may already exist at the destination. Check there, then choose **Mark delivered** or **Send again**."* Never claim exactly-once; the guarantee is **at-least-once with idempotency where the destination allows it**.
* **Retry classes:** network error, `408/425/429` (honour `Retry-After`), `5xx` → retryable with exponential backoff and jitter, max ~6 attempts over ~24 h, then `dead`; other `4xx` → `failed_permanent` with the response excerpt shown (usually a mapping problem); **replay** creates a new linked attempt and records who replayed.
* **Restart recovery:** inherited from the job runner (lease expiry returns the job; the delivery row distinguishes "never sent" from "sending/unknown").

### 4.4 UI (see `06` §6.7)
Marketing → Integrations: *Destinations* tab: guided setup (URL, auth, test) → mapping editor (table with live preview and validation) → dry run → activate; delivery history with filters; per-destination health and last successful delivery.

## 5. Acceptance tests proposed (provider-contract tests use a controllable fake destination server)

| # | Scenario | Type | Pass condition |
|---|---|---|---|
| 1 | Valid Google test lead (`is_test: true`) | integration | 200; lead created, tagged `test`; delivery `created` |
| 2 | Invalid webhook credentials | integration | 401; nothing stored; security event (exists) |
| 3 | Malformed payloads, missing required fields | unit + integration | 400/`needs_review` with a plain reason (exists) |
| 4 | Unknown optional fields in the payload | unit | ignored without error; not stored as free text (exists partly) |
| 5 | Duplicate submissions | integration | one lead; second is a timeline note (exists) |
| 6 | Two workspaces receiving concurrently | integration | no cross-effect (add a concurrent variant; isolation exists) |
| 7 | Destination accepts but the response times out | contract (fake) | `unknown_outcome`; no automatic retry unless idempotency declared; UI shows the unconfirmed message |
| 8 | Retryable vs non-retryable destination errors | contract | 503/429 → retry with backoff; 400/422 → `failed_permanent` with excerpt |
| 9 | Worker restart mid-delivery | integration | no duplicate delivery for a delivered row; `sending` rows reconcile per policy |
| 10 | Mapping validation and date conversion (incl. DST) | unit | table-driven cases, explicit zones |
| 11 | Dry-run | integration | exact redacted request shown; **zero** outbound calls, **zero** delivery rows |
| 12 | Credential redaction and rotation | integration | secrets absent from logs/API/audit; old secret rejected after rotation |
| 13 | SSRF: 127.0.0.1, 10.x, 169.254.169.254, `[::1]`, IPv4-mapped, DNS that resolves private, redirect to private | unit + integration | all refused before any connection |
| 14 | Another workspace's destination/delivery log | integration | 404 / empty |

## 6. What works without Google Ads API access, and what needs it

| Works with **no** Google Ads API/OAuth | Needs Google Ads API / OAuth / developer token (⛔) |
|---|---|
| Lead-form **webhook** intake (needs only the key and a public HTTPS URL) | Importing **ad spend/cost** automatically |
| Website and generic signed intake, CSV import | Resolving **campaign / ad group names** from ids |
| **Manual spend entry** and CSV spend import (cost per lead, ROI) | **Uploading conversions** (e.g. click-id conversions / enhanced conversions for leads) back to Google |
| Outbound push of a lead to a client's CRM over HTTP (§4) | Pulling lead-form submissions by **API polling** instead of webhook |
| Click-id (`gclid`) captured and stored on the lead | Listing a customer's lead forms/campaigns to pick from a dropdown |

Meta: reading a lead's answers needs a page access token with lead-retrieval permission; production use on *customers'* pages may require Meta app review or advanced access (**verify against Meta's current rules before promising it to customers**). Everything above is the *capability boundary as I understand it today*; confirm against the providers' current documentation at build time.

---

## 7. Marketing Attribution: audit of the current page

**Data path:** `src/pages/AttributionPage.tsx` → `GET /api/dashboard/attribution` (`server/src/routes/dashboard.ts:156-217`, legacy, `pool.query`). `GET /api/reports/attribution` (touch table) exists but the page does not use it.

### 7.1 Current formulas (verbatim logic)

| Shown | Formula | Problems |
|---|---|---|
| **Attributed Leads** | `COUNT(*)` of **all** leads of the workspace, summed over sources | counts untracked (`other`), direct, **archived** leads and **test** leads; not "leads with known attribution" |
| **Won from Attribution** | `COUNT(*) FILTER (status = 'won')` | all-time; no date window; "won" = stage mapped to status won |
| **Conversion Rate** | `won / leads × 100` per source (zero-guarded) | all-time; denominator includes archived and untracked |
| **Lead Source Breakdown** | `GROUP BY leads.source` (enum of 8) | `source` is `NOT NULL DEFAULT 'other'`, so **"unknown" and "other" are the same bucket**; the code's `source \|\| 'direct'` fallback never fires; the enum's own `direct` is a different value |
| **Channel Performance** | the same rows renamed `channel` | **source and channel are not distinguished** |
| **Campaign Performance** | `campaign_name: "<source> Inbound"` | **fabricated**; real campaign data (`leads.campaign`, `leads.source_details`) is ignored |
| Qualified | `status = 'qualified'` only | excludes later stages (viewing, negotiation, won): qualified leads that progressed vanish from the count |
| First/last touch | none: one `source` value, overwritten by edits | `marketing_attribution` (touch type, campaign, source, medium, ad group, keyword, click id, `is_direct`) **exists but is never written** (only read by `reports/attribution`) |
| Dates, timezone, spend | none | no filter; no spend table anywhere |

Evidence: probe `workflow.txt` → `attributionTotals: {total_attributed: 8, liveLeadsInList: 7, testLeadsInList: 1}`, all in bucket `other`. The page's example (1 direct, 1 qualified, 0 won) is consistent with these formulas, which is exactly the problem: they cannot say whether the numbers are good.

### 7.2 Data that already exists (and is unused)
`leads.source`, `leads.campaign`, `leads.source_details` (provider, endpoint, campaign/ad/adset/form ids, `gclid`, utm tracking, answers — written for every lead-source lead), `marketing_attribution` (touch table), `lead_stage_history`, `viewings`, `leads.estimated_value`.

## 8. Proposed Attribution redesign (needs approval; schema additions marked ➕)

### 8.1 Purpose and vocabulary (shown on the page, in plain words)
* **Source**: where the enquiry came from (Meta ads, Google ads, website, referral, walk-in …).
* **Channel**: the *kind* of marketing (Paid social, Paid search, Organic/website, Referral, Offline). A source maps to a channel by a visible table.
* **Campaign**: the specific ad campaign inside a source (from the ad platform's id/name, or the label you set).
* **Attribution model**: the rule for crediting. Default **first touch** (credit the first known source) with **last touch** shown alongside. The page states plainly: *"This shows where buyers came from. It does not prove which ad caused a sale."*
* **Conversion event**: a stage event you choose: *Lead*, *Qualified*, *Site visit done*, *Booked*, *Won* (sale completed). **Booking ≠ sale**; revenue is recognised on the Won event only (decision D3).

### 8.2 Layout
1. **Header strip:** date range (presets + custom), timezone label, model switch (First / Last touch), data-freshness ("Last lead received 12 min ago · 2 sources healthy · 1 source needs attention").
2. **Tracking health card:** share of leads with a known source and campaign; count of *untracked* leads (source `other`/null) vs *direct*; integration errors (links to the delivery log).
3. **Funnel by source** (table + bar): Leads → Qualified → Site visits done → Booked → Won, each with count and "% of leads"; clicking a number opens the underlying leads (drill-down).
4. **Campaigns table** (only real campaigns): leads, qualified, visits, booked, won, plus cost columns **only when spend exists**.
5. **Money panel** (appears only with spend ➕): spend, cost per lead, cost per qualified lead, cost per booking, **ROI = (revenue − spend) / spend** with the formula in a tooltip; hidden with an explanation ("Add spend to see cost per lead") otherwise.
6. **Empty states for a workspace with no integrations:** explains the three ways to start (connect a source, add a website form, import a CSV) and still shows manual-source leads.

### 8.3 Metric definitions (all in the tooltip *and* in `docs/METRICS.md`)
All counts are over **live (non-archived), non-test** leads whose `created_at` (in the **workspace timezone**) falls in the range; a lead counts once per row (first-touch default), so source rows **sum to the total**.
* Leads = count. Qualified = leads that have **ever entered** a stage with probability ≥ the *Qualified* stage (from stage history, so progressed leads still count). Site visit done = ever entered *Site visit done* (or has a completed viewing). Booked = ever entered *Booked*. Won = in a Won stage.
* Rates = numerator / denominator, **shown as "—" (not 0 %) when the denominator is 0**; always show the counts next to the rate.
* Cost per X = spend / X, "—" when X = 0 or spend unknown. ROI = (won revenue − spend) / spend, "—" when spend = 0.
* Revenue = recorded **deal value** of Won leads (➕ needs deal value tied to the unit; today only `estimated_value`).

### 8.4 Schema and code needed
➕ stamp **first-touch and last-touch** at lead creation from the lead-source data (reuse `marketing_attribution` rows, written by `createInTx`); ➕ `marketing_spend` (tenant, source, campaign, period, amount, currency, entered_by); ➕ channel mapping; ➕ stage-entry snapshots in history (name, probability) for stable funnels; replace `/api/dashboard/attribution` with a tenant-context, permission-checked, date-ranged v1 endpoint (`attribution:read`), computed from live rows excluding archived/test; exclusion of `test` tag is a **named, visible setting**, not hidden.

### 8.5 Acceptance criteria
1. Source rows sum to the headline total; both reconcile to the lead list for the same filters (automated reconciliation test).
2. Archived and test leads never appear; toggling the "include test leads" setting changes the totals as described.
3. A lead's original first-touch source/campaign is unchanged after stage moves and edits (test).
4. 0 denominators render "—"; no `NaN`/`Infinity` anywhere.
5. With no spend, no cost/ROI element is rendered and the empty state explains why; with spend, each formula matches a hand-computed fixture.
6. Another workspace's leads, spend and campaigns never appear (cross-tenant test); role without `attribution:read` gets 403.
7. Date ranges and group boundaries use the workspace timezone (DST test).
8. Every number links to a drill-down list that reproduces it.

### 8.6 Tests
Unit: formulas, zero denominators, timezone bucketing. Integration (restricted roles): reconciliation, archived/test exclusion, first-touch immutability, cross-tenant, permissions. Browser: filter → drill-down → numbers match; empty state; phone width without horizontal overflow (the current page overflows at 390 px).
