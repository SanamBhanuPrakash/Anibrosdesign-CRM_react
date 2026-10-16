# Anibros CRM — Security & Tenant-Isolation Remediation Report

This document records the tenant-isolation guarantees, role-based permission matrix, SECURITY DEFINER inventory, trust boundaries, secret management, identified vulnerabilities, and remediations.

---

## 1. Tenant Isolation & Role-Based Permission Matrix

### 1.1 Tenant Roles (`tenant_role` enum)
- `tenant_owner`: Complete administrative control of workspace, billing, users, integrations, and deletions.
- `tenant_admin`: Workspace administration, configuration, user management, and operational recovery.
- `sales_manager`: Lead pipeline management, team assignment, viewing management, and operational queue oversight.
- `sales_agent`: Lead engagement, contact creation, task completion, and viewing scheduling. Destructive deletions blocked.
- `marketing_manager`: Inbound/outbound integrations, automation rules, custom fields, and attribution reporting.
- `marketing_analyst`: Read-only access to marketing attribution, pipelines, and reporting. Writes blocked.
- `executive_readonly`: Comprehensive read-only view of aggregate reporting and dashboards. Writes blocked.
- `auditor`: Read-only access to immutable audit logs and operational health telemetry. CRM writes blocked.

### 1.2 Table-by-Table Authorization Rules

| Table | SELECT | INSERT | UPDATE | DELETE | Tenant Isolation Guard |
|---|---|---|---|---|---|
| `tenants` | Active tenant member | Platform/Agency Admin | `tenant_owner`, `tenant_admin` | `platform_owner` only | `id IN (SELECT get_user_tenant_ids(auth.uid()))` |
| `tenant_memberships` | Self OR same tenant member | `tenant_owner`, `tenant_admin` | `tenant_owner`, `tenant_admin` | `tenant_owner` | Non-recursive via `get_user_tenant_ids()` |
| `leads` | All active members | `sales_agent`+ | `sales_agent`+ (assigned/team) | `tenant_owner`, `tenant_admin`, `sales_manager` | `tenant_id` match verified on USING and WITH CHECK |
| `contacts` | All active members | `sales_agent`+ | `sales_agent`+ | `tenant_owner`, `tenant_admin` | `tenant_id` match verified on USING and WITH CHECK |
| `properties` | All active members | `sales_manager`+ | `sales_manager`+ | `tenant_owner`, `tenant_admin` | `tenant_id` match verified on USING and WITH CHECK |
| `pipelines` & `pipeline_stages` | All active members | `tenant_admin`, `tenant_owner` | `tenant_admin`, `tenant_owner` | `tenant_admin`, `tenant_owner` | Restrictive role policy from Migration 010 |
| `integrations` | `marketing_manager`+ | `marketing_manager`+ | `marketing_manager`+ | `tenant_owner`, `tenant_admin` | Configuration restricted to admin/marketing |
| `webhook_inbox` | `tenant_admin`+ | Service role / Edge Function | Service role / Edge Function | `tenant_owner` | Client direct INSERT/UPDATE revoked |
| `outbox_events` | `tenant_admin`+ | Service role / RPC / Admin | Service role / Edge Function | `tenant_owner` | Client direct UPDATE revoked |
| `audit_logs` | Active member (own) / Auditor | System / Authenticated self-action | **IMMUTABLE (None)** | **IMMUTABLE (None)** | Append-only, caller user_id validated |
| `notifications` | Targeted user or Broadcast | `create_tenant_notification` RPC | Self (read status only) | `tenant_owner` | Tampering blocked via BEFORE UPDATE trigger |
| `notification_reads` | Self (`user_id = auth.uid()`) | Self | Self | Self | Per-user broadcast read receipts |
| `tenant_invitations` | Active member | `tenant_owner`, `tenant_admin` | `tenant_owner`, `tenant_admin` | `tenant_owner`, `tenant_admin` | Eliminates zero-UUID foreign key violations |

---

## 2. SECURITY DEFINER Function Inventory & Audit

| Function Name | Defined In | Search Path | Role & Membership Guard | Audit Log Emitted | Risk Mitigated |
|---|---|---|---|---|---|
| `search_leads` | Migration 026 | `public, auth` | Active tenant membership required | Telemetry metric | Correct column reference (`lead_score`), cross-tenant leak prevented |
| `schedule_viewing` | Migration 022 | `public, auth` | Active membership, slot overlap lock | `audit_logs` | Double-booking and partial commits eliminated |
| `transition_lead_stage` | Migration 003 | `public, auth` | Active membership, valid transition map | `audit_logs`, `activities` | Invalid stage skips and unauthorized moves prevented |
| `create_tenant_notification`| Migration 026 | `public, auth` | Membership + role check (`tenant_role` enum) | N/A | Forged privileged alerts blocked; enum values reconciled |
| `mark_notification_read` | Migration 026 | `public, auth` | Membership check, recipient check | `notification_reads` | Broadcast read states isolated per-user |
| `reset_stuck_webhook_jobs` | Migration 026 | `public, auth` | `p_tenant_id` required; manager/admin only | `audit_logs` | Cross-tenant queue tampering completely prevented |
| `reset_stuck_outbox_jobs` | Migration 026 | `public, auth` | `p_tenant_id` required; manager/admin only | `audit_logs` | Cross-tenant queue tampering completely prevented |
| `invite_user_to_tenant` | Migration 026 | `public, auth` | `tenant_owner` or `tenant_admin` only | `audit_logs` | FK violation on uncreated users eliminated via `tenant_invitations` |
| `log_client_telemetry` | Migration 023 | `public, auth` | Membership required; severity restricted | `operational_logs` | Spoofed server severity and cross-tenant logs prevented |
| `get_user_tenant_ids` | Migration 001 | `public, auth` | User ID lookup on active memberships | N/A | RLS infinite recursion eliminated |

---

## 3. Webhook & Worker Trust Boundaries

1. **Inbound Webhook Ingestion (`webhook-ingestion`):**
   - Public endpoint: Gateway pass-through (`--no-verify-jwt`) enables third-party provider POST requests (Meta Lead Ads, Google Ads).
   - In-function authentication:
     - Meta: Raw payload HMAC-SHA256 signature verification against app secret.
     - Google: Configured webhook verification key verification.
   - Fail-closed: Missing secret or signature results in immediate HTTP 401/403.
   - Persistence before acknowledgment: Raw payload saved to `webhook_inbox` with unique constraint deduplication before HTTP 200 is returned.

2. **Internal Queue Workers (`process-webhooks`, `process-outbox`):**
   - Protected endpoint: Gateway pass-through (`--no-verify-jwt`) allows server-to-server worker secret delivery (`x-worker-secret`).
   - In-function timing-safe authentication (`authenticateCaller()`):
     - Mode 1: Global cron/worker invocation with timing-safe comparison against `CRON_SECRET`.
     - Mode 1b: Service-role JWT authorization.
     - Mode 2: Tenant operator invocation with user JWT, verifying active membership and minimum role (`tenant_owner`, `tenant_admin`, `sales_manager`, or `marketing_manager`).
   - Unauthenticated or unauthorized callers are rejected with HTTP 401/403.
