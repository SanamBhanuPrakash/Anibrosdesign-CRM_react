> **HISTORICAL — NOT CURRENT.** Its statuses were assigned before the audit and are superseded by the capability matrix in docs/audit/2026-10-14/01_EXECUTIVE_FINDINGS_AND_CAPABILITY_MATRIX.md. Current status lives in docs/audit/2026-10-14/ (audit and roadmap), PROJECT_LOG.md and the code. Do not treat statuses or PASS marks below as verified.

# ANIBROS CRM — REQUIREMENT TRACEABILITY MATRIX (RTM)

| Requirement ID | Directive Source | Design Decision Document | Implementation Component / File | Verification Test Path | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| `ARCH-001` | Dir 3 §1, Dir 4 §0 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/server.ts`, `src/lib/api-client.ts` | Codebase audit for 0 `supabase-js` imports | PLANNED |
| `ARCH-002` | Dir 3 §1, Dir 4 §0 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/db/pool.ts` | Database connection pool test | PLANNED |
| `ARCH-003` | Dir 3 §1, Dir 4 §0 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `src/` (Vite SPA) | `npm run build` & browser smoke test | PASS |
| `ARCH-004` | Dir 3 §1, Dir 4 §4 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `docker-compose.yml`, `migrations/` | Docker Compose bootstrap test | PLANNED |
| `ARCH-005` | Dir 3 §1, Dir 4 §8 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/realtime/hub.ts` | Multi-client WebSocket isolation test | PLANNED |
| `ARCH-006` | Dir 3 §1, Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/workers/outbox.ts` | Queue delivery & retry test | PLANNED |
| `ARCH-007` | Dir 3 §2 | `docs/REQUIREMENT_CONFLICTS_AND_DECISIONS.md` | Git & deployment scripts | Read-only verification check | PASS |
| `ARCH-008` | Dir 4 §1 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/` | OWASP ASVS L2 automated test suite | PLANNED |
| `ARCH-009` | Dir 4 §1 | `docs/SECURITY_ARCHITECTURE.md` | `migrations/init_roles.sql` | Role privilege grant test | PLANNED |
| `ARCH-010` | Dir 4 §1 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/auth-guard.ts` | Negative unauthenticated route test | PLANNED |
| `DB-001` | Dir 3 §5, Dir 4 §4 | `docs/DATABASE_DESIGN.md` | `migrations/001_core_schema.sql` | Empty DB bootstrap test | PLANNED |
| `DB-002` | Dir 3 §5, Dir 4 §4.3 | `docs/DATABASE_DESIGN.md` | `server/src/db/migrate.ts` | Migration runner execution test | PLANNED |
| `DB-003` | Dir 2 §2.1, Dir 3 §5 | `docs/DATABASE_DESIGN.md` | `migrations/002_crm_tables.sql` | `test_p0_contract_remediation.mjs` | PASS |
| `DB-004` | Dir 4 §4.2 | `docs/DATABASE_DESIGN.md` | `migrations/002_crm_tables.sql` | Composite foreign key violation test | PLANNED |
| `DB-005` | Dir 4 §4.2 | `docs/DATABASE_DESIGN.md` | `migrations/002_crm_tables.sql` | Enum and check constraint test | PLANNED |
| `DB-006` | Dir 4 §4.2 | `docs/DATABASE_DESIGN.md` | All migrations | SQL schema inspection script | PLANNED |
| `DB-007` | Dir 4 §4.2 | `docs/DATABASE_DESIGN.md` | `server/src/services/` | Transaction rollback test | PLANNED |
| `DB-008` | Dir 4 §4.4 | `docs/DATABASE_DESIGN.md` | `server/src/db/pool.ts` | Connection pool load test | PLANNED |
| `DB-009` | Dir 4 §4.5 | `docs/DATABASE_DESIGN.md` | `migrations/003_rls_policies.sql` | Direct RLS boundary test | PLANNED |
| `DB-010` | Dir 4 §4.5 | `docs/DATABASE_DESIGN.md` | `server/src/db/pool.ts` | Connection pool session reset test | PLANNED |
| `AUTH-001` | Dir 3 §4, Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/password.ts` | Argon2id verification test | PLANNED |
| `AUTH-002` | Dir 3 §4, Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/session.ts` | Session creation and revocation test | PLANNED |
| `AUTH-003` | Dir 3 §4, Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/cookie.ts` | Cookie security attribute inspection | PLANNED |
| `AUTH-004` | Dir 3 §4, Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/csrf.ts` | CSRF mutation rejection test | PLANNED |
| `AUTH-005` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/rate-limit.ts` | Rate limiter throttling test | PLANNED |
| `AUTH-006` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/routes/auth.ts` | User enumeration timing test | PLANNED |
| `AUTH-007` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/reset.ts` | Password reset lifecycle test | PLANNED |
| `AUTH-008` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/invitation.ts` | Team member invitation test | PLANNED |
| `AUTH-009` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/mfa.ts` | MFA TOTP verification test | PLANNED |
| `AUTH-010` | Dir 4 §5 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/session.ts` | Logout & session revocation test | PLANNED |
| `SEC-001` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | All query modules | SAST parameterized query audit | PLANNED |
| `SEC-002` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/schemas/` | Zod payload validation test | PLANNED |
| `SEC-003` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/cors.ts` | CORS origin policy test | PLANNED |
| `SEC-004` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/headers.ts` | Helmet security headers test | PLANNED |
| `SEC-005` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `vite.config.ts` | Client bundle secret scan test | PASS |
| `SEC-006` | Dir 4 §6 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/lib/logger.ts` | PII & password redaction log test | PLANNED |
| `SEC-007` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | All route handlers | Cross-tenant IDOR negative test | PLANNED |
| `SEC-008` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/lib/safe-fetch.ts` | Outbound SSRF rejection test | PLANNED |
| `SEC-009` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/error.ts` | Sanitized error response test | PLANNED |
| `SEC-010` | Dir 4 §6 | `docs/SECURITY_ARCHITECTURE.md` | Git & CI | Git secret scanning check | PASS |
| `ENC-001` | Dir 4 §7.1 | `docs/SECURITY_ARCHITECTURE.md` | Reverse proxy config | TLS verification test | PLANNED |
| `ENC-002` | Dir 4 §7.2 | `docs/SECURITY_ARCHITECTURE.md` | Docker / OS storage | Storage volume encryption audit | PLANNED |
| `ENC-003` | Dir 4 §7.3 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/lib/encryption.ts` | AES-256-GCM field encryption test | PLANNED |
| `ENC-004` | Dir 4 §7.3 | `docs/SECURITY_ARCHITECTURE.md` | Environment config | Secret separation verification | PLANNED |
| `ENC-005` | Dir 4 §7.3 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/lib/encryption.ts` | Key rotation test | PLANNED |
| `ENC-006` | Dir 4 §7.4 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/auth/password.ts` | Argon2id verification test | PLANNED |
| `ENC-007` | Dir 4 §7.5 | `docs/SECURITY_ARCHITECTURE.md` | `docs/SECURITY_ARCHITECTURE.md` | Secret inventory audit | PLANNED |
| `TEN-001` | Dir 4 §8 | `docs/SECURITY_ARCHITECTURE.md` | All API routes | Two-tenant isolation test suite | PLANNED |
| `TEN-002` | Dir 4 §8 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/tenant.ts` | Tenant spoofing rejection test | PLANNED |
| `TEN-003` | Dir 4 §8 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/middleware/rbac.ts` | Role-permission negative test | PLANNED |
| `TEN-004` | Dir 4 §8 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/routes/webhooks.ts` | Webhook tenant routing test | PLANNED |
| `TEN-005` | Dir 4 §8 | `docs/SECURITY_ARCHITECTURE.md` | `server/src/tests/` | 15+ automated negative tenant tests | PLANNED |
| `INT-001` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/routes/webhooks.ts` | Webhook HMAC signature test | PLANNED |
| `INT-002` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/routes/webhooks.ts` | Webhook receipt persistence test | PLANNED |
| `INT-003` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/workers/` | Duplicate webhook replay test | PLANNED |
| `INT-004` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/workers/` | Outbox event creation test | PLANNED |
| `INT-005` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/workers/` | Concurrent job claiming test | PLANNED |
| `INT-006` | Dir 4 §9 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/workers/` | Dead-letter queue transition test | PLANNED |
| `LOG-001` | Dir 4 §10.1 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/lib/logger.ts` | JSON log format validation test | PLANNED |
| `LOG-002` | Dir 4 §10.2 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/lib/security-logger.ts` | Security event log test | PLANNED |
| `LOG-003` | Dir 4 §10.3 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/services/audit.service.ts` | Immutable audit log test | PLANNED |
| `OBS-001` | Dir 4 §10.4 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/routes/health.ts` | Health probes test | PLANNED |
| `OBS-002` | Dir 4 §10.4 | `docs/OBSERVABILITY_AND_LOGGING.md` | `server/src/routes/operations.ts` | Operations metrics test | PLANNED |
| `REL-001` | Dir 4 §11 | `docs/BACKUP_AND_DISASTER_RECOVERY.md` | Backup & restore scripts | Backup restore drill test | PLANNED |
| `REL-002` | Dir 4 §14 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | `server/src/server.ts` | Graceful shutdown test | PLANNED |
| `PERF-001` | Dir 4 §12 | `docs/DATABASE_DESIGN.md` | `migrations/004_indexes.sql` | Index scan verification test | PLANNED |
| `PERF-002` | Dir 4 §12 | `docs/DATABASE_DESIGN.md` | `server/src/services/viewing.service.ts` | Concurrent booking conflict test | PLANNED |
| `TEST-001` | Dir 2 §6, Dir 4 §17 | `docs/RELEASE_READINESS.md` | Vitest / TypeScript / Vite | CI test suite run | PASS |
| `TEST-002` | Dir 4 §17 | `docs/MIGRATION_AND_ROLLBACK_PLAN.md` | Migration runner | Clean DB migration test | PLANNED |
| `CRM-001` | Dir 2 §3, Dir 4 §16 | `docs/NATIVE_POSTGRESQL_ARCHITECTURE.md` | Frontend + API | End-to-end CRM workflow test | PLANNED |
| `DEP-001` | Dir 3 §7, Dir 4 §18 | `docs/LOCAL_AND_PRODUCTION_RUNBOOK.md` | `docker-compose.yml` | Local Docker Compose boot test | PLANNED |
| `DOC-001` | Dir 1 §2 | `docs/SOURCE_COVERAGE_REPORT.md` | `docs/MASTER_ENGINEERING_DIRECTIVE.md` | Verbatim text SHA-256 match | PASS |
