import crypto from 'crypto';
import { config } from '../config';

/**
 * Field-level encryption for secrets stored in the database (integration tokens, webhook secrets, MFA seeds).
 *
 *   AES-256-GCM, random 96-bit IV per message, 128-bit auth tag.
 *   Token format:  v1.<keyId>.<iv>.<tag>.<ciphertext>   (base64url segments)
 *   AAD (additional authenticated data) binds a ciphertext to its context (e.g. `${tenantId}:integration:meta`), so a
 *   value copied to another row/tenant fails authentication instead of decrypting.
 *   Key rotation: FIELD_ENCRYPTION_KEYS="k2:<hex>,k1:<hex>" — first key encrypts, all keys decrypt; `needsRotation`
 *   tells a background job which rows to re-encrypt.
 *
 * Keys live in the environment / secret manager, NEVER in the same database as the ciphertext.
 */
const keys = config.encryptionKeys;
const active = keys[0];

const b64 = (b: Buffer) => b.toString('base64url');

export function encryptField(plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', active.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', active.id, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
}

export function decryptField(token: string, aad: string): string {
  const [version, keyId, iv, tag, ct] = token.split('.');
  if (version !== 'v1' || !keyId || !iv || !tag || !ct) throw new Error('Malformed encrypted field');
  const key = keys.find((k) => k.id === keyId);
  if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong AAD or tampering — deliberately indistinguishable.
    throw new Error('Encrypted field failed authentication');
  }
}

export function needsRotation(token: string): boolean {
  return token.split('.')[1] !== active.id;
}

/** Constant-time string comparison for secrets/signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn comparable time to avoid length oracle on short secrets.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
