import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../errors';

/**
 * Token-bucket rate limiter with pluggable store.
 *
 *  - Bucket = `capacity` tokens refilled at `refillPerSecond`. Allows bursts, enforces the long-run rate.
 *  - Keys are composed by the caller (ip, ip+email, tenant, api-key …): limits attach to the thing being protected.
 *  - In-memory store is exact for one process. With ≥ 2 API replicas swap in a Redis store implementing `RateStore`
 *    (INCR/EXPIRE or a Lua token bucket) — the interface is deliberately tiny. Documented in ARCHITECTURE_V2 §3.6.
 *  - Never bypassed in tests: tests construct limiters with explicit limits and an injected clock.
 */
export interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateStore {
  get(key: string): Bucket | undefined;
  set(key: string, bucket: Bucket): void;
  size(): number;
}

export class MemoryRateStore implements RateStore {
  private map = new Map<string, Bucket>();
  constructor(private maxKeys = 100_000) {}
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, bucket: Bucket) {
    if (this.map.size >= this.maxKeys && !this.map.has(key)) {
      // Bound memory: evict the oldest entry (Map preserves insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.delete(key);
    this.map.set(key, bucket);
  }
  size() {
    return this.map.size;
  }
}

export interface LimiterOptions {
  name: string;
  capacity: number;
  refillPerSecond: number;
  store?: RateStore;
  now?: () => number;
}

export interface Decision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

export class RateLimiter implements Limiter {
  private store: RateStore;
  private now: () => number;
  constructor(readonly opts: LimiterOptions) {
    this.store = opts.store ?? new MemoryRateStore();
    this.now = opts.now ?? Date.now;
  }

  /** Same as take(); async so it can be swapped for the shared limiter. */
  takeAsync(key: string, cost = 1): Promise<Decision> {
    return Promise.resolve(this.take(key, cost));
  }

  take(key: string, cost = 1): Decision {
    const { capacity, refillPerSecond } = this.opts;
    const t = this.now();
    const b = this.store.get(key) ?? { tokens: capacity, updatedAt: t };
    const elapsed = Math.max(0, (t - b.updatedAt) / 1000);
    const tokens = Math.min(capacity, b.tokens + elapsed * refillPerSecond);
    if (tokens >= cost) {
      this.store.set(key, { tokens: tokens - cost, updatedAt: t });
      return { allowed: true, remaining: Math.floor(tokens - cost), retryAfterSeconds: 0, limit: capacity };
    }
    this.store.set(key, { tokens, updatedAt: t });
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((cost - tokens) / refillPerSecond),
      limit: capacity,
    };
  }
}

/** Express middleware factory. `keyOf` decides what is being limited. */
export function rateLimit(limiter: RateLimiter, keyOf: (req: Request) => string, cost = 1) {
  return (req: Request, res: Response, next: NextFunction) => {
    const d = limiter.take(`${limiter.opts.name}:${keyOf(req)}`, cost);
    res.setHeader('RateLimit-Limit', String(d.limit));
    res.setHeader('RateLimit-Remaining', String(d.remaining));
    if (!d.allowed) {
      req.logger?.warn('Rate limit exceeded', { limiter: limiter.opts.name });
      return next(Errors.rateLimited(d.retryAfterSeconds));
    }
    next();
  };
}

export const clientIp = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown';

// ── shared limiter (several API processes) ───────────────────────────────────────────────────────────────────

/** What every caller needs from a limiter; the in-memory and the shared (Postgres) one both fit. */
export interface Limiter {
  readonly opts: { name: string; capacity: number; refillPerSecond: number };
  takeAsync(key: string, cost?: number): Promise<Decision>;
}

/**
 * The same token bucket, kept in one place all API processes can see: an UNLOGGED Postgres table updated by one atomic function
 * (`app.rate_take`), so ten processes behind a load balancer enforce ONE allowance instead of ten. The database clock is used, so the
 * processes cannot disagree about time. If the database cannot be reached the request is let through (and a warning logged): by then
 * nothing else would work either, and a limiter must never be the reason the whole service is down.
 */
export class PgRateLimiter implements Limiter {
  constructor(readonly opts: LimiterOptions, private db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) {}
  async takeAsync(key: string, cost = 1): Promise<Decision> {
    const { capacity, refillPerSecond } = this.opts;
    try {
      const { rows } = await this.db.query(`SELECT allowed, remaining, retry_after FROM app.rate_take($1, $2::float8, $3::float8, $4::float8)`, [key.slice(0, 200), capacity, refillPerSecond, cost]);
      const r = rows[0];
      return { allowed: Boolean(r.allowed), remaining: Number(r.remaining), retryAfterSeconds: Number(r.retry_after), limit: capacity };
    } catch {
      return { allowed: true, remaining: capacity, retryAfterSeconds: 0, limit: capacity };
    }
  }
}

/** Per-process buckets by default; shared ones when RATE_LIMIT_STORE=postgres and a database handle is given. */
export function makeLimiter(opts: LimiterOptions, db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } | undefined, shared: boolean): Limiter {
  return shared && db ? new PgRateLimiter(opts, db) : new RateLimiter(opts);
}
