import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

/**
 * Typed, validated runtime configuration.
 *
 * Principles
 *  - One schema, parsed once at process start; the process refuses to boot on invalid config.
 *  - Development gets safe, obviously-fake defaults. PRODUCTION GETS NONE for anything secret or environment-specific.
 *  - Secrets are never logged: use `describeConfig()` for diagnostics.
 */

const envFile = path.resolve(process.cwd(), '.env.native');
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });
else dotenv.config({ quiet: true });

const DEV_DB = 'postgresql://anibros:dev-only-not-a-secret@127.0.0.1:5542/anibrosdesign';
const DEV_COOKIE_SECRET = 'dev-only-cookie-secret-change-me-0123456789';
const DEV_ENC_KEY = '0'.repeat(64);

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4200),
    HOST: z.string().default('0.0.0.0'),
    /** Public URL of the SPA (used in emails/links and to derive default CORS origin). */
    PUBLIC_APP_URL: z.string().url().optional(),
    /** Public base URL of this API (shown in the OpenAPI document). Defaults to relative '/'. */
    PUBLIC_API_URL: z.string().url().optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

    // --- database -----------------------------------------------------------------------------------------
    /** Runtime role used by the API (RLS enforced). */
    DATABASE_URL: z.string().url().optional(),
    /** Runtime role used by the worker process. Falls back to DATABASE_URL only outside production. */
    WORKER_DATABASE_URL: z.string().url().optional(),
    /** Privileged role: migrations & role provisioning ONLY. Never used by the API/worker at runtime. */
    MIGRATOR_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).default(5_000),

    // --- sessions & cookies ---------------------------------------------------------------------------------
    SESSION_COOKIE_NAME: z.string().default('anibrosdesign_session'),
    /** Sign-in attempts allowed per IP address per 15 minutes (a whole office shares one address). Per-account guessing limits are separate and stricter. */
    LOGIN_IP_LIMIT: z.coerce.number().int().min(10).max(100_000).default(600),
    SESSION_IDLE_TTL_HOURS: z.coerce.number().min(1).default(12),
    SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().min(1).default(14),
    CSRF_HEADER_NAME: z.string().default('x-csrf-token'),
    COOKIE_SECRET: z.string().min(32).optional(),

    // --- crypto -------------------------------------------------------------------------------------------
    /** 32-byte AES-256-GCM key as 64 hex chars. Prefix with key id for rotation: "k2:<hex>" (comma separated, first = active). */
    FIELD_ENCRYPTION_KEYS: z.string().optional(),

    // --- files ------------------------------------------------------------------------------------------
    /** Where uploaded files live (local-disk adapter). Production: a persistent volume, or replace the adapter with S3-compatible storage. */
    STORAGE_DIR: z.string().default('./storage'),

    // --- mail -------------------------------------------------------------------------------------------
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: bool.optional(),
    MAIL_FROM: z.string().default('Anibros CRM <no-reply@localhost>'),

    // --- providers (all optional; features degrade to BLOCKED/disabled, never to fake success) -------------------
    META_APP_SECRET: z.string().optional(),
    META_VERIFY_TOKEN: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

    // --- operations -------------------------------------------------------------------------------------
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    METRICS_TOKEN: z.string().min(16).optional(),
    RUN_WORKER_IN_PROCESS: bool.optional(),
    /** Dev-only escape hatch while routes are being ported; refused in production. */
    ALLOW_PRIVILEGED_RUNTIME_ROLE: bool.optional(),
    /** Development and tests only: let outgoing webhooks reach private addresses (a local receiver). Refused in production. */
    OUTBOUND_ALLOW_PRIVATE: bool.optional(),
    /** Where request-rate counters live. "postgres" shares them between several API processes; "memory" is per process (default). */
    RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
    /** WhatsApp Cloud API base (override only for tests). */
    WHATSAPP_GRAPH_URL: z.string().url().default('https://graph.facebook.com/v21.0'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const need = (key: keyof typeof env, why: string) => {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${String(key)} is required in production (${why})` });
    };
    need('DATABASE_URL', 'restricted runtime role');
    need('WORKER_DATABASE_URL', 'restricted worker role');
    need('COOKIE_SECRET', '>= 32 chars');
    need('FIELD_ENCRYPTION_KEYS', 'integration credential encryption');
    need('PUBLIC_APP_URL', 'links in emails and CORS');
    need('SMTP_HOST', 'transactional email (verification, reset, invitations)');
    if (env.OUTBOUND_ALLOW_PRIVATE) {
      ctx.addIssue({ code: 'custom', path: ['OUTBOUND_ALLOW_PRIVATE'], message: 'must not be enabled in production' });
    }
    if (env.ALLOW_PRIVILEGED_RUNTIME_ROLE) {
      ctx.addIssue({ code: 'custom', path: ['ALLOW_PRIVILEGED_RUNTIME_ROLE'], message: 'must not be enabled in production' });
    }
    if (env.COOKIE_SECRET === DEV_COOKIE_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECRET'], message: 'dev secret must not be used in production' });
    }
    if (env.DATABASE_URL && env.WORKER_DATABASE_URL && env.DATABASE_URL === env.WORKER_DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['WORKER_DATABASE_URL'], message: 'API and worker must use different DB roles' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  // Do not print values (they may be secrets).
  throw new Error(`[config] Invalid environment configuration:\n${lines.join('\n')}`);
}
const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

const allowedOrigins = (
  env.ALLOWED_ORIGINS ??
  env.PUBLIC_APP_URL ??
  // `localhost` first: it is the first entry that becomes the e-mail link base, and unlike 127.0.0.1 it works whether the
  // dev server bound to IPv4 or IPv6 (Vite on Windows often listens on [::1] only, which refuses 127.0.0.1).
  'http://localhost:5274,http://127.0.0.1:5274'
)
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

export const config = {
  ...env,
  isProduction,
  isTest,
  databaseUrl: env.DATABASE_URL ?? DEV_DB,
  workerDatabaseUrl: env.WORKER_DATABASE_URL ?? env.DATABASE_URL ?? DEV_DB,
  migratorDatabaseUrl: env.MIGRATOR_DATABASE_URL ?? env.DATABASE_URL ?? DEV_DB,
  COOKIE_SECRET: env.COOKIE_SECRET ?? DEV_COOKIE_SECRET,
  /** key id → 32-byte key. First entry is the active encryption key. */
  encryptionKeys: parseKeys(env.FIELD_ENCRYPTION_KEYS ?? `dev:${DEV_ENC_KEY}`),
  allowedOriginsArray: allowedOrigins,
  publicAppUrl: env.PUBLIC_APP_URL ?? allowedOrigins[0],
  publicApiUrl: env.PUBLIC_API_URL,
  sessionIdleMs: env.SESSION_IDLE_TTL_HOURS * 3_600_000,
  sessionAbsoluteMs: env.SESSION_ABSOLUTE_TTL_DAYS * 86_400_000,
  /** Legacy alias retained while routes are ported. */
  SESSION_TTL_DAYS: env.SESSION_ABSOLUTE_TTL_DAYS,
};

function parseKeys(raw: string): Array<{ id: string; key: Buffer }> {
  const keys = raw.split(',').map((entry) => {
    const [id, hex] = entry.includes(':') ? entry.split(':') : ['k1', entry];
    if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) {
      throw new Error(`[config] FIELD_ENCRYPTION_KEYS entry "${id}" must be 64 hex chars (32 bytes)`);
    }
    return { id: id.trim(), key: Buffer.from(hex, 'hex') };
  });
  if (isProduction && keys.some((k) => k.key.equals(Buffer.alloc(32)))) {
    throw new Error('[config] all-zero encryption key is not allowed in production');
  }
  return keys;
}

/** Safe-to-log summary (no secrets, no connection strings). */
export function describeConfig() {
  const host = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.username}@${x.hostname}:${x.port}${x.pathname}`;
    } catch {
      return 'invalid';
    }
  };
  return {
    env: config.NODE_ENV,
    port: config.PORT,
    db: host(config.databaseUrl),
    workerDb: host(config.workerDatabaseUrl),
    origins: config.allowedOriginsArray,
    smtp: Boolean(config.SMTP_HOST),
    meta: Boolean(config.META_APP_SECRET),
    ai: Boolean(config.ANTHROPIC_API_KEY),
    privilegedRuntimeAllowed: Boolean(config.ALLOW_PRIVILEGED_RUNTIME_ROLE),
  };
}

export type AppConfig = typeof config;
