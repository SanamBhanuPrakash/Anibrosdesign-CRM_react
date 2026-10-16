# Anibros CRM — Wave 3 Domain Design (Contacts, Leads, Pipelines, Tasks, Notifications, Inventory, Files)

How the CRM domain modules fit together, why they are built this way, what breaks at scale, and what we would revisit. Companion to `ARCHITECTURE_V2.md` (platform), `SECURITY_MODEL.md`, `FAILURE_MODES.md` and `API_PLATFORM.md`.

## 1. Requirements

**Functional.** An agency captures enquiries, de-duplicates people, works leads through a pipeline, is reminded of follow-ups, and sells or rents inventory with pictures and a trustworthy availability history.

**Non-functional (targets used for design, not yet load-tested).**

| Dimension | Target | Where it shows up |
|---|---|---|
| Tenants | 1 000 workspaces, mostly 5–50 users | RLS on every table, `tenant_id` leads every index |
| Largest tenant | 500 k contacts · 1 M leads · 100 k properties | keyset pagination, trigram indexes, no `OFFSET`, no `COUNT(*)` on list calls |
| List latency | p95 < 150 ms server time at the largest tenant | one index-backed query per page; summary counts are separate and cacheable |
| Write correctness | no lost update, no double reminder, no duplicate contact under retries or races | ETag/`If-Match`, `FOR UPDATE SKIP LOCKED`, unique indexes, idempotency keys |
| Availability | one API replica can fail without data loss | all state in Postgres; outbox + lease queue; blob written before the row that points at it |
| Security | tenant isolation enforced by the database, not by remembering a `WHERE` | restricted DB roles + RLS + transaction-local GUCs; tests run as the restricted role |

## 2. High-level design

```
 Browser (React + MUI, TanStack Query)
   │  REST /api/v1  (JSON, problem+json, ETag, keyset cursors)      SSE hints → cache invalidation
   ▼
 API process (Express 5)                                  Worker process
 ┌───────────────────────────────────────┐      ┌─────────────────────────────────────────┐
 │ defineRoute: authn → permission+scope │      │ lease-based job queue (leads.import, …) │
 │  → zod → handler → service            │      │ 15 s tick → app.dispatch_task_           │
 │ services: contacts · leads · pipelines│      │            notifications(200)  (DEFINER) │
 │  tasks · notifications · properties   │      │ outbox consumers (realtime, later hooks) │
 │  projects · files                     │      └───────────────┬─────────────────────────┘
 │ withTenant(): BEGIN; set_config(...)  │                      │
 └───────────────┬───────────────────────┘                      │
                 ▼                                              ▼
        Postgres 17 (RLS)  ◄───────────── domain_events + NOTIFY (same transaction as the change)
                 │
        Storage adapter (LocalDisk now, S3-compatible later)  ── blobs by tenant/entity/sha256
```

Each request runs in one transaction that sets `app.current_tenant_id` / `app.current_user_id` locally; a service call writes its rows, an `audit()` row and an `emit()` event in that same transaction. If any part fails, nothing is visible.

## 3. Data model (essentials)

| Module | Tables | Notes |
|---|---|---|
| Contacts | `contacts`, `contact_identifiers`, `communication_consents` | Phone (E.164) and e-mail normalised into `contact_identifiers` with a **unique** index → 8 parallel creates give 1 contact. Merge keeps a 30-day undo. |
| Leads | `leads`, `lead_stage_history`, `activities`, `saved_views`, `import_jobs` | `version` column (bumped by trigger, **ignoring derived columns**: score, breakdown, next follow-up, last activity, first response). |
| Pipelines | `pipelines`, `pipeline_stages`, `pipeline_stage_transitions` | Stage has meaning (`open/won/lost`) and probability; transition matrix has per-edge required fields. |
| Tasks | `tasks` (+ recurrence columns), `notifications` | `remind_at`, `reminder_sent_at`, `overdue_notified_at`, `recurrence jsonb`, `recurrence_root_id`; notification `dedupe_key` is unique. |
| Inventory | `projects`, `properties`, `property_status_history`, `property_price_history`, `files` | `price_per_sqft` is a generated column. History tables are append-only (no UPDATE/DELETE grant) and written by a trigger. |

Soft delete (`deleted_at`) everywhere users can click “Archive”; partial unique indexes (`WHERE deleted_at IS NULL`) let a name or unit number be reused after archiving.

## 4. State machines

**Property availability** (`properties/status`): illegal moves return `409 INVALID_TRANSITION` with the allowed list.

```
            ┌──────────────► under_offer ◄──────────┐
available ◄─┼──────────────► reserved ◄─────────────┤        sold / rented → available
   │  ▲     │                    │                  │        requires a reason (stored in history)
   │  └─────┼── inactive ◄───────┘ (not from reserved)        sold only for listing_type=sale
   └────────┴──► sold | rented ──► available                  rented only for rent/lease
```

The reason travels to the history trigger through `set_config('app.status_reason', …, true)` — transaction-local, so it cannot leak to another request on the same pooled connection.

**Lead stage**: configurable matrix per pipeline; moving into a stage can require fields (e.g. lost reason). Reopening a closed lead to any open stage is always allowed (gates still apply). History timestamps use `clock_timestamp()` so concurrent moves sort by real order.

## 5. Reminder dispatch (the only cross-tenant job)

```
worker tick (every 15 s)
  └─ SELECT app.dispatch_task_notifications(200)          -- SECURITY DEFINER, EXECUTE granted to crm_worker only
        1. pick due tasks  (remind_at <= now AND reminder_sent_at IS NULL) …
           FOR UPDATE SKIP LOCKED   ← two workers never take the same row
        2. INSERT notification (dedupe_key = 'task:<id>:reminder:<epoch of remind_at>')
           ON CONFLICT DO NOTHING   ← retry-safe
        3. UPDATE task SET reminder_sent_at = now()
        4. same for overdue (dedupe key includes due epoch)
        5. emit notification.created (outbox) → SSE → bell updates
```

Design choices: the function is narrow (it can only insert notifications and stamp tasks), has a pinned `search_path`, and revokes EXECUTE from PUBLIC and the API role. Rescheduling a task changes the epoch in the key, so a moved reminder fires again. Recurrence is computed in the **tenant time zone** (DST-safe, month-end clamp, no backlog after downtime: the next occurrence is the first one in the future).

## 6. Files and storage

```
POST /properties/:id/files?name=…   (raw body, ≤ 10 MB, parsed after auth)
  authz → count < 40 → sniff magic bytes (JPEG/PNG/WebP/PDF; extension & client MIME ignored)
        → AV scanner hook → sha256 → dedupe per entity (unique index) →
        → storage.put(tenant/entity/sha256)  (tmp file + atomic rename)  → INSERT files row → audit/emit
GET  /files/:id   → RawReply + nosniff + sandbox CSP + Cache-Control: private, no-cache + ETag = sha256
```

* **Order of effects**: blob first, row second. A crash leaves an orphan blob (harmless, sweepable), never a row pointing at nothing.
* **Key safety**: storage keys are generated server-side; the adapter rejects traversal.
* **Why originals are served**: simple and correct. Thumbnails (sharp + cache by sha256) are the next step once listing pages show > 24 images each.
* **Swap to S3**: implement `Storage` (`put/get/delete`) against an S3-compatible API; keys, sniffing and DB model do not change. Serve via short-lived signed URLs behind the same authorisation check.

## 7. Concurrency, caching, consistency

* **ETag**: `makeEtag(version, …derived)` → `"7.3fa91c0e"`. The fingerprint covers derived fields that do not bump `version` (e.g. lead score), which fixed a stale-UI bug where a `304` served an old score. `If-Match` accepts `"7"`, `W/"7"`, `"7.fp"`; a mismatch is `412` and the UI explains it.
* **`Cache-Control: no-store`** on all `/api` JSON; only file downloads are cacheable (`private, no-cache` + ETag, so the browser revalidates cheaply).
* **Realtime**: server pushes *hints* (“lead 123 changed”); clients invalidate TanStack Query keys. No client state is trusted from the push itself.
* **Idempotency**: `Idempotency-Key` on POST create endpoints; replays return the original response.

## 8. Scale estimates and where it bends

| Concern | Estimate | Plan |
|---|---|---|
| Reminder scan | 1 M tasks, ~1 % with a pending reminder | partial index `idx_tasks_reminder_due` on `(remind_at)` limited to unsent, open, live tasks; 200/tick = 800 reminders/min per worker, scale by adding workers (SKIP LOCKED) |
| Notifications | 50 users × 20/day × 1 000 tenants ≈ 1 M rows/day | monthly partitions + 90-day retention (Wave 3.4/5); unread index per user |
| Lead list | keyset on sort signature + trigram search | covered by composite indexes; avoid offset; count only in the summary endpoint |
| Files | 100 k properties × 10 images × 1 MB = 1 TB | object storage + thumbnails + lifecycle rules; DB holds metadata only (~100 B/row) |
| Hot tenant | one tenant doing a 100 k-row CSV import | async job in worker, 100-row batches with per-batch commit, progress polled; does not hold the API pool |
| Connection pool | API pool default 20 (`DB_POOL_MAX`) | `SERVICE_BUSY` + `Retry-After` on exhaustion; PgBouncer (transaction mode) is compatible because all GUCs are transaction-local |

## 9. Anticipated failures (full table in `FAILURE_MODES.md` F24–F33)

Duplicate reminders · reminders after a reschedule · stale 304 · disguised upload · blob/row crash window · concurrent status change · double-click create · two workers on one row · SMTP down in dev · cross-tenant leakage via DEFINER function.

## 10. Trade-offs made

| Decision | Alternative | Why this way | Revisit when |
|---|---|---|---|
| Postgres is the queue and the outbox | Redis/Kafka | one transactional store, exactly-once effects, fewer moving parts for a small team | > ~2 k jobs/s or fan-out to many consumers |
| Reminders via polling tick | per-task timers / delayed jobs | trivially correct after crashes; 15 s precision is fine for CRM | sub-second precision or > 10 M pending reminders |
| Local disk storage in dev | S3 now | no cloud dependency to run locally; adapter makes swap mechanical | first production deployment (Wave 9) |
| SECURITY DEFINER for the dispatcher | worker with `BYPASSRLS` | blast radius = two statements instead of every table | if more cross-tenant jobs appear, move them to a dedicated schema |
| Keyset cursors tied to sort | offset pagination | stable under writes, O(1) deep pages | never; but adds a rule: new sort keys need an index and a cursor key |
| Derived fingerprint in ETag | bump `version` on derived changes | avoids spurious 412s while staying correct | if derived columns become user-editable |

## 11. Not done yet (explicit)

Task grouping uses the browser day, the server uses workspace time zone · mixed-currency forecast sums as stored · no thumbnails · no orphan-blob sweep · notifications not partitioned · mentions/attachments on lead activities (3.4) · viewings (3.7) · matching (3.8) · custom fields (3.9) · runtime DB role still privileged until the legacy routes are rebuilt.
