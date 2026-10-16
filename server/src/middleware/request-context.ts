import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Logger } from '../logger';
import { recordEvent } from '../platform/observability/event-log';

const SLOW_MS = Number(process.env.SLOW_REQUEST_MS ?? 1500);

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      id: string;
      logger: Logger;
      /** Raw request body (Buffer) captured for signed-webhook verification on /hooks routes. */
      rawBody?: Buffer;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const SAFE_ID = /^[A-Za-z0-9._:-]{8,64}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Assigns a correlation id (client-supplied only if it is a safe token), response header and an access log line. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header('x-request-id');
  const reqId = supplied && SAFE_ID.test(supplied) ? supplied : crypto.randomUUID();
  req.id = reqId;
  req.logger = new Logger(reqId);
  res.setHeader('X-Request-Id', reqId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    // Full path with ids folded to :id (low-cardinality, readable). req.baseUrl is already reset when 'finish' fires, so build it from the URL.
    const route = req.originalUrl.split('?')[0].replace(UUID_RE, ':id');
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.logger[level](`${req.method} ${route} → ${res.statusCode} (${ms}ms)`, {
      method: req.method,
      path: route,
      status: res.statusCode,
      durationMs: ms,
      ip: req.ip,
      tenantId: req.actor?.tenantId,
      userId: req.actor?.userId,
      ua: req.get('user-agent')?.slice(0, 120),
    });

    // The curated, workspace-visible record (see platform/observability/event-log.ts). Only requests we can attribute to a workspace:
    // anonymous noise (logged-out page loads, scanners) stays on stdout, never in the database.
    const tenantId = req.actor?.tenantId;
    if (!tenantId) return;
    const ctx = { method: req.method, route, status: res.statusCode, durationMs: ms, ip: req.ip };
    const base = { tenantId, userId: req.actor?.userId, correlationId: reqId };
    if (res.statusCode >= 500) recordEvent({ ...base, component: 'api', severity: 'error', throttleKey: `5xx:${route}`, message: `Server error on ${req.method} ${route} (${res.statusCode})`, context: ctx });
    else if (res.statusCode === 403 || res.statusCode === 429) recordEvent({ ...base, component: 'security', severity: 'warn', throttleKey: `${res.statusCode}:${req.actor?.userId}:${route}`, message: `${res.statusCode === 403 ? 'Permission denied' : 'Rate limited'}: ${req.method} ${route}`, context: ctx });
    else if (ms >= SLOW_MS) recordEvent({ ...base, component: 'api', severity: 'warn', throttleKey: `slow:${route}`, message: `Slow request: ${req.method} ${route} took ${ms} ms`, context: ctx });
  });
  next();
}
