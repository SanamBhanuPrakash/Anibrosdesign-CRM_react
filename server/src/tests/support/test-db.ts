import pg from 'pg';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { runMigrations } from '../../db/migrate';
import { provisionRoles, withCredentials } from '../../db/provision';

/**
 * Disposable PostgreSQL database per test file.
 *
 *  - Creates `anibros_test_<unique>` on the cluster referenced by DATABASE_TEST_URL.
 *  - Runs ALL migrations from an empty database (so a broken migration fails every suite, never silently skipped).
 *  - Provisions per-run LOGIN roles (random passwords) that mirror production: API role (RLS enforced) + worker role.
 *  - Never touches any other database. Name must contain "test" or the helper refuses to run.
 */
const envPath = path.resolve(process.cwd(), '.env.native');
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

export interface TestDatabase {
  name: string;
  /** Privileged (migrator) connection — DDL & fixtures only. */
  adminUrl: string;
  /** Restricted runtime roles — what the API / worker use in production. */
  apiUrl: string;
  workerUrl: string;
  /** Create this run's login roles (called automatically when migrate !== false). */
  provision(): Promise<void>;
  drop(): Promise<void>;
}

function baseUrl(): URL {
  const raw =
    process.env.DATABASE_TEST_URL ||
    process.env.MIGRATOR_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://anibros:dev-only-not-a-secret@127.0.0.1:5542/anibrosdesign_test';
  return new URL(raw);
}

function withDb(url: URL, db: string): string {
  const u = new URL(url.toString());
  u.pathname = `/${db}`;
  return u.toString();
}

export interface CreateOptions {
  /** Skip migrations (used by the bootstrap test, which runs them itself and asserts on the result). */
  migrate?: boolean;
}

export async function createTestDatabase(opts: CreateOptions = {}): Promise<TestDatabase> {
  const base = baseUrl();
  const name = `anibros_test_${process.pid}_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  if (!name.includes('test')) throw new Error('[test-db] refusing to create a database without "test" in its name');

  const maintenance = new pg.Client({ connectionString: withDb(base, 'postgres') });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${maintenance.escapeIdentifier(name)}`);
  } finally {
    await maintenance.end();
  }

  const adminUrl = withDb(base, name);
  const suffix = crypto.randomBytes(4).toString('hex');
  const apiRole = `crm_api_t_${suffix}`;
  const workerRole = `crm_wrk_t_${suffix}`;
  const apiPassword = crypto.randomBytes(24).toString('hex');
  const workerPassword = crypto.randomBytes(24).toString('hex');

  const provision = () =>
    provisionRoles({ adminConnectionString: adminUrl, apiPassword, workerPassword, apiRole, workerRole });

  if (opts.migrate !== false) {
    await runMigrations({ connectionString: adminUrl, verbose: false });
    await provision();
  }

  return {
    name,
    adminUrl,
    provision,
    apiUrl: withCredentials(adminUrl, apiRole, apiPassword),
    workerUrl: withCredentials(adminUrl, workerRole, workerPassword),
    async drop() {
      const m = new pg.Client({ connectionString: withDb(base, 'postgres') });
      await m.connect();
      try {
        await m.query(`DROP DATABASE IF EXISTS ${m.escapeIdentifier(name)} WITH (FORCE)`);
        // Per-run login roles are cluster-wide objects: remove them or they accumulate.
        for (const role of [apiRole, workerRole]) {
          await m.query(`DROP ROLE IF EXISTS ${m.escapeIdentifier(role)}`).catch(() => undefined);
        }
      } finally {
        await m.end();
      }
    },
  };
}
