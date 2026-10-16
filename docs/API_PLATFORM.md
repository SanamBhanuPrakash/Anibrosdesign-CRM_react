# Anibros CRM — API Platform

Audience: engineers integrating with Anibros CRM, and engineers extending the API.
Source of truth for endpoints: **`/api/v1/openapi.json`** (generated from the code) and the interactive reference at **`/api/docs`**. This page explains the conventions those documents assume.

## 1. Surfaces
| Surface | Who | Auth |
|---|---|---|
| `/api/v1/*` REST | Web app, customers' integrations | Session cookie (+CSRF) **or** API key |
| `/api/v1/openapi.json`, `/api/docs` | Anyone | none (contains no secrets) |
| `/hooks/{endpointId}` *(Wave 4)* | Meta, Google, website forms | per-endpoint signature / secret |
| Outbound webhooks *(Wave 4)* | Customer servers | HMAC-signed, retried |
| `/healthz` `/readyz` `/metrics` | Load balancer, monitoring | none / none / bearer token |

## 2. Authentication
- **API key** — `Authorization: Bearer crm_live_<prefix>_<secret>`. Created in *Settings → API keys* (or `POST /api/v1/api-keys`). Shown once; only a SHA-256 of the secret is stored. A key belongs to one workspace, has a **ceiling role** and an explicit **scope list**; effective permission = role ∩ scopes, and a key can never exceed its creator. Keys can be revoked (instant) and may expire. `last_used_at/ip` are tracked.
- **Session** (browser): HttpOnly cookie. Mutations must send `x-csrf-token` (value of the `anibros_csrf` cookie, or `GET /api/v1/auth/csrf`). API-key requests need no CSRF header.
- Workspace selection: a session has an active workspace (`POST /api/v1/me/switch-tenant`). `X-Tenant-Id` may *select among your memberships* for that request; it never grants access to a workspace you are not in. API keys are bound to their own workspace.

Scopes are permission strings such as `leads:read`, `leads:create`, `contacts:update` (the full matrix is in `server/src/platform/authz/matrix.ts`; `GET /api/v1/api-keys/scopes` lists what *you* may grant).

## 3. Requests & responses
- JSON only. Success: `{ "data": … }`; lists: `{ "data": [...], "page": { "limit", "next", "hasMore" } }`; `204` has no body.
- **Errors** are RFC 9457 `application/problem+json`:
  ```json
  { "type": "https://docs.anibros.app/errors/validation-failed", "title": "Validation failed", "status": 400,
    "detail": "Invalid body", "code": "VALIDATION_FAILED", "requestId": "…",
    "errors": [{ "path": "body.email", "message": "Invalid email", "code": "invalid_format" }] }
  ```
  `code` is stable and machine-readable (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMITED`, `INVALID_TRANSITION`, `SLOT_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, …). Quote `requestId` to support. Resources in another workspace return **404**, never 403, so existence never leaks.
- **Pagination**: keyset cursors. `?limit=50&cursor=<opaque>`; follow `page.next` until `hasMore=false`. Cursors are bound to the sort order and stable under concurrent writes.
- **Idempotency**: send `Idempotency-Key: <8–128 chars>` on idempotent-capable POSTs. A retry with the same key and body replays the original response (`Idempotent-Replay: true`); same key + different body → `422 IDEMPOTENCY_CONFLICT`; concurrent duplicate → `409` + `Retry-After`. Keys live 24 h.
- **Concurrency control**: `ETag` / `If-Match` on PATCH for contacts, leads, projects and properties. Read the `ETag` from GET/POST/PATCH responses and send it back as `If-Match`; a stale value returns `412` with code `PRECONDITION_FAILED`. Treat the ETag as opaque (it may look like `"7"` or `"7.3fa91c0e"`).
- **Caching**: every `/api` JSON response is `Cache-Control: no-store`. Do not cache API data in intermediaries; use `ETag` + `If-Match` for writes. File downloads (`GET /files/{id}`) are `private, no-cache` with a content-hash `ETag`; send `If-None-Match` to get `304`.
- **File uploads**: `POST /properties/{id}/files?name=<file name>` (and `/projects/{id}/files`) with the **raw file bytes** as the body (not multipart) and the file's `Content-Type`. Accepted: JPEG, PNG, WebP, PDF, up to 10 MB each, 40 files per entity; the server checks the real content, not the extension. Re-uploading the same bytes to the same entity returns `409`. Errors: `415` unsupported content, `413` too large.
- **CSV**: list exports (`/leads/export`) respond with `text/csv`; cells that start with `=`, `+`, `-` or `@` are neutralised. Imports are asynchronous: `POST /leads/imports` returns a job id; poll `GET /leads/imports/{id}`.
- **Inbound lead webhooks** (public receiving addresses, created under *Lead sources* or `POST /api/v1/lead-sources`): `POST /hooks/{endpointId}` with no cookies. The id only locates the source; authenticity is proven per source:
  - **Meta** — `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body with your app secret. Subscription handshake: `GET /hooks/{id}?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` echoes the challenge.
  - **Google Ads** — your key in the JSON body as `google_key`.
  - **Generic** — `X-Anibros-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`; deliveries older than 5 minutes are refused. Optional `X-Event-Id` makes redeliveries idempotent.
  - **Website** — browser form post (JSON or urlencoded); allowed origins per source; a hidden `_hp` field must stay empty.
  Responses: `200 {"status":"received","accepted":n}` once stored; `400` unreadable; `401` proof failed; `403` origin not allowed; `404` unknown address; `413` body over 256 KB; `429` too many requests (honour `Retry-After`); `503` paused or temporarily unavailable (retry later — nothing was stored). Processing is asynchronous; see the delivery log (`GET /api/v1/lead-sources/events`).
- **Monitor**: `GET /api/v1/monitor/overview` (health snapshot), `/events` (activity log, 30 days), `/audit` + `/audit/{id}` + `/audit/facets` + `/audit/export` (CSV). All scoped to the caller’s workspace.
- **Rate limits**: `RateLimit-Limit`, `RateLimit-Remaining`; `429` + `Retry-After`. Authentication endpoints have stricter, layered limits (per IP, per IP+email, per email).
- **Request ids**: send `X-Request-Id` (8–64 safe chars) to correlate; otherwise one is generated. Always echoed in the response header and error body.

## 4. Versioning & compatibility policy
- `/api/v1` is additive-only: new optional fields, endpoints and enum values may appear; clients must ignore unknown fields. Removing/renaming fields, changing semantics, or tightening validation requires `/api/v2`.
- Deprecations are announced in the OpenAPI document (`deprecated: true`) and via a `Deprecation`/`Sunset` header ≥ 6 months before removal.
- The legacy unversioned `/api/*` routes used by not-yet-rebuilt pages are **not** part of the public API and will be removed.

## 5. Webhooks (outbound) — contract
*(Delivery implementation: Wave 4; the contract below is already published in the OpenAPI `webhooks` section.)*
- Subscribe per event type (`lead.created`, `lead.stage_changed`, …; see `EVENT_CATALOG` in `server/src/platform/events/index.ts`).
- Body: `{ "id", "type", "createdAt", "tenantId", "data": { "object", "id", … } }`. Deliveries are **at-least-once**; de-duplicate on `id`.
- Signature header: `Anibros-Signature: t=<unix>,v1=<hex>` with `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`. Reject if `|now − t| > 300 s`. Secrets can be rotated with an overlap window.
- Respond `2xx` within 10 s. Failures retry with exponential backoff + jitter for 24 h, then the delivery is dead-lettered and visible (and replayable) in the delivery log. Target URLs must be public HTTPS (private/loopback/link-local ranges are blocked to prevent SSRF).

## 6. Generating clients & checking drift
```bash
npm run api:export   # docs/openapi.json (from the live route registry — no DB needed)
npm run api:types    # + src/api/schema.d.ts (TypeScript types used by the web app)
npm run api:check    # CI gate: fails if committed artefacts are stale
```
Any OpenAPI generator works against `docs/openapi.json` (e.g. `openapi-generator`, `oapi-codegen`, Postman/Insomnia import).

## 7. Adding an endpoint (checklist)
1. Define the route with `defineRoute({ method, path, summary, tags, permission, params/query/body/response (zod), handler })` — validation, authorization, envelope and docs come from this one declaration.
2. Put business rules in a **service** that takes the `Actor`, runs inside `db.withTenant(actor, …)`, applies scope filters (`scopeFor`), and calls `audit()` + `emit()` **inside the same transaction**.
3. Add the permission(s) to the matrix and to `authz.test.ts`.
4. Write integration tests as the **restricted DB role** (harness `bootApi({ restricted: true })`): happy path, validation, permission denial per role, cross-tenant 404, concurrency where relevant.
5. `npm run api:types` and commit the regenerated contract.
