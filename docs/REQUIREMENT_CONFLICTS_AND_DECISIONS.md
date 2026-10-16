# ANIBROS CRM — ARCHITECTURAL DECISIONS, CONFLICT RESOLUTION & RECONCILIATIONS

## 1. Overview
The Master Engineering Directive consolidates multiple engineering directives issued across project phases. This document records all identified tensions, cross-section dependencies, and architectural resolutions formulated in accordance with Principal Engineering and Security principles.

---

## 2. Reconciled Architectural Conflicts

### Conflict 1: 48-Hour Release Mode vs. Complete Native PostgreSQL Migration
- **Source A (Directive 2, Section 1):** "We have a 48-hour delivery target for a genuinely usable Anibros CRM... Do not perform another broad architecture exercise... The priority now is proven end-to-end correctness, integration, security, and release readiness."
- **Source B (Directive 3, Section 1):** "We are discontinuing Supabase as a runtime platform... We want to use standard PostgreSQL locally during development and testing, then run that same architecture on our own production server... Do NOT finish the project on hosted Supabase and migrate later."
- **Source C (Directive 4, Section 19):** "If the migration becomes too large to complete safely within 48 hours, state that honestly. Prioritize a small, fully integrated and secure vertical slice first, without pretending full CRM parity has been achieved."
- **Implications:** Performing an unverified, hasty replacement of 29 frontend pages, 4 Edge Functions, and 29 database migrations within 48 hours without rigorous release gates risks regressions and data corruption.
- **Architectural Decision (Resolution):**
  1. Maintain the current baseline on `main` where all 51 Vitest tests pass, TypeScript builds clean, and schema contracts have been audited.
  2. Implement the Native PostgreSQL Migration on a dedicated branch (`feat/native-postgresql-migration`).
  3. Deliver a robust, fully verified vertical slice first:
     - Standalone PostgreSQL 16 schema bootstrap (with native `users` and `sessions` tables).
     - Dedicated Node.js/TypeScript API backend with connection pooling, Argon2id auth, HttpOnly cookies, and CSRF protection.
     - Core Lead Intake -> Stage Transition -> Viewing Booking vertical slice.
  4. Expand incrementally to all 16 CRM modules while maintaining honest `PASS` / `NOT VERIFIED` statuses in the evidence ledger.

---

### Conflict 2: Preserving the Existing Supabase Project vs. Decoupling Runtime
- **Source A (Directive 3, Section 2):** "Do not destroy, reset, or migrate the current hosted Supabase project. Treat it as a read-only reference until we explicitly authorize any future data export. Do not alter its credentials, webhooks, campaigns, migrations, or configuration."
- **Source B (Directive 4, Section 0):** "Do not recommend self-hosting the Supabase platform as the final target. Do not keep Supabase Auth, supabase-js, hosted Supabase RPCs, Supabase Realtime, or Supabase Edge Functions in the final runtime architecture."
- **Architectural Decision (Resolution):**
  - Hosted project `wnhqwkasddggifgqmdlf` is marked strictly **READ-ONLY REFERENCE**.
  - Local development runs against a standalone PostgreSQL 16 container (`localhost:5432` or isolated port) managed via Docker Compose.
  - No commands will run `supabase db push`, `supabase db reset`, or modify hosted remote schemas.

---

### Conflict 3: Application Authorization vs. Native PostgreSQL RLS
- **Source A (Directive 4, Section 4.5):** "Evaluate and implement RLS as defense in depth where it provides meaningful protection... Never let an untrusted frontend choose an arbitrary user or tenant identity. Ensure the application database role does not accidentally bypass the required RLS policies."
- **Source B (Directive 4, Section 8):** "The tenant scope must be enforced on every applicable: API request, SQL query, mutation, worker job, realtime channel... Frontend permission gating is not an authorization boundary."
- **Architectural Decision (Resolution):**
  - **Layer 1 (Backend API):** Every authenticated request verifies the session cookie, extracts `user_id` and `active_tenant_id` from the server-side session cache, and validates permissions before executing queries.
  - **Layer 2 (PostgreSQL Connection Context & RLS):** For defense-in-depth, queries that leverage PostgreSQL RLS are executed inside a transaction where session variables are set:
    ```sql
    SET LOCAL app.current_user_id = '...';
    SET LOCAL app.current_tenant_id = '...';
    ```
    PostgreSQL RLS policies check `tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`.
  - When connections return to the pool, `DISCARD ALL` or `RESET ALL` ensures no session contamination.

---

### Conflict 4: Realtime Event Fan-out without Supabase Realtime
- **Source A (Directive 3, Section 1):** "Our own realtime service for authorized live updates."
- **Source B (Directive 4, Section 8):** "Tenant isolation is a P0 invariant... An authorized realtime mechanism that cannot broadcast one tenant's records to another tenant."
- **Architectural Decision (Resolution):**
  - Implement a native WebSocket server (`ws` in Node.js/TypeScript) bundled with or co-located alongside the API.
  - The WebSocket handshake authenticates using the existing HttpOnly session cookie.
  - Clients subscribe to channels (e.g. `tenant:<tenant_id>:leads`).
  - The WebSocket server verifies that the authenticated user possesses active membership in `<tenant_id>`. Cross-tenant channel subscription requests are rejected immediately.
  - Database mutations publish notifications using PostgreSQL `NOTIFY tenant_events, '...'` or an in-memory Redis/EventEmitter bridge.

---

### Conflict 5: Schema Missing Baseline (`001_organisation_tenant_hierarchy.sql`)
- **Source:** Historical migration 001 was missing from the repository.
- **Resolution:** Foundational migration was reconstructed and verified (`20261009100000_001_organisation_tenant_hierarchy.sql`), then unified with schema reconciliation migration `026`. In the native PostgreSQL migration chain, this is consolidated into a clean, standalone initial migration `001_core_schema.sql` that defines `public.users` directly without any dependency on `auth.users`.
