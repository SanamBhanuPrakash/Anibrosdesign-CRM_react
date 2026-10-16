# ANIBROS CRM — COMPREHENSIVE DEEP-DIVE ANALYSIS
## Engineering Audit · Security Review · Architecture Gap Analysis · FAANG-Level Assessment

**Generated:** 13 October 2026 (Asia/Kolkata, 14:00 IST)
**Analyst:** Independent forensic review of local repository `feat/native-postgresql-migration` (HEAD: `a45d5f4`)
**Scope:** System design, security, scalability, architecture quality, feature completeness vs. PROJECT_OVERVIEW.md, FAANG-level engineering standard

---

> [!CAUTION]
> This document is brutally honest. It distinguishes what is **actually built and verified** from what is **claimed in logs, reported by previous agents, or partially started**. Progress percentages are estimates based on actual file evidence, not self-reported task completion.

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [What Is Actually Built (Verified)](#2-what-is-actually-built-verified)
3. [What Is Missing — Full Inventory](#3-what-is-missing--full-inventory)
4. [Security Deep Dive — How Bad Is It?](#4-security-deep-dive--how-bad-is-it)
5. [Architecture Gaps and System Design Issues](#5-architecture-gaps-and-system-design-issues)
6. [Database Engineering Assessment](#6-database-engineering-assessment)
7. [Scalability — Will It Work When Users Increase?](#7-scalability--will-it-work-when-users-increase)
8. [FAANG-Level Assessment](#8-faang-level-assessment)
9. [The Plan — How To Fix Everything](#9-the-plan--how-to-fix-everything)
10. [Priority Matrix](#10-priority-matrix)

---

## 1. EXECUTIVE SUMMARY

### The Brutal Truth

Anibros CRM has a **solid foundation** but is nowhere near production-ready, FAANG-level quality, or even mid-tier SaaS quality. Here is where things stand:

| Dimension | Current State | FAANG Target | Gap |
|---|---|---|---|
| **Authentication** | ~70% complete. Native Argon2id + sessions + CSRF. Email verification enforced. Password reset skeleton. BUT: no MFA, no account lockout, no session fingerprinting, no brute-force IP block, no refresh token rotation. | 100% | **30% missing** |
| **Authorization / RBAC** | ~50%. Roles exist in DB. `requireRoles()` middleware exists. BUT: most routes do NOT call `requireRoles()` — only auth required. No granular per-route role checks. RLS is tenant-scoped only, not role-scoped. | 100% | **50% missing** |
| **Multi-Tenancy** | ~65%. Tenant isolation via `executeInTenantContext` + SET LOCAL is correct. BUT: `system_health` table lacks tenant scoping. WebSocket picks first tenant from multi-tenant membership. Operations routes partially skip tenant isolation. | 100% | **35% missing** |
| **Database Schema** | ~55%. Core CRM tables exist (leads, contacts, pipeline, properties, viewings, tasks). BUT: 6 out of 14 planned domain groups are missing or incomplete (marketing attribution, consent, custom fields, automation, SaaS subscription, notification read receipts). | 100% | **45% missing** |
| **CRM Features** | ~35% end-to-end. Pages exist for most features but many call APIs that return stubs or have zero backend. Properties, matching, reports, attribution, automation, custom fields, subscriptions are UI-only or partial. | 100% | **65% missing** |
| **Realtime** | ~50%. WebSocket server authenticated and scoped. Frontend hook exists. BUT: no LISTEN/NOTIFY pipeline, no snapshot reconciliation, no reconnect cursor, no duplicate detection, no fallback polling in WS mode. | 100% | **50% missing** |
| **Worker / Queue** | ~40%. DurableWorker with FOR UPDATE SKIP LOCKED. BUT: no actual lead creation from webhooks (stub), no outbound provider calls, no stuck-job recovery wired, no dead-letter replay API, no worker health metrics. | 100% | **60% missing** |
| **Provider Integrations** | ~10%. Webhook route exists but is stub-level. No Google Ads parsing. No Meta HMAC verification in native backend. No outbound conversion events. | 100% | **90% missing** |
| **Testing** | ~20%. Unit tests for utils, permissions, realtime leads, telemetry, webhook-security exist (89 tests claimed). BUT: no E2E browser tests, no API integration tests against real DB (only 2 test files in server/), no performance tests, no security negative tests, no cross-tenant isolation tests on native DB. | 100% | **80% missing** |
| **Operations Center** | ~45%. UI page is massive (68KB). Backend `/api/operations` routes exist. BUT: `system_health` not scoped to tenant, no PostgreSQL LISTEN integration, replay/recovery stubs present but untested. | 100% | **55% missing** |
| **Production Readiness** | ~5%. No CI/CD. No backup strategy. No TLS config. No migration to real hosting. No load testing. No runbooks. No alerts. Supabase JS dependency still in package.json. | 100% | **95% missing** |

### Overall Completion vs. PROJECT_OVERVIEW.md

> **Estimated 28-35% complete** against the full scope defined in PROJECT_OVERVIEW.md.

This is not a criticism — the architecture work done is genuinely solid. But the honest state is: **this is a good skeleton, not a working CRM**.

---

## 2. WHAT IS ACTUALLY BUILT (VERIFIED)

These items are verified against the actual files inspected (commit `a45d5f4`):

### Solid Foundations (Built Correctly)

#### Authentication Core
- **Argon2id password hashing** (`server/src/auth/password.ts`) — industry standard, correctly calibrated
- **Server-managed sessions** with SHA-256 token hashes, HttpOnly cookies, SameSite=Lax — correct design
- **Double-submit CSRF protection** (`server/src/middleware/csrf.ts`) — properly implemented
- **Rate limiting** on auth routes — 15 requests per 15-min window
- **Email verification enforced** in `requireAuth` — fails closed, no `autoVerify` bypass
- **Email verification tokens** — hashed at rest, 24h expiry, stored in `email_verification_tokens` table
- **Atomic signup** — user + org + tenant + membership + pipeline seeded in one transaction

#### Database Schema (Native PostgreSQL)
- **6 migration files** covering: identity/auth, CRM core, queues/diagnostics, RLS/security, pipeline transitions/viewings, email verification
- **RLS enabled** on core tables with `app.current_tenant_id()` function — correct architectural pattern
- **Least-privilege runtime role** `crm_app_user` with CREATE revoked, audit_logs UPDATE/DELETE revoked
- **Composite FK constraints** enforcing cross-tenant integrity (`fk_transition_pipeline_tenant`)
- **Pipeline state machine** with 13 stages and proper transition table
- **Atomic viewing booking** with interval check and property row lock
- **Stuck job recovery** function with role authorization check

#### Backend API (Express/TypeScript)
- **13 route modules** registered: auth, leads, properties, viewings, contacts, tasks, dashboard, notifications, projects, tenant, operations, webhooks, health
- **Structured middleware pipeline**: Helmet → CORS → Cookie Parser → JSON → Request Context → CSRF
- **`executeInTenantContext`** — correctly sets `app.current_tenant_id` and `app.current_user_id` per-transaction via SET LOCAL, resets on release
- **Centralized error handler** redacting stack traces from client responses
- **Correlation IDs** in `requestContextMiddleware`

#### WebSocket Realtime
- **Authenticated WS upgrade** — validates session cookie against DB before accepting connection
- **Tenant-scoped broadcast** — `broadcastToTenant()` filters strictly by `tenantId`
- **Heartbeat/ping-pong** — 30-second interval dead connection cleanup

#### Worker
- **DurableWorker** with `FOR UPDATE SKIP LOCKED` — correct concurrency pattern
- **Exponential backoff** on failures (3-second initial, bounded)

#### Frontend Structure
- **All routes registered** in App.tsx (24 routes)
- **MUI theme** installed and `AppThemeProvider` wrapping the app
- **Auth flow pages**: SignIn, SignUp, ForgotPassword, ResetPassword, VerifyEmail
- **Error boundary** at app level

---

## 3. WHAT IS MISSING — FULL INVENTORY

### 3.1 Missing Authentication Features

| Feature | Status | Risk |
|---|---|---|
| MFA (TOTP/SMS) | NOT BUILT | HIGH — Admin accounts have no second factor |
| Account lockout after failed attempts | NOT BUILT | HIGH — Brute force is possible |
| Session fingerprinting (device binding) | NOT BUILT | MEDIUM |
| Session listing/revocation for user | NOT BUILT | MEDIUM — User can't see or kill active sessions |
| Password strength enforcement | PARTIAL — only 8-char min | MEDIUM |
| Password history (prevent reuse) | NOT BUILT | LOW |
| Refresh token rotation | NOT BUILT — single session token | MEDIUM |
| IP-based rate limiting (not just route-level) | NOT BUILT | HIGH |
| Account deactivation enforcement | `is_active` column exists, NOT checked in auth | HIGH |
| Audit trail for login/logout/failed attempts | NOT VERIFIED in current native routes | HIGH |
| Resend email verification | Route not confirmed | MEDIUM |

### 3.2 Missing RBAC Enforcement (Biggest Gap)

Most routes use only `requireAuth` (checks if logged in). They do NOT call `requireRoles()`.

**Result:** Any authenticated user — regardless of role (`marketing_analyst`, `auditor`, `executive_readonly`) — can create leads, create contacts, modify properties.

| Route | Auth Required | Role Check | Problem |
|---|---|---|---|
| `GET /api/leads` | YES | NO | `auditor` should not see leads |
| `POST /api/leads` | YES | NO | `marketing_analyst`, `executive_readonly`, `auditor` cannot create leads per spec |
| `DELETE /api/leads/:id` | YES | NO | Only `tenant_owner`, `tenant_admin` should delete |
| `POST /api/contacts` | YES | NO | Role check absent |
| `POST /api/properties` | YES | NO | `sales_agent` cannot create properties per spec |
| `DELETE /api/properties/:id` | YES | NO | Only admins can delete |
| `GET /api/tenant/members` | YES | NO | Only admins should see member list |
| `POST /api/tenant/members/invite` | YES | YES | OK — has requireRoles |

**RLS is not a substitute** — the RLS policies in migration 004 use `FOR ALL` with tenant check only, not role check. This means broken access control at the API layer is not compensated by the database.

### 3.3 Missing Database Tables / Schema Gaps

| Table Group | Status |
|---|---|
| `users`, `sessions`, `password_reset_tokens`, `email_verification_tokens` | BUILT (migrations 001, 006) |
| `organisations`, `tenants`, `tenant_memberships`, `tenant_invitations` | BUILT (migration 001) |
| `pipelines`, `pipeline_stages`, `pipeline_stage_transitions` | BUILT (migrations 002, 005) |
| `contacts`, `leads`, `lead_stage_history` | BUILT (migration 002) |
| `properties`, `projects`, `viewings`, `activities`, `tasks`, `audit_logs` | BUILT (migration 002) |
| `webhook_inbox`, `outbox_events`, `operational_logs`, `system_health`, `incidents` | BUILT (migration 003) |
| `marketing_attribution` | MISSING — Referenced in routes but NOT in any native migration |
| `integrations`, `integration_webhook_endpoints` | MISSING — Not in native migrations |
| `communication_consents` | MISSING |
| `custom_field_definitions`, `custom_field_values` | MISSING |
| `automation_rules`, `automation_executions` | MISSING |
| `subscription_plans`, `tenant_subscriptions` | MISSING |
| `notifications`, `notification_reads` | CRITICAL — `notifications` referenced in RLS (004) but NEVER CREATED |
| `branches`, `property_availability_history` | MISSING |
| Property matching preferences, Lead scoring config | MISSING |

**CRITICAL BUG:** Migration 004 applies `ALTER TABLE notifications ENABLE ROW LEVEL SECURITY` but the `notifications` table is never created in migrations 001-003. This means clean database bootstrap **will FAIL** at migration 004.

### 3.4 Missing API Routes

| Frontend Page | Backend Route Needed | Status |
|---|---|---|
| `AttributionPage.tsx` | `GET /api/attribution/*` | NO ROUTE |
| `ReportsPage.tsx` | `GET /api/reports/*` | NO ROUTE |
| `PropertyMatchingPage.tsx` | `GET /api/matching/*` | NO ROUTE |
| `IntegrationsPage.tsx` | `GET /api/integrations/*` | NO ROUTE |
| `CustomFieldsPage.tsx` | `/api/custom-fields/*` | NO ROUTE |
| `AutomationRulesPage.tsx` | `/api/automation/*` | NO ROUTE |
| `SubscriptionPage.tsx` | `/api/subscription/*` | NO ROUTE |
| `WebhookDiagnosticsPage.tsx` | `/api/operations/webhooks` | PARTIAL |
| `OutboxDiagnosticsPage.tsx` | `/api/operations/outbox` | PARTIAL |
| `CalendarPage.tsx` | Uses viewings routes | PARTIAL |
| `PipelinePage.tsx` | Pipeline stage transitions | PARTIAL — missing update/reorder |

**8 of 24 pages have NO corresponding backend routes. 6 more have incomplete routes.**

### 3.5 Missing CRM Workflow Features

**Leads:** No CSV import/export, no bulk operations, no deduplication logic, no lead scoring endpoint, no assignment workflow, no SLA tracking, no loss reason enforcement on lost stage.

**Pipeline:** No pipeline configuration (create/reorder/edit stages), no deal/opportunity model, no pipeline value aggregation.

**Properties & Projects:** No availability status transition history, no property images/documents, no location/locality search filters, no sold/unavailable filter in matching.

**Tasks & Calendar:** No task reminders/notifications, no calendar conflict checking, no viewing feedback capture, no no-show tracking, no reschedule workflow.

**Reports & Attribution:** No source breakdown reports, no agent performance reports, no conversion rate funnel, no attribution model, no campaign ROI, no CSV export.

**Notifications:** No in-app notifications from backend events, no read receipts per user, no email notifications, no WhatsApp.

**Settings & Admin:** No custom field CRUD, no automation rules configuration, no pipeline stage customization, no tenant branding, no subscription plan enforcement, no user deactivation, no data export/deletion.

---

## 4. SECURITY DEEP DIVE — HOW BAD IS IT?

### 4.1 Critical Security Issues

#### CRITICAL: Missing `is_active` Check in Authentication

When a user account is deactivated (`is_active = false`), they can **still log in** and use the system because session validation only checks the `sessions` table, not `users.is_active`. Deactivated/suspended accounts can continue using valid session tokens until they naturally expire.

**Fix:** Add `AND u.is_active = true` to the session validation query in `validateSession()`.

#### CRITICAL: Role-Based Access Control Not Enforced on Most Routes

As documented in section 3.2, any authenticated user can create leads, modify contacts, and access admin-level data regardless of their assigned role. This is **OWASP Top 10 #1: Broken Access Control**.

#### CRITICAL: Supabase JS Library Still in Production Dependencies

```
package.json: "@supabase/supabase-js": "^2.57.4"
src/lib/supabase.ts: import { createClient } from '@supabase/supabase-js'
```

Despite claiming "zero Supabase runtime," the Supabase client is bundled into the production frontend. The placeholder URL `https://placeholder.supabase.co` is exposed in the bundle.

#### CRITICAL: `notifications` Table RLS Applied But Table Not Created

Migration 004 applies RLS to a `notifications` table that does not exist. Clean database bootstrap fails.

### 4.2 High Security Issues

| Issue | Impact |
|---|---|
| CORS `!origin` bypass — allows no-Origin requests through | Tooling-based CORS bypass |
| WebSocket authentication doesn't check `is_active` | Deactivated users maintain WS connections |
| No IP-level rate limiting; `req.ip` may always be `127.0.0.1` without trust proxy | Brute force possible |
| `system_health` not tenant-scoped — all tenants see infrastructure details | Information disclosure |
| `operational_logs` uses `OR tenant_id IS NULL` — platform logs visible to all tenants | Information disclosure |
| Dev password `'dev-app-password'` hard-coded in migration 004 | Credential leak if migration file leaks |

### 4.3 Medium Security Issues

| Issue | Impact |
|---|---|
| Password reset token consumption not verified as atomic/single-use | Potential token reuse |
| No Content Security Policy (disabled in Helmet config) | XSS escalation enabled |
| No secrets scanning in CI | Risk of secret commits |
| Invitation token not verified against user email on acceptance | Account takeover potential |

### 4.4 OWASP Top 10 2021 Scorecard

| Category | Status |
|---|---|
| A01 Broken Access Control | CRITICAL — RBAC not enforced on most routes |
| A02 Cryptographic Failures | GOOD — Argon2id, SHA-256 hashes, no plain-text |
| A03 Injection | OK — Parameterized queries. Manual SQL construction needs review. |
| A04 Insecure Design | MEDIUM — Design correct, enforcement incomplete |
| A05 Security Misconfiguration | HIGH — CSP disabled, dev password in migrations, CORS bypass |
| A06 Vulnerable Components | UNKNOWN — No automated scanning. Supabase JS in bundle. |
| A07 Identification and Auth Failures | HIGH — No MFA, no account lockout, deactivated account bypass |
| A08 Software and Data Integrity | PARTIAL — Checksum migration runner. No supply chain scanning. |
| A09 Logging and Monitoring Failures | PARTIAL — Structured logs exist. No alerting. Partial tenant isolation. |
| A10 Server-Side Request Forgery | N/A — no user-supplied URL fetching currently |

---

## 5. ARCHITECTURE GAPS AND SYSTEM DESIGN ISSUES

### Problem 1: Two Authentication Systems Coexisting

The codebase contains BOTH:
- New native session system (Express + PostgreSQL)
- Legacy Supabase auth client (still in `package.json` and `src/lib/supabase.ts`)

Additionally, the frontend has THREE different realtime hooks:
- `use-realtime-sync.ts` — uses Supabase channels
- `use-realtime-leads.ts` — also uses Supabase channels
- `use-native-realtime.ts` — the new WebSocket hook

**Three different realtime mechanisms exist simultaneously.** This creates inconsistent behavior, unpredictable event delivery, and security concerns (unauthenticated Supabase subscriptions possible).

### Problem 2: No Database LISTEN/NOTIFY Integration

The WebSocket server (`ws-server.ts`) has no `pg.Client.query("LISTEN channel_name")` call. It can only broadcast events when the API layer calls `realtimeHub.broadcastToTenant()` synchronously. Problems:

- If the API crashes between a DB write and the broadcast, the event is permanently lost
- Worker-generated events broadcast via the same singleton — breaks if WS server is on a different process
- No database-level event propagation means horizontal scaling is impossible without architectural changes

**Realtime currently works only as long as the API and WS server are the same single process.**

### Problem 3: No Service Layer — Business Logic in Route Handlers

Backend routes directly query the database pool inline:

```typescript
// leads.ts, contacts.ts, properties.ts — all build SQL inline in route handlers
const itemsRes = await pool.query(`SELECT l.id, l.tenant_id, ...`);
```

Problems:
- Business logic mixed with HTTP transport concerns
- No code reuse: same SQL duplicated across routes
- Testing requires real database connection — no interface to mock
- Schema changes require finding and updating every inline query

### Problem 4: No Transactional Outbox for Realtime Events

When a lead is created via `POST /api/leads`, the route:
1. Inserts the lead into the database
2. Calls `realtimeHub.broadcastToTenant()` — in the same request

If the server crashes after the DB commit but before the broadcast, connected clients never receive the update. The correct pattern creates an outbox event in the **same transaction** as the business record, then the worker broadcasts it.

### Problem 5: Worker and API Server Not Separated

`DurableWorker` and `RealtimeHub` are singletons in the same Node.js process:
- No independent scaling of worker vs. API
- Worker failures impact API response times
- Cannot run multiple worker instances without duplicate processing
- No graceful worker shutdown independent of API

### Problem 6: No Connection Pool Tuning

The `pg.Pool` is created with defaults (max 10 connections). PostgreSQL has ~10MB RAM per connection. With default pool settings and a busy API + worker:
- Pool exhaustion under ~50 concurrent requests
- No pool monitoring or overflow alerting
- Worker competes with API requests for pool connections

### Problem 7: No Caching Layer

Every dashboard request, every report query, every `/api/leads` triggers a full database query. No Redis, no in-memory cache, no HTTP Cache-Control exists. Under moderate user load, the database will be overwhelmed.

### System Design vs. Target Architecture

| Component | Target | Current State | Gap |
|---|---|---|---|
| Frontend | React 18 + TypeScript + Vite + MUI | Correct stack | Minor: Tailwind + MUI co-exist |
| Backend | Express TypeScript modular monolith | Correct | Service layer missing |
| Database | Native PostgreSQL 17, least-privilege | Correct design | Schema incomplete (8+ missing tables) |
| Auth | Argon2id, server sessions, HttpOnly | Correct | Incomplete enforcement |
| Realtime | Authenticated WS + LISTEN/NOTIFY | WS exists, LISTEN/NOTIFY MISSING | Critical gap |
| Workers | FOR UPDATE SKIP LOCKED, durable inbox | Partial — stubs only | Lead ingestion not wired |
| Observability | Structured logs, correlation IDs, audit | Partially implemented | Alerting/monitoring missing |
| CI/CD | Full automated testing pipeline | NOT BUILT | No CI at all |
| Deployment | TLS, reverse proxy, containerized | NOT BUILT | Dev-only setup |

---

## 6. DATABASE ENGINEERING ASSESSMENT

### What Is Good

- **Migrations are forward-only** and versioned — correct pattern
- **Checksum-based migration runner** prevents silent tampering — excellent
- **Advisory locks** in migration runner prevent concurrent runs — excellent
- **Composite FK constraints** (`fk_transition_pipeline_tenant`) prevent cross-tenant child records
- **`FOR UPDATE SKIP LOCKED`** in the worker — correct concurrency pattern
- **`RESET ALL`** after `executeInTenantContext` transactions — prevents context bleed

### Schema Issues Found

**Issue 1: `notifications` table never created** — Migration 004 applies RLS to a table that doesn't exist. Clean bootstrap fails.

**Issue 2: `marketing_attribution` referenced in routes but absent from all 6 migrations** — Operations route query will error on clean database.

**Issue 3: Missing 20+ indexes from masterplan**
- `leads (tenant_id, assigned_to)` — agent lead queries
- `leads (tenant_id, lead_source)` — attribution reports
- `contacts (tenant_id, email_normalized)` — deduplication
- `contacts (tenant_id, phone_normalized)` — deduplication
- `activities (tenant_id, lead_id, performed_at)` — activity timeline
- `audit_logs (tenant_id, created_at)` — audit views
- `properties (tenant_id, locality)` — location search

**Issue 4: No soft delete** — The masterplan specifies `deleted_at` columns. Deletes are permanent. Data recovery after accidental deletion requires a backup restore.

**Issue 5: Enum type mismatch** — Migration 001 creates `tenant_role` with 5 values (`tenant_owner`, `tenant_admin`, `sales_manager`, `sales_agent`, `marketing_manager`). The masterplan and invitation route expect 8 roles — missing `marketing_analyst`, `executive_readonly`, `auditor`. Inviting users with these roles will fail with a PostgreSQL type constraint violation.

**Issue 6: Viewing conflict check is exact-match only** — The `schedule_viewing()` function checks `scheduled_at = p_scheduled_at` (exact timestamp equality). A viewing at 10:00 and one at 10:15 would NOT conflict even if the first is 30 minutes long. The OVERLAPS operator needs to be used instead.

**Issue 7: No retention or archival policy** — `audit_logs` and `operational_logs` grow unboundedly. In active production, these can reach millions of rows within months with no partition pruning or archival mechanism.

---

## 7. SCALABILITY — WILL IT WORK WHEN USERS INCREASE?

### Current Architecture Capacity Estimate

With the current single-process Node.js + PostgreSQL setup on a typical VPS (4 vCPU, 8GB RAM):

| Concurrent Users | Estimated Behavior |
|---|---|
| 1-10 | Works fine |
| 10-50 | OK for simple reads. Dashboard aggregations slow (200-500ms). |
| 50-100 | Pool exhaustion likely (default pg Pool max 10). Lead list queries slow without indexes. |
| 100-500 | **System degrades.** Worker competes with API for pool connections. No caching = DB overwhelmed. WS connections consume memory. |
| 500+ | **System fails.** Cannot scale horizontally. Worker is single-threaded. No load balancing strategy. |

### Critical Bottlenecks

1. **Database Connection Pool** — Default max 10 connections. At 50 concurrent users, pool saturates.
2. **Dashboard Queries Without Caching** — 5-8 queries per load per user. At 100 users = 500-800 DB queries/second against unindexed columns.
3. **WebSocket Memory** — In-memory `Map<WebSocket, AuthenticatedClient>` singleton. At 1,000 concurrent users, may consume 100MB+.
4. **Worker Pool Competition** — Worker polls every 5 seconds, grabbing connections that compete with API requests.
5. **No Read Replicas** — All reads (reports, dashboard, pipeline) go to the write primary.
6. **Single Point of Failure** — API + WS hub + worker in one process. One crash = total outage.

### Scale Roadmap

| Scale Tier | Users | Changes Needed |
|---|---|---|
| Tier 1 (Fix current) | <50 | Fix connection pool size to 25-50. Add missing indexes. Basic viable. |
| Tier 2 | 50-500 | Add Redis for session caching + dashboard TTL cache. Separate worker process. PgBouncer. |
| Tier 3 | 500-5,000 | Read replicas for reports. Horizontal API scaling. LISTEN/NOTIFY via dedicated subscriber. Partitioned tables for logs. |
| Tier 4 (SaaS) | 5,000+ | Consider microservice extraction (worker, notification). CDN. Multi-region PostgreSQL. Message queue. |

---

## 8. FAANG-LEVEL ASSESSMENT

### What "FAANG Level" Actually Means

FAANG-level engineering is NOT about microservices, Kubernetes, or 10 layers of abstraction.

It IS about:
- **Correctness first** — the system does what it says, consistently, verifiably
- **Security by default** — every trust boundary is explicit and tested
- **Operational confidence** — you can deploy, monitor, diagnose, and fix without heroics
- **Testability** — every behavior has a test that fails when the behavior breaks
- **Code quality** — readable, maintainable, consistent, self-documenting

### FAANG-Level Scorecard

| Engineering Dimension | Score | Max | Notes |
|---|---|---|---|
| **Correctness** | 4 | 10 | Many features claim to work but have zero backend |
| **Security** | 4 | 10 | Good crypto foundations, broken access control, no MFA |
| **Reliability** | 3 | 10 | No graceful degradation, no retry for API calls, no circuit breakers |
| **Observability** | 4 | 10 | Structured logs exist, no alerting, no metrics, no traces |
| **Testability** | 3 | 10 | Unit tests only, no E2E, no contract tests, tests don't catch real failures |
| **Maintainability** | 5 | 10 | Good TypeScript, but no service layer, SQL inline, no OpenAPI spec |
| **Performance** | 3 | 10 | No caching, no load testing, poor query design, missing indexes |
| **Scalability** | 2 | 10 | Single-process, no horizontal scale path, no LISTEN/NOTIFY |
| **Documentation** | 6 | 10 | Excellent architectural docs, code-level docs sparse |
| **Operational Readiness** | 1 | 10 | No CI, no CD, no backup, no runbooks, no monitoring |

### OVERALL FAANG SCORE: 3.9 / 10

### Honest Comparison to Industry Standards

| Benchmark | Anibros CRM | Industry Standard |
|---|---|---|
| Auth security | Argon2id, HttpOnly (good!), but no MFA/lockout | Google/Stripe: MFA required for admin, lockout after 10 attempts |
| RBAC | ~20% enforced in code | Airbnb/Uber: every endpoint has explicit capability check with policy test |
| Test coverage | ~15% meaningful coverage | Netflix: >80% unit + contract + integration |
| Error rates | Unknown — no metrics | Google SRE: 99.9%+ for P0 paths |
| Deployment | Manual, dev-only | Amazon: automated CI/CD, blue-green, canary |
| Security audit | None | Stripe: quarterly pen test, continuous SAST/DAST |
| Database reliability | No backup strategy | Salesforce: PITR + daily snapshots + restore drills |

### What Separates This From FAANG-Level

1. **No behavioral tests** — Tests assert "file loads" not "role X cannot do action Y"
2. **No explicit API contract** — No OpenAPI/GraphQL schema enforcing request/response contracts
3. **RBAC is aspirational, not enforced** — Permission matrix exists in docs but not in code
4. **No observability pipeline** — Logs exist but no way to alert, trace, or correlate
5. **Incomplete features shipped as complete** — Pages exist with no backend; this misleads users
6. **No production deployment story** — Cannot safely deploy to production in current state

---

## 9. THE PLAN — HOW TO FIX EVERYTHING

### Wave 0: Emergency Fixes (1-2 days) — DO FIRST

These blocking issues must be fixed before any further development:

**0.1 Fix the Database Migration Sequence**

Create migration 007 (or amend 002) to add:
```sql
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL, message TEXT,
    type TEXT NOT NULL DEFAULT 'info',
    is_read BOOLEAN NOT NULL DEFAULT false,
    entity_type TEXT, entity_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Fix missing enum values
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'marketing_analyst';
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'executive_readonly';
ALTER TYPE tenant_role ADD VALUE IF NOT EXISTS 'auditor';
```

**0.2 Fix Deactivated Account Bypass**

In `validateSession()`, add `AND u.is_active = true` to the session validation query.

**0.3 Fix system_health Tenant Isolation**

Add `WHERE tenant_id = $1 OR tenant_id IS NULL` to system_health query in operations route.

**0.4 Remove Supabase from Production Bundle**

Move `@supabase/supabase-js` to devDependencies or remove. Replace `src/lib/supabase.ts` with a safe stub or remove entirely.

**0.5 Fix Viewing Interval Overlap Check**

Replace exact-match `scheduled_at = p_scheduled_at` with proper OVERLAPS interval check in `schedule_viewing()`.

### Wave 1: Security Hardening (3-5 days)

1. **Add RBAC to all routes** — Create a route-level permission map and enforce via `requireRoles()`
2. **Add account lockout** — Track failed login attempts, lock after 5-10 attempts for 15 minutes
3. **Enable CSP** — Configure proper Content-Security-Policy header via Helmet
4. **Fix CORS no-origin bypass** — Restrict `!origin` bypass to health routes only
5. **Remove hard-coded dev password** from migration 004 — Use environment variable injection
6. **Add invitation acceptance route** — Verify token + email match + atomic membership creation
7. **Add `is_active` check to WS authentication** — Same fix as session validation

### Wave 2: Schema Completion (5-7 days)

Add native migrations for all missing tables:
- Migration 007: `marketing_attribution`, `notifications`, `notification_reads`
- Migration 008: `integrations`, `integration_webhook_endpoints`, `communication_consents`
- Migration 009: `custom_field_definitions`, `custom_field_values`
- Migration 010: `automation_rules`, `automation_executions`
- Migration 011: `subscription_plans`, `tenant_subscriptions`
- Migration 012: `property_availability_history`, `branches`
- Migration 013: 20+ missing indexes from masterplan
- Migration 014: Soft delete (`deleted_at` columns on leads, contacts)
- Migration 015: Role-aware RLS policies (add role checks to UPDATE/DELETE policies)

### Wave 3: Backend API Completion (7-10 days)

Build missing API route groups:
- `GET/POST /api/attribution` — Marketing attribution reports
- `GET /api/reports` — Agent performance, source breakdown, funnel
- `GET/POST /api/matching` — Property matching with explanation scores
- `GET/POST/PUT/DELETE /api/integrations` — Integration configuration
- `GET/POST/PUT/DELETE /api/custom-fields` — Custom field management
- `GET/POST/PUT/DELETE /api/automation` — Automation rules
- `GET /api/subscription` — Subscription plan info
- `POST /api/leads/:id/assign` — Lead assignment with audit trail
- `POST /api/leads/import` — CSV import with validation and idempotency
- `GET /api/leads/export` — CSV export with role check

### Wave 4: Service Layer and Code Quality (3-5 days)

Extract business logic from route handlers into service files:
```
server/src/services/
  lead.service.ts       — lead CRUD, scoring, assignment, deduplication
  contact.service.ts    — contact CRUD, deduplication
  property.service.ts   — property lifecycle, availability
  pipeline.service.ts   — stage transitions, validation
  notification.service.ts — notification creation and delivery
  attribution.service.ts  — attribution record creation and reporting
```

Benefits: testable without HTTP, reusable across routes, consistent error handling.

### Wave 5: Real Realtime (5-7 days)

1. **Add LISTEN/NOTIFY to WebSocket server** — Use a dedicated `pg.Client` for NOTIFY subscriptions
2. **Add NOTIFY calls** to key DB functions (leads, contacts, properties, tasks, viewings mutations)
3. **Remove Supabase realtime hooks** from `use-realtime-leads.ts` and `use-realtime-sync.ts`
4. **Implement snapshot reconciliation** — On WS connect, send current state; on reconnect, send delta since last cursor
5. **Add event cursor** — Client tracks last event timestamp, requests missed events on reconnect
6. **Add fallback polling** — If WS disconnects, switch to 8-second polling

### Wave 6: Worker Completion (3-5 days)

1. **Wire Google Ads webhook parsing** in `processSingleInboxItem()`
2. **Wire Meta Lead Ads webhook parsing** with HMAC-SHA256 verification
3. **Implement actual lead creation** from webhook payload (deduplication, contact matching)
4. **Add outbound conversion events** to outbox on lead stage transitions
5. **Wire worker health metrics** to `system_health` table
6. **Add stuck job recovery** to worker's scheduled iteration
7. **Separate worker into its own process** with a health endpoint

### Wave 7: Testing (7-10 days)

1. **Fix existing tests** — Ensure tests actually assert behavior, not just "things compile"
2. **Add API integration tests** — Against real test PostgreSQL database
3. **Add RBAC negative tests** — Verify role X cannot perform action Y
4. **Add cross-tenant isolation tests** — Verify tenant A cannot access tenant B data
5. **Add E2E browser tests** — Playwright: signup → login → create lead → stage transition → verify
6. **Add performance tests** — Query times at 1K, 10K, 100K lead records
7. **Set up CI** — GitHub Actions: typecheck → lint → unit → integration → build

### Wave 8: Production Readiness (5-7 days)

1. **Docker Compose** — API + WS + Worker + PostgreSQL + Redis (optional) for local dev
2. **Environment validation** — Fail fast if required env vars are missing at startup
3. **Database backup script** — pg_dump with encryption, rotation, off-site copy
4. **Reverse proxy config** — Nginx with TLS termination, rate limiting, WebSocket upgrade
5. **Structured logging** — Replace console.log with file-based structured JSON logger
6. **Load testing** — k6 or Artillery against realistic data volumes
7. **Migration rollback plan** — Document how to roll back each migration
8. **Restore drill** — Actually test restoring from a backup

---

## 10. PRIORITY MATRIX

### Absolute Blockers (Fix Before Anything Else)

| ID | Issue | Severity | Effort |
|---|---|---|---|
| B1 | `notifications` table missing — migration fails on clean DB | CRITICAL | 30 min |
| B2 | `tenant_role` enum missing 3 values — invites fail at DB level | CRITICAL | 30 min |
| B3 | Deactivated users can access the system (is_active not checked) | CRITICAL | 1 hour |
| B4 | RBAC not enforced on ~80% of API routes | CRITICAL | 3-5 days |
| B5 | Viewing conflict check uses exact-match not interval overlap | HIGH | 2 hours |

### High Priority (Next 2 Weeks)

| ID | Issue | Severity | Effort |
|---|---|---|---|
| H1 | Supabase JS in production bundle | HIGH | 1 day |
| H2 | CSP disabled — XSS escalation possible | HIGH | 2 hours |
| H3 | system_health not tenant-scoped | HIGH | 1 hour |
| H4 | No account lockout after failed logins | HIGH | 1 day |
| H5 | 8+ domain table groups missing from native migrations | HIGH | 5-7 days |
| H6 | No LISTEN/NOTIFY — realtime unreliable at scale | HIGH | 5-7 days |
| H7 | Missing API routes for attribution, reports, matching, integrations | HIGH | 7-10 days |
| H8 | No soft delete on leads/contacts | HIGH | 1 day |

### Medium Priority (Next Month)

| ID | Issue | Effort |
|---|---|---|
| M1 | Service layer extraction | 3-5 days |
| M2 | Missing 20+ indexes from masterplan | 1 day |
| M3 | Connection pool tuning (increase max, add PgBouncer) | 2 days |
| M4 | Session listing and revocation UI for users | 2 days |
| M5 | CSV import/export for leads | 3 days |
| M6 | Property matching with explainable scores | 3 days |
| M7 | Automation rule execution engine | 5 days |
| M8 | Custom field CRUD and dynamic rendering | 3 days |
| M9 | Notification delivery (email + in-app) | 3 days |

### Lower Priority (Phase 2)

| ID | Issue | Effort |
|---|---|---|
| L1 | MFA (TOTP) implementation | 3 days |
| L2 | Stripe billing integration (when approved) | 5 days |
| L3 | WhatsApp Cloud API (needs credentials) | 5 days |
| L4 | Google Ads E2E (needs credentials) | 3 days |
| L5 | Meta Lead Ads E2E (needs credentials) | 3 days |
| L6 | Performance testing with k6 or Artillery | 3 days |
| L7 | Full CI/CD pipeline | 3 days |
| L8 | Backup and restore drill | 2 days |
| L9 | DPDP/legal compliance review | External specialist |

---

## CLOSING STATEMENT

The engineering DNA of this project is **sound**. The architectural decisions — Argon2id, server sessions, CSRF double-submit, `FOR UPDATE SKIP LOCKED`, checksum migration runner, `executeInTenantContext` with SET LOCAL and RESET ALL — are all correct, well-reasoned, and clearly documented.

What is missing is **completeness and enforcement**. The foundation is excellent. The building above it is approximately 30% built, and critical security enforcement layers that were designed are not yet wired into the code.

**The gap to FAANG-level quality is bridgeable.** The hardest parts (security architecture, database design, tenant isolation pattern, worker pattern) are already done correctly. What remains is:

1. Close security gaps — RBAC enforcement on all routes, account lockout, CSP
2. Fix the broken migration sequence — 8+ missing table groups
3. Build missing API routes — 8+ route groups with zero backend
4. Add real realtime — PostgreSQL LISTEN/NOTIFY
5. Build meaningful tests — RBAC negative, E2E, cross-tenant isolation
6. Set up CI and production infrastructure

Estimated time to reach "production-ready, FAANG-quality" standard: **6-8 focused engineering weeks**.

The architecture is right. The execution needs to catch up.

---

*End of Analysis — Based on actual repository inspection of commit `a45d5f4` on `feat/native-postgresql-migration` branch, 13 October 2026.*
