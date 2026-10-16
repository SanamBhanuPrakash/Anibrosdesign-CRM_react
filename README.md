# Anibros CRM

A multi-tenant CRM for real-estate sales teams: leads and pipelines, contacts, tasks and reminders, property inventory,
viewings, lead capture from web forms, Meta and Google, and an operations monitor.

Stack: Node 24, Express 5, PostgreSQL 17 with row-level security, React 19, MUI 9, Vite.

> **Status:** under active remediation. See [docs/audit/2026-10-14/](docs/audit/2026-10-14/) for the audit (what works,
> what does not) and the remediation roadmap, and [PROJECT_LOG.md](PROJECT_LOG.md) for progress. The automation engine,
> reservations, deal values, spend reporting and outbound connectors are **not built yet**; the screens that used to
> pretend otherwise have been removed or marked "Not available yet".

## Run it locally

Prerequisites: Node 24, Docker.

```bash
npm ci
cp .env.native.example .env.native            # local settings; gitignored
docker compose up -d postgres mailpit         # PostgreSQL 17 on 127.0.0.1:5442, mail inbox on http://127.0.0.1:8025
npm run db:migrate                            # applies database/migrations in order (checksum-guarded)
npm run db:provision -- --write-env           # creates the restricted API/worker database roles
npm run api:dev                               # API on http://127.0.0.1:4000
npm run worker:dev                            # background jobs: e-mail, imports, lead-source processing, heartbeat
npm run dev -- --host 127.0.0.1 --port 5174   # web app (proxies /api to the API)
```

Sign up in the app; the verification e-mail appears in Mailpit.

The API refuses to start as a database superuser in production. In development, point `DATABASE_URL` and
`WORKER_DATABASE_URL` at the `RESTRICTED_*` values that `db:provision` wrote, so you test with row-level security on.

## Checks (all must pass before a change is accepted)

```bash
npm run typecheck      # app + server
npm run lint
npm test               # each test file creates and drops its own database; needs PostgreSQL at DATABASE_TEST_URL
npm run build
npm run api:check      # docs/openapi.json and src/api/schema.d.ts match the routes (fix with: npm run api:types)
npm audit --omit=dev   # production dependencies must be clean at high severity
```

`npm run test:db:clean` removes databases left behind by an interrupted test run.
`npm run db:report-integrity` is a read-only report of data problems (cross-workspace links, status/stage mismatches)
to run **before** applying a migration to a database that has real data.

## Layout

| Path | What it is |
| --- | --- |
| `server/src/platform/` | Shared infrastructure: config, database/RLS, authorisation matrix, routes, audit, jobs, outbox, mail, crypto |
| `server/src/modules/` | Feature modules: identity, leads, contacts, tasks, inventory, viewings, dashboard, workspace, lead sources, monitor |
| `database/migrations/` | Numbered SQL migrations. Never edit an applied one; add the next number |
| `src/` | React app: `api/` typed clients, `features/` pages, `ui/` shared components, `app/` shell and navigation |
| `docs/` | Architecture, security model, runbook, API reference (`openapi.json`), audit and decision records |

## Where to read more

- Product guide: [docs/CRM_HANDOUT.md](docs/CRM_HANDOUT.md)
- Operations and deployment: [docs/LOCAL_AND_PRODUCTION_RUNBOOK.md](docs/LOCAL_AND_PRODUCTION_RUNBOOK.md)
- Security model: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)
- Audit and roadmap: [docs/audit/2026-10-14/](docs/audit/2026-10-14/)
- Decisions: [docs/adr/](docs/adr/)
