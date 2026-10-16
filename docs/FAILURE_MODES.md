# Anibros CRM — Failure Modes & Mitigations

"What will go wrong, how will we know, what happens to the user, and what proves it." Updated per wave. Status: ✅ proven by a test · 🟡 implemented, not yet load/chaos-tested · ⏳ planned.

| # | Failure | Impact if unhandled | Mitigation | Detection | Status |
|---|---|---|---|---|---|
| F1 | Provider sends the same webhook twice / out of order | Duplicate leads | Unique `(endpoint, provider_event_id)`; idempotent processor; contact match by normalised keys | `webhook.dedup` counter | ⏳ Wave 4 |
| F2 | Worker crashes mid-job | Job lost or stuck forever | Lease + heartbeat; reaper returns expired leases; ownership-checked completion (zombie cannot overwrite) | `jobs_queue_depth{running}`, oldest-age gauge | ✅ `platform-db` (lease recovery, zombie ignored, poison dead-letters) |
| F3 | Poison message | Blocks the queue | Bounded attempts → dead-letter; `SKIP LOCKED` lets others pass; permanent errors skip retries | dead-letter count alert | ✅ |
| F4 | Two workers/dispatchers race | Double processing | `SKIP LOCKED` claims; cursor row lock per event consumer | — | ✅ (60 jobs × 2 runners exactly once; 2 dispatchers no duplicates) |
| F5 | Event committed out of id order (late commit) | Consumer cursor skips an event forever | Cursor is `(tx_id,id)` bounded by `pg_snapshot_xmin` — only finished transactions are read | consumer lag gauge | ✅ (late-commit test) |
| F6 | Rolled-back transaction after notifying clients | Phantom updates | Event row + NOTIFY are transactional (delivered at COMMIT) | — | ✅ |
| F7 | WebSocket drops / API restarts / DB restarts | Stale UI | Client reconnect with jittered backoff; `hello`/`resync` ⇒ refetch everything; fallback polling in legacy pages | `ws_connections` | ✅ server · 🟡 browser reconnect (manual journey) |
| F8 | One slow browser tab | Server memory growth | Drop sockets with > 1 MB buffered; per-user cap 6; global cap | `ws_connections` | ✅ (cap) · 🟡 (slow consumer) |
| F9 | Session revoked/user deactivated while connected | Access continues | HTTP re-validates every request; WS re-validates every 30 s | — | ✅ |
| F10 | New query forgets `tenant_id` | Cross-tenant leak | RLS returns 0 rows / 403 | security log `Access denied` | ✅ (restricted role suites) |
| F11 | Noisy tenant monopolises DB | Everyone slow | Role-level `statement_timeout`, `lock_timeout`, idle-in-tx timeout; pool back-pressure → 503 + Retry-After; (per-tenant limiter Wave 4) | pool waiting gauge, p95 | 🟡 |
| F12 | Pool exhaustion | Hung requests | `connectionTimeoutMillis` → mapped to 503 `SERVICE_BUSY` with `Retry-After` | `db_pool_connections{state=waiting}` | ✅ (mapping) · ⏳ load test |
| F13 | Concurrent last-owner removal | Workspace without owner | Row-lock all owners before counting | — | ✅ |
| F14 | Double-click / client retry on create | Duplicate record | `Idempotency-Key` replay; unique constraints | — | ✅ (API keys) · rolled out per module |
| F15 | Verification/reset link replayed or raced | Account takeover / double use | Atomic single-use consumption; reset revokes sessions | — | ✅ |
| F16 | SMTP outage | Signup blocked / email lost | Email via durable job with retries; signup never calls SMTP inline | `jobs{type=mail.send,dead}` | ✅ (queue) · 🟡 (real SMTP) |
| F17 | Migration fails half-way | Broken schema | One transaction per migration; advisory lock; checksum guard; clean-bootstrap test in CI | CI | ✅ |
| F18 | Bad deploy of API contract | Clients break | Additive-only `/v1`; generated OpenAPI + `api:check` in CI | CI | ✅ |
| F19 | Provider outage (Meta/Google/WhatsApp) | Lost conversions/messages | Outbox + retries with jitter + circuit breaker; visible degraded state | integration health | ⏳ Wave 4 |
| F20 | Clock skew / DST for viewings | Wrong appointment times | Store UTC + IANA tz; interval math in DB (`tstzrange`, exclusion constraints) | — | ⏳ Wave 3 |
| F21 | Disk/WAL growth from logs/events | Outage | Retention jobs (events 14 d, logs 30 d, jobs 7/30 d, tokens, sessions); partitioning planned | table size alerts | 🟡 job code ✅, scheduling in prod ⏳ |
| F22 | Browser tab renders a broken page | White screen | Route-level `ErrorBoundary` with reset on navigation | client error log | ✅ (manual) |
| F23 | Dev server floods browser with module requests | Dev crash | Vite pre-bundles all deps up-front (found and fixed during E2E) | — | ✅ |
| F24 | Reminder sent twice (two workers, retry after crash) | Duplicate bells/e-mails | `FOR UPDATE SKIP LOCKED` + unique `notifications.dedupe_key` (`ON CONFLICT DO NOTHING`) + `reminder_sent_at` stamped in the same statement | `jobs`/tick log | ✅ `tasks` (concurrent dispatch) |
| F25 | Task rescheduled after its reminder fired | Never reminded again | Dedupe key includes the reminder/due epoch; rescheduling clears `reminder_sent_at` | — | ✅ |
| F26 | Worker down for hours, recurring tasks pile up | Backlog flood on restart | Next occurrence is the first one in the future; no catch-up copies | — | ✅ `tasks-units` |
| F27 | DST change / month-end for recurring tasks | Task lands an hour off or on a day that does not exist | Recurrence computed in the tenant IANA zone; day clamped to month length | — | ✅ `tasks-units` |
| F28 | Browser shows an old lead after a background update (304 on version-only ETag) | Agent acts on stale score/follow-up | ETag carries a fingerprint of derived fields; `/api` is `no-store` | — | ✅ regression test in `leads` |
| F29 | Two people edit the same lead/property/project | Lost update | `If-Match` → `412 PRECONDITION_FAILED`; UI tells the user to reopen | `http 412` counter | ✅ |
| F30 | Upload is not what its name says (HTML renamed `.png`, SVG with script) | Stored XSS, malware hosting | Content sniffing on magic bytes (JPEG/PNG/WebP/PDF only), AV hook, `nosniff` + sandbox CSP on download, per-file size and count limits | `415` rate | ✅ `inventory` + browser journey |
| F31 | Crash between writing the blob and the DB row | Row pointing at a missing file | Blob first, row second: worst case is an orphan blob; per-entity SHA-256 dedupe makes the retry idempotent | orphan-sweep report (planned) | 🟡 sweep ⏳ |
| F32 | Concurrent status changes on one property (two agents mark “sold” and “under offer”) | Inconsistent history | Row lock + transition check inside the transaction; trigger writes history in the same transaction | — | ✅ `inventory` |
| F33 | Cross-tenant reminder job leaks data | Tenant isolation broken | The only cross-tenant path is one narrow `SECURITY DEFINER` function (pinned `search_path`, EXECUTE only for `crm_worker`, inserts notifications only) | privilege test | ✅ `tasks` (API role denied) |
| F34 | Dev sign-up e-mail never arrives | Developer cannot verify the account | Dev SMTP goes to Mailpit (`localhost:8025`); API logs the transport at start-up | boot log `mail.transport` | ✅ |
| F35 | Verification link points at an address nothing listens on (Vite bound to IPv6 `[::1]` only, link built with `127.0.0.1`) | “Site can’t be reached”; user cannot verify | Default app origin is `localhost` (resolves to IPv4 or IPv6); explicit `PUBLIC_APP_URL` always wins | manual / journey | ✅ (found and fixed 2026-10-14) |
| F36 | Provider redelivers the same lead (Meta/Google retry, network blips) | Duplicate leads | Unique `(endpoint, provider event id)` + `ON CONFLICT DO NOTHING`; only a new row enqueues a job | `inbound_events` outcomes | ✅ `inbound` |
| F37 | API dies between receiving a delivery and answering | Lead lost, or provider thinks it was delivered | Store first, answer `200` after the commit; before the commit the provider gets no `200`/a `503` and retries | provider retry logs | ✅ by construction · 🟡 chaos test |
| F38 | Worker down while leads arrive | Leads sit unprocessed | Deliveries and jobs are durable; Monitor shows the worker heartbeat failing and the queue age; processing resumes on restart | Monitor → Health, `jobs_queue_depth` | ✅ |
| F39 | Meta page access token expired or lacks permission | Every Meta lead fails | Classified as permanent: delivery goes to `needs_review` with the Meta message; banner on Lead sources + Monitor; **Retry** after fixing | delivery log | ✅ |
| F40 | Meta Graph API slow or down | Lead processing stalls | Classified as transient: job retries with exponential backoff + jitter, delivery stays `received`; no failure recorded until retries are exhausted | job `last_error` | ✅ |
| F41 | Person submits two forms or the same form twice | Two open leads for one person | Duplicate guard: second becomes a timeline note on the open lead and the owner is notified | outcome `duplicate` | ✅ |
| F42 | Submission has no phone or e-mail, or the workspace has no default pipeline | Lead silently dropped | `needs_review` with the reason; Retry/Ignore | delivery log, banner | ✅ |
| F43 | Bot floods a website form | Spam leads, cost | Allowed origins, honeypot (silent drop), per-visitor limit (8 burst, 1 per 5 s), per-source and per-IP limits | `429` rate, security events | ✅ |
| F44 | Secret leaks (screenshot, chat) | Anyone could forge leads for that source | Rotate (Google/generic) or replace (Meta) invalidates the old one at once; secrets are shown once and stored encrypted | audit `lead_source.rotate_secret` | ✅ |
| F45 | Scanner hammers a known endpoint id with bad signatures | Log table flood, noise hides real events | Throttled to 1 activity-log row per minute per source with a suppressed count; stdout still has every line; rate limits apply | activity log | ✅ |
| F46 | Logging backend (DB) is slow or down | Observability takes the API down | Bounded in-memory buffer (drops oldest, counts), batched off the request path, failures only logged to stdout | `eventLogStats()` | ✅ |
| F47 | Worker silently stops (process alive, loop dead) | Emails, reminders, intake stall unnoticed | Heartbeat written every 15 s from the loop itself; Monitor warns at 45 s, fails at 120 s | Monitor | ✅ |
