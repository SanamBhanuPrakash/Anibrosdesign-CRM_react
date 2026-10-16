import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/** Upgrade from the PREVIOUS supported schema (001–023) to 024 (viewing lifecycle), with a booked viewing in place. */
let tdb: TestDatabase;
let admin: pg.Client;
let prevDir: string;
let upToDir: string;
const fullDir = path.resolve(process.cwd(), 'database/migrations');
const ids = { tenant: '', viewing: '', task: '', otherTenant: '' };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  prevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-024-'));
  upToDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-upto-024-'));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '024')) fs.copyFileSync(path.join(fullDir, f), path.join(prevDir, f));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '025')) fs.copyFileSync(path.join(fullDir, f), path.join(upToDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: prevDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade3-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  const mk = async (slug: string) => {
    const org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1,$1,$2) RETURNING id`, [slug, owner])).rows[0].id as string;
    return (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,$2,$2) RETURNING id`, [org, slug])).rows[0].id as string;
  };
  ids.tenant = await mk('visit-ws');
  ids.otherTenant = await mk('other-visit-ws');
  const pipeline = (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [ids.tenant])).rows[0].id as string;
  const stage = (await admin.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'new'`, [pipeline])).rows[0].id as string;
  const lead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'website') RETURNING id`, [ids.tenant, pipeline, stage])).rows[0].id as string;
  const prop = (await admin.query(`INSERT INTO properties (tenant_id, title, price, status) VALUES ($1,'Flat',1000000,'available') RETURNING id`, [ids.tenant])).rows[0].id as string;
  ids.viewing = (await admin.query(`INSERT INTO viewings (tenant_id, lead_id, property_id, scheduled_at, duration_minutes, status) VALUES ($1,$2,$3,'2031-01-01T10:00:00Z',30,'completed') RETURNING id`, [ids.tenant, lead, prop])).rows[0].id as string;
  ids.task = (await admin.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'existing') RETURNING id`, [ids.tenant])).rows[0].id as string;
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.rmSync(upToDir, { recursive: true, force: true });
  await tdb?.drop();
});

describe('upgrade 023 → 024 with data in place', () => {
  it('applies cleanly; earlier migrations are verified, not re-run', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toEqual(['024']);
    expect(r.skipped.length).toBe(23);
  });

  it('an existing viewing keeps everything and becomes version 1 with no outcome and no reminder', async () => {
    const v = (await admin.query(`SELECT status, version, outcome_code, outcome_note, closed_at, cancel_reason, reminder_task_id, duration_minutes FROM viewings WHERE id = $1`, [ids.viewing])).rows[0];
    expect(v).toEqual({ status: 'completed', version: 1, outcome_code: null, outcome_note: null, closed_at: null, cancel_reason: null, reminder_task_id: null, duration_minutes: 30 });
  });

  it('the reminder must be a task of the SAME workspace; outcomes must look like codes; notes are bounded', async () => {
    const foreignTask = (await admin.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'foreign') RETURNING id`, [ids.otherTenant])).rows[0].id as string;
    await expect(admin.query(`UPDATE viewings SET reminder_task_id = $2 WHERE id = $1`, [ids.viewing, foreignTask])).rejects.toThrow(/fk_viewing_reminder_task_tenant|foreign key/);
    await admin.query(`UPDATE viewings SET reminder_task_id = $2 WHERE id = $1`, [ids.viewing, ids.task]);
    await expect(admin.query(`UPDATE viewings SET outcome_code = 'Not A Code' WHERE id = $1`, [ids.viewing])).rejects.toThrow(/ck_viewings_outcome_code/);
    await expect(admin.query(`UPDATE viewings SET outcome_note = repeat('x', 1001) WHERE id = $1`, [ids.viewing])).rejects.toThrow(/ck_viewings_text_len/);
  });

  it('deleting the reminder task keeps the viewing and clears only the link', async () => {
    await admin.query(`DELETE FROM tasks WHERE id = $1`, [ids.task]);
    const v = (await admin.query(`SELECT status, reminder_task_id, tenant_id FROM viewings WHERE id = $1`, [ids.viewing])).rows[0];
    expect(v).toEqual({ status: 'completed', reminder_task_id: null, tenant_id: ids.tenant });
  });

  it('re-running the whole set is a no-op', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied).toEqual([]);
  });
});
