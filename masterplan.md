# Anibros CRM — Exhaustive Master Implementation Plan

> **THE** reference document. Read `PROJECT_LOG.md` for what's built. Read this for everything else:
> full schema, permission matrix, state machines, threat model, SLOs, cost model, acceptance criteria,
> architecture corrections, edge function specs, and a per-phase breakdown with dependencies, risks, and tests.
> Last updated: Session 4 (2026-10-09).

---

## Table of Contents

1. [Project Overview & Vision](#1-project-overview--vision)
2. [Tech Stack & Dependencies](#2-tech-stack--dependencies)
3. [Organisational Hierarchy & Role System](#3-organisational-hierarchy--role-system)
4. [Permission Matrix](#4-permission-matrix)
5. [Database Schema — Complete Reference](#5-database-schema--complete-reference)
6. [Migrations Applied](#6-migrations-applied)
7. [Pending Migrations](#7-pending-migrations)
8. [State Machines](#8-state-machines)
9. [Event Processing Architecture (Inbox/Outbox)](#9-event-processing-architecture-inboxoutbox)
10. [Edge Functions — Full Specs](#10-edge-functions--full-specs)
11. [Architecture Decisions (Recorded)](#11-architecture-decisions-recorded)
12. [Architecture Corrections — 7 Findings](#12-architecture-corrections--7-findings)
13. [Threat Model](#13-threat-model)
14. [Security & Privacy Controls](#14-security--privacy-controls)
15. [Reliability Specification & SLOs](#15-reliability-specification--slos)
16. [Cost & Operational Model](#16-cost--operational-model)
17. [Frontend File Inventory](#17-frontend-file-inventory)
18. [Phase-by-Phase Roadmap with Dependencies, Risks, Tests](#18-phase-by-phase-roadmap)
19. [Blocked Work & External Dependencies](#19-blocked-work--external-dependencies)
20. [Remaining Feasible Work](#20-remaining-feasible-work)
21. [Acceptance Criteria](#21-acceptance-criteria)
22. [Production Readiness Checklist](#22-production-readiness-checklist)
23. [Key File References](#23-key-file-references)

---

## 1. Project Overview & Vision

### Product
**Anibros CRM** — a multi-tenant real estate CRM and marketing operating platform built for Anibros Design (a digital marketing/technology agency). Starts as an internal agency tool, designed to become a SaaS product sold to multiple real estate businesses.

### Vision Stages
1. **Internal prototype** — Anibros team manages clients, properties, leads, ad sources, pipelines
2. **Controlled production pilot** — real client data, real ad integrations, limited tenants
3. **Commercially operated SaaS** — self-serve sign-up, subscriptions, multiple unrelated tenants

### Core Modules
| Module | Description |
|--------|-------------|
| Executive Dashboard | Business overview: leads, SLA, viewings, pipeline value, integration health |
| Lead & Contact Management | Contacts separated from leads; one person → multiple leads/opportunities |
| Pipeline & Sales Workflows | Configurable pipeline, validated stage transitions, drag-and-drop, assignment, SLAs |
| Property & Inventory | Projects, properties, availability history, images, documents, pricing |
| Property Matching | Rule-based matching: budget, location, type, bedrooms, amenities — explainable |
| Viewings & Calendar | Appointment creation, conflict checks, no-show tracking, reminders |
| Opportunities & Deals | Negotiation stages, offers, booking/reservation, deal won/lost |
| Activity & Task Management | Calls, notes, emails, tasks, follow-ups, activity timeline, audit history |
| Reporting & Analytics | Source breakdown, qualification rates, agent performance, attribution, CSV export |
| Inbound Integrations | Google Ads lead forms, Meta Lead Ads, website forms, CSV import — durable inbox |
| Outbound Conversion Feedback | Google enhanced conversions, Meta Conversions API for CRM — consent-checked |
| Communications | WhatsApp Cloud API, email (provider adapter), templates, delivery tracking |
| Automation | Trigger→action rules engine, custom fields per entity |
| SaaS Readiness | Subscription plans, tenant admin, user invitations, onboarding, billing |

### Target Users & Roles
| Role | Description | Tenancy |
|------|-------------|---------|
| Platform Owner | Anibros Design leadership, full platform control | Platform-wide |
| Platform Admin | Support/operations, controlled delegated access | Platform-wide |
| Agency Owner/Admin | Manages agency org and its client tenants | Org-level |
| Tenant Owner | Client business owner, full tenant control | Tenant-level |
| Tenant Admin | Manages users, settings, integrations within a tenant | Tenant-level |
| Sales Manager | Manages agents, views team pipeline, assigns leads | Tenant-level |
| Sales Agent/Rep | Owns assigned leads, creates activities/tasks | Tenant-level |
| Marketing Manager | Manages integrations, campaigns, attribution | Tenant-level |
| Marketing Analyst | Read-only reports, attribution, no edit access | Tenant-level |
| Executive Read-only | Dashboard and reports only | Tenant-level |
| Auditor | Audit log access, no CRUD on business data | Tenant-level |

---

## 2. Tech Stack & Dependencies

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 18.3.1 | UI framework |
| TypeScript | 5.5.3 | Type safety |
| Vite | 5.4.2 | Build tool & dev server |
| Tailwind CSS | 3.4.1 | Styling (custom design system) |
| React Router DOM | 7.18.4 | Routing |
| Zustand | 5.0.15 | State management |
| lucide-react | 0.446.0 | Icons |
| date-fns | 4.4.0 | Date utilities |
| clsx | 2.1.1 | Class name composition |
| tailwind-merge | 3.7.0 | Tailwind class dedup |

### Backend
| Technology | Purpose |
|-----------|---------|
| Supabase (PostgreSQL) | Primary database, Auth, RLS, Edge Functions, Storage |
| Supabase Auth | Email/password authentication, JWT sessions |
| PostgreSQL RLS | Row-level security on every tenant-owned table |
| Supabase Edge Functions (Deno) | Webhook ingestion, webhook processing, outbox processing (pending) |
| Supabase Storage | File/document storage (planned) |

### Design System
- Custom Tailwind theme with 6+ color ramps: primary, accent, success, warning, error, surface
- Each ramp has 50-900 shades for hierarchical application
- 8px spacing system
- 3 font weights max
- 150% line height for body, 120% for headings
- Light theme primary; dark mode deferred

---

## 3. Organisational Hierarchy & Role System

### Hierarchy
```
SaaS Platform
└── Platform Owner / Platform Admin (platform-wide)
    └── Agency Organisation
        └── Agency Owner / Agency Admin (org-level)
            └── Client Organisation (Tenant)
                └── Tenant Owner / Tenant Admin (tenant-level)
                    └── Branch (optional, within tenant)
                        └── Team Members
                            ├── Sales Manager
                            ├── Sales Agent
                            ├── Marketing Manager
                            ├── Marketing Analyst
                            ├── Executive Read-only
                            └── Auditor
```

### Membership Model
- **Organisation Memberships** — link users to organisations with org-level roles
- **Tenant Memberships** — link users to tenants with tenant-level roles
- A user can belong to multiple tenants (with different roles in each)
- Active tenant context stored in localStorage, verified server-side via RLS
- Membership status: `active` | `invited` | `revoked`

### Role Types (Enums)
```typescript
// Org-level roles
type OrgRole = 'platform_owner' | 'platform_admin' | 'agency_owner' | 'agency_admin';

// Tenant-level roles
type TenantRole =
  | 'tenant_owner' | 'tenant_admin'
  | 'sales_manager' | 'sales_agent'
  | 'marketing_manager' | 'marketing_analyst'
  | 'executive_readonly' | 'auditor';
```

---

## 4. Permission Matrix

### CRUD Permissions by Role (per entity, within a tenant)

| Entity | Role | SELECT | INSERT | UPDATE | DELETE | Notes |
|--------|------|--------|--------|--------|--------|-------|
| Leads | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Full CRUD |
| Leads | sales_manager | ✓ | ✓ | ✓ | ✗ | Can't delete |
| Leads | sales_agent | ✓ (assigned) | ✓ | ✓ (assigned) | ✗ | Only own leads |
| Leads | marketing_* | ✓ | ✗ | ✗ | ✗ | Read-only |
| Leads | executive_readonly | ✓ | ✗ | ✗ | ✗ | Read-only |
| Leads | auditor | ✗ | ✗ | ✗ | ✗ | Audit log only |
| Contacts | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Full CRUD |
| Contacts | sales_manager | ✓ | ✓ | ✓ | ✗ | Can't delete |
| Contacts | sales_agent | ✓ | ✓ | ✓ (own) | ✗ | Limited update |
| Properties | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Full CRUD |
| Properties | sales_manager | ✓ | ✓ | ✓ | ✗ | Can't delete |
| Properties | sales_agent | ✓ | ✗ | ✗ | ✗ | Read-only |
| Integrations | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Admin only |
| Integrations | marketing_manager | ✓ | ✓ | ✓ | ✗ | Can configure |
| Integrations | others | ✓ | ✗ | ✗ | ✗ | View only |
| Pipeline Config | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Admin only |
| Pipeline Config | others | ✓ | ✗ | ✗ | ✗ | Read-only |
| Users/Memberships | tenant_owner/admin | ✓ | ✓ (invite) | ✓ (revoke) | ✓ | Admin only |
| Audit Logs | auditor | ✓ | ✗ | ✗ | ✗ | Read-only |
| Audit Logs | tenant_owner/admin | ✓ | ✗ | ✗ | ✗ | Read-only |
| Reports | all except auditor | ✓ | ✗ | ✗ | ✗ | Read-only + CSV export |
| Settings | tenant_owner/admin | ✓ | ✓ | ✓ | ✗ | Admin only |
| Custom Fields | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Admin only |
| Automation Rules | tenant_owner/admin | ✓ | ✓ | ✓ | ✓ | Admin only |
| Automation Rules | marketing_manager | ✓ | ✓ | ✓ | ✗ | Can create/edit |
| Webhook Inbox | tenant_owner/admin | ✓ | ✗ | ✓ (replay) | ✗ | Diagnostics |
| Webhook Inbox | marketing_manager | ✓ | ✗ | ✓ (replay) | ✗ | Diagnostics |
| Outbox Events | tenant_owner/admin | ✓ | ✗ | ✓ (replay) | ✗ | Diagnostics |
| Outbox Events | marketing_manager | ✓ | ✗ | ✓ (replay) | ✗ | Diagnostics |
| Subscription Plans | all | ✓ | ✗ | ✗ | ✗ | Global, read-only |
| Tenant Subscriptions | tenant_owner/admin | ✓ | ✗ | ✗ | ✗ | View current plan |

### Special Permissions
- **Export (CSV):** tenant_owner, tenant_admin, sales_manager, marketing_manager, marketing_analyst — NOT sales_agent
- **Lead Assignment:** tenant_owner, tenant_admin, sales_manager — NOT sales_agent
- **Integration Config:** tenant_owner, tenant_admin, marketing_manager — NOT sales_agent
- **User Invitation:** tenant_owner, tenant_admin only
- **Tenant Settings:** tenant_owner, tenant_admin only
- **Pipeline Customization:** tenant_owner, tenant_admin only

### Enforcement Layers
1. **Database RLS** — tenant membership check (DONE), role-based check (PENDING)
2. **SECURITY DEFINER functions** — explicit role verification inside function body
3. **Frontend route guards** — hide UI actions based on role (convenience, not security)
4. **Column-level privileges** — for sensitive columns like roles, balances (planned)

---

## 5. Database Schema — Complete Reference

### Table Groups

#### Group A: Tenant Hierarchy
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| organisations | id (uuid) | No | name, type, parent_organisation_id | SELECT as member |
| tenants | id (uuid) | Self | organisation_id, name, slug, status, settings (jsonb) | SELECT as member |
| branches | id (uuid) | Yes | tenant_id, name, location | 4 policies |
| organisation_memberships | id (uuid) | No | user_id, organisation_id, role, status | SELECT own |
| tenant_memberships | id (uuid) | No | user_id, tenant_id, role, branch_id, status | SELECT own |

#### Group B: CRM Core
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| pipelines | id | Yes | tenant_id, name, is_default, sort_order | 4 policies |
| pipeline_stages | id | Yes | tenant_id, pipeline_id, name, stage_key, stage_type, sort_order, is_won_stage, is_lost_stage, requires_loss_reason, color | 4 policies |
| pipeline_stage_transitions | id | Yes | tenant_id, pipeline_id, from_stage_id, to_stage_id | 4 policies |
| contacts | id | Yes | tenant_id, first_name, last_name, email, email_normalized, phone, phone_normalized, communication_consent (jsonb), contact_preferences (jsonb), source_summary (jsonb) | 4 policies |
| leads | id | Yes | tenant_id, contact_id, pipeline_id, pipeline_stage_id, stage, lead_source, integration_id, provider_lead_id, campaign_id, ad_group_id, ad_id, form_id, landing_page_url, gclid, gbraid, wbraid, fbclid, utm_*, assigned_to, assigned_at, qualification_status, qualification_notes, budget_min, budget_max, desired_location, property_type_preference, bedroom_preference, transaction_intent, expected_timeline, financing_status, loss_reason, nurture_status, lead_score, response_sla_due_at, first_contacted_at, last_activity_at, title, description | 4 policies |
| lead_stage_history | id | Yes | tenant_id, lead_id, from_stage, to_stage, changed_by, changed_at, reason, metadata (jsonb) | 4 policies |
| marketing_attribution | id | Yes | tenant_id, lead_id, source, campaign_id, ad_group_id, ad_id, form_id, landing_page_url, gclid, fbclid, utm_*, is_original, attributed_at | 4 policies |
| projects | id | Yes | tenant_id, name, developer, location, rera_number, status | 4 policies |
| properties | id | Yes | tenant_id, project_id, name, property_type, transaction_type, listing_type, address_*, city, state, postal_code, locality, lat/lng, bedrooms, bathrooms, built_up_area_sqft, carpet_area_sqft, floor_number, total_floors, facing, furnishing, amenities, price, currency, price_per_sqft, availability_status, availability_expires_at, owner_name, commission_percentage, notes, images (jsonb), documents (jsonb) | 4 policies |
| property_availability_history | id | Yes | tenant_id, property_id, from_status, to_status, changed_at, changed_by, reason | 4 policies |
| activities | id | Yes | tenant_id, lead_id, contact_id, type, direction, subject, content, performed_by, performed_at, metadata (jsonb), is_internal | 4 policies |
| tasks | id | Yes | tenant_id, lead_id, assigned_to, title, description, due_date, due_time, priority, status, completed_at, created_by | 4 policies |
| viewings | id | Yes | tenant_id, lead_id, property_id, assigned_to, scheduled_date, scheduled_time, duration_minutes, timezone, status, notes, feedback, outcome, cancelled_reason, cancelled_at | 4 policies |
| audit_logs | id | Yes (nullable) | tenant_id, user_id, action, entity_type, entity_id, old_value (jsonb), new_value (jsonb), ip_address, user_agent | 4 policies (INSERT is system-generated) |

#### Group C: Integrations
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| integrations | id | Yes | tenant_id, provider, display_name, status, config (jsonb), credential_ref, last_health_check_at, last_success_at, last_error_at, last_error_detail | 4 policies |
| integration_webhook_endpoints | id | Yes | tenant_id, integration_id, endpoint_url, webhook_key, is_active | 4 policies |
| webhook_inbox | id | Yes | tenant_id, integration_id, provider, provider_event_id, status, raw_payload (jsonb), retry_count, max_retries, error_detail, is_test, received_at, processed_at, next_attempt_at | 4 policies |
| outbox_events | id | Yes | tenant_id, integration_id, event_type, provider, provider_event_id, status, payload (jsonb), response_status, response_body, retry_count, max_retries, next_attempt_at, error_detail, sent_at, acknowledged_at | 4 policies |

#### Group D: Compliance
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| communication_consents | id | Yes | tenant_id, contact_id, channel, status, consent_source, consented_at, withdrawn_at | 4 policies |

#### Group E: Customization
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| custom_field_definitions | id | Yes | tenant_id, entity_type, field_key, field_label, field_type, field_options (text[]), is_required, is_searchable, sort_order | 4 policies |
| custom_field_values | id | Yes | tenant_id, field_definition_id, entity_id, value (jsonb) | 4 policies |
| automation_rules | id | Yes | tenant_id, name, description, trigger_type, trigger_config (jsonb), action_type, action_config (jsonb), is_active, priority | 4 policies |
| automation_executions | id | Yes | tenant_id, rule_id, entity_id, entity_type, status, executed_at, error_detail | 4 policies |

#### Group F: SaaS
| Table | PK | Tenant-scoped | Key Columns | RLS |
|-------|-----|--------------|-------------|-----|
| subscription_plans | id | No (global) | name, display_name, description, price_monthly, currency, features (jsonb), limits (jsonb), is_active, sort_order | SELECT only |
| tenant_subscriptions | id | Yes | tenant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id | SELECT own |

### Unique Constraints
| Table | Columns | Purpose |
|-------|---------|---------|
| webhook_inbox | (integration_id, provider_event_id) | Idempotent webhook receipt |
| leads | (integration_id, provider_lead_id) | Prevent duplicate provider leads |
| contacts | (tenant_id, email_normalized) | Prevent duplicate emails (WHERE email_normalized IS NOT NULL) |
| contacts | (tenant_id, phone_normalized) | Prevent duplicate phones (WHERE phone_normalized IS NOT NULL) |
| tenants | slug | Globally unique tenant slug |
| subscription_plans | name | Unique plan name |

### Indexes (existing + planned)
| Table | Columns | Type | Purpose |
|-------|---------|------|---------|
| leads | (tenant_id, created_at) | btree | Dashboard recent leads |
| leads | (tenant_id, stage) | btree | Pipeline board |
| leads | (tenant_id, assigned_to) | btree | Agent's leads |
| leads | (tenant_id, lead_source) | btree | Source reports |
| contacts | (tenant_id, email_normalized) | btree | Dedup lookup |
| contacts | (tenant_id, phone_normalized) | btree | Dedup lookup |
| webhook_inbox | (status, next_attempt_at) | btree | Worker polling |
| outbox_events | (status, next_attempt_at) | btree | Worker polling |
| activities | (tenant_id, lead_id, performed_at) | btree | Activity timeline |
| tasks | (tenant_id, assigned_to, status) | btree | User's tasks |
| viewings | (tenant_id, scheduled_date) | btree | Calendar |
| audit_logs | (tenant_id, created_at) | btree | Audit log view |
| properties | (tenant_id, property_type, availability_status) | btree | Property filter |
| properties | (tenant_id, locality) | btree | Location search |

### SECURITY DEFINER Functions
| Function | Purpose | Security |
|----------|---------|----------|
| `is_platform_admin()` | Check if user is platform admin | Helper, search_path set |
| `is_agency_admin_for_org(org_id)` | Check if user is agency admin for org | Helper, search_path set |
| `get_user_tenant_ids()` | Get all tenant IDs for user | Helper, search_path set |
| `create_default_tenant(user_email)` | Auto-onboard new sign-up: org + tenant + memberships + pipeline | SECURITY DEFINER, EXECUTE: authenticated only |
| `seed_default_pipeline(tenant_id)` | Create 13 standard RE stages + 30+ transitions | SECURITY DEFINER, EXECUTE: authenticated only |
| `transition_lead_stage(lead_id, to_stage, reason)` | Validate and execute stage transition atomically | SECURITY DEFINER, EXECUTE: authenticated only |
| `calculate_lead_score(lead_id)` | Rule-based scoring from source, budget, timeline, engagement | SECURITY DEFINER, EXECUTE: authenticated only |
| `invite_user_to_tenant(tenant_id, email, role)` | Verify caller is admin/owner, create invited membership, log audit | SECURITY DEFINER, EXECUTE: authenticated only |

---

## 6. Migrations Applied (9)

| # | Filename | Key Changes |
|---|----------|-------------|
| 1 | `001_organisation_tenant_hierarchy` | organisations, tenants, branches, org_memberships, tenant_memberships + RLS + helper functions |
| 2 | `002_crm_domain_tables` | 16 CRM tables (pipelines through audit_logs) + webhook_inbox + outbox_events, all with tenant_id + 4 RLS policies |
| 3 | `003_seed_pipeline_and_transition_function` | `transition_lead_stage()` + `seed_default_pipeline()` (13 stages, 30+ transitions) |
| 4 | `004_fix_security_advisor_warnings` | Explicit search_path on helper functions |
| 5 | `005_fix_function_grants` | Revoke EXECUTE from PUBLIC/anon on SECURITY DEFINER functions, grant to authenticated only |
| 6 | `006_auto_onboarding_function` | `create_default_tenant()` auto-creates org + tenant + memberships + pipeline for new sign-ups |
| 7 | `007_lead_scoring_function` | `calculate_lead_score()` rule-based scoring |
| 8 | `008_integrations_consent_customfields_automation_subscriptions` | 10 new tables: integrations, integration_webhook_endpoints, communication_consents, custom_field_definitions, custom_field_values, automation_rules, automation_executions, subscription_plans (seeded free+pro), tenant_subscriptions |
| 9 | `009_user_invitation_function` | `invite_user_to_tenant()` SECURITY DEFINER function |

---

## 7. Pending Migrations

### Migration 10: Role-Based Permission Enforcement
**Goal:** Restrict destructive operations (DELETE) to admin/manager roles. Restrict config changes (integrations, pipeline, custom fields, automation rules) to admin/marketing-manager roles.

**Approach:**
- Replace existing DELETE policies with role-aware versions
- Add role check helper function: `get_user_tenant_role(tenant_id)` returns the user's role in that tenant
- New DELETE policies check that user's role is in ('tenant_owner', 'tenant_admin') for config tables
- Lead/property DELETE restricted to admin/manager
- Sales agents get SELECT + INSERT + UPDATE (own leads only) but no DELETE

**Tables affected:** leads, contacts, properties, projects, integrations, automation_rules, custom_field_definitions, pipeline_stages, pipelines, tasks, viewings, activities

### Migration 11: Database Integrity Composite FKs
**Goal:** Prevent cross-tenant child references at the database level.

**Approach:**
- Add composite unique constraints: `(tenant_id, id)` on parent tables (pipelines, pipeline_stages, contacts, properties, projects, integrations)
- Replace single-column FKs with composite FKs: `FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, id)`
- This ensures a lead's pipeline_id belongs to the same tenant as the lead's tenant_id
- Apply to: leads→pipelines, leads→pipeline_stages, leads→contacts, leads→integrations, activities→leads, tasks→leads, viewings→leads, viewings→properties, marketing_attribution→leads, lead_stage_history→leads, communication_consents→contacts, custom_field_values→custom_field_definitions, automation_executions→automation_rules, outbox_events→integrations, webhook_inbox→integrations

### Migration 12: Additional Indexes for Query Performance (planned)
- Add missing indexes listed in the indexes table above
- Add partial indexes on webhook_inbox/outbox_events for worker polling

### Migration 13: Stuck-Job Recovery (planned)
- Add function to reset `processing` events stuck for >10 minutes back to `received`/`pending`
- Schedule via pg_cron if available, or manual trigger from diagnostics UI

---

## 8. State Machines

### Lead Pipeline State Machine
```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                                                              │
  new ──> contact_attempted ──> contacted ──> qualified ──> viewing_scheduled ──> viewing_completed ──> negotiation ──> booking_reserved ──> won
   │         │                    │            │           │                    │                 │                 │                │
   │         │                    │            │           │                    │                 │                 │                │
   │         └──> unqualified     │            └──> lost   └──> lost            └──> lost         └──> lost         └──> lost         │
   │                              │                                                                                │
   └──> invalid                   └──> nurture                                                                    │
                                                                                                                    │
  ────────────────────────────────────── any active stage can go to: lost, invalid, nurture ────────────────────────┘
```

**Default stages (13):** new, contact_attempted, contacted, qualified, viewing_scheduled, viewing_completed, negotiation, booking_reserved, won, lost, invalid, unqualified, nurture

**Stage types:** active, won, lost, terminal

**Transition rules:**
- Only allowed transitions accepted (validated by `transition_lead_stage()`)
- `won` and `lost` are terminal — cannot transition out (must reopen first)
- `lost` requires `loss_reason`
- Every transition creates: lead_stage_history record, audit_log entry, activity record
- Stage changes trigger conversion feedback events (Phase 5, pending)

### Webhook Inbox State Machine
```
received ──> processing ──> completed
                │
                ├──> retrying ──> processing (retry)
                │       │
                │       └──> dead_letter (after max_retries=5)
                │
                └──> rejected (permanent failure, invalid payload)
```

**Retry schedule:** 30s → 2min → 10min → 30min → 2h (exponential backoff)
**Dead-letter:** After 5 retries, event is dead-lettered. Can be manually replayed from UI.
**Replay:** Resets status to `received`, retry_count to 0, clears error_detail.

### Outbox Event State Machine
```
pending ──> processing ──> sent ──> acknowledged
                │           │
                │           ├──> rejected (provider rejected)
                │           └──> failed (delivery failure)
                │
                ├──> retrying ──> processing (retry)
                │       │
                │       └──> dead_letter (after max_retries)
                │
                └──> failed (permanent failure)
```

**Idempotency:** Each outbox event has a unique `provider_event_id` to prevent duplicate conversions from repeated stage edits.

### Task State Machine
```
open ──> in_progress ──> completed
  │        │
  │        ├──> cancelled
  │        └──> overdue (auto, based on due_date)
  │
  └──> cancelled
```

### Viewing State Machine
```
scheduled ──> confirmed ──> completed
    │           │
    │           ├──> no_show
    │           ├──> cancelled
    │           └──> rescheduled ──> scheduled (new entry)
    │
    └──> cancelled
```

---

## 9. Event Processing Architecture (Inbox/Outbox)

### Design: Database-Backed Transactional Inbox/Outbox

**Why not pgmq/Supabase Queues?** pgmq adds infrastructure complexity. The database-backed approach provides transactional consistency (event and business data commit atomically), which is critical for the CRM. pgmq can be evaluated for Phase 9 if scaling requires it.

### Inbound Flow (Webhook → Lead)

```
1. Provider sends webhook to edge function endpoint
2. Edge function validates provider auth (google_key / page_id verification)
3. Edge function resolves tenant from integration config (NEVER from payload)
4. Edge function persists to webhook_inbox with unique(provider_event_id)
   - If duplicate: return 200 (idempotent receipt)
   - If new: INSERT with status='received'
5. Edge function returns 200 (durable acceptance — event is now in the database)
6. process-webhooks edge function polls webhook_inbox for status='received'
7. Claims event: UPDATE status='processing' WHERE id=? AND status='received' (concurrency-safe)
8. Normalizes lead data from provider format
9. Deduplicates contact: match by email_normalized OR phone_normalized
   - If match: reuse existing contact
   - If no match: create new contact
10. Deduplicates lead: match by (integration_id, provider_lead_id)
    - If match: update, don't create duplicate
    - If no match: create new lead with pipeline_stage_id (default: 'new' stage)
11. Creates marketing_attribution record
12. Updates webhook_inbox: status='completed', processed_at=now()
    - On error: status='retrying', retry_count++, next_attempt_at=backoff, error_detail=msg
    - After max_retries: status='dead_letter'
```

### Outbound Flow (Stage Transition → Conversion Event → Provider)

```
1. Lead stage transition occurs (via transition_lead_stage function)
2. If transition triggers a conversion event (e.g., qualified, won):
   - Check communication_consent for advertising measurement
   - Create outbox_event with payload (normalized, hashed PII per provider requirements)
   - Set status='pending', provider_event_id=unique id
3. process-outbox edge function polls outbox_events for status='pending'
4. Claims event: UPDATE status='processing' WHERE id=? AND status='pending'
5. Sends to provider API (Google Data Manager / Meta Conversions API)
6. On success: status='sent' → 'acknowledged' (when provider confirms)
7. On failure: status='retrying' with backoff, or 'failed'/'rejected' for permanent errors
8. Idempotency: provider_event_id prevents duplicate sends
```

### Concurrency Safety
- Claiming uses `UPDATE ... WHERE status='received' AND id=?` — only one worker can claim
- If a worker crashes mid-processing, the event stays in `processing` status
- Stuck-job recovery: after 10 minutes, `processing` events can be reset to `received` (manual or scheduled)

### Retry/Backoff Schedule
| Retry # | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 10 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| After 5 | Dead-letter |

### SLOs (Initial Targets — To Be Validated)
| Metric | Target | Guarantee Type |
|--------|--------|----------------|
| Webhook receipt-to-durable-acceptance | p95 < 2s | Best-effort |
| Receipt-to-lead-visible | p95 < 60s | Best-effort (depends on processing cycle) |
| API responsiveness (typical queries) | p95 < 500ms | Best-effort |
| Job completion (first attempt) | p95 < 5min | Best-effort |
| Availability | 99.5% | Platform-dependent (Supabase SLA) |
| Data loss exposure | 0 committed transactions | Database guarantee |

---

## 10. Edge Functions — Full Specs

### Deployed Edge Functions

#### 1. webhook-ingestion
- **Path:** `/functions/v1/webhook-ingestion`
- **verify_jwt:** false (public endpoint)
- **Purpose:** Receive webhooks from Google Ads and Meta Lead Ads
- **Flow:**
  1. Parse provider from URL path or payload structure
  2. Validate: Google checks `google_key` against integration config; Meta checks `page_id` + verifies webhook subscription
  3. Resolve integration by matching provider + config fields (page_id, google_key, etc.)
  4. Resolve tenant from integration's tenant_id (NEVER from payload)
  5. INSERT into webhook_inbox with unique(integration_id, provider_event_id)
  6. On duplicate: return 200 (already received)
  7. On success: return 200 with event_id
  8. On validation failure: return 401/400
  9. On server error: return 500 (provider will retry)
- **CORS:** Mandatory headers on all responses
- **Code:** `supabase/functions/webhook-ingestion/index.ts`

#### 2. process-webhooks
- **Path:** `/functions/v1/process-webhooks`
- **verify_jwt:** false (called by scheduler/cron)
- **Purpose:** Process webhook_inbox events into leads
- **Flow:**
  1. Query webhook_inbox for status='received' ORDER BY received_at LIMIT 10
  2. For each: claim with `UPDATE ... SET status='processing' WHERE id=? AND status='received'`
  3. Normalize lead data from Google/Meta format
  4. Deduplicate contact by email_normalized/phone_normalized
  5. Deduplicate lead by (integration_id, provider_lead_id)
  6. Create/update contact + lead + marketing_attribution
  7. Update webhook_inbox: status='completed' or 'retrying'/'dead_letter'
  8. Exponential backoff for retries
- **Code:** `supabase/functions/process-webhooks/index.ts`

### Planned Edge Functions (Blocked by External Credentials)

#### 3. process-outbox (Phase 5)
- **Path:** `/functions/v1/process-outbox`
- **verify_jwt:** false
- **Purpose:** Send outbound conversion events to Google/Meta
- **Dependencies:** Google Ads API credentials, Meta Conversions API credentials
- **Flow:**
  1. Query outbox_events for status='pending' ORDER BY created_at LIMIT 10
  2. Claim with `UPDATE ... SET status='processing'`
  3. Route to provider-specific sender (Google Data Manager / Meta CAPI)
  4. Hash PII (SHA-256) per provider requirements
  5. Send event with provider_event_id for idempotency
  6. Update outbox_events: status='sent'/'acknowledged'/'failed'/'retrying'
- **Status:** NOT BUILT — blocked by credentials

#### 4. send-whatsapp (Phase 6)
- **Path:** `/functions/v1/send-whatsapp`
- **verify_jwt:** true
- **Purpose:** Send WhatsApp messages via Cloud API
- **Dependencies:** WhatsApp phone_number_id, access_token, business_account
- **Status:** NOT BUILT — blocked by credentials

#### 5. send-email (Phase 6)
- **Path:** `/functions/v1/send-email`
- **verify_jwt:** true
- **Purpose:** Send emails via provider adapter (SendGrid/SES/Resend)
- **Dependencies:** Email provider API key
- **Status:** NOT BUILT — blocked by credentials

---

## 11. Architecture Decisions (Recorded)

### ADR-001: All tables carry tenant_id directly (including child tables)
- **Decision:** Every tenant-owned table has `tenant_id` column, including child tables like pipeline_stages, lead_stage_history, activities
- **Rationale:** Uniform RLS policy pattern. No need for subqueries to resolve tenant from parent. Simplifies policies and improves query performance.
- **Trade-off:** Slightly denormalized (tenant_id repeated), but security and simplicity outweigh this.

### ADR-002: Stage transitions via SECURITY DEFINER function
- **Decision:** All stage transitions go through `transition_lead_stage()` function
- **Rationale:** Atomic validation + update + history + audit + activity in one transaction. Prevents invalid transitions. Can't be bypassed by direct table updates (RLS allows UPDATE, but the function provides business logic).
- **Trade-off:** Less flexible than pure CRUD; but correctness is more important.

### ADR-003: Integration credentials as edge function secrets (credential_ref pattern)
- **Decision:** Store only the secret name (`credential_ref`) in the integrations table. Actual values stored as Supabase Edge Function secrets.
- **Rationale:** Never expose credentials to the browser. Secrets are server-side only. Supports rotation by updating the secret and keeping the same ref name.
- **Trade-off:** Can't query credential values from the database. Must be managed via Supabase dashboard or CLI.

### ADR-004: Database-backed inbox/outbox (not pgmq)
- **Decision:** Use database tables (webhook_inbox, outbox_events) instead of pgmq/Supabase Queues
- **Rationale:** Transactional consistency — event and business data commit atomically. Simpler infrastructure. pgmq can be evaluated for Phase 9 if scaling requires it.
- **Trade-off:** Manual retry/backoff logic. No built-in visibility timeout. Mitigated by status-based claiming and stuck-job recovery.

### ADR-005: Contact separated from Lead
- **Decision:** Contacts (people) are separate from Leads (opportunities). One contact can have multiple leads.
- **Rationale:** A person may enquire about several properties or through several campaigns. Merging them into one "lead" would lose distinct opportunities.
- **Trade-off:** Slightly more complex UI. Deduplication logic needed.

### ADR-006: JWT in localStorage (Supabase Auth default)
- **Decision:** Use Supabase Auth's default JWT-in-localStorage session architecture
- **Rationale:** Simplest integration with Supabase client library. Works with SPA architecture.
- **Trade-off:** XSS risk if attacker can execute JS. Mitigated by: no user-generated HTML, CSP headers, no dangerouslySetInnerHTML. For production: evaluate httpOnly cookie + SSR approach.

### ADR-007: Email confirmation OFF
- **Decision:** Keep email confirmation OFF for sign-ups
- **Rationale:** Faster onboarding for internal/pilot use. Supabase default. Can be enabled for SaaS production.

### ADR-008: Subscription plans seeded but Stripe not wired
- **Decision:** Create subscription_plans table with free + pro plans, but don't wire Stripe billing yet
- **Rationale:** Schema is ready for when Stripe account is available. No blocking dependency for CRM functionality.

---

## 12. Architecture Corrections — 7 Findings

### Finding 1: Tenant-level Authorization
**Severity:** Critical
**Status:** PARTIAL — RLS enforces tenant membership. Role-based permissions within a tenant not yet at DB level.
**What's done:**
- RLS on every table checks tenant_memberships
- SECURITY DEFINER functions verify caller role (invite_user_to_tenant, transition_lead_stage)
- 4 separate policies per table (no FOR ALL)
- EXECUTE revoked from PUBLIC/anon on all SECURITY DEFINER functions
**What's pending:**
- Migration 10: Role-aware DELETE/UPDATE policies (agents can't delete, analysts can't edit)
- `get_user_tenant_role(tenant_id)` helper function
- Automated negative tests for cross-role access
- Column-level privileges for sensitive columns (roles, commission)

### Finding 2: Per-tenant Integration Credentials
**Severity:** Critical
**Status:** DONE — `credential_ref` pattern implemented. Stores secret name only. Values are edge function secrets.
**What's done:**
- `credential_ref` column on integrations table (stores name, never value)
- Edge functions retrieve secrets via `Deno.env.get(credential_ref)`
- Global app credentials separate from per-tenant tokens
- Status tracking: last_health_check_at, last_success_at, last_error_at, last_error_detail
**What's pending:**
- Token refresh/rotation workflow (requires OAuth flow implementation — blocked by provider credentials)
- Audit records for credential changes (audit_logs table exists, can be used)

### Finding 3: Durable Event Processing
**Severity:** Critical
**Status:** DONE — Database-backed inbox/outbox with full reliability features.
**What's done:**
- webhook_inbox with unique(integration_id, provider_event_id) for idempotency
- Concurrency-safe claiming: UPDATE...WHERE status='received'
- Bounded retries with exponential backoff (30s→2h, max 5)
- Dead-letter handling and manual replay from UI
- Persist before acknowledge pattern
- outbox_events table ready for outbound events
**What's pending:**
- Stuck-job recovery (reset processing→received after timeout)
- process-outbox edge function (blocked by credentials)
- Reconciliation against provider data

### Finding 4: Database Integrity
**Severity:** High
**Status:** PARTIAL — Core tables have tenant_id and RLS. Composite FKs pending.
**What's done:**
- All tables have tenant_id
- Unique constraints on provider_event_id, provider_lead_id
- Contact deduplication via email_normalized/phone_normalized
- Lead deduplication via (integration_id, provider_lead_id)
**What's pending:**
- Migration 11: Composite FKs — `(tenant_id, parent_id) REFERENCES parent(tenant_id, id)` to prevent cross-tenant child references
- Apply to all child→parent relationships (leads→pipelines, activities→leads, etc.)

### Finding 5: Real Advertising Integrations
**Severity:** High
**Status:** BLOCKED — Edge function code written and deployed. Cannot test without credentials.
**What's done:**
- webhook-ingestion edge function handles Google Ads and Meta Lead Ads webhook receipts
- process-webhooks edge function normalizes and processes events
- Provider-specific parsing (Google lead form fields, Meta Lead Ads fields)
- Tenant resolution from integration config (never from payload)
**What's pending:**
- Google Ads API credentials (client ID, secret, developer token, refresh token)
- Meta Graph API credentials (app ID, app secret, page access token)
- End-to-end testing with provider sandboxes
- Meta webhook subscription verification flow
- Google Data Manager API integration for conversion feedback

### Finding 6: Privacy & Authentication
**Severity:** High
**Status:** PARTIAL
**What's done:**
- Communication consent table (separate from preferences)
- Auditable consent history (consented_at, withdrawn_at, consent_source)
- Session management via Supabase Auth
- onAuthStateChange with IIFE deadlock guard
**What's pending:**
- MFA for production administrators (not yet implemented)
- Data retention and deletion policies
- DPDP Act compliance review (needs legal specialist)
- Account verification flow for SaaS production
- Session revocation after security-sensitive changes

### Finding 7: Backups & Operations
**Severity:** Medium
**Status:** NOT STARTED — Depends on Supabase platform features.
**What's pending:**
- PITR (Point-in-Time Recovery) — requires Supabase Pro tier
- Off-site backup copies
- Periodic restore drills
- Documented RPO/RTO
- Monitoring and alerting setup
- Incident response playbook

---

## 13. Threat Model

| Threat | Vector | Mitigation | Status |
|--------|--------|------------|--------|
| Cross-tenant data leakage | Direct API call with other tenant's ID | RLS checks tenant_memberships on every query | DONE |
| Privilege escalation | User changes own role via API | Roles in tenant_memberships, UPDATE restricted by RLS; invite function verifies caller role | DONE |
| Forged webhooks | Attacker sends fake webhook | Provider auth validation (google_key, page_id) + tenant resolution from integration config | DONE (code) |
| Replay attacks | Attacker resends captured webhook | Unique constraint on (integration_id, provider_event_id) — duplicates return 200 but don't reprocess | DONE |
| Duplicate delivery | Provider sends same webhook twice | Same as replay — unique constraint prevents duplicate processing | DONE |
| Malformed/oversized payloads | Attacker sends huge/invalid payload | Edge function try/catch + payload validation | DONE (code) |
| Unauthorised export | Non-privileged user exports data | CSV export is frontend-only; data access still gated by RLS | PARTIAL (role check pending) |
| Stored XSS | User input rendered as HTML | React escapes by default; no dangerouslySetInnerHTML used | DONE |
| SQL injection | User input in database query | Supabase client uses parameterized queries | DONE |
| Session compromise | XSS steals JWT from localStorage | No user-generated HTML, CSP headers (planned) | PARTIAL |
| Broken access control | IDOR — user accesses other user's lead by ID | RLS on leads checks tenant_id; lead belongs to tenant | DONE (tenant level; role level pending) |
| Insecure uploaded files | Malicious file upload | Storage not yet implemented; will use Supabase Storage with access policies | PENDING |
| Log/backup leakage | Secrets in logs | Edge functions don't log secrets; audit_logs don't store credentials | DONE |
| Insider misuse | Admin accesses all tenant data | Platform-wide access tightly controlled; audit_logs track all admin actions | PARTIAL |
| Provider outages | Google/Meta API unavailable | Retry with backoff; dead-letter after max retries; diagnostics UI | DONE (code) |
| Data deletion & recovery | Accidental data deletion | Soft-delete (deleted_at column) on leads and contacts; no hard deletes via UI | DONE |
| Credential leakage | Integration tokens exposed | credential_ref pattern; tokens never in client code or database | DONE |

---

## 14. Security & Privacy Controls

### What's Enforced
- RLS on every tenant-owned table (tenant membership check via auth.uid())
- 4 separate policies per table (SELECT, INSERT, UPDATE, DELETE — never FOR ALL)
- SECURITY DEFINER functions verify membership and role
- EXECUTE on SECURITY DEFINER functions: authenticated only (revoked from PUBLIC/anon)
- All functions have explicit search_path
- Integration credentials never exposed to client (credential_ref pattern)
- auth.uid() in all policies (never current_user)
- Soft-delete on leads and contacts (deleted_at column)
- Audit logs for stage transitions, user invitations

### What's Pending
- Role-based permission matrix at DB level (Migration 10)
- Composite FKs for cross-tenant prevention (Migration 11)
- MFA for production administrators
- Automated negative authorization tests
- Data retention and deletion policies
- DPDP Act compliance review
- Rate limiting on auth endpoints
- CSP headers
- Account enumeration prevention
- Session revocation after security-sensitive changes

### Session Architecture
- Supabase Auth with JWT stored in localStorage
- onAuthStateChange with IIFE deadlock guard
- Protected routes redirect to /sign-in
- Active tenant ID stored in localStorage, verified server-side via RLS
- For production: evaluate httpOnly cookie + SSR approach

### Privacy Lifecycle
- **Consent tracking:** communication_consents table records opt-in/opt-out per channel
- **Consent sources:** lead_form, explicit, imported, inferred_from_interaction
- **Consent withdrawal:** UPDATE status to 'opted_out', set withdrawn_at
- **Data export:** CSV export from leads/reports pages
- **Data deletion:** Soft-delete (deleted_at) on leads and contacts; hard delete restricted
- **Retention:** Not yet defined — needs policy decision

---

## 15. Reliability Specification & SLOs

### Delivery & Persistence Guarantees
| Property | Guarantee | Mechanism |
|----------|-----------|-----------|
| Webhook receipt durability | Once webhook_inbox INSERT commits, the event will not be lost | Database transaction |
| Duplicate prevention | Same provider_event_id will not create duplicate leads | Unique constraint |
| Atomic stage transition | Lead update + history + audit + activity commit together | SECURITY DEFINER function transaction |
| Outbox event consistency | Stage transition and outbox event creation in same transaction (planned) | Transactional outbox |

### Retry Policies
| Component | Max Retries | Backoff | Dead-Letter |
|-----------|-------------|---------|-------------|
| webhook_inbox processing | 5 | 30s, 2m, 10m, 30m, 2h | Yes, manual replay |
| outbox_events delivery | 5 (planned) | Same schedule | Yes, manual replay |
| WhatsApp/email sending | 5 (planned) | Same schedule | Yes, manual retry |

### Monitoring (Planned)
- Integration health metrics (last_success_at, last_error_at, last_error_detail)
- Error rates and retry counts (queryable from webhook_inbox/outbox_events)
- Dead-letter monitoring (filter by status='dead_letter' in diagnostics UI)
- Processing latency (received_at → processed_at)

### Backup & Recovery (Planned)
| Requirement | Development (Current) | Production (Required) |
|-------------|----------------------|----------------------|
| Database backup | Supabase daily snapshots | Supabase Pro PITR |
| Retention | 7 days (free tier) | 30 days minimum |
| RPO | Up to 24 hours | <15 minutes (PITR) |
| RTO | Hours (manual restore) | <1 hour (with PITR) |
| Off-site copies | No | Recommended |
| Restore drills | Not done | Quarterly |

---

## 16. Cost & Operational Model

### Development Configuration (Current)
| Service | Plan | Cost | Limitations |
|---------|------|------|-------------|
| Supabase | Free | $0 | 500MB DB, 1GB storage, 50k MAU, 2 edge functions/sec, daily backups (7-day retention) |
| Vite/Bolt hosting | Free | $0 | Static hosting, no SSR |
| Domain | — | ~$10-15/year | Required for production |

### Production Configuration (Required for Pilot)
| Service | Plan | Est. Cost/month | What It Adds |
|---------|------|-----------------|--------------|
| Supabase Pro | Pro | ~$25 | 8GB DB, PITR backups, 100GB storage, daily backups with 7-day PITR, no edge function rate limits |
| Supabase add-ons | — | Usage-based | Additional DB size, bandwidth, edge function invocations |
| WhatsApp Cloud API | Meta | $0.005-0.10/msg | First 1000 conversations/month free |
| Email provider | SendGrid/Resend | $0-$20 | Free tier: 100-3000 emails/day |
| Google Ads API | Google | $0 | API access is free; costs are ad spend |
| Meta API | Meta | $0 | API access is free; costs are ad spend |
| Stripe | Stripe | 2-3% per transaction | For subscription billing |
| Domain | — | ~$1/month | Required |
| **Total (minimum)** | | **~$25-45/month** | Supabase Pro + email + domain |

### What Makes Free Tier Unsuitable for Production
- No PITR (can lose up to 24 hours of data)
- 500MB DB limit (sufficient for pilot, not for scale)
- Edge function rate limiting (2 invocations/sec)
- No daily backups beyond 7-day retention
- No SLA
- No pausing protection (project can be paused after inactivity)

---

## 17. Frontend File Inventory

### Infrastructure
| File | Purpose |
|------|---------|
| `src/lib/supabase.ts` | Supabase client singleton |
| `src/lib/utils.ts` | cn(), formatCurrency, formatNumber, formatDate, formatDateTime, timeAgo, initials, normalizeEmail, normalizePhone, slugify |
| `src/types/index.ts` | All TypeScript interfaces (37+ types/enums) |
| `src/stores/auth-store.ts` | Zustand auth store (user, tenants, activeTenant, memberships, loadTenantData, setActiveTenant, signOut) |
| `src/hooks/use-tenant-data.ts` | useTenantQuery() and useTenantData() hooks |

### UI Components (src/components/ui/)
| Component | Variants/Features |
|-----------|-------------------|
| Button | 6 variants (primary/secondary/outline/ghost/danger/success), 4 sizes, loading state, icon support |
| Input | Input, Textarea, Select with label/error/hint support |
| Card | Card, CardHeader, CardTitle, CardContent, CardFooter |
| Badge | 7 variants (primary/accent/success/warning/error/info/neutral) with optional dot |
| Avatar | Initials-based, 4 sizes, image fallback |
| Spinner | Spinner + FullPageSpinner |
| EmptyState | Icon, title, description, action button |
| Dialog | Modal with ESC close, backdrop click, 4 sizes (sm/md/lg/xl) |
| Table | Table primitives + DataTable generic component |

### Auth (src/components/auth/)
| Component | Purpose |
|-----------|---------|
| AuthProvider | Session management, onAuthStateChange with IIFE deadlock guard, auto-onboarding |
| ProtectedRoute | Redirects to /sign-in if no user; shows "No Tenant Access" if no activeTenant |

### Layout (src/components/layout/)
| Component | Purpose |
|-----------|---------|
| AppLayout | Sidebar nav (14 items), top bar with tenant selector, search, notifications, user profile, responsive mobile drawer |

### Pages
| Page | Path | Status | Features |
|------|------|--------|----------|
| SignIn | /sign-in | DONE | Email/password, error handling |
| SignUp | /sign-up | DONE | First/last name, email, password |
| Dashboard | / | DONE | 8 metric cards, recent leads |
| Leads | /leads | DONE | Search, filters, create dialog, CSV import/export |
| Lead Detail | /leads/:id | DONE | Stage transitions (RPC), activity timeline, tasks, assignment |
| Contacts | /contacts | DONE | Search, link to leads |
| Pipeline | /pipeline | DONE | Kanban board, drag-and-drop, server-validated |
| Properties | /properties | DONE | Grid, search, type/availability filters, create |
| Property Detail | /properties/:id | DONE | Edit mode, overview stats, notes, amenities |
| Projects | /projects | DONE | List, create dialog |
| Tasks | /tasks | DONE | Open/completed/all filters, create, toggle |
| Calendar | /calendar | DONE | Upcoming viewings by date |
| Reports | /reports | DONE | Date range filter, CSV export, 8 metric cards, source/stage breakdowns, agent performance |
| Integrations | /integrations | DONE | Add/pause/activate/delete, provider selector, status badges |
| Webhook Diagnostics | /integrations/webhooks | DONE | Status filter tabs, event detail, raw payload, replay |
| Outbox Diagnostics | /integrations/outbox | DONE | Status filter tabs, event detail, payload, replay |
| Settings | /settings | DONE | General info, Members (invite/revoke), Audit log |
| Custom Fields | /settings/custom-fields | DONE | Entity type tabs, create/edit/delete, field types |
| Automation Rules | /settings/automation | DONE | Create/edit/delete, trigger/action selectors, toggle |
| SaaS Onboarding | /onboarding | NOT BUILT | Sign-up → tenant setup wizard |
| Tenant Config | /settings/tenant | NOT BUILT | Branding, pipeline customization |

### Routing (src/App.tsx)
- Public: /sign-in, /sign-up
- Protected: /, /leads, /leads/:id, /contacts, /pipeline, /properties, /properties/:id, /projects, /tasks, /calendar, /reports, /integrations, /integrations/webhooks, /integrations/outbox, /settings, /settings/custom-fields, /settings/automation

### Sidebar Navigation Items
Dashboard, Leads, Contacts, Pipeline, Properties, Projects, Calendar, Tasks, Reports, Integrations, Webhooks, Outbox, Custom Fields, Automation, Settings

---

## 18. Phase-by-Phase Roadmap

### Phase 1 — Application Foundation [DONE]
**Scope:** Design system, app shell, navigation, reusable components, auth, loading/error/empty states
**Dependencies:** None
**Schema changes:** None (frontend only)
**Tests:** Build passes, type check passes
**Acceptance:** App renders with sidebar, sign-in/sign-up works, loading/error/empty states show

### Phase 2 — Authentication & Multi-tenancy [DONE + 1 PENDING]
**Scope:** Orgs, tenants, memberships, roles, tenant switching, RLS, auto-onboarding, invitations
**Dependencies:** Phase 1
**Schema:** Migrations 1-9 (org hierarchy, memberships, helper functions, invitation function)
**Tests:** Build passes, RLS policies in place
**Acceptance:** User can sign up, gets auto-onboarded with a tenant, can switch tenants, can invite users
**Pending:** Role-based permission enforcement at DB level (Migration 10)

### Phase 3 — Core CRM [DONE + 1 PENDING]
**Scope:** Contacts, leads, properties, projects, pipelines, stage transitions, activities, tasks, viewings, assignment, dashboard, lead scoring
**Dependencies:** Phase 2
**Schema:** Migration 2 (16 CRM tables), Migration 3 (pipeline + transition function), Migration 7 (scoring)
**Tests:** Build passes, stage transitions validated server-side
**Acceptance:** Full lead lifecycle works: create → contact → qualify → schedule viewing → negotiate → win
**Pending:** Composite FKs for cross-tenant prevention (Migration 11)

### Phase 4 — Inbound Integrations [BLOCKED — Code DONE]
**Scope:** Google Ads lead form ingestion, Meta Lead Ads ingestion, webhook verification, tenant resolution, durable receipt, dedup, retries, diagnostics
**Dependencies:** Phase 2 (integrations table), external credentials
**Schema:** Migration 8 (integrations, integration_webhook_endpoints, webhook_inbox)
**Code:** webhook-ingestion + process-webhooks edge functions deployed
**Tests:** Code review only — cannot test without provider credentials
**Acceptance:** Webhook from Google/Meta creates a lead in the correct tenant with correct contact dedup
**Blocked by:** Google Ads API credentials, Meta Graph API credentials

### Phase 5 — Outbound Conversion Feedback [BLOCKED — Scaffolding PARTIAL]
**Scope:** Google enhanced conversions, Meta Conversions API for CRM, event mapping, consent checks, idempotency, delivery status, retries, diagnostics
**Dependencies:** Phase 4 (credentials), outbox_events table
**Schema:** Migration 2 (outbox_events table)
**Done:** Outbox diagnostics UI page built
**Tests:** None — blocked by credentials
**Acceptance:** Stage transition to 'qualified' or 'won' creates an outbox event that gets sent to the correct provider with hashed PII and consent check
**Blocked by:** Same Google/Meta credentials as Phase 4

### Phase 6 — Communications [BLOCKED]
**Scope:** WhatsApp Cloud API, email provider adapter, templates, delivery tracking, opt-in/opt-out
**Dependencies:** External provider accounts (WhatsApp, email)
**Schema:** Migration 8 (communication_consents table)
**Tests:** None — blocked by credentials
**Acceptance:** User can send WhatsApp/email to a lead, delivery status is tracked, opt-outs are respected
**Blocked by:** WhatsApp Cloud API credentials, email provider API key

### Phase 7 — Reporting & Automation [PARTIAL]
**Scope:** Reporting, marketing attribution, custom fields, automation rules
**Dependencies:** Phase 3 (CRM data)
**Done:**
- Reports page with date range filter, CSV export, 8 metric cards
- Source breakdown, pipeline distribution, agent performance
- Custom fields management UI
- Automation rules UI
- Lead CSV import/export
**Pending:**
- Marketing attribution dashboard (campaign breakdown)
- Time-to-first-contact metric (DONE in reports)
- Conversion rate between stages
- Stale leads and follow-up backlog report (DONE in reports)
- Integration health report
**Tests:** Build passes, reports render with real data
**Acceptance:** Reports show accurate metrics with date filtering, CSV export works

### Phase 8 — SaaS Readiness [PARTIAL]
**Scope:** Tenant admin, onboarding, subscription readiness, billing
**Dependencies:** Phase 2 (tenant schema), Phase 8 external (Stripe)
**Done:**
- Subscription plans schema (free + pro seeded)
- User invitation flow
- Tenant admin features (members, audit log)
**Pending:**
- SaaS self-serve onboarding flow (sign-up → tenant creation → config wizard)
- Tenant configuration UI (branding, pipeline customization)
- Subscription management UI (view plan, upgrade prompt)
- Usage metering
- Stripe billing integration
**Tests:** Build passes
**Acceptance:** New user can self-serve sign up and get a configured tenant; admin can manage users and settings

### Phase 9 — Production Readiness [NOT STARTED]
**Scope:** Security audit, dependency audit, performance testing, backup drills, integration failure simulation, observability, production deployment
**Dependencies:** All previous phases
**Pending:**
- Negative authorization tests (cross-tenant, cross-role)
- npm audit / vulnerability scan
- Load testing (webhook burst, concurrent users)
- Query optimization (add missing indexes)
- Backup and restoration drills
- Stuck-job recovery mechanism
- Structured logging with correlation IDs
- Monitoring and alerting
- CSP headers
- MFA for admin accounts
**Acceptance:** All tests pass, security verified, backups tested, monitoring in place

---

## 19. Blocked Work & External Dependencies

| Phase | Dependency | What's Needed | Status |
|-------|-----------|---------------|--------|
| 4 | Google Ads API | Client ID, client secret, developer token, refresh token | NOT PROVIDED |
| 4 | Meta Graph API | App ID, app secret, page access token | NOT PROVIDED |
| 5 | Same as Phase 4 | Same Google/Meta credentials | NOT PROVIDED |
| 6 | WhatsApp Cloud API | Phone number ID, access token, business account | NOT PROVIDED |
| 6 | Email provider | API key (SendGrid/SES/Resend) | NOT PROVIDED |
| 8 | Stripe billing | API keys, webhook secret | NOT PROVIDED |
| 9 | Supabase Pro | Paid tier for PITR, no rate limits | NOT PROVISIONED |

**What's built despite blockers:**
- Edge function code for webhook ingestion and processing (deployed, untested with real data)
- Outbox events table and diagnostics UI (no processing edge function yet)
- Communication consents table (no messaging integration yet)
- Subscription plans schema (no Stripe wiring)

---

## 20. Remaining Feasible Work (No External Credentials Needed)

### Immediate Priority (This Session)
1. ~~Reports page: date range filters + CSV export~~ DONE
2. ~~Outbox diagnostics page~~ DONE
3. **Role-based permission enforcement migration** (Migration 10)
4. **Database integrity composite FKs migration** (Migration 11)
5. **SaaS onboarding flow** (Phase 8)
6. **Tenant configuration UI** (Phase 8)

### Secondary Priority (Future Sessions)
7. Marketing attribution dashboard with campaign breakdown
8. Conversion rate between pipeline stages (stage-to-stage funnel)
9. Integration health dashboard
10. Property matching engine UI (rule-based, explainable matches)
11. Stuck-job recovery function + diagnostics UI button
12. Additional performance indexes (Migration 12)
13. Frontend role-based UI gating (hide actions based on role)
14. Negative authorization test scaffolding
15. Observability: correlation IDs in edge functions
16. CSP headers and security hardening

---

## 21. Acceptance Criteria

### Tenant Isolation
- [ ] User in Tenant A cannot SELECT/INSERT/UPDATE/DELETE records in Tenant B
- [ ] User with no tenant membership cannot access any tenant data
- [ ] Tenant context verified server-side via RLS (not just frontend)
- [ ] Cross-tenant child reference prevented by composite FK

### Role Enforcement
- [ ] Sales agent cannot delete leads
- [ ] Sales agent can only update leads assigned to them
- [ ] Marketing analyst cannot create/edit/delete any data
- [ ] Auditor can only read audit logs
- [ ] Only tenant_owner/admin can invite users
- [ ] Only tenant_owner/admin can configure integrations
- [ ] Only tenant_owner/admin can modify pipeline settings

### Lead Ingestion
- [ ] Webhook from Google Ads creates a lead in the correct tenant
- [ ] Webhook from Meta Lead Ads creates a lead in the correct tenant
- [ ] Duplicate webhook delivery does not create duplicate lead
- [ ] Lead data is normalized from provider-specific format
- [ ] Contact is deduplicated by email_normalized/phone_normalized
- [ ] Failed processing retries with exponential backoff
- [ ] After max retries, event is dead-lettered and visible in diagnostics UI
- [ ] Dead-lettered event can be replayed from UI

### Provider-Specific Auth
- [ ] Google webhook validates google_key against integration config
- [ ] Meta webhook validates page_id and verifies subscription
- [ ] Invalid auth returns 401
- [ ] Tenant is resolved from integration config, never from payload

### Data Exports
- [ ] CSV export from reports page downloads valid CSV
- [ ] CSV export from leads page downloads valid CSV
- [ ] Export respects RLS (only current tenant's data)

### Audit Trails
- [ ] Stage transitions create audit_log entries
- [ ] User invitations create audit_log entries
- [ ] Integration config changes create audit_log entries (planned)
- [ ] Audit logs are read-only (no UPDATE/DELETE except by system)

### Performance
- [ ] Dashboard loads in <2s with 1000 leads
- [ ] Pipeline board loads in <2s with 500 leads
- [ ] Reports page loads in <3s with 10k leads
- [ ] Webhook ingestion responds in <2s

### Security Regressions
- [ ] No SQL injection (parameterized queries)
- [ ] No XSS (React auto-escaping, no dangerouslySetInnerHTML)
- [ ] No credential exposure in client code
- [ ] No open redirects
- [ ] CSRF protection (Supabase Auth handles)

---

## 22. Production Readiness Checklist

### Security
- [ ] Negative authorization tests (cross-tenant, cross-role)
- [ ] Role-based permission enforcement at DB level (Migration 10)
- [ ] Composite FKs for cross-tenant prevention (Migration 11)
- [ ] Dependency vulnerability audit (npm audit)
- [ ] Rate limiting on auth endpoints
- [ ] MFA for admin accounts
- [ ] Session revocation after security-sensitive changes
- [ ] CSP headers
- [ ] Account enumeration prevention

### Reliability
- [ ] Load testing (webhook burst, concurrent users)
- [ ] Query optimization (add missing indexes — Migration 12)
- [ ] Stuck-job recovery mechanism
- [ ] Circuit breaker for external API calls
- [ ] Structured logging with correlation IDs
- [ ] Error rate monitoring
- [ ] Dead-letter alerting

### Backups
- [ ] PITR enabled (requires Supabase Pro)
- [ ] Off-site backup copies
- [ ] Periodic restore drills
- [ ] Documented RPO/RTO
- [ ] Backup retention policy

### Deployment
- [ ] Environment separation (staging/production)
- [ ] Migration rollback strategy
- [ ] Monitoring and alerting setup
- [ ] Incident response playbook
- [ ] CI/CD pipeline

### Compliance
- [ ] DPDP Act compliance review (needs legal specialist)
- [ ] Data retention policy
- [ ] Privacy notices
- [ ] Consent withdrawal workflow
- [ ] Data export and deletion procedures
- [ ] Cookie consent (if applicable)

---

## 23. Key File References

| File | Purpose |
|------|---------|
| `PROJECT_LOG.md` | What's been built (read first each session) |
| `masterplan.md` | THIS FILE — exhaustive reference for everything |
| `plan.md` | Quick reference for next steps |
| `docs/ARCHITECTURE.md` | Full architecture spec (2135 lines) — the original design doc |
| `src/App.tsx` | Routing |
| `src/components/layout/AppLayout.tsx` | Sidebar nav + top bar |
| `src/stores/auth-store.ts` | Zustand auth store |
| `src/types/index.ts` | All TypeScript types |
| `src/lib/supabase.ts` | Supabase client |
| `src/lib/utils.ts` | Utility functions |
| `src/hooks/use-tenant-data.ts` | Tenant-scoped query hooks |
| `supabase/config.toml` | Edge function config |
| `supabase/functions/webhook-ingestion/index.ts` | Webhook receipt edge function |
| `supabase/functions/process-webhooks/index.ts` | Webhook processing edge function |
| `supabase/migrations/` | All migration SQL files |
