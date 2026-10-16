import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AppError, Errors, fromUnknown, toProblem } from '../platform/errors';
import { RateLimiter, MemoryRateStore } from '../platform/http/rate-limit';
import { buildPage, decodeCursor, encodeCursor, cursorPredicate } from '../platform/http/pagination';
import { zodIssues } from '../platform/http/route';
import { redactSensitiveData } from '../logger';

describe('error taxonomy & Postgres mapping', () => {
  const pg = (code: string, extra: object = {}) => Object.assign(new Error('db'), { code, ...extra });

  it.each([
    ['23505', 409, 'CONFLICT'],
    ['23503', 409, 'CONFLICT'],
    ['23502', 422, 'UNPROCESSABLE'],
    ['23514', 422, 'UNPROCESSABLE'],
    ['22P02', 400, 'BAD_REQUEST'],
    ['42501', 403, 'FORBIDDEN'], // RLS violation never becomes a 500
    ['40001', 409, 'CONFLICT'],
    ['40P01', 409, 'CONFLICT'],
    ['55P03', 503, 'SERVICE_BUSY'],
    ['57014', 503, 'DEPENDENCY_UNAVAILABLE'],
    ['53300', 503, 'SERVICE_BUSY'],
  ])('pg %s → HTTP %i %s', (code, status, appCode) => {
    const e = fromUnknown(pg(code))!;
    expect(e).toBeInstanceOf(AppError);
    expect(e.status).toBe(status);
    expect(e.code).toBe(appCode);
  });

  it('maps our SQL RAISE EXCEPTION prefixes to domain errors', () => {
    expect(fromUnknown(pg('P0001', { message: 'ILLEGAL_TRANSITION: from new to won is not allowed' }))).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    expect(fromUnknown(pg('P0001', { message: 'SLOT_OCCUPIED: overlapping' }))).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
    expect(fromUnknown(pg('P0001', { message: 'NOT_FOUND: Lead not found in active tenant' }))).toMatchObject({ status: 404 });
    expect(fromUnknown(pg('P0001', { message: 'FORBIDDEN: tenant context mismatch' }))).toMatchObject({ status: 403 });
  });

  it('pool saturation becomes 503 with Retry-After (load shedding), not a hung request', () => {
    const e = fromUnknown(new Error('timeout exceeded when trying to connect'))!;
    expect(e.status).toBe(503);
    expect(e.headers?.['Retry-After']).toBeDefined();
  });

  it('unknown errors are NOT mapped (they must be logged as defects and shown as opaque 500)', () => {
    expect(fromUnknown(new Error('segfault-ish'))).toBeUndefined();
    expect(fromUnknown(pg('XX000'))).toBeUndefined();
    expect(fromUnknown('string')).toBeUndefined();
  });

  it('problem document follows RFC 9457 and never leaks internals', () => {
    const p = toProblem(Errors.notFound('Lead'), 'req-1');
    expect(p).toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'req-1', title: 'Not found' });
    expect(p.type).toMatch(/^https:\/\/docs\.anibros\.app\/errors\/not-found$/);
    const internal = toProblem(Errors.internal(), 'r');
    expect(JSON.stringify(internal)).not.toMatch(/stack|select|password/i);
  });

  it('zod issues become field-level validation errors', () => {
    const r = z.object({ email: z.string().email(), n: z.number().min(1) }).safeParse({ email: 'nope', n: 0 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issues = zodIssues(r.error);
      expect(issues.map((i) => i.path).sort()).toEqual(['email', 'n']);
      const e = Errors.validation(issues);
      expect(e.status).toBe(400);
      expect(e.errors).toHaveLength(2);
    }
  });
});

describe('token-bucket rate limiter', () => {
  const make = (capacity: number, refillPerSecond: number) => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ name: 't', capacity, refillPerSecond, now: () => now });
    return { limiter, advance: (ms: number) => (now += ms) };
  };

  it('allows a burst up to capacity, then blocks with an accurate Retry-After', () => {
    const { limiter } = make(3, 1);
    expect([1, 2, 3].map(() => limiter.take('k').allowed)).toEqual([true, true, true]);
    const blocked = limiter.take('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it('refills over time but never beyond capacity', () => {
    const { limiter, advance } = make(2, 1);
    limiter.take('k'); limiter.take('k');
    expect(limiter.take('k').allowed).toBe(false);
    advance(1000);
    expect(limiter.take('k').allowed).toBe(true);
    advance(60_000);
    expect(limiter.take('k').remaining).toBe(1); // capped at capacity-1, not 59
  });

  it('keys are independent (one abuser does not throttle others)', () => {
    const { limiter } = make(1, 0.01);
    expect(limiter.take('ip:1.1.1.1').allowed).toBe(true);
    expect(limiter.take('ip:1.1.1.1').allowed).toBe(false);
    expect(limiter.take('ip:2.2.2.2').allowed).toBe(true);
  });

  it('memory store is bounded (cannot be exhausted by key flooding)', () => {
    const store = new MemoryRateStore(100);
    const l = new RateLimiter({ name: 'x', capacity: 1, refillPerSecond: 1, store });
    for (let i = 0; i < 1000; i++) l.take(`k${i}`);
    expect(store.size()).toBeLessThanOrEqual(100);
  });
});

describe('keyset pagination', () => {
  const sig = 'created_at:desc';
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`, created: `2026-01-0${6 - i}` }));

  it('returns limit rows + a cursor when more exist, and none on the last page', () => {
    const p1 = buildPage(rows, 5, sig, (r) => r.created);
    expect(p1.items).toHaveLength(5);
    expect(p1.page.hasMore).toBe(true);
    expect(p1.page.next).toBeTruthy();
    const p2 = buildPage(rows.slice(0, 5), 5, sig, (r) => r.created);
    expect(p2.page).toEqual({ limit: 5, hasMore: false, next: null });
  });

  it('cursor round-trips and is bound to its sort order', () => {
    const c = encodeCursor({ k: '2026-01-02', i: 'id-4', s: sig });
    expect(decodeCursor(c, sig)).toMatchObject({ k: '2026-01-02', i: 'id-4' });
    expect(() => decodeCursor(c, 'name:asc')).toThrowError(/cursor/i);
    expect(() => decodeCursor('%%%not-base64%%%', sig)).toThrowError(/cursor/i);
    expect(decodeCursor(undefined, sig)).toBeUndefined();
  });

  it('predicate binds values as parameters (no interpolation of cursor data)', () => {
    const params: unknown[] = ['tenant'];
    const sql = cursorPredicate({ k: "2026-01-02'; DROP TABLE x;--", i: 'abc', s: sig }, params, 'l.created_at', 'l.id', 'desc', '::timestamptz');
    expect(sql).toBe('(l.created_at, l.id) < ($2::timestamptz, $3::uuid)');
    expect(sql).not.toContain('DROP');
    expect(params[1]).toContain('DROP'); // only ever a bound parameter
  });
});

describe('log redaction', () => {
  it('redacts secrets by key fragment at any depth, case-insensitively', () => {
    const out = redactSensitiveData({
      user: 'a',
      Password: 'p',
      headers: { Authorization: 'Bearer x', 'x-api-key': 'k', cookie: 'c', Accept: 'ok' },
      nested: { deep: { refreshToken: 't', webhook_secret: 's', ok: 1 } },
      list: [{ apiKey: 'k' }],
    });
    const s = JSON.stringify(out);
    for (const secret of ['"p"', 'Bearer x', '"k"', '"c"', '"t"', '"s"']) expect(s).not.toContain(secret);
    expect(out.user).toBe('a');
    expect(out.headers.Accept).toBe('ok');
    expect(out.nested.deep.ok).toBe(1);
  });

  it('survives cycles-depth and truncates huge strings', () => {
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) cur = cur.next = {};
    expect(() => redactSensitiveData(deep)).not.toThrow();
    expect(redactSensitiveData('x'.repeat(5000)).length).toBeLessThan(2100);
  });
});

describe('field encryption (AES-256-GCM)', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  async function load(keys: string) {
    vi.resetModules();
    process.env.FIELD_ENCRYPTION_KEYS = keys;
    return import('../platform/crypto/field-encryption');
  }

  it('round-trips and produces a different ciphertext every time (random IV)', async () => {
    const { encryptField, decryptField } = await load(`k1:${KEY_A}`);
    const t1 = encryptField('meta-token-123', 'tenant-1:meta');
    const t2 = encryptField('meta-token-123', 'tenant-1:meta');
    expect(t1).not.toBe(t2);
    expect(t1).not.toContain('meta-token-123');
    expect(decryptField(t1, 'tenant-1:meta')).toBe('meta-token-123');
  });

  it('is bound to its context: a ciphertext moved to another tenant/field fails authentication', async () => {
    const { encryptField, decryptField } = await load(`k1:${KEY_A}`);
    const t = encryptField('secret', 'tenant-1:meta');
    expect(() => decryptField(t, 'tenant-2:meta')).toThrowError(/authentication/);
    expect(() => decryptField(t, 'tenant-1:google')).toThrowError(/authentication/);
  });

  it('detects tampering', async () => {
    const { encryptField, decryptField } = await load(`k1:${KEY_A}`);
    const parts = encryptField('secret', 'ctx').split('.');
    parts[4] = Buffer.from('tampered-ciphertext').toString('base64url');
    expect(() => decryptField(parts.join('.'), 'ctx')).toThrowError(/authentication/);
    expect(() => decryptField('garbage', 'ctx')).toThrowError(/Malformed/);
  });

  it('supports key rotation: old tokens still decrypt, new tokens use the active key, needsRotation flags old ones', async () => {
    const before = await load(`k1:${KEY_A}`);
    const old = before.encryptField('rotate-me', 'ctx');
    const after = await load(`k2:${KEY_B},k1:${KEY_A}`);
    expect(after.decryptField(old, 'ctx')).toBe('rotate-me');
    expect(after.needsRotation(old)).toBe(true);
    const fresh = after.encryptField('rotate-me', 'ctx');
    expect(fresh.split('.')[1]).toBe('k2');
    expect(after.needsRotation(fresh)).toBe(false);
    const retired = await load(`k2:${KEY_B}`); // k1 removed
    expect(() => retired.decryptField(old, 'ctx')).toThrowError(/Unknown encryption key/);
  });

  it('safeEqual is constant-time-safe for different lengths', async () => {
    const { safeEqual } = await load(`k1:${KEY_A}`);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
