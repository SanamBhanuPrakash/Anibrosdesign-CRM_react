import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/**
 * Upgrade from the PREVIOUS supported schema (migrations 001–020) to 021, with data in place.
 * Proves: valid data survives; a pre-existing cross-workspace custom-field link makes the migration STOP without changing
 * anything (no silent deletion); once a human has removed the bad row the migration applies and the database then refuses
 * such links.
 */
let tdb: TestDatabase;
let admin: pg.Client;
let previousDir: string;
const allDir = path.resolve(process.cwd(), 'database/migrations');
const ids = { orgA: '', orgB: '', tenantA: '', tenantB: '', field: '', goodValue: '', badValue: '' };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  previousDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-migrations-'));
  for (const f of fs.readdirSync(allDir).filter((x) => x.endsWith('.sql') && x < '021')) fs.copyFileSync(path.join(allDir, f), path.join(previousDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: previousDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  // legacy-shaped data: two workspaces, a field definition in A, a legitimate value in A, and a bad value in B pointing at A's definition
  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  const org = async (n: string) => (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1, $1, $2) RETURNING id`, [n, owner])).rows[0].id as string;
  ids.orgA = await org('Org A');
  ids.orgB = await org('Org B');
  const tenant = async (o: string, n: string) => (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,$2,$2) RETURNING id`, [o, n])).rows[0].id as string;
  ids.tenantA = await tenant(ids.orgA, 'a');
  ids.tenantB = await tenant(ids.orgB, 'b');
  ids.field = (await admin.query(`INSERT INTO custom_field_definitions (tenant_id, entity_type, name, label, field_key) VALUES ($1,'lead','Band','Band','band') RETURNING id`, [ids.tenantA])).rows[0].id;
  const val = async (t: string) => (await admin.query(`INSERT INTO custom_field_values (tenant_id, field_id, entity_type, entity_id, value) VALUES ($1,$2,'lead',gen_random_uuid(),'x') RETURNING id`, [t, ids.field])).rows[0].id as string;
  ids.goodValue = await val(ids.tenantA);
  ids.badValue = await val(ids.tenantB);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(previousDir, { recursive: true, force: true });
  await tdb?.drop();
});

describe('upgrade 020 → 021 with data in place', () => {
  it('stops, changes nothing and explains itself when a cross-workspace custom-field link already exists', async () => {
    await expect(runMigrations({ connectionString: tdb.adminUrl, migrationsDir: allDir, verbose: false })).rejects.toThrow(/Migration 021 stopped: 1 custom_field_values row/);
    // nothing was deleted or rewritten, the migration is not recorded, the constraint does not exist
    expect((await admin.query(`SELECT count(*)::int AS n FROM custom_field_values`)).rows[0].n).toBe(2);
    expect((await admin.query(`SELECT 1 FROM schema_migrations WHERE version = '021'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_custom_field_value_def_tenant'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_leads_status_guard'`)).rowCount).toBe(0); // whole migration rolled back
  });

  it('applies once a person has reviewed and removed the offending row; valid data survives', async () => {
    await admin.query(`DELETE FROM custom_field_values WHERE id = $1`, [ids.badValue]); // the deliberate, human step
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: allDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toContain('021');
    expect(r.skipped.length).toBe(20); // 001–020 were verified by checksum, not re-run
    expect((await admin.query(`SELECT id FROM custom_field_values WHERE id = $1`, [ids.goodValue])).rowCount).toBe(1);
  });

  it('the database now refuses a value that links a field of one workspace to another workspace', async () => {
    await expect(
      admin.query(`INSERT INTO custom_field_values (tenant_id, field_id, entity_type, entity_id, value) VALUES ($1,$2,'lead',gen_random_uuid(),'x')`, [ids.tenantB, ids.field])
    ).rejects.toThrow(/fk_custom_field_value_def_tenant|violates foreign key/);
  });

  it('the status guard exists and the viewing function now runs as the caller with a pinned search path', async () => {
    expect((await admin.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_leads_status_guard'`)).rowCount).toBe(1);
    const fn = (await admin.query(`SELECT prosecdef, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'schedule_viewing'`)).rows[0];
    expect(fn.prosecdef).toBe(false);
    expect(JSON.stringify(fn.proconfig)).toMatch(/search_path/);
  });

  it('re-running the migration set is a no-op (idempotent upgrade path)', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: allDir, verbose: false });
    expect(r.applied.length).toBe(0);
  });
});
