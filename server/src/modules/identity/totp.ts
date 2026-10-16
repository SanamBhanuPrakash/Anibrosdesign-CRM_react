import crypto from 'crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) on Node crypto — no third-party dependency to audit.
 * Replay protection: the caller stores the last accepted time-step and passes it back; a code for a step ≤ that is refused.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, RFC 4226 recommended
}

export function otpauthUri(accountName: string, secret: string, issuer = 'Anibros CRM'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export const timeStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / 30);

/** Returns the accepted time-step, or null. Accepts ±`window` steps to tolerate clock drift. */
export function verifyTotp(secretBase32: string, code: string, opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = timeStep(opts.nowMs);
  const window = opts.window ?? 1;
  let accepted: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    // evaluate every candidate (no early exit) so timing doesn't reveal which step matched
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code));
    if (ok && (opts.lastUsedStep == null || step > opts.lastUsedStep)) accepted = step;
  }
  return accepted;
}

export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const normalizeRecoveryCode = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();
