import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/**
 * Upgrade from the PREVIOUS supported schema (001–021) to 022, with data in place.
 * Rows written by the retired automation editor and ordinary tasks must survive untouched; the new guarantees must then hold.
 */
let tdb: TestDatabase;
let admin: pg.Client;
let previousDir: string;
const fullDir = path.resolve(process.cwd(), 'database/migrations');
let allDir = fullDir; // migrations up to and including 022 (set in beforeAll)
const ids = { tenant: '', legacyRule: '', task: '' };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  previousDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-migrations-'));
  allDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-upto-022-'));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x <= '022_z')) fs.copyFileSync(path.join(fullDir, f), path.join(allDir, f));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '022')) fs.copyFileSync(path.join(fullDir, f), path.join(previousDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: previousDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade1-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  const org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ('Org', 'org-up1', $1) RETURNING id`, [owner])).rows[0].id as string;
  ids.tenant = (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,'t','t-up1') RETURNING id`, [org])).rows[0].id;
  // a rule and an execution as the retired editor / old API could have left them
  ids.legacyRule = (
    await admin.query(
      `INSERT INTO automation_rules (tenant_id, name, trigger_type, actions, status) VALUES ($1, 'Old rule', 'lead_created', '[{"type":"send_whatsapp"}]'::jsonb, 'active') RETURNING id`,
      [ids.tenant]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO automation_executions (tenant_id, rule_id, trigger_entity_type, trigger_entity_id, status) VALUES ($1,$2,'lead',gen_random_uuid(),'completed')`, [ids.tenant, ids.legacyRule]);
  ids.task = (await admin.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'An existing task') RETURNING id`, [ids.tenant])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(previousDir, { recursive: true, force: true });
  fs.rmSync(allDir, { recursive: true, force: true });
  await tdb?.drop();
});

describe('upgrade 021 → 022 with data in place', () => {
  it('applies cleanly; earlier migrations are verified, not re-run', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: allDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toEqual(['022']);
    expect(r.skipped.length).toBe(21);
  });

  it('keeps legacy rules and runs exactly as they were, as unusable rows the engine never executes', async () => {
    const rule = (await admin.query(`SELECT name, status, template, params, version, actions FROM automation_rules WHERE id = $1`, [ids.legacyRule])).rows[0];
    expect(rule).toMatchObject({ name: 'Old rule', status: 'active', template: null, params: {}, version: 1 });
    expect(rule.actions).toEqual([{ type: 'send_whatsapp' }]);
    const ex = (await admin.query(`SELECT status, trigger_event_id, attempts, summary FROM automation_executions WHERE rule_id = $1`, [ids.legacyRule])).rows[0];
    expect(ex).toMatchObject({ status: 'completed', trigger_event_id: null, attempts: 0, summary: null });
    expect((await admin.query(`SELECT dedupe_key FROM tasks WHERE id = $1`, [ids.task])).rows[0].dedupe_key).toBeNull();
  });

  it('many legacy-style rows with no template may coexist; one rule per template per workspace is enforced', async () => {
    await admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type) VALUES ($1,'another old rule','lead_created')`, [ids.tenant]);
    await admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, status, template) VALUES ($1,'t','lead_created','active','new_lead_follow_up')`, [ids.tenant]);
    await expect(admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, status, template) VALUES ($1,'t2','lead_created','active','new_lead_follow_up')`, [ids.tenant])).rejects.toThrow(/uq_automation_rule_template/);
    // an archived one does not block a fresh rule
    await admin.query(`UPDATE automation_rules SET status = 'archived' WHERE tenant_id = $1 AND template = 'new_lead_follow_up'`, [ids.tenant]);
    await admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, status, template) VALUES ($1,'t3','lead_created','active','new_lead_follow_up')`, [ids.tenant]);
  });

  it('one execution per rule per event is a database guarantee; executions without an event id are unaffected', async () => {
    const rule = (await admin.query(`SELECT id FROM automation_rules WHERE tenant_id = $1 AND template = 'new_lead_follow_up' AND status = 'active'`, [ids.tenant])).rows[0].id;
    const ins = (event: number | null) => admin.query(`INSERT INTO automation_executions (tenant_id, rule_id, trigger_entity_type, trigger_entity_id, trigger_event_id) VALUES ($1,$2,'lead',gen_random_uuid(),$3)`, [ids.tenant, rule, event]);
    await ins(1001);
    await expect(ins(1001)).rejects.toThrow(/uq_automation_execution_event/);
    await ins(1002);
    await ins(null);
    await ins(null);
  });

  it('a task dedupe key can be used once per workspace; ordinary tasks are unaffected', async () => {
    await admin.query(`INSERT INTO tasks (tenant_id, title, dedupe_key) VALUES ($1,'a','k1')`, [ids.tenant]);
    await expect(admin.query(`INSERT INTO tasks (tenant_id, title, dedupe_key) VALUES ($1,'b','k1')`, [ids.tenant])).rejects.toThrow(/uq_tasks_dedupe/);
    await admin.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'c')`, [ids.tenant]);
    await admin.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'d')`, [ids.tenant]);
  });

  it('the application role cannot delete run history; the database refuses oversize rule parameters', async () => {
    const p = (await admin.query(`SELECT has_table_privilege('crm_app_user','automation_executions','DELETE') AS d, has_table_privilege('crm_app_user','automation_executions','UPDATE') AS u`)).rows[0];
    expect(p).toEqual({ d: false, u: true });
    await expect(admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, params) VALUES ($1,'big','lead_created', jsonb_build_object('x', repeat('a', 5000)))`, [ids.tenant])).rejects.toThrow(/automation_rules_params_size/);
  });

  it('re-running the whole set is a no-op', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: allDir, verbose: false });
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBe(22);
  });
});
