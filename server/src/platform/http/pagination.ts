import { z } from 'zod';
import { Errors } from '../errors';

/**
 * Keyset (cursor) pagination.
 *
 * Offset pagination degrades linearly with depth and shows duplicates/gaps when rows are inserted while paging.
 * Keyset pagination is O(log n) per page and stable. The cursor is opaque to clients (base64url JSON) and bound to
 * the sort it was issued for, so a cursor can't be replayed against a different ordering.
 */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface Cursor {
  /** sort key value, serialised (ISO timestamp, number or string) */
  k: string | number | null;
  /** tiebreaker id */
  i: string;
  /** sort signature (guards against replaying a cursor on a different ordering) */
  s: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined, sortSignature: string): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c?.i !== 'string' || c.s !== sortSignature) throw new Error('bad cursor');
    return c;
  } catch {
    throw Errors.badRequest('Invalid pagination cursor');
  }
}

/**
 * Build a page from `limit + 1` fetched rows. `keyOf` returns the sort-key value of a row; rows must be fetched
 * with `ORDER BY <key> <dir>, id <dir>` and `LIMIT limit + 1`.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortSignature: string,
  keyOf: (row: T) => string | number | null
): { items: T[]; page: { limit: number; next: string | null; hasMore: boolean } } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    page: {
      limit,
      hasMore,
      next: hasMore && last ? encodeCursor({ k: keyOf(last), i: last.id, s: sortSignature }) : null,
    },
  };
}

/**
 * SQL fragment for "rows after the cursor" for a (key, id) ordering.
 * `keyExpr` and `idExpr` are trusted SQL fragments (never user input); values are bound parameters.
 *
 *   descending:  (key, id) < ($n, $n+1)      ascending: (key, id) > ($n, $n+1)
 *
 * Returns the fragment and pushes the parameters onto `params`.
 */
export function cursorPredicate(
  cursor: Cursor | undefined,
  params: unknown[],
  keyExpr: string,
  idExpr: string,
  direction: 'asc' | 'desc',
  keyCast = ''
): string | undefined {
  if (!cursor) return undefined;
  params.push(cursor.k, cursor.i);
  const a = params.length - 1;
  const b = params.length;
  const op = direction === 'desc' ? '<' : '>';
  return `(${keyExpr}, ${idExpr}) ${op} ($${a}${keyCast}, $${b}::uuid)`;
}
