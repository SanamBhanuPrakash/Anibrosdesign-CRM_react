# Anibrosdesign CRM

A new product: a CRM for a **marketing agency** that runs campaigns for many clients at once (doctor, restaurant, bank, shop, ...).
Started on 2026-10-15 as a copy of the real-estate Anibros CRM. The original keeps running untouched; this folder shares nothing with it.

## What is separate from the original CRM

| Thing            | Original CRM                         | Anibrosdesign CRM                      |
|------------------|--------------------------------------|----------------------------------------|
| Folder           | `Anibros CRM\project-bolt-...\project` | `htdocs\Anibrosdesign-CRM`             |
| API port         | 4000                                 | **4200**                               |
| Web (Vite) port  | 5174                                 | **5274**                               |
| Postgres         | container on 5442, DB `anibros`      | container `anibrosdesign-crm-postgres` on **5542**, DB `anibrosdesign` |
| Docker volume    | `anibros-crm_pgdata`                 | `anibrosdesign_crm_postgres_data`      |
| Mailpit          | SMTP 1025, inbox 8025                | SMTP **1125**, inbox http://localhost:**8125** |
| E2E test stack   | 4100 / 4101 / 5199                   | 4300 / 4301 / 5299                     |
| Session/CSRF cookie | `anibros_session`, `anibros_csrf` | `anibrosdesign_session`, `anibrosdesign_csrf` (cookies are shared across ports on localhost, so the names must differ) |
| Secrets          | its own                              | freshly generated, in gitignored `.env.native` / `.env` |
| Git              | original repo + GitHub remote        | fresh local repo, **no remote** (nothing may be pushed to the old repo) |
| Supabase         | not used by code                     | not used; legacy keys removed          |

## Run it

    docker compose up -d          # Postgres 5542 + Mailpit 1125/8125 (needs ANIBROSDESIGN_DB_PASSWORD from .env)
    npm run db:migrate            # 29 migrations (uses MIGRATOR_DATABASE_URL, the admin role)
    npm run server:dev            # API on http://127.0.0.1:4200, running as the restricted DB role so isolation is enforced by the database
    npm run dev                   # web on http://localhost:5274

Tests: `npx vitest run` (creates disposable DBs on the 5542 cluster only). Clean leftovers: `npm run test:db:clean`.

## Baseline

State after the agency core (2026-10-15): 38 test files / 763 tests pass; typecheck, lint, build and API-description check pass. Design: docs/AGENCY_DESIGN.md. Everything real-estate specific (properties, inventory, viewings, offers, sales)
is still present and is to be generalised: see the multi-client plan (client workspaces, per-client lead sources, spend, webhooks, staff assignment).

`reference-from-original-crm/` holds the original hand-off documents for context only.
