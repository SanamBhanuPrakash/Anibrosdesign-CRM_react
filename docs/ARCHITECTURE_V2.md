# Anibros CRM — Architecture V2 (target design)

Status: **DESIGN — being implemented per `Claude_plan.md`.** Sections marked ✅ exist in code and are verified; everything else is target state.
Audience: engineers and operators of Anibros CRM. Supersedes `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` (kept for history).

---

## 1. Requirements

### 1.1 Functional (summary)
Multi-tenant real-estate CRM: lead capture (ads, forms, portals, CSV, API) → qualification → matching → viewings → negotiation → booking; contacts, inventory, tasks, communications, automation, analytics, attribution, public API + webhooks, admin/security, operations center.

### 1.2 Non-functional
| Attribute | Target | Notes |
|---|---|---|
| Availability | 99.9 % API (≈ 43 min/month) | stateless API replicas, DB failover |
| Latency | read p95 < 200 ms, write p95 < 400 ms | measured at API edge, excl. network |
| Realtime | commit → UI p95 < 2 s | cursor replay on reconnect |
| Ingest | webhook ack < 300 ms; lead visible p95 < 10 s | ack only after durable commit |
| Durability | RPO ≤ 5 min (WAL archiving), RTO ≤ 30 min | proven by restore drill |
| Isolation | zero cross-tenant reads/writes | DB-enforced (RLS) + API-enforced + tested |
| Security | OWASP ASVS L2 subset | see `SECURITY_MODEL.md` |
| Cost | start on 1 small VPS / 1 PG; scale only on measured need | no premature Redis/K8s |

### 1.3 Constraints
Small team, existing stack (Node 20+/TS, Express 5, pg, React 18, MUI 9, PG 17), India-first (INR, DPDP), no mandatory paid vendor.

### 1.4 Load estimate (T1 → T2)
- 500 users, 20 % concurrent → 100 sessions; ~1 req/3 s each → **~35 rps** avg, 5× burst ≈ 175 rps.
- Lead ingest: 50 tenants × 200 leads/day = 10 k/day ≈ 0.12/s avg; campaign burst 50/s for minutes — absorbed by durable inbox.
- Storage: 1 M leads × ~2 kB + activities 20 M × ~0.5 kB ≈ 12 GB/yr. Fits one PG; partition activities/logs monthly.
- WS: 100–1 000 concurrent sockets per API node (≈ 50 kB each) — trivial.
- **Bottleneck order:** (1) DB connections → PgBouncer, (2) unindexed search → trigram/FTS, (3) dashboard aggregates → rollups, (4) fan-out WS → Redis pub/sub only if > 5 k conns.

---

## 2. High-level design

### 2.1 Processes
| Process | Responsibility | Scaling | DB role |
|---|---|---|---|
| `api` | HTTP, WS gateway, authN/Z, use-cases | horizontal, stateless | `crm_app` (RLS enforced) |
| `worker` | jobs, inbound/outbound webhook processing, automation, email, scheduled tasks | by queue depth | `crm_worker` (cross-tenant only on queue tables) |
| `web` | static SPA | CDN/nginx | — |
| `migrator` | DDL, one-shot at deploy | n/a | `crm_migrator` (owns objects) |

### 2.2 Request pipeline (API)
```
requestId/trace ─► security headers ─► CORS ─► rate limit(ip) ─► body parse (raw kept for /hooks)
 ─► authN: session cookie | API key (hashed) ─► tenant resolve (explicit, verified membership)
 ─► authZ: permission matrix (resource:action, scope own|team|all) ─► zod validate(params,query,body)
 ─► route ─► SERVICE ─► REPOSITORY ─► db.withTenant(ctx, tx => …)   (SET LOCAL app.tenant_id, app.user_id)
 ─► emit domain events + audit INSIDE the same tx ─► commit ─► problem+json | envelope
```

### 2.3 Layering rules (enforced by lint rule / architecture test)
- `routes/*` may import only `services/*`, `platform/http`, schemas. **No SQL, no `pool`.**
- `services/*` own transactions and authorization scope; call `repositories/*` and `events.emit`.
- `repositories/*` contain SQL only; receive a transaction client; never open their own.
- Anything that touches the DB goes through `platform/db` (`withTenant`, `withSystem`). Direct `new Pool` outside it is a CI failure.

### 2.4 Event spine (transactional outbox)
Single source of truth for "something happened":
```
service tx: INSERT business rows + INSERT domain_events(tenant_id,type,aggregate,payload,correlation_id)
                                            │ AFTER INSERT trigger → pg_notify('crm_events', id)
   ┌────────────────────────────────────────┼─────────────────────────────────────────┐
   ▼ realtime hub (api)                      ▼ dispatcher (worker)                      ▼ audit/other
 reads events > client cursor        per-consumer cursor (event_consumers):        (future: search index,
 pushes {type,id,cursor}             automation • outbound webhooks • notifications  analytics sink)
 client refetches via API (authorized)       • conversions • email
```
- `domain_events.id` is a `bigint identity` = **global monotonic cursor**. WS clients resume with `?since=<cursor>`; if gap > retention, server sends `resync` → client invalidates caches.
- NOTIFY carries only the id (≤ 8 kB limit, no PII). Authorized data is always loaded via API/RLS.
- Delivery semantics: **at-least-once** per consumer, consumers idempotent (event id as dedupe key).
- Replaces: direct `realtimeHub.broadcast` after commit and per-table NOTIFY triggers (defect C9).

### 2.5 Jobs & queues
One generic `jobs` table (type, payload, tenant_id, run_at, attempts, max_attempts, lease_until, locked_by, status, dedupe_key, last_error) + the two domain queues `webhook_inbox`, `outbox_events` using the same lease protocol:
```
claim:  UPDATE … SET status='running', lease_until=now()+ttl, locked_by=$w
        WHERE id IN (SELECT id FROM jobs WHERE status IN ('queued','retry') AND run_at<=now()
                     ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *
work:   each job in its OWN transaction (or savepoint); extend lease if long
finish: success → 'done' • transient → 'retry', run_at = now()+backoff*jitter • exhausted → 'dead' + alert
reaper: every 30 s: running AND lease_until < now() → back to retry (attempts+1)
```
No transaction is held open across network I/O.

### 2.6 Multi-tenancy & data isolation (defense in depth)
1. **API**: tenant derived from verified membership, never from body. Header `X-Tenant-Id` only *selects among* the user's memberships.
2. **DB (RLS)**: every tenant table has `tenant_id NOT NULL`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy `USING/WITH CHECK (tenant_id = app.tenant_id())` `TO crm_app`. `app.tenant_id()` reads a transaction-local GUC set by `db.withTenant`. No context ⇒ **zero rows**.
3. **Constraints**: composite FKs `(id, tenant_id)` forbid cross-tenant references.
4. **Roles**: `crm_app` is not owner, not superuser, no BYPASSRLS, no DDL. `crm_worker` gets cross-tenant policies only on queue tables, and sets tenant context to touch business tables.
5. **Tests run as `crm_app`** — a forgotten filter fails CI instead of leaking.
6. **Noisy neighbor**: per-tenant token-bucket + in-flight cap; `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` on roles.
7. **Future sharding**: `db.withTenant` resolves tenant → DSN; moving an enterprise tenant to its own database is a config change, not a code change.

### 2.7 AuthN / AuthZ
- Sessions: opaque 256-bit token, SHA-256 at rest, HttpOnly + SameSite=Lax (+ `__Host-` prefix and Secure in prod), idle (12 h) + absolute (14 d) timeouts, rotation on privilege change, list/revoke. One-query validation on every request, **deliberately uncached** (a cache would delay revocation/deactivation; the query is a single indexed lookup).
- API keys: `crm_live_<id>_<secret>`, only hash stored, scopes (`leads:read`, …), optional expiry/IP allow-list, per-key rate limit.
- MFA: TOTP (RFC 6238) + 10 single-use recovery codes; step-up for API-key creation, role change, export.
- Authorization: central **permission matrix** (`platform/authz/matrix.ts`) = single source of truth, used by routes, services (scope filters), UI capability endpoint, and docs. Scopes: `own` (assigned to me), `team`, `all`.

### 2.8 Data model (core, additions in **bold**)
```
users ─< tenant_memberships >─ tenants >─ organisations
tenants ─< branches, teams(+members), pipelines ─< stages ─< stage_transitions
tenants ─< contacts (+ **contact_identifiers** normalized email/phone) ─< leads >─ stage/owner
leads ─< lead_stage_history, activities(partitioned), tasks, viewings >─ properties >─ projects
leads ─< marketing_attribution(touches)    leads/contacts ─< **tags**, **notes**, **attachments**
**saved_views**, **custom_field_definitions** (values in JSONB w/ GIN), **email_templates**, **messages**
**domain_events**, **jobs**, webhook_inbox, outbox_events, **idempotency_keys**
**api_keys**, **webhook_subscriptions** ─< **webhook_deliveries**, **integration_endpoints**(per-tenant secret)
audit_logs(partitioned), operational_logs(partitioned), system_health, incidents, **mfa_factors**, **sessions(+device,last_seen)**
```
Conventions: UUIDv7-style ids where ordering helps (else `gen_random_uuid()`), `created_at/updated_at timestamptz`, soft delete (`deleted_at`) on leads/contacts/properties with partial indexes, money as `numeric(14,2)` + ISO currency, all times UTC with IANA tz on tenant/user.
Indexes: every FK, `(tenant_id, created_at DESC, id)` for keyset lists, `pg_trgm` GIN on name/email/phone/title for search, `tsvector` for notes, GIN on `custom_fields`, partial indexes for open tasks/active leads.
Partitioning: `activities`, `audit_logs`, `operational_logs`, `domain_events`, `webhook_deliveries` by month (declarative), retention jobs drop old partitions.

### 2.9 API design
- REST, JSON, `/api/v1/...`, plural nouns, `PATCH` for partial update, **keyset pagination** (`?limit=50&cursor=…` → `{data, page:{next, hasMore}}`), filtering via `filter[field]=…`, sorting `sort=-created_at`, sparse `fields=`.
- Errors: RFC 9457 `application/problem+json` `{type,title,status,detail,code,requestId,errors[]}`.
- Idempotency-Key on all non-idempotent POSTs; `ETag`/`If-Match` on PATCH for lost-update protection.
- Rate-limit headers (`RateLimit-*`, `Retry-After`).
- OpenAPI 3.1 generated from the same zod schemas used for validation — **no hand-written drift**.
- Details: `docs/API_PLATFORM.md`.

### 2.10 Frontend
React 18 + TS + Vite · MUI v9 + Emotion · TanStack Query (server state, optimistic updates) · React Router 7 (lazy routes) · React Hook Form + zod · MUI X (DataGrid/Charts/Date pickers). Realtime = one WS hook that **invalidates query keys**; UI never trusts WS payloads for data. Details: `docs/UI_DESIGN_SYSTEM.md`.

---

## 3. Deep dives

### 3.1 Why enforce RLS if the API already filters?
Because a single missed `WHERE tenant_id` in 200+ queries is the most likely cross-tenant breach. RLS turns that bug from *data leak* into *empty result / permission error*. Cost: every query must run inside a context-setting transaction (1 extra round-trip, mitigated by sending `BEGIN; set_config…` in one simple-protocol message, and by PgBouncer transaction pooling being compatible with `SET LOCAL`).

### 3.2 Lead ingestion (the money path)
```
Meta/Google/Form ──► POST /hooks/{endpointId}   (no auth cookie; secret/HMAC per endpoint)
  1 resolve endpoint → tenant (DB lookup by id; unknown ⇒ 404, no body echo)
  2 verify signature over RAW body (timing-safe) ; reject ⇒ 401 (+ security log, rate-limit by ip)
  3 INSERT webhook_inbox(endpoint_id, provider_event_id, raw_ref) ON CONFLICT DO NOTHING   ← durable
  4 respond 200 within 300 ms
worker: claim → normalize → (Meta: fetch lead by leadgen_id) → match/create contact (normalized keys)
        → create lead (+attribution touch, first activity) → emit lead.created → mark done
        failures: retry w/ jitter → dead-letter; unmapped/invalid ⇒ quarantine (never "guess a tenant")
```

### 3.3 Viewing scheduling (race-proof)
Store `during tstzrange` generated from `scheduled_at, duration`; two **exclusion constraints** `EXCLUDE USING gist (property_id WITH =, during WITH &&) WHERE (status IN ('scheduled','confirmed'))` and same for `agent_id`. Concurrency is then guaranteed by the database, not by application locks (needs `btree_gist`).

### 3.4 Search
`pg_trgm` GIN for fuzzy name/email/phone/title; weighted `tsvector` for notes/descriptions; one `/search?q=` endpoint fans out to ≤5 indexed queries, permission-filtered, limit 5 per type. Revisit: OpenSearch/Meilisearch when > 10 M searchable rows or typo-tolerance/ranking needs exceed PG.

### 3.5 Error handling & retries
- Inbound: never 5xx-then-lose; durable first. Outbound: timeouts (connect 3 s, total 10 s), retries only for idempotent requests or with provider idempotency key, exponential backoff + full jitter, circuit breaker per (tenant, provider) with half-open probes, bounded concurrency.
- API: domain errors map to 4xx problem types; unexpected → 500 with requestId only; DB `40001/40P01` retried once.
- Realtime: client backoff 1→30 s with jitter; on reconnect `since=cursor`.

### 3.6 Caching
In-process LRU for static lookups (sessions are intentionally not cached) (pipelines/stages/permissions, invalidated by event). HTTP `ETag` on lists. Redis introduced only when: shared rate-limit counters across ≥2 API nodes must be exact, or WS > 5 k. Never cache tenant data without tenant in the key.

---

## 4. Scale & reliability
- **Horizontal**: API & worker stateless; WS fan-out via each node's own `LISTEN` (no sticky sessions needed). Load balancer: round-robin + health `/readyz`.
- **DB**: PgBouncer (transaction mode), primary + streaming replica (reports, exports use `withReadReplica`), WAL archiving, `pg_stat_statements`, autovacuum tuned for hot tables (`jobs`, `domain_events`, `sessions`).
- **Failover**: managed HA or Patroni; app retries connection with backoff; readiness fails fast so LB drains.
- **Backpressure**: pool wait queue bounded → 503 `Retry-After`; job claim batch sizes adaptive; per-tenant concurrency caps.
- **Deploy**: expand → migrate → contract; backward-compatible API within a `v1`; feature flags; rolling restarts with drain (stop accepting, finish in-flight ≤30 s, WS close 1001).
- **Observability**: JSON logs (requestId, tenantId, userId, route, ms), Prometheus RED metrics + `db_pool_*`, `jobs_queue_depth{type}`, `jobs_oldest_age_seconds`, `ws_connections`, `event_consumer_lag`. SLO burn-rate alerts: API error rate, p95 latency, queue age, consumer lag, webhook ack failures, backup age.

## 5. Trade-offs
| Decision | Chosen | Alternative | Why / revisit when |
|---|---|---|---|
| Architecture | modular monolith, 2 processes | microservices | team size; extract worker-heavy modules only when independently scaled |
| Queue | Postgres `SKIP LOCKED` | Redis/BullMQ, SQS, Kafka | transactional with business data, no extra infra; revisit > ~1 k jobs/s |
| Realtime | LISTEN/NOTIFY + cursor | Redis pub/sub, Kafka | simplest correct; revisit > 5 k sockets |
| Tenancy | shared schema + RLS | schema/DB per tenant | cost & ops; DB-per-tenant path kept open via DSN router |
| IDs | uuid | bigint | safe to expose, shardable |
| Auth | server sessions | JWT | instant revoke, no token theft window; API keys cover machine access |
| Search | PG trgm/FTS | OpenSearch | zero infra at T1 |
| UI | MUI | Tailwind+shadcn | owner decision; MUI X grids/charts reduce custom code |

## 6. ADR index (decisions in this doc)
ADR-101 modular monolith + 2 processes · ADR-102 enforced RLS with three DB roles · ADR-103 domain_events spine + cursor realtime · ADR-104 Postgres job leases · ADR-105 keyset pagination · ADR-106 RFC 9457 errors · ADR-107 OpenAPI from zod · ADR-108 exclusion constraints for scheduling · ADR-109 session+API-key auth, MFA TOTP · ADR-110 MUI only, Fontsource fonts · ADR-111 subscriptions deferred (`SUBSCRIPTION_DESIGN.md`).

## 7. What to revisit as it grows
Read replica routing · partition-by-tenant or Citus · dedicated search · Redis · multi-region · per-tenant encryption keys (BYOK) · data warehouse export (CDC) for analytics.
