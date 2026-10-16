# Anibros CRM — Security Model

Scope: what is enforced, where, how it is proven, and what is **not** yet covered. Status words follow `Claude_plan.md` (PASS = proven by a test in this repo).
Reference frames: OWASP ASVS 5.0 (selected controls), OWASP API Security Top 10, STRIDE per trust boundary. No blanket compliance claim is made.

## 1. Trust boundaries & assets
```
Browser ──TLS──► API (stateless) ──restricted DB role──► PostgreSQL (RLS)
 3rd party ──signed──► /hooks ─► inbox ─► Worker (separate role) ─► providers
```
Assets: tenant business data (leads/contacts = PII), credentials (passwords, API keys, MFA seeds, provider tokens), audit trail, availability.
Actors: anonymous internet, authenticated tenant users (8 roles), API keys, a malicious tenant, a compromised browser session, a compromised API process (SQL injection), operators.

## 2. Controls (and proof)
| # | Threat | Control | Status / proof |
|---|---|---|---|
| T1 | Cross-tenant read/write (the #1 SaaS risk) | Tenant from verified membership only; **RLS enforced** with a non-owner, non-superuser role; composite tenant FKs; tests run as the restricted role | PASS — `platform-db.test.ts` (no-context ⇒ 0 rows; A cannot read/update/delete/insert into B **without any WHERE tenant_id**; context never leaks across pooled connections) |
| T2 | Forgotten tenant filter in new code | RLS turns the bug into "0 rows"/403, not a leak | PASS (same suite) · *runtime still privileged until legacy routes are rebuilt — see §4* |
| T3 | Privilege escalation via roles | Central permission matrix; own/all scopes; admins cannot grant/modify owners; last-owner invariant under concurrency; API keys ⊆ creator | PASS — `authz.test.ts` (69), `access-control.test.ts` (race: two owners demoting each other) |
| T4 | Credential stuffing / brute force | Argon2id (64 MiB, bounded concurrency), per-IP, per-(IP,email) and per-email token buckets, **no hard account lock-out** (lock-out is a DoS lever) | PASS — `identity.test.ts` (strict limiter blocks 6th attempt even with the right password; other IP unaffected) |
| T5 | Account enumeration | Uniform responses for signup/reset/resend; constant-time verification on unknown user | PASS |
| T6 | Token replay/races (verify, reset, invite) | Atomic single-use `UPDATE … RETURNING`; hashed at rest; TTLs; reset revokes all sessions | PASS — 8 parallel submissions ⇒ exactly one success |
| T7 | Session theft / fixation | Opaque 256-bit tokens, SHA-256 at rest, HttpOnly + SameSite=Lax (+`__Host-`/Secure in prod), idle (12 h) + absolute (14 d) expiry, server-side revoke, device list, deactivation effective next request, new token per login | PASS |
| T8 | CSRF | Origin allow-list + double-submit token on cookie-auth mutations; API keys carry no ambient credentials | PASS |
| T9 | MFA bypass / replay | TOTP with ±1 step window, per-step replay protection, encrypted seed (AES-GCM, AAD=user), single-use recovery codes, challenge bound by HMAC with 5-min TTL | PASS |
| T10 | Invitation hijack | Token + **email-bound** consumption; existing accounts must be signed in as that address; atomic single use | PASS |
| T11 | Secrets in DB/logs | AES-256-GCM field encryption with key rotation and context binding; recursive log redaction; no secrets in JWT/localStorage (none used) | PASS — `platform-units.test.ts` |
| T12 | SQL injection | Parameterised queries only; UUID/regex validation of context values; dynamic SQL limited to whitelisted identifiers | PASS (design) · SAST pending (Wave 9) |
| T13 | Cross-site WebSocket hijack / over-sharing | Origin check, session required, explicit tenant, per-socket permission filter, IDs-only payloads, session re-validation, caps | PASS — `realtime.test.ts` |
| T14 | Forged provider webhooks / wrong-tenant ingestion | **Legacy endpoints disabled (410).** Replacement: per-tenant endpoint secret + HMAC on raw body, tenant only from endpoint mapping, quarantine unmapped | BLOCKED on Wave 4 (fail-closed meanwhile) |
| T15 | SSRF via outbound webhooks | Public-HTTPS-only target validation, DNS-rebinding-safe resolve-then-connect | Wave 4 |
| T16 | Audit tampering | Append-only for the runtime role (no UPDATE/DELETE grant, no policy); actor/IP/request id come from transaction context defaults (cannot be forged by callers) | PASS (grants + `platform-db.test.ts`) · hash-chaining planned |
| T17 | Migration/tooling abuse | Runtime roles cannot read `schema_migrations`, cannot CREATE, TEMP revoked, SECURITY DEFINER functions pin `search_path`, narrow DEFINER lookups only | PASS |
| T18 | Resource exhaustion | Body limit 1 MB, statement/lock/idle-in-tx timeouts per role, pool back-pressure → 503, WS caps & slow-consumer drop, Argon2 concurrency cap | PASS (unit/integration) · load test pending (Wave 9) |
| T19 | Clickjacking / XSS impact | API CSP `default-src 'none'`, `frame-ancestors 'none'`; SPA CSP (strict, nonce) at the static host | API PASS · SPA host config in Wave 9 |
| T21 | Malicious upload (disguised HTML/SVG/script, polyglot, oversized, path traversal in file name) | Allow-list by **magic bytes** (JPEG/PNG/WebP/PDF), client MIME and extension ignored, display name sanitised, storage keys generated server-side with traversal guard, ≤ 10 MB / 40 files per entity, AV scanner hook, upload parsed only **after** authn+authz; downloads served with `nosniff`, sandbox CSP and `private, no-cache` | PASS — `inventory.test.ts` (disguised HTML ⇒ 415, cross-tenant file id ⇒ 404, viewer cannot upload) · AV engine adapter pending (Wave 9) |
| T22 | Cross-tenant background job abuse | The one cross-tenant path (`app.dispatch_task_notifications`) is `SECURITY DEFINER`, pinned `search_path`, EXECUTE revoked from PUBLIC and the API role, inserts notifications and stamps tasks only | PASS — `tasks.test.ts` (API role cannot execute it) |
| T23 | Stale or cached sensitive data in shared browsers/proxies | `Cache-Control: no-store` on every `/api` JSON response; file bytes `private, no-cache` with ETag revalidation | PASS — `leads.test.ts` regression |
| T24 | Notification link injection (phishing via in-app link) | `notifications.link` is in-app-path only (DB CHECK, rejects absolute/protocol-relative URLs); notifications are personal (recipient = user) | PASS |
| T25 | CSV formula injection on export; malicious import files | Export prefixes `= + - @` cells; import has row/size limits, runs in the worker, per-row errors, audited | PASS — `leads.test.ts` |
| T26 | Forged or replayed lead deliveries (Meta, Google, website, generic) | Per-source proof over the raw body (HMAC-SHA256 / key / signed timestamp, constant-time), tenant taken from the endpoint row only, event-id dedupe, 256 KB cap, per-IP/endpoint/visitor rate limits, uniform 404 for unknown/deleted/suspended ids, honeypot + allowed origins for forms | PASS — `inbound.test.ts` (36), `inbound-units.test.ts` (26). Live provider round trips BLOCKED on credentials |
| T27 | Integration secrets at rest and in output (Meta app secret, page token, Google key, signing secret) | AES-256-GCM with the endpoint id as AAD; only a 4-char hint returned; shown once; redacted from logs and audit; rotation invalidates immediately | PASS — `inbound.test.ts` (“no secret ever appears…”) |
| T28 | Pre-tenant database lookups abused to read other workspaces’ endpoints | Two narrow DEFINER functions (lookup by endpoint id, receipt) with pinned `search_path`; API role has no row access without tenant context; no DELETE on endpoints/deliveries for the API role | PASS — `inbound.test.ts` (database section) |
| T29 | Tampering with or hiding the trail | `audit_logs` append-only for the application (no UPDATE/DELETE grant), written in the business transaction; the activity log is insert-only for the API role; exports are themselves audited; read-back redacts secrets | PASS — `monitor.test.ts` |
| T30 | Observability leaks data across workspaces or to the wrong role | Every monitor query is tenant-scoped under RLS; audit needs `audit:read`, health/activity needs `operations:read`; lead counts withheld from roles without `leads:read`; worker heartbeat exposed through one function returning platform components only | PASS — `monitor.test.ts` |
| T20 | Supply chain | Lockfile; `npm audit` and secret scanning in CI | **OPEN** — `npm audit` currently reports 33 findings (2 critical) to triage (Wave 9) |

## 3. Data protection
- PII: contacts/leads. Consent model exists (`communication_consents`); enforcement points land with messaging (Wave 4). Retention jobs purge tokens, attempts, logs, idempotency keys; subject export/erasure workflow in Wave 5.
- Backups encrypted, restore drill, RPO/RTO measured: Wave 9. Region: single region (India) assumed (DPDP), documented in `Claude_plan.md` R7.

## 4. Known gaps & residual risk (honest list)
Updated 2026-10-15 after the release-readiness pass (`docs/audit/2026-10-14/16_RELEASE_READINESS_PASS.md`).

1. **R-1 · Identity tables: CLOSED in migration 034 (2026-10-16).** `users`, `organisations`, `tenants`, `tenant_memberships`, `sessions`, the token, MFA and read-marker tables and `login_attempts` now have row-level policies. Three contexts: a workspace context (`withTenant`: its own workspace, its members, and people who share a workspace with the caller), a user context (`Database.asUser`: the workspaces the person belongs to, plus every client of an agency they own or administer) and the identity flow (`Database.identity`: sign-in, sign-up, sessions, tokens, invitations). With no context nothing is visible. Ending a removed person's sessions (`app.detach_sessions`) and retention purges (`app.purge_identity`, worker only) are narrow SECURITY DEFINER functions, so no role reads or deletes another person's session or token, and session columns other than last-seen, revoked and active workspace cannot be updated. Proved with the restricted roles and raw SQL in `identity-rls.test.ts`; `schema_migrations` is the only public table without a policy. **Residual:** inside the identity flow (about 50 statements in the sign-in, sign-up, session and invitation code) the policies are permissive by necessity, so those statements must stay parameterised and reviewed. Earlier mitigations still hold: `DELETE` on `users`, `organisations`, `tenants` and `tenant_memberships` is withdrawn from the runtime roles (migration 027), and a catalog test pins the set of tables without RLS.
2. **The dev database role is a superuser.** `.env.native` points `DATABASE_URL` at the dev owner role, so a developer's API does not enforce RLS even though every route works under the restricted role (the E2E stack, the browser sweep and all journeys run restricted). `provision-cli` prints the restricted URLs; production **refuses to boot** if the role is a superuser, has BYPASSRLS, or owns tables (owners skip RLS without FORCE), and refuses `ALLOW_PRIVILEGED_RUNTIME_ROLE`.
3. No step-up re-auth for sensitive actions yet; session-token rotation on privilege change pending.
4. Per-API-key rate limiting not implemented (global/IP limits only).
5. Rate-limit state is in-memory: exact for one API replica; use a shared store (Redis) at 2 or more replicas. Limits are scaled ×1000 under `NODE_ENV=test`; the real limits are exercised with injected limiters (`identity.test.ts`).
6. `/api/docs` (the API reference) is public in production. It contains no secrets (tested) but advertises the surface; put it behind the proxy if that matters.
7. Dependency audit is clean for production dependencies (`npm audit --omit=dev`: 0) and runs in CI; SAST and DAST are not run, and CI has not yet run on a remote.
8. An operator with database superuser access is outside the threat model (audit immutability is for the application, not for DBAs).

## 5. Security review checklist for every change
Threat? · New input validated (zod)? · Permission added to matrix + tests? · Runs inside `withTenant`? · Cross-tenant test? · Secrets encrypted/redacted? · Audit + event in the same transaction? · Negative tests (role denied, replay, race)? · Docs/OpenAPI regenerated?
