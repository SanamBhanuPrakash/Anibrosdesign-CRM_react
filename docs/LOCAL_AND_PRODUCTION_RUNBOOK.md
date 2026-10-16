# ANIBROS CRM — LOCAL DEVELOPMENT AND PRODUCTION RUNBOOK

## 1. Local Development Setup

The README has the short version. In full:

### Prerequisites
- Node.js 24
- Docker with Compose (PostgreSQL 17 and Mailpit run in containers). No Python is needed.

### Step 1: Configure
```bash
npm ci
cp .env.native.example .env.native    # gitignored; edit as needed
```
Every variable is documented in `.env.native.example` and validated at start-up by `server/src/platform/config.ts`.

### Step 2: Start PostgreSQL and the local mail inbox
```bash
docker compose up -d postgres mailpit
# PostgreSQL 17 on 127.0.0.1:5442 (not 5432, so it never collides with another local PostgreSQL)
# Mailpit inbox: http://127.0.0.1:8025 (SMTP on 127.0.0.1:1025)
```

### Step 3: Migrate and create the restricted database roles
```bash
npm run db:migrate                    # applies database/migrations/*.sql in order; refuses if an applied file was edited
npm run db:provision -- --write-env   # creates crm_api_login / crm_worker_login; appends RESTRICTED_* URLs to .env.native
```
Point `DATABASE_URL` and `WORKER_DATABASE_URL` at the `RESTRICTED_*` values so local development runs with row-level
security enforced, exactly as production does.

Before migrating a database that holds real data, run `npm run db:report-integrity` (read-only). Migration 021
deliberately stops, changing nothing, if it finds custom-field values linked across workspaces.

### Step 4: Start the three processes
```bash
npm run api:dev                                   # API, http://127.0.0.1:4000 (watch mode)
npm run worker:dev                                # background jobs (e-mail, imports, lead-source processing, heartbeat)
npm run dev -- --host 127.0.0.1 --port 5174       # web app; proxies /api to the API
```
`npm run server:dev` runs the API and the worker in one process, for convenience only.

### Step 5: Verify
```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run api:check
```

---

## 2. Production Deployment & Operations

Status: **there is no container image or hosted environment yet** (planned in Slice 8 of `docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md`). What follows is the procedure that was exercised on a workstation against a disposable database (production boot drill, restore drill, clean-checkout CI simulation: see `docs/audit/2026-10-14/16_RELEASE_READINESS_PASS.md`). Nothing here has been run on a real server.

### 2.1 Architecture
- Static web app (`npm run build` → `dist/`) behind a TLS-terminating proxy that also forwards `/api` and the `/api/realtime` WebSocket to the API.
- API (`server/src/api.ts`) and worker (`server/src/worker.ts`) are separate processes (`server/src/server.ts` runs both in one, for small installs). The API is stateless; rate-limit state is in memory, so run **one** API replica until a shared store exists.
- PostgreSQL 17, not exposed to the internet. Three roles: a **migrator** (owner, DDL only, never used at runtime), the **API** role and the **worker** role (both restricted, row-level security enforced).

### 2.2 Required production environment
The process refuses to start (and prints which variables, never their values) unless these are set; see `server/src/platform/config.ts`.
| Variable | Rule |
| --- | --- |
| `NODE_ENV=production` | |
| `DATABASE_URL`, `WORKER_DATABASE_URL` | the restricted API and worker roles, and they must differ. The boot **fails** if the role is a superuser, has BYPASSRLS or owns tables |
| `MIGRATOR_DATABASE_URL` | the owner role; used only by `db:migrate` and `db:provision` |
| `COOKIE_SECRET` | at least 32 random characters, not the dev value |
| `FIELD_ENCRYPTION_KEYS` | `k1:<64 hex>` (first entry is active; keep old keys to decrypt). All-zero key refused |
| `PUBLIC_APP_URL` | the https origin of the web app (used for links in email and as the only CORS origin) |
| `SMTP_HOST` (+ port, user, pass) | verification, reset and invitation mail |
| `METRICS_TOKEN` | at least 16 characters; `/metrics` answers 401 without it |
| `ALLOW_PRIVILEGED_RUNTIME_ROLE` | must be unset; production refuses it |

### 2.3 Deploy
1. **Preflight** (on the commit being released): `npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run api:check && npm audit --omit=dev`.
2. **Back up first** (section 2.5). Do not migrate without a restorable backup taken minutes earlier.
3. **Migrate** with the owner role: `NODE_ENV=production npm run db:migrate`. It is additive and idempotent, verifies the checksum of every earlier migration and refuses if an applied file was edited. For a database that already holds real data run `npm run db:report-integrity` (read-only) before 021.
4. **Provision roles** once per environment: `DB_API_PASSWORD=<secret> DB_WORKER_PASSWORD=<secret> npm run db:provision` with `MIGRATOR_DATABASE_URL` set. It creates or refreshes the two restricted login roles (`--write-env` is refused in production). Take the passwords from your secret manager and build `DATABASE_URL` / `WORKER_DATABASE_URL` from them.
5. **Start** `tsx server/src/api.ts` and `tsx server/src/worker.ts` (after `npm ci --omit=dev`; `tsx` is a production dependency) under a process manager, and serve `dist/` from the proxy.
6. **Verify**: `curl -f https://<host>/healthz` (process alive), `curl -f https://<host>/readyz` (database connected; the body reports `schemaVersion`, which must equal the newest file in `database/migrations/`), `curl -i https://<host>/metrics` must answer 401 without the token. Then sign in, open Monitor and confirm the worker heartbeat is healthy.

### 2.4 Rollback
- **Application**: redeploy the previous commit. Migrations are additive, so the previous code runs against the newer schema (every migration since 021 was tested as an upgrade with data in place).
- **Database**: there is no down-migration. To undo a migration, restore the backup taken in 2.3 step 2 (section 2.6). Anything written after the backup is lost, so stop the API and worker first and decide what to replay.

### 2.5 Back up
```bash
pg_dump -h <host> -U <owner> -Fc -f anibros_$(date +%Y%m%dT%H%M%S).dump <database>
```
Custom format, restorable with `pg_restore`. Uploaded files live in `STORAGE_DIR`: back that directory up with the same schedule (the database holds only their metadata). Dumps contain customer data and encrypted integration credentials: store them encrypted, off the database host, and keep the `FIELD_ENCRYPTION_KEYS` in a **different** place (a backup is useless without the key and dangerous together with it). **No scheduled or off-site backup exists yet**; that is a Slice 8 item.

### 2.6 Prove a backup restores (the restore drill)
```bash
npm run db:restore-drill      # PG_BIN=/path/to/postgres/bin BACKUP_DIR=./backups when the tools are not on PATH
```
Takes a dump of the configured database, restores it into a disposable database on the same server, compares every table's row count, the migration ledger and the number of indexes, policies and functions, then drops the disposable database and keeps the dump. It exits 0 only if everything matches. Last run (2026-10-15, developer database, 58 tables, about 1,600 rows): dump 0.3 s, restore 2.3 s, all counts equal, **PASS**. Run it on every release candidate and monthly.

To restore for real: create an empty database, `pg_restore -d <new database> --no-owner --exit-on-error <dump>`, run `npm run db:provision` to recreate the restricted roles' grants if the server is new, point `DATABASE_URL` at it, and check `/readyz`.

### 2.7 Monitoring (what exists)
`/healthz`, `/readyz`, `/metrics` (Prometheus, request rate/errors/duration and DB pool), structured JSON logs with a correlation id on every request, the in-app Monitor (worker heartbeat, delivery failures, audit trail). **Not built yet:** alert rules and paging, log shipping, uptime checks and a load test (Slice 8).
