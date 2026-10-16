import { z, type ZodType } from 'zod';
import { routeRegistry, type RouteSpec } from '../http/route';
import { EVENT_CATALOG } from '../events';
import { MATRIX, ROLES } from '../authz/matrix';

/**
 * OpenAPI 3.1 generated from the declarative route registry — the same zod schemas that validate requests produce
 * the documentation, so the public reference cannot drift from behaviour.
 */
type Json = Record<string, any>;

function schemaOf(schema: ZodType | undefined): Json | undefined {
  if (!schema) return undefined;
  try {
    const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Json;
    delete js.$schema;
    return js;
  } catch {
    return { type: 'object' };
  }
}

function parametersFrom(schema: ZodType | undefined, where: 'path' | 'query'): Json[] {
  const js = schemaOf(schema);
  if (!js?.properties) return [];
  const required = new Set<string>(js.required ?? []);
  return Object.entries<Json>(js.properties).map(([name, s]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.has(name),
    schema: s,
    ...(s.description ? { description: s.description } : {}),
  }));
}

const operationId = (method: string, path: string) =>
  method +
  path
    .replace(/^\/api\/v1/, '')
    .split(/[/{}]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1).replace(/[-_](\w)/g, (_, c) => c.toUpperCase()))
    .join('');

const problemRef = { $ref: '#/components/schemas/Problem' };
const problemResponse = (description: string) => ({ description, content: { 'application/problem+json': { schema: problemRef } } });

export interface OpenApiOptions {
  version: string;
  serverUrl?: string;
}

export function buildOpenApi(opts: OpenApiOptions): Json {
  const paths: Json = {};
  const tags = new Map<string, number>();

  for (const { spec, fullPath } of routeRegistry as Array<{ spec: RouteSpec; fullPath: string }>) {
    if (spec.internal) continue;
    const isPublic = (spec.auth ?? 'session') === 'public';
    const perms = ([] as string[]).concat(spec.permission ?? []);
    const success = spec.successStatus ?? (spec.method === 'post' ? 201 : 200);
    const itemSchema = schemaOf(spec.response);
    const dataSchema = spec.paginated ? { type: 'array', items: itemSchema ?? {} } : itemSchema;
    const parameters = [...parametersFrom(spec.params, 'path'), ...parametersFrom(spec.query, 'query')];
    if (spec.idempotent) {
      parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Unique key (8–128 chars) so a retried request is applied once. Replays return the original response with `Idempotent-Replay: true`.', schema: { type: 'string', minLength: 8, maxLength: 128 } });
    }
    if (spec.ifMatch) {
      parameters.push({ name: 'If-Match', in: 'header', required: false, description: 'ETag (the record version) from a previous read. If the record changed since, the request fails with 412 instead of overwriting someone else’s edit.', schema: { type: 'string' } });
    }
    for (const t of spec.tags) tags.set(t, (tags.get(t) ?? 0) + 1);

    const op: Json = {
      operationId: operationId(spec.method, fullPath),
      summary: spec.summary,
      description: [spec.description, perms.length ? `**Requires permission:** ${perms.map((p) => `\`${p}\``).join(', ')}` : undefined].filter(Boolean).join('\n\n') || undefined,
      tags: spec.tags,
      security: isPublic ? [] : [{ cookieAuth: [] }, { bearerApiKey: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(spec.rawBody ? { requestBody: { required: true, description: spec.rawBody.description, content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/webp': { schema: { type: 'string', format: 'binary' } }, 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } } : {}),
      ...(spec.body ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(spec.body) } } } } : {}),
      responses: {
        [success]:
          success === 204
            ? { description: 'No content' }
            : spec.responseContentType
              ? { description: 'Success', content: { [spec.responseContentType]: { schema: { type: 'string' } } } }
              : {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: spec.paginated ? ['data', 'page'] : ['data'],
                      properties: {
                        data: dataSchema ?? {},
                        ...(spec.paginated ? { page: { type: 'object', required: ['limit', 'next', 'hasMore'], properties: { limit: { type: 'integer' }, next: { type: ['string', 'null'] }, hasMore: { type: 'boolean' } } } } : {}),
                      },
                    },
                  },
                },
              },
        400: problemResponse('Validation failed or malformed request'),
        ...(isPublic ? {} : { 401: problemResponse('Authentication required'), 403: problemResponse('Permission denied') }),
        404: problemResponse('Not found (also returned for resources in another workspace)'),
        409: problemResponse('Conflict with current state'),
        ...(spec.ifMatch ? { 412: problemResponse('The record changed since your If-Match version') } : {}),
        429: problemResponse('Rate limited — see `Retry-After`'),
        500: problemResponse('Unexpected server error (quote `requestId` to support)'),
      },
      ...(perms.length ? { 'x-required-permissions': perms } : {}),
      ...(spec.idempotent ? { 'x-idempotent': true } : {}),
    };
    (paths[fullPath] ??= {})[spec.method] = op;
  }

  const webhooks: Json = {};
  for (const [type, meta] of Object.entries(EVENT_CATALOG)) {
    webhooks[type] = {
      post: {
        summary: type,
        description: `${meta.description}\n\nDelivered to your subscription endpoint with the headers described in "Webhooks" (signature \`Anibros-Signature: t=<unix>,v1=<hmac>\`). Requires the \`${meta.permission}\` permission on the subscription owner.`,
        tags: ['Webhook events'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEvent' } } } },
        responses: { 200: { description: 'Return any 2xx within 10 seconds to acknowledge. Other responses are retried with exponential backoff for up to 24 hours.' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Anibros CRM API',
      version: opts.version,
      summary: 'Multi-tenant real-estate CRM — REST API and webhooks',
      description: [
        '## Overview',
        'Every resource lives under `/api/v1`. Requests and responses are JSON. Successful responses wrap the payload as `{ "data": … }`; lists add `{ "page": { "limit", "next", "hasMore" } }`.',
        '',
        '## Authentication',
        '- **API key (server-to-server):** `Authorization: Bearer crm_live_<prefix>_<secret>`. Create keys in *Settings → API keys*. A key is scoped to one workspace and to the permissions you grant it; it can never exceed the role it was created with.',
        '- **Browser session:** HttpOnly cookie + `x-csrf-token` header on mutations (used by the web app).',
        '',
        '## Errors',
        'Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json` with a stable machine-readable `code`, a human `detail`, per-field `errors[]` for validation failures and a `requestId` you can quote to support.',
        '',
        '## Pagination',
        'Cursor (keyset) pagination: pass `limit` (1–200, default 50) and the opaque `cursor` from the previous `page.next`. Cursors are stable under concurrent inserts.',
        '',
        '## Idempotency',
        'Send `Idempotency-Key` on POST requests marked idempotent to make retries safe.',
        '',
        '## Rate limits',
        'Limits are enforced per API key / user and per IP. Responses carry `RateLimit-Limit` and `RateLimit-Remaining`; when exceeded you receive `429` with `Retry-After` (seconds).',
        '',
        '## Webhooks',
        'Subscribe to the events listed under *Webhook events* to receive signed HTTP callbacks. Verify `Anibros-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`, reject timestamps older than 5 minutes, and treat deliveries as at-least-once (use the event `id` to de-duplicate).',
      ].join('\n'),
      contact: { name: 'Anibros CRM API support' },
    },
    servers: [{ url: opts.serverUrl ?? '/', description: 'Current environment' }],
    tags: [...tags.keys()].map((name) => ({ name })).concat([{ name: 'Webhook events' }]),
    paths,
    webhooks,
    components: {
      securitySchemes: {
        bearerApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'crm_live_<prefix>_<secret>', description: 'Workspace API key' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'anibrosdesign_session', description: 'Browser session (web app). Mutations also need the CSRF header.' },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string', examples: ['VALIDATION_FAILED', 'NOT_FOUND', 'FORBIDDEN', 'RATE_LIMITED'] },
            requestId: { type: 'string' },
            errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' }, code: { type: 'string' } } } },
          },
        },
        WebhookEvent: {
          type: 'object',
          required: ['id', 'type', 'createdAt', 'tenantId', 'data'],
          properties: {
            id: { type: 'string', description: 'Unique event id — use to de-duplicate (delivery is at-least-once).' },
            type: { type: 'string', enum: Object.keys(EVENT_CATALOG) },
            createdAt: { type: 'string', format: 'date-time' },
            tenantId: { type: 'string', format: 'uuid' },
            data: { type: 'object', properties: { object: { type: 'string' }, id: { type: 'string', format: 'uuid' } }, additionalProperties: true },
          },
        },
        Role: { type: 'string', enum: [...ROLES] },
        Permission: { type: 'string', enum: Object.keys(MATRIX) },
      },
    },
  };
}
