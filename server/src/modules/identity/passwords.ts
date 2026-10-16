import argon2 from 'argon2';
import { config } from '../../platform/config';

/**
 * Password hashing (Argon2id, OWASP profile) with two protections that a plain `argon2.hash` call lacks:
 *
 *  1. Bounded concurrency. Each hash needs 64 MiB; an attacker flooding /login could otherwise exhaust RAM/CPU.
 *     Excess work queues (the per-IP/email rate limiters shed it before it gets here).
 *  2. Constant-time "user not found" path. `verifyAgainstDummy` burns the same Argon2 cost so response time does not
 *     reveal whether an account exists.
 */
const PROD_PARAMS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;
// Tests use a cheap profile (hashes embed their own parameters, so verification still works everywhere).
const TEST_PARAMS = { type: argon2.argon2id, memoryCost: 4_096, timeCost: 2, parallelism: 1 } as const;
const PARAMS = config.isTest ? TEST_PARAMS : PROD_PARAMS;

class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
const gate = new Semaphore(Number(process.env.ARGON2_CONCURRENCY ?? 4));

export const MAX_PASSWORD_LENGTH = 128; // bound the work an attacker can force per request

export function hashPassword(password: string): Promise<string> {
  return gate.run(() => argon2.hash(password, PARAMS));
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  return gate.run(async () => {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  });
}

let dummyHash: Promise<string> | undefined;
/** Spend the same time as a real verification when no such user exists. Always returns false. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= argon2.hash('dummy-password-for-timing-equalisation', PARAMS);
  await verifyPassword(password, await dummyHash);
  return false;
}

/** True when the stored hash uses weaker parameters than the current policy → rehash on next successful login. */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, PARAMS);
}
