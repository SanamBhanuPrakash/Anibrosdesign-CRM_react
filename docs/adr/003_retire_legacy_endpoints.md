# ADR 003: Retire the legacy `/api/*` routers; one validated writer for workspace settings

## Status
Accepted and implemented in Slice 0.

## Context
Eight routers written before the declarative route platform (`viewings`, `properties` match, `dashboard`, `tenant`, `reports`,
`integrations`, `custom-fields`, `automation`) queried the database without a permission check, some without tenant
scoping, and needed a privileged database connection to work at all. The audit found, among other things:
any member could invite or remove members; any member could read or write integration and automation settings; custom-field
values could point at another workspace's definition; the Tenant Configuration page replaced the whole settings document with
four keys; the time zone it saved was never read by reminders; dashboard numbers counted archived and test leads; and the
Attribution page presented unattributed leads as a marketing channel.

## Decision
1. Delete the eight routers and the legacy pool. Callers were inventoried first: only Dashboard, Reports, Attribution, Calendar,
   Property matching and Tenant Configuration used any of them; they now call the v1 endpoints below.
2. Replacements, all declarative (permission matrix, zod validation, problem+json, OpenAPI, row-level security):
   `GET/POST /api/v1/viewings`, `GET /api/v1/dashboard/metrics|attribution`, `POST /api/v1/matching/properties`,
   `GET/PATCH /api/v1/workspace`. Members and invitations were already served by `/api/v1/members`.
3. Automation, integrations and custom-field editors are **removed from the UI** and replaced by an honest "Not available yet"
   page: they only stored settings that nothing read. Replacements arrive in Slices 1, 2 and 6.
4. `PATCH /api/v1/workspace` changes only the keys it is sent, rejects unknown keys, validates the IANA time zone and stores it
   in `tenants.timezone` (the column reminders read), supports `If-Match`, and writes an audit entry naming the changed fields.
5. Migration 021 adds database-level guarantees so the rules do not depend on application code: composite foreign key for
   custom-field values, a trigger that refuses a lead status that contradicts its stage, and a safer `app.schedule_viewing`
   (live lead and unit, availability rule D6, active-member agent, no status rewrite). It stops without changing anything if
   existing data violates the new constraints; `npm run db:report-integrity` shows what.

## Consequences
- `viewings:read` for sales agents narrowed from "all" to "own" (their viewings or viewings of their leads). Auditors never had it.
- The old endpoints return 404; anything still calling them fails visibly instead of working insecurely.
- Dashboard and report numbers changed (they are now correct): they will be lower than before in workspaces that had archived or test leads.
