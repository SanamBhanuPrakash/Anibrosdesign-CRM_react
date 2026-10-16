> **STALE — HISTORICAL.** Records the retired hosted-Supabase project. The runtime is native PostgreSQL + own API. Kept as a reference only; do not use for deployment decisions.

# Anibros CRM — Live Deployment State & Ledger

This document records the exact remote deployment state, target Supabase reference, migration ledger, Edge Function versions, environment status, and verification date.

---

## 1. Remote Target Summary

- **Target Supabase Project Reference:** `wnhqwkasddggifgqmdlf`
- **Organization Name:** `Anibros` (Organization ID: `opgocirdaohoaskwexmr`)
- **Project Name:** `anibros-crm`
- **Region:** `ap-south-1` (Mumbai, India)
- **Status:** `ACTIVE_HEALTHY`
- **CLI Authentication:** Logged in locally as user `Sanam` (`cli_Sanam@DESKTOP-PCVQ2V3_1791800740`)
- **Last Verification Date:** 2026-10-12 17:30 IST

---

## 2. Remote Migration Ledger (100% Parity)

All 27 migrations are applied and match local files statement-for-statement:

| Version Timestamp | Migration File | Status | Description |
|---|---|---|---|
| `20261009100000` | `20261009100000_001_organisation_tenant_hierarchy.sql` | `APPLIED` | Foundational multi-tenant org/tenant hierarchy & RLS |
| `20261009100411` | `20261009100411_002_crm_domain_tables.sql` | `APPLIED` | Pipelines, contacts, leads, properties, tasks, audit |
| `20261009100457` | `20261009100457_003_seed_pipeline_and_transition_function.sql` | `APPLIED` | `transition_lead_stage` and default pipeline seed |
| `20261009101645` | `20261009101645_004_fix_security_advisor_warnings.sql` | `APPLIED` | Fixed search_path on helper functions |
| `20261009101705` | `20261009101705_005_fix_function_grants.sql` | `APPLIED` | Revoked anon execute from security definer functions |
| `20261009101859` | `20261009101859_006_auto_onboarding_function.sql` | `APPLIED` | `create_default_tenant` onboarding RPC |
| `20261009102424` | `20261009102424_007_lead_scoring_function.sql` | `APPLIED` | Rule-based lead scoring |
| `20261009104548` | `20261009104548_008_integrations_consent_customfields_automation_subscriptions.sql` | `APPLIED` | Integrations, consent, custom fields, automations |
| `20261009104755` | `20261009104755_009_user_invitation_function.sql` | `APPLIED` | User invitation function |
| `20261009111840` | `20261009111840_010_role_based_permission_enforcement.sql` | `APPLIED` | Role-aware DELETE, UPDATE, and INSERT policies |
| `20261009112139` | `20261009112139_011_database_integrity_composite_fks.sql` | `APPLIED` | Composite FKs preventing cross-tenant child references |
| `20261009113347` | `20261009113347_012_stuck_job_recovery.sql` | `APPLIED` | Baseline stuck job recovery functions |
| `20261009115052` | `20261009115052_013_fix_anon_security_definer_execute.sql` | `APPLIED` | Revoked anon execution on utility RPCs |
| `20261009115301` | `20261009115301_014_automation_rule_execution_engine.sql` | `APPLIED` | Automation rule execution engine |
| `20261009115824` | `20261009115824_015_outbox_event_generation_on_stage_transition.sql` | `APPLIED` | Outbox event generation on stage changes |
| `20261011130253` | `20261011130253_016_fix_rls_recursion_tenant_memberships.sql` | `APPLIED` | Non-recursive RLS policy on memberships |
| `20261011131104` | `20261011131104_017_dashboard_stats_function.sql` | `APPLIED` | `get_dashboard_stats` RPC |
| `20261011131647` | `20261011131647_018_attribution_stats_function.sql` | `APPLIED` | Baseline attribution stats RPC |
| `20261011131711` | `20261011131711_018_attribution_stats_function_fix.sql` | `APPLIED` | Resolved ambiguous column in attribution stats |
| `20261011173839` | `20261011173839_019_operations_center_observability.sql` | `APPLIED` | `operational_logs`, `system_health`, `incidents` |
| `20261012041810` | `20261012041810_020_harden_audit_logs_insert_policy.sql` | `APPLIED` | Enforces `user_id = auth.uid()` on audit inserts |
| `20261012053000` | `20261012053000_021_leads_search_rpc.sql` | `APPLIED` | Multi-field text search RPC |
| `20261012061500` | `20261012061500_022_atomic_viewing_scheduling_rpc.sql` | `APPLIED` | Atomic viewing scheduling with advisory locks |
| `20261012070000` | `20261012070000_023_client_telemetry_rpc.sql` | `APPLIED` | Scoped client telemetry RPC and restrictive RLS |
| `20261012073000` | `20261012073000_024_enable_realtime_publications.sql` | `APPLIED` | Realtime publication for leads, tasks, activities |
| `20261012133000` | `20261012133000_025_notifications_system.sql` | `APPLIED` | Notifications table and realtime publication |
| `20261012170000` | `20261012170000_026_reconcile_p0_database_contracts_and_security.sql` | `APPLIED` | Reconciled `search_leads` score column, outbox schema, attribution schema, tenant recovery, notification receipts, and invitations |

---

## 3. Remote Edge Functions State

| Function Name | Deployment Status | Gateway JWT Mode | Internal Auth Mode | Script Size |
|---|---|---|---|---|
| `webhook-ingestion` | `DEPLOYED` | Pass-through (`verify_jwt=false`) | Provider HMAC / Verification Key | 769 kB |
| `process-webhooks` | `DEPLOYED` | Pass-through (`verify_jwt=false`) | Timing-safe `CRON_SECRET` / Role check | 772 kB |
| `process-outbox` | `DEPLOYED` | Pass-through (`verify_jwt=false`) | Timing-safe `CRON_SECRET` / Role check | 774 kB |
| `integration-status` | `DEPLOYED` | Pass-through (`verify_jwt=false`) | Timing-safe `CRON_SECRET` / Role check | 770 kB |

---

## 4. Environment Variables Presence (Names & Status Only)

- `VITE_SUPABASE_URL`: Configured (points to `https://wnhqwkasddggifgqmdlf.supabase.co`)
- `VITE_SUPABASE_ANON_KEY`: Configured (matches user project public anon key)
- `CRON_SECRET`: Configured in remote Supabase Secrets
- `SUPABASE_SERVICE_ROLE_KEY`: Configured in remote Supabase Secrets (system-managed)
- `SUPABASE_DB_URL`: Configured in remote Supabase Secrets (system-managed)
