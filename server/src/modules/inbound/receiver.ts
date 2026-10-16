import express, { Router, type Request, type Response } from 'express';
import type { Database } from '../../platform/db';
import { makeLimiter, clientIp, type Limiter } from '../../platform/http/rate-limit';
import { config } from '../../platform/config';
import { safeEqual } from '../../platform/crypto/field-encryption';
import { authDenied } from '../../platform/observability/metrics';
import { recordEvent } from '../../platform/observability/event-log';
import { hookUrl, readSecret } from './service';
import { captureScript } from './capture-script';
import {
  BadPayload, extractEvents, honeypotTripped, parseBody, verifyGenericSignature, verifyGoogleKey, verifyMetaSignature,
  type EndpointConfig, type InboundProvider,
} from './providers';

/**
 * Public inbound receiver: POST /hooks/:endpointId (and GET for Meta's one-time verification handshake).
 *
 * Order of operations is deliberate:
 *   1  cheap checks first: id shape, per-IP and per-endpoint rate limits (before any database work)
 *   2  endpoint lookup through a narrow SECURITY DEFINER function; unknown/deleted/suspended → the same 404
 *   3  prove the sender over the RAW bytes (HMAC / key / signed timestamp); failure → 401, logged, never stored
 *   4  parse → extract events → durable receipt + job in ONE database call
 *   5  only then answer 200. A crash before step 4 means the provider retries; after it, nothing can be lost.
 * The tenant is whatever the endpoint row says. Nothing in the payload can select a tenant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = '256kb';

export interface HookLimits {
  perIp: Limiter;
  perEndpoint: Limiter;
  /** Browser form posts are limited much harder per IP than server-to-server providers. */
  websitePerIp: Limiter;
}
export const defaultHookLimits = (db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): HookLimits => {
  const shared = config.RATE_LIMIT_STORE === 'postgres';
  return {
    perIp: makeLimiter({ name: 'hook-ip', capacity: 120, refillPerSecond: 20 }, db, shared),
    perEndpoint: makeLimiter({ name: 'hook-ep', capacity: 600, refillPerSecond: 100 }, db, shared),
    websitePerIp: makeLimiter({ name: 'hook-web-ip', capacity: 8, refillPerSecond: 0.2 }, db, shared),
  };
};

interface Endpoint { id: string; tenant_id: string; provider: InboundProvider; status: string; secret_enc: string | null; verify_token: string | null; config: EndpointConfig }

const reject = (res: Response, status: number, code: string, message: string, headers: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).type('application/json').json({ status: 'error', code, message });
};

function corsFor(req: Request, res: Response, cfg: EndpointConfig): boolean {
  const origin = req.get('origin');
  const allowed = (cfg.allowedOrigins ?? []).map((o) => o.replace(/\/$/, ''));
  if (origin) {
    if (allowed.length && !allowed.includes(origin.replace(/\/$/, ''))) return false;
    res.setHeader('Access-Control-Allow-Origin', allowed.length ? origin : '*');
    res.setHeader('Vary', 'Origin');
  }
  return true;
}

export function createHookRouter(db: Database, limits: HookLimits = defaultHookLimits(db)): Router {
  const router = Router();

  const lookup = async (id: string): Promise<Endpoint | undefined> => (await db.query<Endpoint>('SELECT * FROM app.inbound_endpoint_lookup($1)', [id])).rows[0];

  // Meta's subscription handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
  router.get('/:endpointId', async (req, res) => {
    const endpointId = String(req.params.endpointId);
    if (!UUID.test(endpointId)) return reject(res, 404, 'NOT_FOUND', 'Not found');
    const ip = await limits.perIp.takeAsync(`ip:${clientIp(req)}`);
    if (!ip.allowed) return reject(res, 429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': String(ip.retryAfterSeconds) });
    const ep = await lookup(endpointId);
    const token = typeof req.query['hub.verify_token'] === 'string' ? (req.query['hub.verify_token'] as string) : '';
    const challenge = typeof req.query['hub.challenge'] === 'string' ? (req.query['hub.challenge'] as string) : '';
    if (!ep || ep.provider !== 'meta' || req.query['hub.mode'] !== 'subscribe' || !ep.verify_token || !token || !safeEqual(token, ep.verify_token) || !/^[\w-]{1,200}$/.test(challenge)) {
      authDenied.inc({ reason: 'hook_verify' });
      req.logger?.warn('Inbound verification refused', { endpointId, found: Boolean(ep) });
      return reject(res, 403, 'FORBIDDEN', 'Verification failed');
    }
    res.type('text/plain').send(challenge);
  });

  // The one-line website script: finds the enquiry forms on a page, whatever their fields, and sends each submission here.
  router.get('/:endpointId/capture.js', async (req, res) => {
    const endpointId = String(req.params.endpointId);
    if (!UUID.test(endpointId)) return reject(res, 404, 'NOT_FOUND', 'Not found');
    const ip = await limits.perIp.takeAsync(`ip:${clientIp(req)}`);
    if (!ip.allowed) return reject(res, 429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': String(ip.retryAfterSeconds) });
    const ep = await lookup(endpointId);
    if (!ep || ep.provider !== 'website') return reject(res, 404, 'NOT_FOUND', 'Not found');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('application/javascript').send(captureScript(hookUrl(endpointId)));
  });

  router.options('/:endpointId', async (req, res) => {
    const endpointId = String(req.params.endpointId);
    const ep = UUID.test(endpointId) ? await lookup(endpointId) : undefined;
    if (!ep || ep.provider !== 'website' || !corsFor(req, res, ep.config)) return void res.status(204).end();
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  router.post('/:endpointId', express.raw({ type: () => true, limit: MAX_BODY }), async (req: Request, res: Response) => {
    const endpointId = String(req.params.endpointId);
    if (!UUID.test(endpointId)) return reject(res, 404, 'NOT_FOUND', 'Not found');
    const ip = await limits.perIp.takeAsync(`ip:${clientIp(req)}`);
    if (!ip.allowed) return reject(res, 429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': String(ip.retryAfterSeconds) });
    const ep = await limits.perEndpoint.takeAsync(`ep:${endpointId}`);
    if (!ep.allowed) return reject(res, 429, 'RATE_LIMITED', 'Too many requests for this source', { 'Retry-After': String(ep.retryAfterSeconds) });

    const endpoint = await lookup(endpointId);
    if (!endpoint) return reject(res, 404, 'NOT_FOUND', 'Not found');
    const provider = endpoint.provider;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const log = (level: 'info' | 'warn', msg: string, extra: Record<string, unknown> = {}) => req.logger?.[level](msg, { endpointId, tenantId: endpoint.tenant_id, provider, bytes: raw.length, ...extra });

    if (endpoint.status !== 'active') {
      log('warn', 'Inbound delivery to a paused source');
      return reject(res, 503, 'PAUSED', 'This source is paused', { 'Retry-After': '3600' });
    }

    try {
      // Browser forms: origin allow-list + a much stricter per-IP limit; they carry no signature by design.
      if (provider === 'website') {
        const web = await limits.websitePerIp.takeAsync(`web:${endpointId}:${clientIp(req)}`);
        if (!web.allowed) return reject(res, 429, 'RATE_LIMITED', 'Too many submissions. Please try again shortly.', { 'Retry-After': String(web.retryAfterSeconds) });
        if (!corsFor(req, res, endpoint.config)) {
          authDenied.inc({ reason: 'hook_origin' });
          recordEvent({ tenantId: endpoint.tenant_id, component: 'security', severity: 'warn', throttleKey: `origin:${endpointId}`, message: 'A website that is not on the allowed list tried to send a lead', context: { endpointId, provider, origin: req.get('origin') }, correlationId: req.id });
          log('warn', 'Inbound website form from a disallowed origin', { origin: req.get('origin') });
          return reject(res, 403, 'FORBIDDEN', 'This website is not allowed to post to this form');
        }
      } else {
        const secret = readSecret(endpoint.id, endpoint.secret_enc);
        let ok = false;
        if (secret) {
          if (provider === 'meta') ok = verifyMetaSignature(raw, req.get('x-hub-signature-256'), secret);
          else if (provider === 'generic') {
            // Signed (for developers) or a plain key (for chatbots and no-code tools that cannot sign): Authorization: Bearer, X-Anibros-Key or ?key=
            ok = verifyGenericSignature(raw, req.get('x-anibros-signature'), secret);
            if (!ok) {
              const bearer = /^Bearer\s+(\S{8,300})$/i.exec(req.get('authorization') ?? '')?.[1];
              const q = typeof req.query.key === 'string' ? req.query.key : '';
              const presented = bearer ?? req.get('x-anibros-key') ?? q;
              ok = presented.length >= 8 && presented.length <= 300 && safeEqual(presented, secret);
            }
          }
          else if (provider === 'google') {
            // Google puts the key in the JSON body; parse only to compare, store nothing from an unauthenticated body.
            try { ok = verifyGoogleKey(parseBody(raw, req.get('content-type')), secret); } catch { ok = false; }
          }
        }
        if (!ok) {
          authDenied.inc({ reason: 'hook_signature' });
          recordEvent({ tenantId: endpoint.tenant_id, component: 'security', severity: 'warn', throttleKey: `sig:${endpointId}`, message: `A ${provider} delivery failed its signature check and was refused`, context: { endpointId, provider, ip: req.ip }, correlationId: req.id });
          log('warn', 'Inbound signature rejected');
          return reject(res, 401, 'UNAUTHENTICATED', 'Signature check failed');
        }
      }

      const body = parseBody(raw, req.get('content-type'));
      if (provider === 'website' && honeypotTripped(body)) {
        // Looks like success to the bot; nothing is stored.
        log('info', 'Inbound website form dropped (honeypot)');
        return void res.status(200).json({ status: 'received', accepted: 1 });
      }
      const events = extractEvents(provider, body, raw, req.headers);
      let accepted = 0;
      if (events.length) {
        accepted = (await db.query<{ n: number }>('SELECT app.inbound_receive($1, $2::jsonb) AS n', [endpoint.id, JSON.stringify(events)])).rows[0]?.n ?? 0;
      }
      log('info', 'Inbound delivery received', { events: events.length, newEvents: accepted });
      res.status(200).json({ status: 'received', accepted: events.length });
    } catch (e: any) {
      if (e instanceof BadPayload) {
        log('warn', 'Inbound payload rejected', { reason: e.message });
        return reject(res, 400, 'BAD_REQUEST', e.message);
      }
      if (/NOT_FOUND: endpoint/.test(e?.message ?? '')) return reject(res, 404, 'NOT_FOUND', 'Not found');
      req.logger?.error('Inbound receipt failed', { endpointId, error: e?.message });
      // 5xx tells the provider to retry later — the delivery was NOT stored, so nothing is lost by asking again.
      return reject(res, 503, 'UNAVAILABLE', 'Temporarily unavailable', { 'Retry-After': '30' });
    }
  });

  return router;
}
