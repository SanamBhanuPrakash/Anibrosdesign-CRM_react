> **HISTORICAL — NOT CURRENT.** It maps the retired Supabase schema to the first native schema; the live schema is database/migrations (001-021). Current status lives in docs/audit/2026-10-14/ (audit and roadmap), PROJECT_LOG.md and the code. Do not treat statuses or PASS marks below as verified.

# ANIBROS CRM — NATIVE POSTGRESQL SCHEMA MAPPING SPECIFICATION

## 1. Executive Summary & Strategy
This document maps every existing database object (36 tables, 26 enums, 26 functions, 5 triggers, 77 policies) from the legacy Supabase migration chain (migrations 001–026) to its native PostgreSQL 16+ replacement.

### Classification Categories:
- **`PRESERVE`**: Relational structure, constraints, enums, or indexes are standard SQL and preserved with identical semantics.
- **`TRANSLATE`**: Supabase-coupled primitives (`auth.users`, `auth.uid()`, Supabase roles) are translated to native application user identities, session variables, or application roles.
- **`REDESIGN`**: Structural schema enhancements required to eliminate legacy vulnerabilities (e.g. adding tenant-aware composite foreign keys, transactional locking, or per-user read receipts).
- **`DEFERRED TO A LATER IMPLEMENTATION PHASE`**: Non-core domain tables (e.g. billing, custom fields, automation engine, branches) explicitly mapped and scheduled for subsequent phases after the core CRM lead-to-viewing workflow is verified.

---

## 2. Table-by-Table Schema Mapping

| Domain | Legacy Table | Status | Native Replacement Strategy | Supabase Dependency Removed | Phase |
| :--- | :--- | :---: | :--- | :--- | :---: |
| **Identity & Tenancy** | *(New)* `users` | **TRANSLATE** | Native `public.users` table with Argon2id `password_hash`, `email_verified`, `created_at`, `updated_at`. | Replaces `auth.users` | Phase 1 (Foundation) |
| **Identity & Tenancy** | *(New)* `sessions` | **TRANSLATE** | Native `public.sessions` table storing SHA-256 token hashes, `expires_at`, `revoked_at`. | Replaces Supabase Auth Gotrue | Phase 1 (Foundation) |
| **Identity & Tenancy** | *(New)* `password_reset_tokens` | **TRANSLATE** | Native `public.password_reset_tokens` storing high-entropy single-use tokens. | Replaces Supabase Auth reset | Phase 1 (Foundation) |
| **Identity & Tenancy** | `organisations` | **TRANSLATE** | `owner_id REFERENCES users(id) ON DELETE RESTRICT`. Preserved slug, name, metadata. | `auth.users` FK removed | Phase 1 (Foundation) |
| **Identity & Tenancy** | `tenants` | **PRESERVE** | `organisation_id REFERENCES organisations(id) ON DELETE CASCADE`. Slug, settings jsonb. | None | Phase 1 (Foundation) |
| **Identity & Tenancy** | `tenant_memberships` | **REDESIGN** | `user_id REFERENCES users(id)`. Role enum check (`tenant_owner`, `tenant_admin`, `sales_manager`, `sales_agent`, `marketing_manager`). | `auth.users` FK removed | Phase 1 (Foundation) |
| **Identity & Tenancy** | `tenant_invitations` | **REDESIGN** | Hardened invitation table from migration 026 with token hash and role ceiling enforcement. | Eliminates 00000000 fake user FK | Phase 1 (Foundation) |
| **Identity & Tenancy** | `branches` | **DEFERRED** | Multi-branch office hierarchy for enterprise agencies. | None | Phase 5 |
| **Identity & Tenancy** | `organisation_memberships` | **DEFERRED** | Multi-tenant organization level membership hierarchy. | None | Phase 5 |
| **CRM Core: Contacts** | `contacts` | **REDESIGN** | `(id, tenant_id)` composite unique key. Removed obsolete `lead_source` column; provider provenance stored in `source_summary JSONB`. | None | Phase 1 (Foundation) |
| **CRM Core: Pipeline** | `pipelines` | **PRESERVE** | Multi-pipeline support per tenant. `(id, tenant_id)` composite unique key. | None | Phase 1 (Foundation) |
| **CRM Core: Pipeline** | `pipeline_stages` | **REDESIGN** | `(id, tenant_id)` composite unique key. Order index, color, stage type enum. | None | Phase 1 (Foundation) |
| **CRM Core: Pipeline** | `pipeline_stage_transitions` | **PRESERVE** | Stage transition validation rules and SLAs. | None | Phase 1 (Foundation) |
| **CRM Core: Leads** | `leads` | **REDESIGN** | Core table with reconciled `lead_score`, composite FKs `(contact_id, tenant_id) REFERENCES contacts(id, tenant_id)` and `(stage_id, tenant_id) REFERENCES pipeline_stages(id, tenant_id)`. | Eliminates cross-tenant reference bug | Phase 1 (Foundation) |
| **CRM Core: Leads** | `lead_stage_history` | **REDESIGN** | Composite FK `(lead_id, tenant_id) REFERENCES leads(id, tenant_id)`. Changed by `users(id)`. | `auth.users` FK removed | Phase 1 (Foundation) |
| **CRM Core: Inventory** | `projects` | **PRESERVE** | Development projects inventory. Composite unique `(id, tenant_id)`. | None | Phase 1 (Foundation) |
| **CRM Core: Inventory** | `properties` | **REDESIGN** | Property listings. Composite FK `(project_id, tenant_id) REFERENCES projects(id, tenant_id)`. | None | Phase 1 (Foundation) |
| **CRM Core: Inventory** | `property_availability_history`| **DEFERRED** | Historical status tracking for unit availability. | None | Phase 5 |
| **CRM Core: Viewings** | `viewings` | **REDESIGN** | Atomic viewing bookings. Composite FKs to leads and properties. Unique index on `(property_id, scheduled_at)` for active bookings to prevent double-booking. | `auth.users` FK removed | Phase 1 (Foundation) |
| **CRM Core: Activities**| `activities` | **TRANSLATE** | Lead timeline activities. `user_id REFERENCES users(id)`. Composite FK to leads. | `auth.users` FK removed | Phase 1 (Foundation) |
| **CRM Core: Tasks** | `tasks` | **TRANSLATE** | Agent task management. `assigned_to REFERENCES users(id)`. Composite FK to leads. | `auth.users` FK removed | Phase 1 (Foundation) |
| **Queues & Integrations** | `webhook_inbox` | **REDESIGN** | Durable webhook intake table. Unique idempotency constraint `(provider, provider_event_id)`. Safe claiming via `status` and `attempts`. | Cloud edge function binding | Phase 1 (Foundation) |
| **Queues & Integrations** | `outbox_events` | **REDESIGN** | Reconciled outbox table with `provider`, `integration_id`, `response_status`, `response_body`, and `idempotency_key UNIQUE`. | Cloud edge function binding | Phase 1 (Foundation) |
| **Queues & Integrations** | `integrations` | **TRANSLATE** | Third-party credentials with encrypted token fields (AES-256-GCM). | Decoupled from Supabase vault | Phase 1 (Foundation) |
| **Queues & Integrations** | `integration_webhook_endpoints`| **DEFERRED** | Custom inbound webhook endpoint routing. | None | Phase 5 |
| **Attribution** | `marketing_attribution` | **REDESIGN** | Reconciled attribution table with `touch_type`, campaign dimensions, click IDs, UTM parameters, and composite FK to leads. | None | Phase 1 (Foundation) |
| **Consent & Governance**| `communication_consents` | **DEFERRED** | Explicit customer consent records (TCPA/GDPR/DND). | None | Phase 5 |
| **Custom Fields** | `custom_field_definitions` | **DEFERRED** | Dynamic schema custom fields per tenant. | None | Phase 5 |
| **Custom Fields** | `custom_field_values` | **DEFERRED** | Entity-attribute-value storage for dynamic custom fields. | None | Phase 5 |
| **Automation** | `automation_rules` | **DEFERRED** | Business automation triggers, conditions, and actions. | None | Phase 5 |
| **Automation** | `automation_executions` | **DEFERRED** | Execution logs and audit trail for automated workflows. | None | Phase 5 |
| **Notifications** | `notifications` | **TRANSLATE** | In-app user notifications. `user_id REFERENCES users(id)`. | `auth.users` FK removed | Phase 1 (Foundation) |
| **Notifications** | `notification_reads` | **REDESIGN** | Per-user read receipt table from migration 026. | None | Phase 1 (Foundation) |
| **Subscriptions** | `subscription_plans` | **DEFERRED** | SaaS billing plans and feature entitlements. | None | Phase 5 |
| **Subscriptions** | `tenant_subscriptions` | **DEFERRED** | Tenant plan subscriptions and Stripe customer mappings. | None | Phase 5 |
| **Audit & Observability** | `audit_logs` | **TRANSLATE** | Append-only business audit trail. `actor_id REFERENCES users(id)`. | `auth.users` FK removed | Phase 1 (Foundation) |
| **Audit & Observability** | `operational_logs` | **PRESERVE** | Structured JSON logs for SRE monitoring and error telemetry. | None | Phase 1 (Foundation) |
| **Audit & Observability** | `system_health` | **PRESERVE** | Dependency health observations and latency metrics. | None | Phase 1 (Foundation) |
| **Audit & Observability** | `incidents` | **PRESERVE** | Security and reliability incident records. | None | Phase 1 (Foundation) |

---

## 3. Database Functions & Stored Procedures Mapping

| Legacy Function Name | Legacy Source | Native Replacement | Security / Architecture Review Note |
| :--- | :--- | :--- | :--- |
| `auth.uid()` | Built-in Supabase Auth | `app.current_user_id() RETURNS uuid` | Returns session setting `current_setting('app.current_user_id', true)::uuid`. Set by trusted backend inside transaction. |
| `auth.jwt()` | Built-in Supabase Auth | `app.current_tenant_id() RETURNS uuid` | Returns session setting `current_setting('app.current_tenant_id', true)::uuid`. Set by trusted backend inside transaction. |
| `transition_lead_stage` | Migrations 003, 015 | `app.transition_lead_stage(...)` | Enforces caller active tenant membership, valid transition rules, inserts `lead_stage_history`, and logs audit trail transactionally. |
| `schedule_viewing` | Migration 022 | `app.schedule_viewing(...)` | Transactionally checks property availability, prevents double-booking using lock or unique index, and records viewing. |
| `search_leads` | Migrations 020, 021, 026 | `app.search_leads(...)` | Fixed score contract: returns `lead_score`, validates pagination bounds, and filters by tenant ID. |
| `calculate_lead_score` | Migration 007 | `app.calculate_lead_score(p_lead_id)` | Re-computes dynamic lead score based on activities and contact profile. |
| `reset_stuck_webhook_jobs` | Migrations 012, 026 | `app.reset_stuck_webhook_jobs(p_tenant_id, p_timeout_minutes)` | **Security Hardening:** Requires mandatory `p_tenant_id` and caller role `tenant_owner`/`tenant_admin`. Global signature permanently eliminated. |
| `reset_stuck_outbox_jobs` | Migrations 012, 026 | `app.reset_stuck_outbox_jobs(p_tenant_id, p_timeout_minutes)` | **Security Hardening:** Requires mandatory `p_tenant_id` and caller role `tenant_owner`/`tenant_admin`. Global signature permanently eliminated. |
| `replay_webhook_event` | Migration 019 | `app.replay_webhook_event(p_tenant_id, p_event_id)` | Strictly tenant-scoped and role-gated. |
| `replay_outbox_event` | Migration 019 | `app.replay_outbox_event(p_tenant_id, p_event_id)` | Strictly tenant-scoped and role-gated. |
| `log_client_telemetry` | Migration 023 | Handled via API endpoint `POST /api/telemetry` | Moves telemetry validation to backend API with server-side rate limiting and sanitization. |

---

## 4. Enums and Data Integrity Types
All 26 domain enums are standard PostgreSQL `CREATE TYPE ... AS ENUM (...)` constructs and are 100% portable:
- `tenant_role`: `'tenant_owner', 'tenant_admin', 'sales_manager', 'sales_agent', 'marketing_manager'`
- `lead_source`: `'website', 'referral', 'portal', 'direct', 'meta_ads', 'google_ads', 'walk_in', 'other'`
- `viewing_status`: `'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'`
- `task_priority`: `'low', 'medium', 'high', 'urgent'`
- `webhook_status`: `'pending', 'processing', 'completed', 'failed', 'dead_letter'`
- `outbox_status`: `'pending', 'processing', 'completed', 'failed', 'dead_letter'`
- `property_type_enum`, `transaction_type_enum`, `furnishing_type`, etc.

---

## 5. Security & Isolation Architecture

### Defense-in-Depth Model:
1. **Application Role (`crm_app_user`):**
   - Granted: `CONNECT`, `USAGE ON SCHEMA public`, `SELECT, INSERT, UPDATE, DELETE` on operational tables.
   - Denied: All DDL privileges (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`).
   - Denied: `UPDATE, DELETE` on `audit_logs` (strictly append-only).
   - Denied: `BYPASSRLS`.
2. **PostgreSQL Row-Level Security (RLS):**
   - Enabled on all multi-tenant tables.
   - Enforces `tenant_id = app.current_tenant_id()` on all queries.
3. **Relational Constraints (The Invariant Layer):**
   - Composite foreign keys `(contact_id, tenant_id) REFERENCES contacts(id, tenant_id)` physically prevent any application bug from associating a Tenant A lead with a Tenant B contact.
