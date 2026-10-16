import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Identity keys for deduplication. Two records are "the same person" when they share a normalised key, so the
 * normalisation must be strict enough to avoid false merges and tolerant enough to catch real duplicates:
 *   +91 98765-43210, 098765 43210 and 9876543210 (default country IN) are all  +919876543210.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v.length > 254 || !EMAIL_RE.test(v)) return null;
  return v;
}

export function normalizePhone(raw: string | null | undefined, defaultCountry: string = 'IN'): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const parsed = parsePhoneNumberFromString(v, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number; // E.164
}

/** Tags: trimmed, lower-case, de-duplicated, bounded. Order of first appearance is kept. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Escape `%`, `_` and `\` so user text is matched literally by LIKE/ILIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
