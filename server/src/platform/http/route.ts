import crypto from 'crypto';
import express, { type Request, type Response, type Router, type RequestHandler, type NextFunction } from 'express';
import { z, type ZodType } from 'zod';
import { Errors, type FieldIssue } from '../errors';
import { assertCan, type Actor } from '../authz/actor';
import type { Permission } from '../authz/matrix';

/**
 * Declarative routes.
 *
 * A route is DATA: method, path, auth requirement, permission, input schemas, output schema, handler.
 * `mountRoutes` turns that into an Express handler chain (authenticate → authorize → validate → handler → envelope)
 * and registers it in `routeRegistry`, which the OpenAPI generator reads. One declaration ⇒ behaviour + docs.
 */

export interface PageInfo {
  limit: number;
  next: string | null;
  hasMore: boolean;
}

/** Return a Reply from a handler to control status, headers or pagination metadata. */
export class Reply<T = unknown> {
  constructor(
    readonly data: T,
    readonly status?: number,
    readonly page?: PageInfo,
    readonly headers?: Record<string, string>
  ) {}
}
/** Non-JSON response (CSV export, files). Bypasses the `{ data }` envelope. */
export class RawReply {
  constructor(
    readonly body: string | Buffer,
    readonly contentType: string,
    readonly headers: Record<string, string> = {},
    readonly status = 200
  ) {}
}
/**
 * Entity tags. The ETag is the record's version (what `If-Match` compares) — but some records also show DERIVED data that
 * does not bump the version (a lead's score, last activity and follow-up date follow its tasks and timeline). Those values
 * are folded into the tag as a short fingerprint, so a client revalidating with `If-None-Match` can never be told
 * "304 Not Modified" about a representation that changed.   "7"  →  "7.3fa91c0e"
 */
export function makeEtag(version: number, ...derived: unknown[]): { ETag: string } {
  if (!derived.length) return { ETag: `"${version}"` };
  const fp = crypto.createHash('sha256').update(JSON.stringify(derived)).digest('hex').slice(0, 8);
  return { ETag: `"${version}.${fp}"` };
}

/** `If-Match` → the record version it names (ignoring the fingerprint, which only exists for cache validation). */
export function ifMatchVersion(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const m = /^(?:W\/)?"?(\d{1,15})(?:\.[0-9a-f]{8})?"?$/.exec(header.trim());
  if (!m) throw Errors.badRequest('If-Match must be the ETag of the record, e.g. "3"');
  return Number(m[1]);
}

export const created = <T>(data: T, headers?: Record<string, string>) => new Reply(data, 201, undefined, headers);
export const noContent = () => new Reply<undefined>(undefined, 204);
export const paged = <T>(items: T[], page: PageInfo) => new Reply(items, 200, page);

export interface HandlerArgs<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  /** Present for authenticated routes; routes with auth:'public' never receive one. */
  actor: Actor;
  req: Request;
  res: Response;
}

export type AuthMode = 'session' | 'public';

export interface RouteSpec<P = any, Q = any, B = any, R = any> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Path relative to the module mount point, Express syntax (`/:id`). */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth?: AuthMode;
  /** All listed permissions are required. */
  permission?: Permission | Permission[];
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  response?: ZodType<R>;
  successStatus?: number;
  /** Documentation: the handler returns `paged(items, page)`; `response` describes ONE item. */
  paginated?: boolean;
  /** Documentation: the route honours `If-Match` (optimistic concurrency) and may answer 412. */
  ifMatch?: boolean;
  /** Honour the Idempotency-Key header (non-idempotent POSTs on the public API). */
  idempotent?: boolean;
  /** Hide from the public OpenAPI document (internal/UI-only endpoints). */
  internal?: boolean;
  /** Larger JSON body for this route (e.g. '6mb'), parsed AFTER authentication so anonymous clients cannot make us buffer it. */
  bodyLimit?: string;
  /** Binary upload (image/PDF): the body arrives as a Buffer in `req.body`, buffered only AFTER authentication and capped at this size. */
  rawBody?: { limit: string; description: string };
  /** Documentation: the success response is not JSON (e.g. `text/csv`). */
  responseContentType?: string;
  handler: (args: HandlerArgs<P, Q, B>) => Promise<R | Reply<R> | Reply<R[]> | RawReply>;
}

export interface RegisteredRoute {
  spec: RouteSpec;
  /** Full path including module prefix, in OpenAPI `{id}` form. */
  fullPath: string;
  expressPath: string;
}
export const routeRegistry: RegisteredRoute[] = [];

export function defineRoute<P = unknown, Q = unknown, B = unknown, R = unknown>(spec: RouteSpec<P, Q, B, R>): RouteSpec<P, Q, B, R> {
  return spec;
}

export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
    code: i.code,
  }));
}

/** PostgreSQL cannot store NUL in text; left alone it surfaces as a 500 from deep inside a query. Refuse it at the edge as a 400. */
function findNul(value: unknown, path: string, depth = 0): string | null {
  if (typeof value === 'string') return value.includes('\u0000') ? path : null;
  if (value === null || typeof value !== 'object' || depth > 12) return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.includes('\u0000')) return `${path}.${k.split('\u0000').join('')}`;
    const hit = findNul(v, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function parseOrThrow<T>(schema: ZodType<T> | undefined, value: unknown, where: string): T {
  const nul = findNul(value, where);
  if (nul) throw Errors.validation([{ path: nul, message: 'must not contain NUL characters', code: 'invalid_string' }], `Invalid ${where}`);
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) {
    throw Errors.validation(
      zodIssues(r.error).map((i) => ({ ...i, path: `${where}.${i.path}` })),
      `Invalid ${where}`
    );
  }
  return r.data;
}

export type Authenticator = RequestHandler;
export type Idempotency = (spec: RouteSpec) => RequestHandler;

export interface MountOptions {
  authenticate: Authenticator;
  idempotency?: Idempotency;
}

function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function mountRoutes(router: Router, basePath: string, routes: RouteSpec[], opts: MountOptions): void {
  for (const spec of routes) {
    const expressPath = spec.path === '/' ? '/' : spec.path;
    const chain: RequestHandler[] = [];

    if ((spec.auth ?? 'session') === 'session') chain.push(opts.authenticate);
    if (spec.bodyLimit) chain.push(express.json({ limit: spec.bodyLimit }));
    if (spec.rawBody) chain.push(express.raw({ type: () => true, limit: spec.rawBody.limit }));
    if (spec.idempotent && opts.idempotency) chain.push(opts.idempotency(spec));

    chain.push(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = (req as any).actor as Actor | undefined;
        if ((spec.auth ?? 'session') === 'session') {
          if (!actor) throw Errors.unauthenticated();
          for (const p of ([] as Permission[]).concat(spec.permission ?? [])) assertCan(actor, p);
        }
        const params = parseOrThrow(spec.params, req.params, 'path');
        const query = parseOrThrow(spec.query, req.query, 'query');
        const body = parseOrThrow(spec.body, spec.method === 'get' || spec.method === 'delete' ? undefined : req.body ?? {}, 'body');

        const out = await spec.handler({ params, query, body, actor: actor as Actor, req, res });
        if (out instanceof RawReply) {
          for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
          res.status(out.status).type(out.contentType).send(out.body);
          return;
        }
        const reply = out instanceof Reply ? out : new Reply(out as any);
        const status = reply.status ?? spec.successStatus ?? (spec.method === 'post' ? 201 : 200);

        if (reply.headers) for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
        if (status === 204 || reply.data === undefined) {
          res.status(status === 200 ? 204 : status).end();
          return;
        }
        res.status(status).json(reply.page ? { data: reply.data, page: reply.page } : { data: reply.data });
      } catch (err) {
        next(err);
      }
    });

    (router as any)[spec.method](expressPath, ...chain);
    const fullPath = toOpenApiPath(`${basePath}${spec.path === '/' ? '' : spec.path}`);
    // Replace, don't duplicate, when the same app is constructed more than once (tests, tooling).
    const existing = routeRegistry.findIndex((r) => r.fullPath === fullPath && r.spec.method === spec.method);
    const entry = { spec, fullPath, expressPath };
    if (existing >= 0) routeRegistry[existing] = entry;
    else routeRegistry.push(entry);
  }
}
