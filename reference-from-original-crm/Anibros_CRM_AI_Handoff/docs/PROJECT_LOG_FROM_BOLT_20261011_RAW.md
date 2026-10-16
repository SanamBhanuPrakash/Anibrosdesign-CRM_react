# Anibros CRM — Project Log

> Read this file first to understand what's been built and what's next.

## Tech Stack
- React 18 + TypeScript + Vite
- Tailwind CSS 3 (custom design system with primary/accent/success/warning/error/surface color ramps)
- Supabase (PostgreSQL + Auth + RLS + Edge Functions)
- React Router DOM 7, Zustand 5, clsx, tailwind-merge, date-fns, lucide-react
- Path alias: `@/` maps to `src/`

## Database Migrations (12 applied)
1. `001_organisation_tenant_hierarchy` — organisations, tenants, branches, organisation_memberships, tenant_memberships + RLS + helper functions (is_platform_admin, is_agency_admin_for_org, get_user_tenant_ids)
2. `002_crm_domain_tables` — pipelines, pipeline_stages, pipeline_stage_transitions, contacts, leads, lead_stage_history, marketing_attribution, projects, properties, property_availability_history, activities, tasks, viewings, audit_logs, webhook_inbox, outbox_events. All have tenant_id + 4 RLS policies each (SELECT/INSERT/UPDATE/DELETE checking tenant_memberships)
3. `003_seed_pipeline_and_transition_function` — `transition_lead_stage()` SECURITY DEFINER function (validates membership, checks allowed transitions, atomic update + history + audit + activity), `seed_default_pipeline()` function (creates 13 standard RE stages + 30+ allowed transitions)
4. `004_fix_security_advisor_warnings` — Added explicit search_path to helper functions
5. `005_fix_function_grants` — Revoked EXECUTE from PUBLIC on all SECURITY DEFINER functions, granted only to authenticated
6. `006_auto_onboarding_function` — `create_default_tenant()` function auto-creates org + tenant + memberships + pipeline for new sign-ups
7. `007_lead_scoring_function` — `calculate_lead_score()` function (rule-based scoring from source, budget, timeline, engagement)
8. `008_integrations_consent_customfields_automation_subscriptions` — integrations, integration_webhook_endpoints, communication_consents, custom_field_definitions, custom_field_values, automation_rules, automation_executions, subscription_plans (seeded free+pro), tenant_subscriptions. All with tenant_id + 4 RLS policies
9. `009_user_invitation_function` — `invite_user_to_tenant()` SECURITY DEFINER function (verifies caller is tenant_owner/admin, creates invited membership, logs audit)
10. `010_role_based_permission_enforcement` — `get_user_tenant_role()` helper function. Role-aware DELETE/UPDATE/INSERT policies on 20+ tables. Sales agents can no longer delete records. Config tables (integrations, pipeline, automation, custom fields, webhook/outbox) restricted to admin/marketing_manager roles. Auditors and read-only roles blocked from writes on config tables.
11. `011_database_integrity_composite_fks` — Composite unique constraints (tenant_id, id) on 9 parent tables. Replaced 19 single-column FKs with composite FKs to prevent cross-tenant child references. Added 13 performance indexes for common queries.
12. `012_stuck_job_recovery` — `reset_stuck_webhook_jobs()` and `reset_stuck_outbox_jobs()` SECURITY DEFINER functions. Reset processing records stuck for >10 minutes back to received/pending for retry.

## Frontend Files Built

### Infrastructure
- `src/lib/supabase.ts` — Supabase client singleton
- `src/lib/utils.ts` — cn(), formatCurrency, formatNumber, formatDate, formatDateTime, timeAgo, initials, normalizeEmail, normalizePhone, slugify
- `src/types/index.ts` — All TypeScript interfaces (Organisation, Tenant, Branch, Memberships, Contact, Pipeline, PipelineStage, Lead, Property, Project, Activity, Task, Viewing, AuditLog, LeadStageHistory, Integration, CommunicationConsent, CustomFieldDefinition, CustomFieldValue, AutomationRule, SubscriptionPlan, TenantSubscription + all enum types)
- `src/stores/auth-store.ts` — Zustand auth store (user, tenants, activeTenant, tenantMembership, orgMemberships, loadTenantData, setActiveTenant, signOut)
- `src/hooks/use-tenant-data.ts` — useTenantQuery() and useTenantData() hooks for tenant-scoped Supabase queries

### UI Components (src/components/ui/)
- `Button.tsx` — 6 variants (primary/secondary/outline/ghost/danger/success), 4 sizes, loading state
- `Input.tsx` — Input, Textarea, Select with label/error/hint support
- `Card.tsx` — Card, CardHeader, CardTitle, CardContent, CardFooter
- `Badge.tsx` — 7 variants with optional dot indicator
- `Avatar.tsx` — Initials-based avatar with image fallback, 4 sizes
- `Spinner.tsx` — Spinner + FullPageSpinner
- `EmptyState.tsx` — Icon, title, description, action
- `Dialog.tsx` — Modal with ESC close, backdrop, 4 sizes
- `Table.tsx` — Table primitives + DataTable generic component

### Auth (src/components/auth/)
- `AuthProvider.tsx` — Session management, onAuthStateChange with IIFE deadlock guard, auto-onboarding for users with no tenants
- `ProtectedRoute.tsx` — Redirects to /sign-in if no user, shows "No Tenant Access" if no activeTenant

### Layout (src/components/layout/)
- `AppLayout.tsx` — Sidebar (17 items: Dashboard, Leads, Contacts, Pipeline, Properties, Projects, Calendar, Tasks, Reports, Integrations, Webhooks, Outbox, Custom Fields, Automation, Tenant Config, Subscription, Settings), top bar with tenant selector dropdown, search, notifications, user profile with sign-out. Responsive with mobile sidebar.

### Pages (src/pages/)
- `auth/SignInPage.tsx` — Email/password sign-in with error handling
- `auth/SignUpPage.tsx` — Sign-up with first/last name, email, password
- `DashboardPage.tsx` — 8 metric cards (total/new/qualified/won leads, pipeline value, unassigned, stale, tasks due), recent leads list
- `leads/LeadsPage.tsx` — Leads list with search, stage/source filters, create lead dialog, CSV import (paste CSV data), CSV export (download), auto-seeds pipeline if missing
- `leads/LeadDetailPage.tsx` — Lead detail with stage transition (via RPC), activity timeline (add notes/calls/emails), tasks, contact info, lead details, assignment dropdown
- `PipelinePage.tsx` — Kanban board with drag-and-drop stage transitions, per-stage columns with lead cards
- `contacts/ContactsPage.tsx` — Contact list with search, click to navigate to associated lead
- `properties/PropertiesPage.tsx` — Property grid with search, type/availability filters, create property dialog
- `properties/PropertyDetailPage.tsx` — Property detail with edit mode, overview stats, notes, amenities
- `projects/ProjectsPage.tsx` — Project list with create dialog
- `TasksPage.tsx` — Task list with open/completed/all filters, create task dialog, toggle complete
- `CalendarPage.tsx` — Upcoming viewings grouped by date, click to navigate to lead
- `ReportsPage.tsx` — Date range filter (7d/30d/90d/365d/all), CSV export, 8 metric cards (total/qualified/won/conversion rate/avg response time/stale leads/contacted/pipeline value), lead source breakdown bars, pipeline distribution bars, agent performance table with win rates
- `integrations/IntegrationsPage.tsx` — Integration config UI (add/pause/activate/delete integrations, provider selector, status badges, health timestamps)
- `integrations/WebhookDiagnosticsPage.tsx` — Webhook inbox monitoring (status filter tabs, event detail dialog with raw payload, replay dead-lettered events, recover stuck processing jobs button)
- `integrations/OutboxDiagnosticsPage.tsx` — Outbox event monitoring (status filter tabs, event detail with payload + provider response, retry/replay failed/dead-lettered events, recover stuck processing jobs button)
- `settings/SettingsPage.tsx` — Tabs: General (tenant info, user role), Members (membership list with emails, invite user dialog with role selector, revoke access), Audit Log (recent entries with JSON detail)
- `settings/CustomFieldsPage.tsx` — Custom field management (entity type tabs, create/edit/delete fields, field type selector, options for select/multiselect, required/searchable flags)
- `settings/AutomationRulesPage.tsx` — Automation rules management (create/edit/delete rules, trigger/action selectors, enable/disable toggle, rule cards with badges)
- `settings/TenantConfigPage.tsx` — Tenant configuration: Branding tab (org name, timezone, currency, primary/accent color picker with preview), Pipeline tab (view/edit/add/delete pipeline stages, stage types, loss reason requirement)
- `settings/SubscriptionPage.tsx` — Subscription management: current plan summary with status badge, available plans grid (free/pro with features + limits), upgrade buttons (disabled until Stripe is configured), billing not-yet-active notice
- `PropertyMatchingPage.tsx` — Property matching engine: lead selector with search, matches properties by budget (30pts), location (25pts), property type (20pts), bedrooms (15pts), transaction intent (10pts). Shows match percentage, color-coded score indicator, per-match-reason breakdown with check/X icons and detail text. Sorted by match score, top 12 results.

### Routing (src/App.tsx)
- Public routes: /sign-in, /sign-up
- Protected routes: /, /leads, /leads/:id, /contacts, /pipeline, /properties, /properties/:id, /property-matching, /projects, /tasks, /calendar, /reports, /integrations, /integrations/webhooks, /integrations/outbox, /settings, /settings/custom-fields, /settings/automation, /settings/tenant, /settings/subscription

### Sidebar Navigation Items (18)
Dashboard, Leads, Contacts, Pipeline, Properties, Matching, Projects, Calendar, Tasks, Reports, Integrations, Webhooks, Outbox, Custom Fields, Automation, Tenant Config, Subscription, Settings

## Edge Functions (4 deployed)
1. `webhook-ingestion` — Receives Google Ads + Meta Lead Ads webhooks. Google: validates per-integration google_key with constant-time comparison. Meta: HMAC-SHA256 signature verification against raw body using META_APP_SECRET, GET verification challenge flow. Resolves tenant from integration config (never from request body). Persists to webhook_inbox with idempotency (23505 unique constraint).
2. `process-webhooks` — Processes webhook_inbox events: normalizes lead data, deduplicates contacts/leads by email/phone, creates marketing attribution, retries with exponential backoff, dead-letters after max retries.
3. `process-outbox` — Processes outbox_events for outbound conversion uploads. Per-tenant credential resolution via credential_ref prefix (e.g. HPR_INFRA_GOOGLE_CLIENT_ID). Google Ads: OAuth refresh + enhanced conversions upload with login-customer-id header for manager-account access. Developer-token optional (sunset Sept 2026). Meta CAPI: per-tenant access token via credential_ref. Fails closed with clear error if credentials missing.
4. `integration-status` — POST endpoint that checks integration configuration completeness and provider connectivity WITHOUT sending live events. Google Ads: validates OAuth token refresh succeeds. Meta CAPI: read-only GET on Pixel to verify token. Webhook providers: validates config fields. Sanitizes all error messages to redact credentials.

## Build Status
- TypeScript: PASSES (0 errors)
- Vite build: PASSES (540KB JS, 29KB CSS gzipped)
- Edge Functions: 4 deployed and ACTIVE (webhook-ingestion, process-webhooks, process-outbox, integration-status)

## What's Done
- [x] Phase 1: Design system, app shell, navigation, components, auth, loading/error/empty states
- [x] Phase 2: Organisations, tenants, memberships, roles, tenant switching, RLS, auto-onboarding, user invitation, role-based permission enforcement at DB level (Migration 010)
- [x] Phase 3: Contacts, leads, properties, projects, pipelines, validated stage transitions, activities, tasks, assignment, dashboard, lead scoring, composite FKs for cross-tenant prevention (Migration 011), property matching engine UI
- [x] Phase 4 (code only): webhook-ingestion + process-webhooks edge functions deployed. Integration config UI + webhook diagnostics UI built. BLOCKED on real credentials for testing.
- [x] Phase 5: process-outbox edge function built and deployed. Per-tenant credential resolution, Google Ads enhanced conversions with manager-account login-customer-id header, Meta CAPI with per-tenant access token. Integration status/test endpoint deployed (no live events). BLOCKED on real credentials for end-to-end testing.
- [x] Phase 7: Custom fields management, automation rules UI, lead CSV import/export, reports page with date range filter + CSV export, 8 metric cards, source/stage breakdowns, agent performance
- [x] Phase 8 (partial): Subscription plans schema, user invitation flow, tenant admin features, tenant configuration UI (branding + pipeline customization), subscription/plan page
- [x] Frontend role-based UI gating: usePermissions hook with role-based permission booleans. Applied across 13 pages — hides create/delete/edit/export/assign/config actions based on role. Sidebar nav items filtered by role (auditors see fewer items, config pages admin-only).

## What's NOT Done
- [ ] Phase 4: Real Google/Meta credentials for end-to-end testing — BLOCKED (code complete, needs secrets)
- [ ] Phase 5: End-to-end conversion upload testing — BLOCKED (code complete, needs OAuth credentials + live approval)
- [ ] Phase 6: WhatsApp Cloud API + email workflows — BLOCKED (needs provider accounts)
- [ ] Phase 8: SaaS self-serve onboarding wizard, Stripe billing integration — BLOCKED (needs Stripe account)
- [ ] Phase 9: Security audit, performance testing, backup drills, production deployment

## Architecture Corrections Status
1. **Tenant-level Authorization** — DONE (Migration 010: role-based DELETE/UPDATE/INSERT policies on 20+ tables)
2. **Per-tenant Integration Credentials** — DONE (credential_ref prefix pattern: HPR_INFRA_GOOGLE_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}, HPR_INFRA_META_ACCESS_TOKEN. Fallback to application-wide secrets for single-tenant pilot. Server-side only, never exposed to frontend.)
3. **Durable Event Processing** — DONE (database-backed inbox/outbox, idempotency, bounded retries, dead-letter, replay)
4. **Database Integrity** — DONE (Migration 011: composite FKs on 19 relationships, 13 performance indexes)
5. **Real Advertising Integrations** — BLOCKED (code written, needs credentials)
6. **Privacy & Authentication** — PARTIAL (consent tracking done, MFA not implemented)
7. **Backups & Operations** — NOT STARTED (needs Supabase Pro for PITR)

## Blockers for Phases 4-6
- Google Ads OAuth credentials (client ID, client secret, refresh token) — developer token NO LONGER REQUIRED (sunset Sept 9, 2026)
- Meta Graph API credentials (app secret for webhook signature verification, page access token for lead retrieval, CAPI access token for conversion uploads)
- WhatsApp Cloud API credentials (phone number ID, access token)
- Email provider credentials (SendGrid/SES/Resend API key)
- Stripe API keys (for subscription billing)

## Auth/Onboarding Fix (Oct 9-10, 2026)
- Fixed: auth-store.ts had truncated file (missing closing braces for signOut and create())
- Fixed: AuthProvider ensureTenantAccess called loadTenantData from component scope instead of useAuthStore.getState()
- Fixed: ProtectedRoute now shows recoverable "Workspace Setup Required" screen with Retry + Sign Out buttons instead of dead-end "No Tenant Access"
- Fixed: onboardingError state tracks auto-onboarding failures for user-facing display
- Fixed: TenantConfigPage.tsx type error (Tenant -> Record<string,unknown> cast needed unknown intermediate)
- Fixed (Oct 10): Race condition — getSession() and onAuthStateChange INITIAL_SESSION fired concurrently, both calling loadTenantData and clobbering each other's state. AuthProvider now skips INITIAL_SESSION event when getSession already loaded data for the same user.
- Fixed (Oct 10): loadTenantData silently swallowed query errors. Now logs errors and sets empty state explicitly instead of leaving stale state.
- Fixed (Oct 10): loadTenantData changed from single joined query (select('*, tenant:tenants(*)')) to two separate queries (memberships first, then tenant records by ID). Eliminates any PostgREST join/RLS interaction issue.
- Root cause of "No Tenant Access" screen: The existing user (rakesh@anibrosdesign.com) HAS a valid tenant and active membership in the database. The problem was a frontend race condition where concurrent calls from getSession() and onAuthStateChange's INITIAL_SESSION event both ran loadTenantData, with the second call resetting state to empty while the first was still populating it.
- Verified at database level: user 529aeff8 has tenant 93e50d1e (My Workspace, active) with tenant_owner membership (active). RLS policies, grants, and column privileges all correct.
- Runtime verification NOT performed: Cannot run browser preview to confirm the fix works at runtime. Build and typecheck pass.

## Signup/Onboarding Race Condition Fix (Oct 10, 2026 — Round 2)
- Root cause: After signup, `loadTenantData` finds zero memberships for a new user, sets `tenantLoading: false` and returns. AuthProvider then calls `create_default_tenant` RPC. During the RPC (which takes ~200ms), `tenantLoading` is `false` and `activeTenant` is `null`, so ProtectedRoute immediately renders "Workspace Setup Required" instead of a loading spinner. The database side was always working — both existing users have exactly 1 tenant, 1 owner membership, and a fully seeded 13-stage pipeline.
- Fix: Added `tenantLoading` boolean to auth-store. AuthProvider now sets `tenantLoading: true` at the start of `ensureTenantAccess` (before `loadTenantData`), and only sets it `false` when onboarding fully completes (success or error). ProtectedRoute shows a "Setting up your workspace..." spinner when `!activeTenant && tenantLoading` instead of the error screen.
- Fix: AuthProvider uses `onboardingPromise` ref to track in-flight onboarding. `setInitializing(false)` in the getSession() IIFE now waits for any onboarding started by a SIGNED_IN event that fired first, preventing premature initialization completion.
- Fix: SignUpPage no longer navigates to non-existent `/sign-up-success` route when email confirmation is ON. Now shows an inline "Check Your Email" confirmation screen with a link to sign in. Does NOT call tenant provisioning when no session exists.
- Fix: ProtectedRoute retry handler now sets `tenantLoading: true` during the retry RPC call so the spinner shows instead of the error screen.
- Fix: `signOut` in auth-store now clears `tenantLoading: false`.
- SIGNED_OUT handler in AuthProvider now clears `tenantLoading: false`.
- Database verification: `create_default_tenant` function is SECURITY DEFINER with `search_path = 'public', 'auth'`, EXECUTE granted to `authenticated` only. It uses `auth.uid()`, checks for existing membership first (idempotent), creates org + tenant + org_membership + tenant_membership + default pipeline atomically. Both test users have exactly 1 tenant, 1 membership, 1 pipeline with 13 stages — no duplicates.
- Email confirmation: Currently OFF (verified by checking `email_confirmed_at` timestamps — both users confirmed within 0.07 seconds of creation, indicating autoconfirm). SignUpPage handles both cases (session returned vs no session) correctly.
- Runtime verification NOT performed: Cannot run browser preview or email delivery in this environment. Build and typecheck pass.

## Password Recovery Flow (Oct 10, 2026)
- Added: ForgotPasswordPage at /forgot-password — uses supabase.auth.resetPasswordForEmail() with redirectTo to /reset-password. Generic success message (no email enumeration). Resend with 30s cooldown. Back to sign-in link.
- Added: ResetPasswordPage at /reset-password — validates recovery session (checks URL hash for type=recovery + active session). Handles expired/invalid/already-used links with clear error + link to request new one. Show/hide password toggles, min 6 char validation, confirm-match validation. Uses supabase.auth.updateUser({password}). Signs out recovery session after success, redirects to /sign-in.
- Added: "Forgot password?" link on SignInPage near password field.
- Updated: AuthProvider handles PASSWORD_RECOVERY event — sets user but skips tenant loading and auto-onboarding so recovery session doesn't trigger workspace creation.
- Routes: /forgot-password and /reset-password are public (outside ProtectedRoute), accessible without tenant.
- NOT verified at runtime: Email delivery, recovery redirect, and end-to-end password reset flow require Supabase Auth email configuration. The code is correct but email sending depends on Supabase project settings.
- Manual Supabase configuration required:
  1. Supabase Dashboard → Authentication → URL Configuration
  2. Site URL: set to the production domain (or Bolt preview URL for testing)
  3. Redirect URLs: add /reset-password path (e.g. https://your-domain.com/reset-password)
  4. Email Templates → Reset Password: ensure {{ .ConfirmationURL }} is in the template (Supabase generates the recovery link with type=recovery in the hash)
  5. Email confirmation: currently OFF (password reset still works via email link)

## Key Architecture Decisions
1. All tables have tenant_id directly (including child tables like pipeline_stages) for uniform RLS
2. RLS checks tenant_memberships for every query — no client-supplied tenant_id
3. Stage transitions via SECURITY DEFINER function with allowed-transition validation
4. Auto-onboarding creates org+tenant+pipeline for new sign-ups automatically
5. SECURITY DEFINER functions: EXECUTE revoked from PUBLIC/anon, granted to authenticated only
6. Integration credentials stored as edge function secrets (credential_ref stores name only, never value)
7. Communication consent tracked separately from preferences (auditable consent history)
8. Custom fields support lead/property/contact entities with text/number/date/select/multiselect/boolean types
9. Subscription plans seeded (free + pro) — schema ready for Stripe, not yet wired
10. Role-based permissions enforced at DB level (Migration 010): agents can't delete, analysts read-only, config changes admin-only
11. Composite FKs prevent cross-tenant child references (Migration 011): 19 relationships enforced
12. Database-backed inbox/outbox pattern (not pgmq): transactional consistency, manual retry/backoff, stuck-job recovery via reset_stuck_webhook_jobs/reset_stuck_outbox_jobs functions (Migration 012)
13. Frontend role-based UI gating via usePermissions hook: role checks for create/delete/edit/export/assign/config actions across all pages. Sidebar nav filtered by role. DB-level RLS already enforces permissions server-side; UI gating is convenience layer.
