> **SUPERSEDED** by `docs/ARCHITECTURE_V2.md` (2026-10-13). Kept for history.

# ANIBROS CRM — NATIVE POSTGRESQL & BACKEND ARCHITECTURE

## 1. Architectural Blueprint
```
+---------------------------------------------------------------------------------+
|                               CLIENT LAYER (SPA)                                |
|  React 18 + TypeScript + Vite | TailwindCSS + MUI | Zustand Auth & UI Stores     |
|  API Client (src/lib/api-client.ts) -- Native WebSocket Client (ws://)          |
+---------------------------------------------------------------------------------+
                                       |
                 HTTPS / REST          |         WSS / WebSockets
            (HttpOnly Session Cookies) |     (Session Authenticated)
                                       v
+---------------------------------------------------------------------------------+
|                               APPLICATION API SERVER                            |
|  Node.js 20+ / TypeScript | Fastify or Express | Helmet | CORS | CSRF Guard     |
|                                                                                 |
|  [Middleware Pipeline]                                                          |
|  Request ID -> Rate Limiter -> Session Cookie Auth -> Tenant Context Resolver   |
|                                                                                 |
|  [Domain Handlers]                                                              |
|  - Auth & Onboarding (/api/auth)                                                |
|  - Leads & Pipeline (/api/leads)                                                |
|  - Contacts, Properties, Projects (/api/crm)                                    |
|  - Tasks & Viewings (/api/activities)                                           |
|  - Integrations & Webhooks (/api/webhooks, /api/integrations)                   |
|  - Reports & Attribution (/api/reports)                                         |
|  - Operations & Diagnostics (/api/operations)                                  |
|  - Realtime Hub (ws://... /realtime)                                            |
|                                                                                 |
|  [Background Workers (in-process or dedicated daemon)]                          |
|  - Webhook Inbox Processor (Ingests durable payload -> creates lead)            |
|  - Outbox Dispatcher (Durable conversion event delivery with exponential backoff|
+---------------------------------------------------------------------------------+
                                       |
                          pg connection pool (PoolSize: 20)
                       Parameterized SQL | Transaction Scoping
                                       v
+---------------------------------------------------------------------------------+
|                           NATIVE POSTGRESQL 16+ DATABASE                        |
|                                                                                 |
|  - Standard Extensions: uuid-ossp, pgcrypto                                     |
|  - Core Schema: users (Argon2id), sessions, organisations, tenants, memberships |
|  - CRM Schema: contacts, leads, pipelines, properties, viewings, tasks          |
|  - Queues: webhook_inbox, outbox_events (FOR UPDATE SKIP LOCKED)                |
|  - Logs: audit_logs (append-only), system_telemetry                             |
|  - Security: Row-Level Security (RLS) defense-in-depth with app session vars    |
+---------------------------------------------------------------------------------+
```

---

## 2. Authentication & Session Design
- **Password Storage:** Argon2id with 64MB memory cost, 3 iterations, 4 parallelism lanes.
- **Session Tokens:** 32-byte cryptographically secure random values (generated via `crypto.randomBytes(32)`), stored as SHA-256 hash in `sessions` table.
- **Session Delivery:** Issued via `HttpOnly`, `SameSite=Lax` (or `Strict`), and `Secure` cookie named `anibros_session`.
- **CSRF Protection:** Double-submit cookie or server-generated CSRF token checked on all `POST`, `PUT`, `PATCH`, `DELETE` requests.
- **Tenant Context:** User's active tenant membership is verified on every authenticated request and injected into request context:
  ```typescript
  interface AuthenticatedRequest extends Request {
    user: { id: string; email: string };
    tenant: { id: string; organisationId: string; role: TenantRole };
  }
  ```

---

## 3. Database Access & Row-Level Security (RLS) Strategy
- **Application Role:** `crm_app_user` with `SELECT`, `INSERT`, `UPDATE`, `DELETE` grants on domain tables. No DDL privileges.
- **Connection Pooling:** `pg.Pool` with connection timeout (5000ms), statement timeout (10000ms), and max 20 connections.
- **RLS Session Settings (Defense-in-Depth):**
  When executing tenant-sensitive transactions:
  ```sql
  BEGIN;
  SET LOCAL app.current_user_id = '...';
  SET LOCAL app.current_tenant_id = '...';
  SELECT * FROM leads WHERE ...;
  COMMIT;
  ```
  PostgreSQL RLS policies enforce:
  ```sql
  CREATE POLICY tenant_isolation_policy ON leads
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
  ```

---

## 4. Realtime Gateway Specification
- Native WebSocket server mounted on `/realtime`.
- Connection handshake validates the `anibros_session` cookie.
- Subscription protocol:
  ```json
  // Client -> Server
  { "action": "subscribe", "channel": "leads", "tenant_id": "<uuid>" }

  // Server verifies tenant_id == request.tenant.id. If mismatch -> Close connection with 4403
  ```
- Broadcast mechanism: Database mutations emit PostgreSQL `NOTIFY crm_events, '{"tenant_id": "...", "table": "leads", "type": "INSERT", "record": {...}}'`. The WebSocket server listens to the notification and fans out to connected clients authorized for that specific tenant.
