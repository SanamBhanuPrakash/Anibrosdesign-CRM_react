> **STALE — HISTORICAL (Supabase era).** Describes the retired Supabase RPC/Edge-Function architecture. Statuses below are NOT valid for the native backend. Current truth: `Claude_plan.md` and `docs/ARCHITECTURE_V2.md`.

# Anibros CRM — Backend Feature & Operations Matrix

This document provides a complete mapping from every routed UI module and operational capability to its backend handler, authorization requirements, database policies, observability, Realtime sync, and verified status.

## Status Legend
- `SOURCE VERIFIED`: Code and schema verified in repository source.
- `LOCAL TEST PASSED`: Verified through local automated tests (unit/vitest).
- `REMOTE SCHEMA VERIFIED`: Table/RPC/Index schema verified on active Supabase remote database.
- `REMOTE FUNCTION DEPLOYMENT VERIFIED`: Edge Function deployed and verified actively serving traffic on remote project.
- `AUTHENTICATED RUNTIME TEST PASSED`: Functionality verified via live API execution under authenticated test context.
- `TENANT-ISOLATION TEST PASSED`: RLS/RPC cross-tenant boundary verified to deny unauthorized tenant access.
- `PROVIDER SANDBOX TEST PASSED`: Verified against mock/sandbox provider payloads without touching live ad campaigns.
- `NOT VERIFIED`: Implementation exists but runtime execution has not yet been demonstrated with live test data.
- `BLOCKED`: Dependency on external provider credential, account, or permission.

---

## 1. Core CRM Feature Matrix

| Module / Operation | UI Entry Point | Frontend Handler / Hook | Backend Table / RPC / Function | Required Role | Database Policy / Guard | Observability & Audit | Realtime Impact | Test Status | Evidence Status |
|---|---|---|---|---|---|---|---|---|---|
| **Dashboard Metrics** | `/` | `DashboardPage.tsx` | `rpc/get_dashboard_stats` | Active Member | Active tenant membership checked in RPC | Logged in `operational_logs` | Refreshed via `useRealtimeSync` | `npm test` | `REMOTE SCHEMA VERIFIED` |
| **Leads List & Search** | `/leads` | `LeadsPage.tsx`, `useRealtimeLeads` | `rpc/search_leads` & `leads` table | Active Member | `select_own_tenant_leads` + membership guard in RPC | Query metrics in `operational_logs` | Instant postgres_changes on `leads` table | Automated query test | `REMOTE SCHEMA VERIFIED` |
| **Lead Create** | `/leads` (Modal) | `LeadsPage.tsx` | `leads`, `contacts`, `activities` | `sales_agent`+ | `insert_own_tenant_leads` (WITH CHECK `tenant_id`) | `audit_logs`: `lead_created` | Pushed via Realtime to all tenant sessions | `test_live_lead_sync` | `REMOTE SCHEMA VERIFIED` |
| **Lead Stage Transition** | `/leads/:id` | `LeadDetailPage.tsx` | `rpc/transition_lead_stage` | `sales_agent`+ | Validates transition rules, membership | `lead_stage_history`, `audit_logs`, `activities` | Broadcasts update event on `leads` | Unit tests | `REMOTE SCHEMA VERIFIED` |
| **Viewing Scheduling** | `/leads/:id` (Modal) | `LeadDetailPage.tsx` | `rpc/schedule_viewing` | `sales_agent`+ | Advisory lock, slot overlap guard, atomic TX | `audit_logs`: `viewing_scheduled`, `activities` | Advances lead stage atomically & triggers Realtime | Automated RPC test | `REMOTE SCHEMA VERIFIED` |
| **Contacts List & CRUD** | `/contacts` | `ContactsPage.tsx` | `contacts` | Active Member (CRUD: manager+) | `select_own_tenant_contacts`, `delete_own_tenant_contacts` | `audit_logs` on mutation | Pushed via `useRealtimeSync` | Component test | `REMOTE SCHEMA VERIFIED` |
| **Properties & Inventory** | `/properties` | `PropertiesPage.tsx` | `properties`, `property_images` | Active Member (CRUD: manager+) | `select_own_tenant_properties`, role-aware delete | `audit_logs` on mutation | Realtime synced | Component test | `REMOTE SCHEMA VERIFIED` |
| **Tasks & Activities** | `/tasks`, `/calendar` | `TasksPage.tsx` | `tasks`, `activities` | Active Member | `select_own_tenant_tasks`, user assignment | `audit_logs` on status change | Realtime synced | Component test | `REMOTE SCHEMA VERIFIED` |
| **Attribution Reports** | `/reports/attribution` | `AttributionReportPage.tsx` | `rpc/get_attribution_stats` | `marketing_manager`+ | Scoped to active tenant | Logged in `operational_logs` | Polling / On-demand | Automated RPC test | `REMOTE SCHEMA VERIFIED` |
| **Notifications** | Top Bar Bell / Panel | `notification-store.ts` | `notifications`, `rpc/mark_notification_read` | Active Member | `select_own_notifications`, `notification_reads` | `notification_reads` receipt recorded | Realtime postgres_changes on `notifications` | Vitest store tests | `REMOTE SCHEMA VERIFIED` |

---

## 2. Ingestion & Outbound Integration Matrix

| Integration / Channel | Entry Point | Protocol / Verification | Target Table / Worker | Deduplication & Idempotency | Error Handling & Retry | Sandbox Status | Evidence Status |
|---|---|---|---|---|---|---|---|
| **Google Ads Ingestion** | `/functions/v1/webhook-ingestion` | Webhook Key verification | `webhook_inbox` -> `process-webhooks` | Unique constraint `(integration_id, provider_event_id)` | Exponential backoff (5 retries), dead-letter | Mock payload tested | `REMOTE FUNCTION DEPLOYMENT VERIFIED` |
| **Meta Lead Ads Ingestion**| `/functions/v1/webhook-ingestion` | HMAC-SHA256 signature verification | `webhook_inbox` -> `process-webhooks` | Leadgen ID deduplication | Exponential backoff (5 retries), dead-letter | Mock payload tested | `REMOTE FUNCTION DEPLOYMENT VERIFIED` |
| **Outbound Meta Conversion**| Queue Worker | OAuth Access Token via `credential_ref` | `outbox_events` -> `process-outbox` | Event ID deduplication | Exponential backoff, consent opt-out suppression | Sandbox mock | `REMOTE FUNCTION DEPLOYMENT VERIFIED` |
| **Outbound Google Conversion**| Queue Worker | OAuth refresh token via `credential_ref` | `outbox_events` -> `process-outbox` | Event ID deduplication | Exponential backoff, consent suppression | Sandbox mock | `REMOTE FUNCTION DEPLOYMENT VERIFIED` |

---

## 3. Observability & Operations Center Matrix

| Capability | UI Tab | Backend Handler | Authorization | Failure Mode Handling | Evidence Status |
|---|---|---|---|---|---|
| **Telemetry & Log Explorer** | Operations -> Logs | `operational_logs`, `rpc/log_client_telemetry` | `tenant_admin`+ | Sanitizes secrets/tokens, fail-safe swallow on telemetry log error | `REMOTE SCHEMA VERIFIED` |
| **System Health Monitoring** | Operations -> Health | `system_health` | `tenant_admin`+ | Truthful states: Healthy / Degraded / Failed / Stale | `REMOTE SCHEMA VERIFIED` |
| **Webhook Queue Diagnostics**| Operations -> Webhooks | `webhook_inbox`, `rpc/reset_stuck_webhook_jobs` | `tenant_admin`+ | Tenant-isolated reset of stuck processing items | `REMOTE SCHEMA VERIFIED` |
| **Outbox Queue Diagnostics** | Operations -> Outbox | `outbox_events`, `rpc/reset_stuck_outbox_jobs` | `tenant_admin`+ | Tenant-isolated reset of stuck processing items | `REMOTE SCHEMA VERIFIED` |
| **Incident Management** | Operations -> Incidents | `incidents` | `tenant_admin`+ | Operators can acknowledge and resolve with audit trail | `REMOTE SCHEMA VERIFIED` |
