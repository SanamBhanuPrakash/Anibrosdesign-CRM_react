# Anibros CRM — Lead Intake, Security, Encryption & Observability Design

System design for the two things a lead-driven CRM cannot get wrong: **no lead is lost or forged on the way in**, and **you can always see what the system did and why**. Companion to `ARCHITECTURE_V2.md`, `SECURITY_MODEL.md`, `FAILURE_MODES.md`, `WAVE3_DOMAIN_DESIGN.md`.

Status legend: ✅ built and tested · 🟡 built, needs live credentials or load testing · ⏳ planned.

---

## 1. Requirements

| Area | Requirement | Target |
|---|---|---|
| Intake correctness | A lead from Meta, Google, a website form or another system becomes exactly one lead (or a note on the person's open lead) | exactly-once *effect* under retries, redelivery and crashes |
| Intake authenticity | Only the configured sender can create leads for a workspace; the workspace is never chosen by the payload | cryptographic proof per source, tenant from the endpoint row only |
| Intake latency | Acknowledge a delivery fast so providers do not time out or retry-storm | p95 receipt < 100 ms server time; lead visible p95 < 10 s |
| Intake durability | An acknowledged delivery survives API and worker crashes | stored before the `200` |
| Intake visibility | Anything that did not become a lead says why, in plain language, with a fix | delivery log with outcome + reason + retry |
| Confidentiality | Credentials at rest are unreadable without keys; personal data never leaks across workspaces | AES-256-GCM field encryption; RLS |
| Observability | Answer "is it running?", "what went wrong?", "who changed what?" without database access | Monitor panel (health, activity log, audit trail), request-id tracing |
| Operability | Observability must never cause an outage | bounded buffers, batch writes, throttling |

---

## 2. Lead intake architecture

```
 Meta Lead Ads ─┐
 Google lead form ─┤  POST /hooks/{endpointId}                                   (public, no cookies, no CSRF)
 Website form ─┤        │
 Any system ───┘        ▼
          ┌──────────────────────────── API process ────────────────────────────┐
          │ 1 id shape check            (not a UUID → 404, no DB)                 │
          │ 2 rate limits               (per IP, per endpoint; websites stricter) │
          │ 3 endpoint lookup           app.inbound_endpoint_lookup(id) DEFINER   │
          │                             unknown / deleted / suspended → same 404  │
          │ 4 prove the sender          over the RAW bytes (see §3)               │
          │ 5 parse + fan out           Meta: one POST may carry many leads       │
          │ 6 durable receipt           app.inbound_receive(): INSERT events      │
          │                             ON CONFLICT DO NOTHING  + INSERT jobs     │
          │                             (one function call = one transaction)     │
          │ 7 answer 200                only now                                  │
          └───────────────────────────────┬─────────────────────────────────────┘
                                          ▼  jobs(type='inbound.process', dedupe_key='inbound:<event>')
          ┌──────────────────────────── Worker process ─────────────────────────┐
          │ load stored delivery (tenant from the row)                            │
          │ Meta: fetch the answers by lead id (Graph API, outside any tx)        │
          │ normalise → one tenant transaction:                                   │
          │    create lead (contact match, assignment, score, SLA clock)          │
          │    OR add a note to the person's open lead (duplicate)                │
          │    timeline note · owner notification · audit · domain event          │
          │ mark delivery: created | duplicate | needs_review | failed            │
          └───────────────────────────────────────────────────────────────────────┘
```

**Why receipt and processing are separate.** Providers retry on any non-2xx and give up after a deadline. Doing real work (a Graph call, contact matching, assignment) before answering couples the provider's patience to our slowest dependency. Storing first makes the acknowledgement cheap and the work retryable. The only thing that can fail before the `200` is the database, and then we answer `503` so the provider retries — nothing was stored, so nothing is duplicated or lost.

### 2.1 Outcomes (the delivery log)

| Outcome | Meaning | Who acts |
|---|---|---|
| `received` | stored, waiting for the worker | nobody (seconds) |
| `created` | new lead exists (provenance in `leads.source_details`, timeline note, owner notified) | nobody |
| `duplicate` | the person already had an open lead in that pipeline; the enquiry became a note on it and the owner was notified | nobody |
| `needs_review` | understood but cannot continue without a human: no phone/email, Meta page token missing or refused, no default pipeline, invalid field | fix the cause, press **Retry** or **Ignore** |
| `failed` | technical failure after all retries | fix the cause, **Retry** |
| `ignored` | a human decided not to process it | – |

Every transition writes an audit entry and a domain event (live refresh in the UI). Unprocessable data is **never dropped silently and never guessed into the wrong workspace**.

### 2.2 Exactly-once effect

| Duplicate source | Defence |
|---|---|
| Provider redelivers the same lead | unique `(endpoint_id, provider_event_id)`; the insert is `ON CONFLICT DO NOTHING` and only a *new* row enqueues a job |
| Same signed request replayed by an attacker | generic channel: signed timestamp, 5-minute window; plus the event id is a hash of the bytes, so an exact replay is the same event |
| Job runs twice (worker crash after commit, lease expiry) | handler locks the delivery row `FOR UPDATE` and skips anything not `received`; job `dedupe_key` per event |
| Same person submits two forms | duplicate-open-lead guard turns the second into a timeline note |
| Meta Graph fetched twice | fetched answers are stored on the delivery; a retry never calls Meta again |
| Two workers claim one job | `FOR UPDATE SKIP LOCKED` leases |

### 2.3 Per-provider facts

| Provider | Authenticity | Event id | Notes |
|---|---|---|---|
| Meta | `X-Hub-Signature-256` = HMAC-SHA256(raw body, **app secret**), constant-time compare; GET handshake with a per-source verify token | `leadgen_id` | webhook carries ids only; answers fetched with a page access token and `appsecret_proof`; token in `Authorization` header, never in the URL; `redirect: error`; 8 s timeout |
| Google Ads | the configured key must equal `google_key` in the body (constant-time); the key is not stored | `lead_id` | `is_test` leads tagged `test`; `gcl_id` kept for conversion upload later |
| Website | no signature by design (browser form): per-source **allowed origins**, honeypot field, per-visitor rate limit (8 burst, 1 per 5 s) | client `eventId` or random | CORS answered per source; bots get a normal-looking `200` |
| Generic | `X-Anibros-Signature: t=…,v1=hex` = HMAC-SHA256(secret, `t.body`), 5-minute window | `X-Event-Id` → body id → body hash | optional field map to rename the sender's fields |

---

## 3. Threat model for the public receiver

| # | Threat | Control | Proof |
|---|---|---|---|
| H1 | Forged lead from a stranger who knows the URL | signature / key per source; the id only locates the endpoint | `inbound.test` (401 for wrong, missing, tampered) |
| H2 | Lead injected into another workspace | tenant = endpoint row; payload cannot select a tenant; RLS on every table | `inbound.test` (isolation), `platform-db` suite |
| H3 | Enumeration of endpoint ids | unknown, deleted, suspended and malformed ids all return the same `404`; ids are random UUIDs | tests |
| H4 | Replay of a captured delivery | event-id uniqueness; signed timestamp window | tests |
| H5 | Payload bomb / slow body | 256 KB body cap before any DB work; at most 100 events per delivery, 80 fields and 40 free-form answers per lead, strings ≤ 500 characters | `413` test |
| H6 | Flooding | per-IP and per-endpoint token buckets before the DB; per-visitor limit for forms; paused source answers `503 + Retry-After` | tests |
| H7 | Stored XSS through names/answers | all values are stripped of control characters and length-capped; React escapes on render; the website snippet never inserts submitted text into your page | unit tests |
| H8 | CSV formula injection when exporting leads | export neutralises `= + - @` | `leads.test` |
| H9 | SSRF via the Graph client | fixed base URL from config, id must match `^\d{5,40}$`, no redirects | unit + code review |
| H10 | Secret exposure (DB dump, logs, API output, audit) | AES-256-GCM with the endpoint id as AAD; only a 4-char hint is returned; logger and audit redact; secrets shown once | `inbound.test` ("no secret ever appears…") |
| H11 | Lookup function abused to read other tenants | the two DEFINER functions return/accept only data for the one endpoint id supplied; pinned `search_path`; the API role has no direct table rows without tenant context | `inbound.test` (database section) |
| H12 | Scanner noise drowns real events | security events are throttled to one per minute per source and report the suppressed count | `monitor.test` |

---

## 4. Encryption and secrets

| Layer | What | Where it lives |
|---|---|---|
| In transit | TLS 1.2+ from browser/provider to the gateway; HSTS (2 years, preload) in production; API CSP `default-src 'none'`; secure, HttpOnly, `__Host-` cookies in production | ✅ app side · 🟡 gateway/TLS is a deployment concern (Wave 9) |
| At rest, database | volume/managed-DB encryption | ⏳ infrastructure (Wave 9) |
| At rest, secrets | **field-level AES-256-GCM**: random 96-bit IV, 128-bit tag, **AAD binds the ciphertext to its row** (`inbound:<endpoint id>`, `<tenant>:integration:…`), so a value copied to another row or tenant fails authentication | ✅ `platform/crypto/field-encryption.ts` |
| Key management | keys only in environment / secret manager, never in the database; `FIELD_ENCRYPTION_KEYS="k2:<hex>,k1:<hex>"` — the first key encrypts, all keys decrypt; `needsRotation()` identifies rows to re-encrypt | ✅ rotation job ⏳ |
| Passwords | Argon2id (64 MiB, bounded concurrency), never reversible | ✅ |
| Sessions, API keys, invitation/reset tokens | random 256-bit values, only their SHA-256 stored | ✅ |
| Webhook verification | HMAC-SHA256, constant-time comparison (`safeEqual` burns equal time on length mismatch) | ✅ |
| Logs and audit | recursive redaction of keys containing `password`, `secret`, `token`, `signature`, `authorization`, `cookie`, `api_key`, … before anything is written | ✅ |

**Honest limits.** Contact phone numbers and e-mails are stored in plain columns (they must be searchable and de-duplicated); they are protected by RLS, role separation and disk encryption, not column encryption. If a customer requires column-level PII encryption, the path is a blind index (HMAC of the normalised value) for matching plus AES-GCM for the display value; it changes search and import code and is not built.

---

## 5. Observability design

### 5.1 Signals

| Signal | Mechanism | Retention | Who sees it |
|---|---|---|---|
| **Logs, everything** | one JSON line per event on stdout/stderr (12-factor): access log with method, route (ids folded to `:id`), status, duration, tenant, user, IP, request id; recursive redaction | shipped by the platform to Loki/CloudWatch/ELK (⏳ Wave 9) | operators |
| **Activity log** (curated) | `operational_logs` via a buffered batch writer: server errors, permission denials, rate limits, slow requests (≥ 1.5 s), failed background jobs, rejected deliveries; tenant rows under RLS | 30 days (retention job) | workspace admins/auditors in **Monitor → Activity log** |
| **Audit trail** | `audit_logs`, written **inside the business transaction** (no audit ⇒ no change), actor/IP/request id from transaction context so callers cannot forge them; append-only for the application | per policy (not auto-purged) | **Monitor → Audit trail**, CSV export (itself audited) |
| **Metrics** | Prometheus at `/metrics`: HTTP duration histogram, in-flight, auth denials by reason, jobs by outcome, queue depth and oldest age, event-consumer lag, WebSocket count, DB pool | scrape interval | operators ⏳ dashboards/alerts |
| **Health** | `/healthz` (process), `/readyz` (DB + schema version); worker writes a **heartbeat** to `system_health` every 15 s; tenants read it through `app.platform_health()` | live | Monitor → Health, load balancer |
| **Tracing** | request id (`X-Request-Id`, echoed in responses and error bodies) is carried into audit rows, activity log, job `correlation_id` and logs | – | anyone with the id |
| Distributed tracing (OpenTelemetry) | ⏳ | | |

### 5.2 Why the activity log is curated

Writing every request to Postgres would add a write to every read and turn the database into the log pipeline. Instead: **stdout carries everything**; the database carries what a workspace admin can act on, at most one row per minute per repeating cause (`throttleKey`), only for requests attributable to a workspace (anonymous noise such as logged-out page loads stays on stdout), buffered (flush every 2 s or 50 entries, max 1000 held, oldest dropped and counted), written per tenant in a tenant transaction so RLS applies, and never on the request path. A logging failure is itself only logged to stdout.

### 5.3 Monitor panel: what each check means

| Check | Source | Warn | Fail |
|---|---|---|---|
| Database | round trip inside the read transaction | > 1.5 s | unreachable (page errors) |
| Background worker | `system_health('worker')` heartbeat age | > 45 s | > 120 s or never |
| Job queue | this workspace's `jobs` | dead jobs in 7 days, or oldest waiting > 5 min | – |
| Lead intake | this workspace's `inbound_events` / `inbound_endpoints` | deliveries needing attention, or an active source silent > 24 h | failed deliveries |
| Errors | `operational_logs` last 24 h | ≥ 1 error | ≥ 10 errors |

Overall status is the worst check. Numbers come in plain language ("1 delivery needs attention. A lead may be waiting."). Lead counts are omitted for roles that cannot see leads (auditors see health and audit, not business data). Everything on the panel is scoped to the viewer's workspace; platform-wide operations (fleet health, cross-tenant queue state) are for the operator's metrics stack, not the tenant UI.

### 5.4 Tracing one problem end to end

1. Customer quotes the **request id** from an error message (or you copy it from the Activity log).
2. Search it in stdout logs → the access line, the error with stack (server-side only).
3. Audit trail row (if the request changed data) carries the same id.
4. If the work continued in the background, the job's `correlation_id` and the worker's log lines carry it too.

---

## 6. Latency budget (lead receipt)

| Step | Cost | Notes |
|---|---|---|
| id check, two token buckets | < 0.1 ms | in memory; exact for one replica, shared store (Redis) at ≥ 2 replicas |
| endpoint lookup | 1 indexed query by primary key | |
| decrypt secret + HMAC | ~0.1 ms | AES-GCM + SHA-256 on ≤ 256 KB |
| parse, normalise ids | < 1 ms | |
| `inbound_receive` | 1 round trip: N inserts + N job inserts + 1 update | one transaction |
| **Target** | **p95 < 100 ms server time** | 🟡 load test pending (Wave 9) |

Throughput guard rails: 20 deliveries/s sustained per IP (burst 120), 100/s per source (burst 600) — a Meta page with a viral ad is far below this; raise per source if needed. Receipt scales with API replicas; processing scales with worker replicas (`SKIP LOCKED`).

---

## 7. Scale, retention, cost

| Concern | Estimate | Plan |
|---|---|---|
| Deliveries | 1 000 workspaces × 500 leads/day ≈ 500 k/day ≈ 6/s average | single Postgres handles it; `inbound_events` indexed by tenant+time |
| Payload storage | ~2 KB each → 1 GB/day | 30-day retention deletes processed deliveries (PII minimisation); monthly partitions if volume grows |
| Activity log | throttled, bounded | 30-day retention |
| Audit | ~10–100 entries per user per day | indexed for the explorer; partition by month when > 100 M rows |
| Graph calls | 1 per Meta lead | per-source concurrency is bounded by worker concurrency; transient errors back off with jitter |

---

## 8. Trade-offs

| Decision | Alternative | Why | Revisit when |
|---|---|---|---|
| Receipt and processing split via Postgres jobs | process inline | cheap ack, retries, crash safety | never for intake |
| DEFINER functions for the two pre-tenant steps | give the API role cross-tenant read | blast radius is one endpoint id | if more public receivers appear: move them to a dedicated schema |
| Per-source secrets, not one platform secret | one shared key | a leaked key affects one source; rotation is per source | – |
| Meta: user's own app secret | our Meta app | no Meta app review needed to start; works with each customer's own app | when we become a Meta Tech Provider (one app, OAuth connect) |
| Curated DB activity log + full stdout logs | everything in DB | protects the primary database | when a log store is deployed, add a read-through link instead |
| In-memory rate limits | Redis now | exact for one replica, zero ops | ≥ 2 API replicas |
| Plain PII columns | column encryption | search/dedupe, simplicity | a customer or regulation requires it (blind index design above) |

---

## 9. Not built yet (explicit)

Live Meta and Google round trips (need your app credentials and a public HTTPS address; everything up to the provider call is tested with simulated deliveries) · OAuth "Connect with Facebook" · Meta and Google conversion feedback (4.3) · outbound webhooks (4.5) · alert rules and paging (metrics exist, rules do not) · OpenTelemetry tracing · log shipping · key-rotation job · orphan-blob and old-delivery partitioning · per-API-key rate limits · platform-operator console (fleet view).
