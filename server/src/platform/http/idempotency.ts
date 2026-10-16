import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Database } from '../db';
import { Errors } from '../errors';
import type { Idempotency } from './route';

/**
 * Idempotency-Key support for non-idempotent POSTs (public API).
 *
 *  - First request with a key: reserves it (INSERT … ON CONFLICT DO NOTHING), runs the handler, stores the response.
 *  - Retry with the same key + same payload: replays the stored response (`Idempotent-Replay: true`), handler NOT re-run.
 *  - Same key, different payload/actor/route: 422 — the client has a bug and must be told.
 *  - Retry while the first is still running: 409 + Retry-After.
 *  - 5xx responses are not stored (the client may safely retry for real).
 * Keys are scoped per tenant, expire after 24 h (worker retention job), and bound to actor + method + path + body hash.
 */
const LOCK_SECONDS = 60;

export function createIdempotency(db: Database): Idempotency {
  return () => async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key) return next();
    try {
      if (key.length < 8 || key.length > 128 || !/^[\x21-\x7E]+$/.test(key)) {
        throw Errors.badRequest('Idempotency-Key must be 8–128 printable ASCII characters');
      }
      const actor = req.actor;
      if (!actor) throw Errors.unauthenticated();

      const hash = crypto
        .createHash('sha256')
        .update([req.method, req.baseUrl + req.path, actor.userId ?? actor.apiKeyId ?? '', JSON.stringify(req.body ?? {})].join('\n'))
        .digest('hex');

      const reserved = await db.withTenant(actor, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO idempotency_keys (key, request_hash, locked_until)
           VALUES ($1, $2, now() + make_interval(secs => $3::int))
           ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
          [key, hash, LOCK_SECONDS]
        );
        if (ins.rowCount) return { fresh: true as const };
        const row = (
          await tx.query(`SELECT request_hash, status_code, response_body, locked_until > now() AS locked FROM idempotency_keys WHERE key = $1`, [key])
        ).rows[0];
        // A crashed first attempt leaves a lock that expires; allow takeover then.
        if (row && row.status_code === null && !row.locked) {
          await tx.query(`UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => $2::int), request_hash = $3 WHERE key = $1`, [key, LOCK_SECONDS, hash]);
          return { fresh: true as const };
        }
        return { fresh: false as const, row };
      });

      if (!reserved.fresh) {
        const row = reserved.row;
        if (row.request_hash !== hash) throw Errors.idempotencyConflict();
        if (row.status_code === null) {
          throw Object.assign(Errors.conflict('A request with this Idempotency-Key is still being processed'), {
            headers: { 'Retry-After': '2' },
          });
        }
        res.setHeader('Idempotent-Replay', 'true');
        res.status(row.status_code).json(row.response_body);
        return;
      }

      // Capture the response so it can be replayed.
      let captured: unknown;
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        captured = body;
        return originalJson(body);
      };
      res.on('finish', () => {
        const status = res.statusCode;
        const persist =
          status >= 500
            ? db.withTenant(actor, (tx) => tx.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]))
            : db.withTenant(actor, (tx) =>
                tx.query(`UPDATE idempotency_keys SET status_code = $2, response_body = $3::jsonb, locked_until = NULL WHERE key = $1`, [
                  key,
                  status,
                  JSON.stringify(captured ?? null),
                ])
              );
        persist.catch((e) => req.logger?.warn('Failed to persist idempotent response', { error: e.message }));
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
