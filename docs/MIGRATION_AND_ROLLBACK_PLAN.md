> **HISTORICAL — NOT CURRENT.** It describes the original Supabase-to-native migration plan. Migration discipline today is in the README and runbook. Current status lives in docs/audit/2026-10-14/ (audit and roadmap), PROJECT_LOG.md and the code. Do not treat statuses or PASS marks below as verified.

# ANIBROS CRM — DATABASE MIGRATION AND ROLLBACK PLAN

## 1. Migration Strategy: Forward-Only Discipline
- All schema alterations are versioned forward migrations.
- Each migration is executed inside a transactional block (`BEGIN ... COMMIT`) to ensure atomicity.
- Schema changes are backwards-compatible during rolling deployments (e.g. add columns as nullable first, deploy backend, backfill, apply NOT NULL constraint).

---

## 2. Schema Porting Roadmap (Supabase to Native PostgreSQL)

### Phase 1: Foundational Core (`001_core_schema.sql`)
- Creates `public.users` table with native Argon2id password hash and session tracking.
- Creates `organisations`, `tenants`, and `tenant_memberships` tables with UUID primary keys.

### Phase 2: CRM Domain Tables (`002_crm_tables.sql`)
- Creates `contacts`, `leads`, `pipeline_stages`, `properties`, `projects`, `viewings`, `activities`, `tasks`.
- References `public.users(id)` instead of `auth.users(id)`.
- Defines composite foreign keys `(id, tenant_id)` on child entities.

### Phase 3: Background Queues & Telemetry (`003_queues_and_diagnostics.sql`)
- Creates `webhook_inbox` and `outbox_events` with locking support (`status`, `attempts`, `claimed_at`).
- Creates `marketing_attribution` with reconciled touch-type and campaign dimensions.

### Phase 4: Security & RLS Defense (`004_rls_and_security.sql`)
- Replaces Supabase `auth.uid()` with `app.current_user_id()` session variable helper.
- Creates fail-closed RLS policies on all tenant tables.

---

## 3. Rollback & Disaster Mitigation Procedure
1. If a migration fails during application: transaction aborts automatically (`ROLLBACK`).
2. If post-deployment defect is identified:
   - Apply documented forward rollback migration (e.g. `005_revert_feature_x.sql`).
   - Revert application container to previous verified image tag.
3. Database backup snapshot taken immediately prior to running migrations.
