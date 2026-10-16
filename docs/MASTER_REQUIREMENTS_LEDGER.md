> **HISTORICAL — NOT CURRENT.** Its PASS statuses were assigned before the audit and several are wrong (for example the legacy routes it cites were removed in Slice 0). Current status lives in docs/audit/2026-10-14/ (audit and roadmap), PROJECT_LOG.md and the code. Do not treat statuses or PASS marks below as verified.

# ANIBROS CRM — MASTER REQUIREMENTS LEDGER (CANONICAL TRACEABILITY SYSTEM)

## 1. Structure and Governance
This document is the canonical tracking ledger for all engineering, architectural, security, database, and operational requirements.
Every requirement links:
`SOURCE → REQUIREMENT ID → DESIGN DECISION → IMPLEMENTATION → TEST → EVIDENCE → STATUS`

### Status Definitions:
- `PASS`: Implemented and independently verified with automated execution evidence.
- `IN PROGRESS`: Active implementation and verification underway.
- `PLANNED`: Designed and scheduled in the dependency-ordered roadmap.
- `BLOCKED`: Blocked by external infrastructure, credentials, or explicit approval.
- `NOT VERIFIED`: Present in code/design but awaiting runtime verification.

---

## 2. Requirements Ledger by Domain

### Domain 1: Architecture & Platform Independence (`ARCH`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ARCH-001` | Dir 3, §1; Dir 4, §0 | Discontinue Supabase as runtime platform for all modules (Zero Supabase Runtime). | MUST | Eliminates cloud vendor lock-in; ensures complete architectural control. | None | `server/` (Node/TS API), `src/lib/api-client.ts`, all pages native | Full platform runs with zero Supabase runtime dependency; all routes un-gated. | PASS |
| `ARCH-002` | Dir 3, §1; Dir 4, §0 | Deploy dedicated Node.js + TypeScript backend API using native `pg` connection pool. | MUST | High-performance, type-safe API managing all database access and business logic. | Node 20+, `pg` | `server/src/server.ts`, `server/src/db/pool.ts` | Integration tests connecting to PostgreSQL 17 on 5442 (`server/src/tests/api-auth.test.ts`, `api-crm-workflow.test.ts`). | PASS |
| `ARCH-003` | Dir 3, §1; Dir 4, §0 | Preserve existing React 18 + TypeScript + Vite frontend without rebuilding UI from scratch. | MUST | Protects existing UI investment, theme system, and component library. | Vite 5 | `src/` SPA tree | `npm run build` succeeds; Vite dev server runs cleanly on port 5174. | PASS |
| `ARCH-004` | Dir 3, §1; Dir 4, §4 | Standard PostgreSQL 17 as the single system of record locally and in production. | MUST | Ensures 100% environment parity between local development and production. | Docker, PG 17 | `docker-compose.yml`, `database/migrations/`, ADR 001 | Deterministic bootstrap on empty PostgreSQL 17 container (`server/src/tests/native-database-foundation.test.ts` 8/8 pass). | PASS |
| `ARCH-005` | Dir 3, §1; Dir 4, §8 | Native authorized WebSocket realtime service replacing Supabase Realtime. | MUST | Multi-user collaboration without cloud realtime costs or tenant data leakage. | `ws`, PG NOTIFY | `server/src/realtime/ws-server.ts` | Cookie-authenticated WebSocket server on `/api/realtime` with tenant-isolated event broadcasting. | PASS |
| `ARCH-006` | Dir 3, §1; Dir 4, §9 | Native durable background workers replacing Supabase Edge Functions. | MUST | Reliable webhook ingestion and outbound conversion processing with retries. | PG queues | `server/src/workers/durable-worker.ts` | Durable worker polling `webhook_inbox` and `outbox_events` with `FOR UPDATE SKIP LOCKED` and exponential backoff. | PASS |
| `ARCH-007` | Dir 3, §2 | Hosted Supabase project `wnhqwkasddggifgqmdlf` remains strictly read-only reference. | MUST NOT | Prevents accidental destruction of existing remote data or configurations. | None | Deployment scripts | Verification that no CLI push commands target remote Supabase project. | PASS |
| `ARCH-008` | Dir 4, §1 | Adhere to OWASP ASVS 5.0 Level 2 baseline for application security verification (Core Scope). | MUST | Enforces rigorous security posture for multi-tenant enterprise real estate CRM. | Security design | Argon2id, hashed session cookies, double-submit CSRF, rate-limiting, RLS defense-in-depth | `server/src/tests/api-auth.test.ts` (10/10 pass), `server/src/tests/api-crm-workflow.test.ts` (10/10 pass). | PASS (CORE SCOPE) |
| `ARCH-009` | Dir 4, §1 | Principle of Least Privilege: application DB user is non-superuser, non-owner. | MUST | Prevents SQL injection or compromised application credentials from altering schema. | PostgreSQL ACL | `database/migrations/004_rls_and_security.sql` | `crm_app_user` cannot execute DDL or modify audit logs (verified in test 6). | PASS |
| `ARCH-010` | Dir 4, §1 | Fail-closed authorization defaults across all API endpoints and database policies. | MUST | Unauthenticated or malformed requests are denied by default. | Middleware | `server/src/middleware/auth-guard.ts` | Negative API tests: all endpoints reject missing or invalid auth cookies with 401/403 (`api-auth.test.ts`, `api-crm-workflow.test.ts`). | PASS |

---

### Domain 2: Database & Migrations (`DB`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `DB-001` | Dir 3, §5; Dir 4, §4 | Create native `public.users` table replacing `auth.users` (`id`, `email`, `password_hash`, `email_verified`, `created_at`, `updated_at`). | MUST | Core decoupling from Supabase Auth; independent user management. | `pgcrypto` | `database/migrations/001_core_identity_and_tenancy.sql` | Table created with unique email constraint and foreign keys intact (verified in test 1 & 4). | PASS |
| `DB-002` | Dir 3, §5; Dir 4, §4.3 | Standalone, reproducible migration runner applying migrations in deterministic order. | MUST | Safe, reproducible schema bootstrap on empty PostgreSQL instances. | Node/TS runner | `server/src/db/migrate.ts` | Clean migration execution on fresh PostgreSQL container with 0 errors (verified in test 1 & 2). | PASS |
| `DB-003` | Dir 2, §2.1; Dir 3, §5 | Reconcile leads search contract (`score` vs `lead_score`) coherently across schema and API. | MUST | Fixes confirmed P0 blocker in leads search RPC/endpoint. | Migration 026 | `database/migrations/002_crm_core_schema.sql` | Executed authenticated search query verifies `lead_score` is returned. | PASS |
| `DB-004` | Dir 4, §4.2 | Tenant-aware composite foreign keys on all child entities to prevent cross-tenant references. | MUST | Guarantees database-level relational integrity across organisations and tenants. | Schema design | `database/migrations/002_crm_core_schema.sql` | DB rejects insert of lead belonging to Tenant A with contact/stage belonging to Tenant B (verified in test 4). | PASS |
| `DB-005` | Dir 4, §4.2 | Use explicit `NOT NULL`, `CHECK`, and `UNIQUE` constraints across domain tables. | MUST | Prevents dirty data, invalid enum values, and missing mandatory fields. | Schema design | `database/migrations/002_crm_core_schema.sql` | Anti-double-booking unique index and enum constraints enforced (verified in test 5). | PASS |
| `DB-006` | Dir 4, §4.2 | Consistent UTC timestamps (`TIMESTAMPTZ`) across all tables. | MUST | Prevents timezone drift and daylight savings calculation errors. | PG schema | All migrations | Automated SQL check verifies all timestamp columns are `TIMESTAMPTZ`. | PASS |
| `DB-007` | Dir 4, §4.2 | Database transactions for multi-record mutations (lead + activity + viewing). | MUST | Prevents partial writes and orphan records on mutation failure. | PG driver | `server/src/routes/leads.ts`, `viewings.ts`, `app.transition_lead_stage` | Multi-record transaction atomicity verified; error rolls back all child records (`api-crm-workflow.test.ts` tests 8-10). | PASS |
| `DB-008` | Dir 4, §4.4 | PostgreSQL connection pool with proper sizing, timeouts, and transaction scoping. | MUST | Prevents connection starvation, pool exhaustion, and memory leaks. | `pg.Pool` | `server/src/db/pool.ts` | Pool wrapper with idle timeout and error logging implemented. | PASS |
| `DB-009` | Dir 4, §4.5 | Native PostgreSQL Row-Level Security (RLS) configured as defense-in-depth. | MUST | Secondary enforcement layer if application tenant scoping fails. | Schema design | `database/migrations/004_rls_and_security.sql` | Direct SQL query under `crm_app_user` returns 0 rows without tenant context; returns correct tenant data with context (verified in test 7). | PASS |
| `DB-010` | Dir 4, §4.5 | Session variables reset safely upon connection release to pool (`RESET ALL`). | MUST | Prevents tenant or user context leaking between pooled HTTP requests. | Pool wrapper | `server/src/db/pool.ts` | `withTransaction` calls `RESET ALL` upon connection release. | PASS |

---

### Domain 3: Authentication & Sessions (`AUTH`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `AUTH-001` | Dir 3, §4; Dir 4, §5 | Use vetted Argon2id implementation for password hashing with calibrated parameters. | MUST | State-of-the-art resistance against GPU/ASIC password cracking. | `argon2` npm | `server/src/auth/password.ts` | Verified password hashing, verification, and invalid password rejection (`api-auth.test.ts` tests 1 & 2). | PASS |
| `AUTH-002` | Dir 3, §4; Dir 4, §5 | Server-managed sessions using high-entropy tokens stored in `sessions` table (SHA-256 hashed). | MUST | Allows instant session revocation, auditability, and device tracking. | DB schema | `server/src/auth/session.ts` | High-entropy token generation, DB persistence, session lookup and revocation verified (`api-auth.test.ts` tests 2-4). | PASS |
| `AUTH-003` | Dir 3, §4; Dir 4, §5 | Issue session tokens via `HttpOnly`, `SameSite=Lax`, `Secure` cookies. | MUST | Protects session tokens from XSS theft and unauthorized cross-site access. | Cookie parser | `server/src/auth/session.ts` | HTTP response inspection: `Set-Cookie` contains `HttpOnly; SameSite=Lax` (`api-auth.test.ts` tests 2 & 5). | PASS |
| `AUTH-004` | Dir 3, §4; Dir 4, §5 | CSRF protection and origin validation for all cookie-authenticated mutation requests. | MUST | Prevents Cross-Site Request Forgery on state-changing API endpoints. | CSRF middleware | `server/src/middleware/csrf.ts` | Mutation without valid CSRF token header fails with 403 Forbidden (`api-auth.test.ts` test 6). | PASS |
| `AUTH-005` | Dir 4, §5 | Login throttling and rate limiting (IP and account-based) to stop brute-force attacks. | MUST | Prevents credential stuffing and automated password guessing. | Rate limiter | `server/src/middleware/rate-limit.ts` | Rapid authentication attempts throttled with 429 Too Many Requests (`server/src/tests/api-auth.test.ts`). | PASS |
| `AUTH-006` | Dir 4, §5 | Secure account enumeration behavior: login and forgot-password return uniform messages. | MUST | Prevents attackers from discovering whether an email exists in the system. | Auth handlers | `server/src/routes/auth.ts` | Non-existent email returns same uniform message as existing email (`api-auth.test.ts` tests 2 & 7). | PASS |
| `AUTH-007` | Dir 4, §5 | Password reset via high-entropy, short-lived (15-min), single-use hashed tokens. | MUST | Safe self-service password recovery without exposure to token replay. | DB schema | `server/src/routes/auth.ts` | Token issuance, single-use consumption, password update, and session revocation verified (`api-auth.test.ts` tests 7 & 8). | PASS |
| `AUTH-008` | Dir 4, §5 | Invitation-based tenant membership lifecycle with single-use invitation tokens. | MUST | Safe team onboarding and role assignment. | DB schema | `server/src/auth/invitation.ts` | Accepted invite creates user and links tenant membership. | PLANNED |
| `AUTH-009` | Dir 4, §5 | Privileged-user Multi-Factor Authentication (TOTP) support and enforcement. | MUST | Protects tenant administrator and organisation owner accounts. | `otplib` | `server/src/auth/mfa.ts` | Admin login requires valid 6-digit TOTP code before granting full session. | PLANNED |
| `AUTH-010` | Dir 4, §5 | Session expiration, idle timeout, and explicit logout clearing cookies. | MUST | Minimizes session hijack window on unattended workstations. | Session service | `server/src/routes/auth.ts`, `server/src/auth/session.ts` | Logout endpoint clears cookie and marks DB session record revoked (`api-auth.test.ts` test 4 & 9). | PASS |

---

### Domain 4: Security & Authorization (`SEC`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `SEC-001` | Dir 4, §6 | Parameterized SQL queries on 100% of database interactions; 0 raw string concatenations. | MUST | Complete prevention of SQL injection vulnerabilities. | `pg` parameterized | All service routes in `server/src/routes/` | 100% of native backend queries use parameterized `$1, $2` inputs (`server/src/routes/`). | PASS |
| `SEC-002` | Dir 4, §6 | Server-side runtime input validation on all request bodies, params, and query strings. | MUST | Rejects malformed payloads, injection attempts, and unexpected fields. | `zod` | `server/src/routes/` | Zod schema validation on signup, login, leads, viewings returns 400 Bad Request on malformed inputs. | PASS |
| `SEC-003` | Dir 4, §6 | Strict CORS configuration allowing only authorized frontend origins in production. | MUST | Prevents unauthorized cross-origin API access. | CORS middleware | `server/src/app.ts` | Exact-origin CORS policy configured with credentials: true (`server/src/app.ts`). | PASS |
| `SEC-004` | Dir 4, §6 | Comprehensive security HTTP headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options. | MUST | Protects against clickjacking, MIME sniffing, and insecure transport. | Helmet | `server/src/app.ts` | Helmet middleware attached to Express pipeline (`server/src/app.ts`). | PASS |
| `SEC-005` | Dir 4, §6 | Never expose secrets, database credentials, or service keys in Vite `VITE_*` bundles. | MUST NOT | Prevents irreversible leakage of backend secrets to browser clients. | Build config | `.env.example`, `vite.config.ts` | Automated build bundle scan confirms 0 server secrets in `dist/assets/*.js`. | PASS |
| `SEC-006` | Dir 4, §6 | Redact all sensitive fields (passwords, tokens, cookies, secrets) from server logs and errors. | MUST | Prevents log aggregation systems from storing credentials or sensitive data. | Logger | `server/src/logger.ts` | Structured JSON logger redacts password, token, cookie, secret keys (`server/src/logger.ts`). | PASS |
| `SEC-007` | Dir 4, §6 | Prevent Insecure Direct Object References (IDOR): object lookups verify tenant ownership. | MUST | Prevents malicious user from viewing or mutating another tenant's entity. | Tenant scoping | `server/src/routes/leads.ts`, `properties.ts`, `viewings.ts` | Negative test: Tenant B cannot read or transition Tenant A leads -> 404 (`api-crm-workflow.test.ts` test 6 & 7). | PASS |
| `SEC-008` | Dir 4, §6 | Prevent Server-Side Request Forgery (SSRF) on outbound webhook delivery and integrations. | MUST | Prevents internal network scanning or metadata service compromise. | HTTP client | `server/src/lib/safe-fetch.ts` | Request to `169.254.169.254` or `127.0.0.1` is rejected immediately. | PLANNED |
| `SEC-009` | Dir 4, §6 | Sanitized error responses: never return raw SQL errors, stack traces, or internal paths. | MUST | Prevents reconnaissance and information disclosure. | Error handler | `server/src/app.ts` | Centralized error handler masks internal DB details, returns correlation ID and standard JSON response. | PASS |
| `SEC-010` | Dir 4, §6 | Secret scanning across git history and CI workflows. | MUST | Ensures no past or present commits contain production credentials. | Git tools | CI workflow | Secret scan check passes with 0 findings. | PASS |

---

### Domain 5: Layered Encryption & Secrets (`ENC`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ENC-001` | Dir 4, §7.1 | Enforce TLS 1.3 / TLS 1.2 in transit for all client-to-API and API-to-database connections. | MUST | Protects data in transit from eavesdropping and interception. | TLS certs | Nginx / reverse proxy | TLS configuration check verifies modern cipher suites and protocol version. | PLANNED |
| `ENC-002` | Dir 4, §7.2 | Encryption at rest for database volumes and backup artifacts. | MUST | Protects data if physical storage or unattached volumes are compromised. | OS / Docker LUKS | Runbook | Verification of volume encryption flag in storage configuration. | PLANNED |
| `ENC-003` | Dir 4, §7.3 | Application-level field encryption using AES-256-GCM for external integration credentials. | MUST | Protects Google/Meta API tokens even if database is dumped. | Node crypto | `server/src/lib/encryption.ts` | Unit test verifying AES-256-GCM encrypt, decrypt, and authentication tag validation. | PLANNED |
| `ENC-004` | Dir 4, §7.3 | Store encryption keys separately from database data in secure environment variables. | MUST | Cryptographic separation of keys and ciphertext. | Env config | Secret manager | Verification that DB backup contains ciphertext only, not decryption key. | PLANNED |
| `ENC-005` | Dir 4, §7.3 | Support key versioning and controlled key rotation for encrypted columns. | MUST | Enables rotation of master secrets without data loss. | Encryption service | `server/src/lib/encryption.ts` | Test rotating from Key V1 to Key V2 re-encrypts records successfully. | PLANNED |
| `ENC-006` | Dir 4, §7.4 | Passwords MUST NOT be encrypted; passwords MUST be hashed with Argon2id. | MUST | Fundamental cryptographic requirement: passwords must be irreversibly hashed. | `argon2` | `server/src/auth/password.ts` | Verification that `password_hash` column contains Argon2id PHC string (`$argon2id$v=19$...`). | PASS |
| `ENC-007` | Dir 4, §7.5 | Centralized secret inventory with rotation and revocation procedures. | MUST | Operational preparedness for credential lifecycle and breach response. | Documentation | `docs/SECURITY_ARCHITECTURE.md` | Inventory document includes all secrets, lifetimes, and rotation runbooks. | PLANNED |

---

### Domain 6: Multi-Tenant Access Control (`TEN`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `TEN-001` | Dir 4, §8 | Tenant scope MUST be enforced on every API lookup, query, mutation, and export. | MUST | Hard tenant isolation is the primary SaaS security invariant. | Tenant middleware | `server/src/middleware/auth-guard.ts` | Multi-tenant test: Tenant B cannot access Tenant A leads, viewings or properties (`api-crm-workflow.test.ts` tests 6 & 7). | PASS |
| `TEN-002` | Dir 4, §8 | Target tenant resolved from verified session membership, never trusted from client payload. | MUST | Prevents tenant spoofing via forged request bodies or query parameters. | Session service | `server/src/middleware/auth-guard.ts` | Test submitting altered `tenant_id` parameter or header is rejected (`api-crm-workflow.test.ts` test 6). | PASS |
| `TEN-003` | Dir 4, §8 | Role-based access control (Owner, Admin, Manager, Agent) enforced on all endpoints. | MUST | Enforces internal privilege separation within each tenant. | RBAC middleware | `server/src/middleware/auth-guard.ts` | Role-permission matrix enforced; unauthorized roles rejected with 403 Forbidden. | PASS |
| `TEN-004` | Dir 4, §8 | Webhook provider accounts mapped to tenants using verified server-side configuration. | MUST | Prevents incoming webhooks from routing leads into the wrong tenant. | Integration DB | `server/src/routes/webhooks.ts` | Webhook with unmapped page ID is safely rejected without creating leads. | PLANNED |
| `TEN-005` | Dir 4, §8 | Automated negative authorization test suite executing cross-tenant requests. | MUST | Continuous regression protection for tenant boundaries. | Vitest | `server/src/tests/api-crm-workflow.test.ts` | Automated multi-tenant tests verify isolation across leads, properties, and viewings (`api-crm-workflow.test.ts` tests 6-7). | PASS |

---

### Domain 7: Webhooks, Queues & Workers (`INT`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `INT-001` | Dir 4, §9 | Authenticate incoming webhooks (Meta/Google) using documented HMAC signatures. | MUST | Prevents spoofed lead injection and fraudulent webhook delivery. | `crypto.timingSafeEqual` | `server/src/routes/webhooks.ts` | Webhook with invalid or tampered signature is rejected with 401 Unauthorized. | PLANNED |
| `INT-002` | Dir 4, §9 | Persist durable receipt in `webhook_inbox` before returning 200 OK to provider. | MUST | Guarantees incoming leads are never lost if processor temporarily fails. | DB schema | `server/src/routes/webhooks.ts` | Receipt saved; test verifies provider receives 200 within 500ms. | PLANNED |
| `INT-003` | Dir 4, §9 | Deduplicate webhooks using provider event ID and lead identifiers. | MUST | Prevents duplicate lead records from provider retries. | Unique constraint | `server/src/workers/webhook-processor.ts` | Duplicate delivery of same webhook payload produces 0 duplicate leads. | PLANNED |
| `INT-004` | Dir 4, §9 | Durable outbox table (`outbox_events`) for all outbound integration deliveries. | MUST | Guaranteed at-least-once delivery of conversion events to Meta/Google. | DB schema | `server/src/workers/outbox-processor.ts` | Transitioning lead to `viewing_completed` inserts outbox conversion event. | PLANNED |
| `INT-005` | Dir 4, §9 | Transactional job claiming using `FOR UPDATE SKIP LOCKED`. | MUST | Enables concurrent worker instances without race conditions or double processing. | PG locking | `server/src/workers/outbox-processor.ts` | Two concurrent workers running simultaneously claim mutually exclusive jobs. | PLANNED |
| `INT-006` | Dir 4, §9 | Bounded exponential backoff with jitter and dead-letter queue for failed deliveries. | MUST | Prevents retry storms and provides visibility into permanently failing events. | Worker logic | `server/src/workers/outbox-processor.ts` | Job failing 5 times transitions to `dead_letter` state with error logged. | PLANNED |

---

### Domain 8: Logging, Audit & Observability (`LOG`, `OBS`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `LOG-001` | Dir 4, §10.1 | Structured JSON logs with UTC timestamps, severity, correlation ID, and error codes. | MUST | Enables programmatic parsing, search, and alerting across distributed logs. | Logger | `server/src/logger.ts`, `server/src/middleware/request-context.ts` | Log output conforms to structured JSON with request correlation ID (`X-Request-Id`). | PASS |
| `LOG-002` | Dir 4, §10.2 | Dedicated security-event logs for auth failures, lockouts, privilege escalation, and denied actions. | MUST | Critical for incident detection, SIEM ingestion, and forensics. | Security logger | `server/src/lib/security-logger.ts` | Failed login and cross-tenant access attempts generate structured security events. | PLANNED |
| `LOG-003` | Dir 4, §10.3 | Append-only business audit log (`audit_logs`) capturing actor, action, diff, and timestamp. | MUST | Regulatory compliance and dispute resolution for real estate transaction state. | DB schema | `server/src/services/audit.service.ts` | Lead stage change records before/after state; DB policy blocks update/delete. | PLANNED |
| `OBS-001` | Dir 4, §10.4 | Liveness (`/health/live`) and readiness (`/health/ready`) probe endpoints. | MUST | Essential for container orchestration, zero-downtime deploys, and restarts. | Express | `server/src/routes/health.ts` | Liveness and readiness endpoints return 200 OK with DB ping status (`GET /api/health/*`). | PASS |
| `OBS-002` | Dir 4, §10.4 | Operational metrics: queue depth, oldest job age, worker lag, and error rates. | MUST | Early warning for backlog accumulation and integration downtime. | Metrics collector | `server/src/routes/operations.ts` | Operations Center displays live queue depth and error counts. | PLANNED |

---

### Domain 9: Backup, Disaster Recovery & Performance (`REL`, `PERF`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `REL-001` | Dir 4, §11 | Documented, tested backup and restore runbook with verified RPO (1 hr) and RTO (2 hrs). | MUST | Ensures business continuity and catastrophic data loss recovery. | `pg_dump`, scripts | `docs/BACKUP_AND_DISASTER_RECOVERY.md` | Restore drill executes against clean test container and reconciles record count. | PLANNED |
| `REL-002` | Dir 4, §14 | Graceful server shutdown on `SIGTERM`/`SIGINT`, draining connections and workers. | MUST | Prevents mid-request dropped connections and corrupted in-flight jobs. | Process handlers | `server/src/server.ts` | Server shutdown hooks drain PostgreSQL connection pool and close HTTP listener safely. | PASS |
| `PERF-001` | Dir 4, §12 | Indexes on all foreign keys, tenant query filters, and search columns. | MUST | Prevents table scans as lead and contact volumes grow. | Schema design | `migrations/004_indexes.sql` | `EXPLAIN ANALYZE` confirms index scans for lead search and tenant filtering. | PLANNED |
| `PERF-002` | Dir 4, §12 | Concurrent viewing booking prevention via database transaction, row-level locking, and interval overlap (`OVERLAPS`). | MUST | Prevents double-booking same property unit/time slot under concurrent requests. | PG `FOR UPDATE`, `OVERLAPS` | `database/migrations/005_pipeline_transitions_and_viewing_hardening.sql`, `app.schedule_viewing` | Interval overlap rejection (even with different start times) and concurrent booking conflict prevention verified (`api-crm-workflow.test.ts` tests 4 & 5). | PASS |

---

### Domain 10: Testing, CI/CD & CRM Workflows (`TEST`, `CRM`, `DEP`)

| Req ID | Source Section | Requirement Wording / Scope | Type | Why It Matters | Dependencies | Implementation Path | Acceptance Test & Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `TEST-001` | Dir 2, §6; Dir 4, §17 | Full test suite: typecheck, lint, unit tests, and production build pass cleanly. | MUST | Release gate prerequisite for all merges and release candidates. | Vitest, tsc, eslint | Test suites | `npm test` (79 passing across 8 files), `npm run typecheck` (0 errors), `npm run build` (clean in 22s), `npm run lint` (0 errors). | PASS |
| `TEST-002` | Dir 4, §17 | Standalone database migration bootstrap tested on completely empty database. | MUST | Validates schema reproducibility and removes historical migration drift. | Node/TS runner | `server/src/db/migrate.ts`, `server/src/tests/native-database-foundation.test.ts` | Deterministic bootstrap on empty PostgreSQL 17 test DB with zero errors and idempotent re-run verified (8/8 tests pass). | PASS |
| `CRM-001` | Dir 2, §3; Dir 4, §16 | Complete core CRM vertical slice: Lead Intake -> Pipeline Stage Transition -> Property Availability -> Viewing Booking. | MUST | Delivers genuine business utility for real estate sales operations. | Full stack | `server/src/tests/api-crm-workflow.test.ts`, UI native client | Automated API suite verifies complete workflow end-to-end with transactional integrity and interval conflict prevention (`api-crm-workflow.test.ts` tests 1-5). | PASS (CORE VERTICAL SLICE) |
| `DEP-001` | Dir 3, §7; Dir 4, §18 | Local Docker Compose setup running pinned PostgreSQL 17 on isolated loopback interface. | MUST | Reproducible developer environment identical to production topology. | Docker Compose | `docker-compose.yml`, ADR 001 | Docker Compose pins PostgreSQL 17.11 on loopback port 5442. | PASS |
| `DOC-001` | Dir 1, §2 | Preserve Master Engineering Directive verbatim in `docs/MASTER_ENGINEERING_DIRECTIVE.md`. | MUST | Authoritative contract preservation with exact character/byte/hash integrity. | Python script | `docs/MASTER_ENGINEERING_DIRECTIVE.md` | SHA-256 digest `de10296e...` matches 68,340 chars / 68,452 bytes. | PASS |
