import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/**
 * Upgrade from the PREVIOUS supported schema (001–022) to 023, with data in place.
 * Existing pipelines, leads and history must survive untouched; the history snapshot is back-filled and FLAGGED; the Nurture
 * dead end gets exits only where a restricted pipeline has none; unrestricted pipelines are not given rules they never had.
 */
let tdb: TestDatabase;
let admin: pg.Client;
let prevDir: string;
let upToDir: string;
const fullDir = path.resolve(process.cwd(), 'database/migrations');
const t = { restricted: '', free: '', hasExit: '' };
const p = { restricted: '', free: '', hasExit: '' };
let leadId = '';
let stageNew = '';
let stageQualified = '';
let nurtureRestricted = '';

const mkTenant = async (owner: string, slug: string) => {
  const org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1,$1,$2) RETURNING id`, [slug, owner])).rows[0].id as string;
  return (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,$2,$2) RETURNING id`, [org, slug])).rows[0].id as string;
};
const seedLegacy = async (tenantId: string) => (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [tenantId])).rows[0].id as string;
const stageId = async (pipelineId: string, key: string) => (await admin.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = $2`, [pipelineId, key])).rows[0].id as string;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  prevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-023-'));
  upToDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-upto-023-'));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '023')) fs.copyFileSync(path.join(fullDir, f), path.join(prevDir, f));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '024')) fs.copyFileSync(path.join(fullDir, f), path.join(upToDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: prevDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade2-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  t.restricted = await mkTenant(owner, 'restricted-ws');
  t.free = await mkTenant(owner, 'free-ws');
  t.hasExit = await mkTenant(owner, 'exit-ws');
  p.restricted = await seedLegacy(t.restricted); // original seeded rules: Nurture has no way out
  p.free = await seedLegacy(t.free);
  await admin.query(`DELETE FROM pipeline_stage_transitions WHERE pipeline_id = $1`, [p.free]); // a workspace that chose "any stage to any stage"
  p.hasExit = await seedLegacy(t.hasExit);
  nurtureRestricted = await stageId(p.restricted, 'nurture');
  const nurtureExit = await stageId(p.hasExit, 'nurture');
  await admin.query(
    `INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed)
     SELECT $1, $2, $3, s.id, 'nurture', s.stage_key, true FROM pipeline_stages s WHERE s.pipeline_id = $2 AND s.stage_key = 'qualified'`,
    [t.hasExit, p.hasExit, nurtureExit]
  ); // this workspace already gave Nurture one exit by hand

  stageNew = await stageId(p.restricted, 'new');
  stageQualified = await stageId(p.restricted, 'qualified');
  leadId = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'website') RETURNING id`, [t.restricted, p.restricted, stageNew])).rows[0].id;
  await admin.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, reason) VALUES ($1,$2,NULL,$3,'Lead created')`, [leadId, t.restricted, stageNew]);
  await admin.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, reason) VALUES ($1,$2,$3,$4,'Qualified on call')`, [leadId, t.restricted, stageNew, stageQualified]);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.rmSync(upToDir, { recursive: true, force: true });
  await tdb?.drop();
});

const exits = async (stage: string) => (await admin.query(`SELECT count(*)::int AS n FROM pipeline_stage_transitions WHERE from_stage_id = $1 AND is_allowed`, [stage])).rows[0].n as number;

describe('upgrade 022 → 023 with data in place', () => {
  it('before the upgrade Nurture is a dead end', async () => {
    expect(await exits(nurtureRestricted)).toBe(0);
  });

  it('applies cleanly; earlier migrations are verified, not re-run', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toEqual(['023']);
    expect(r.skipped.length).toBe(22);
  });

  it('existing pipelines, stages and leads are exactly as they were', async () => {
    const ps = (await admin.query(`SELECT id, name, is_default, reason_codes_required, template FROM pipelines WHERE tenant_id = ANY($1::uuid[]) ORDER BY id`, [[t.restricted, t.free, t.hasExit]])).rows;
    expect(ps).toHaveLength(3);
    for (const x of ps) expect(x).toMatchObject({ name: 'Default Real Estate Pipeline', is_default: true, reason_codes_required: false, template: null }); // nothing replaced, nothing switched on
    const lead = (await admin.query(`SELECT stage_id, status, loss_reason_code FROM leads WHERE id = $1`, [leadId])).rows[0];
    expect(lead).toEqual({ stage_id: stageNew, status: 'open', loss_reason_code: null });
    expect((await admin.query(`SELECT count(*)::int AS n FROM pipeline_stages WHERE pipeline_id = $1`, [p.restricted])).rows[0].n).toBe(13);
  });

  it('old history rows get a snapshot of the current values and are flagged as back-filled', async () => {
    const rows = (await admin.query(`SELECT from_stage_name, to_stage_name, to_status, to_probability, snapshot_backfilled, reason FROM lead_stage_history WHERE lead_id = $1 ORDER BY created_at`, [leadId])).rows;
    expect(rows).toEqual([
      { from_stage_name: null, to_stage_name: 'New', to_status: 'open', to_probability: 5, snapshot_backfilled: true, reason: 'Lead created' },
      { from_stage_name: 'New', to_stage_name: 'Qualified', to_status: 'qualified', to_probability: 30, snapshot_backfilled: true, reason: 'Qualified on call' },
    ]);
  });

  it('rows written after the upgrade carry a real snapshot (not flagged)', async () => {
    await admin.query(`INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id) VALUES ($1,$2,$3,$4)`, [leadId, t.restricted, stageQualified, stageNew]);
    const r = (await admin.query(`SELECT to_stage_name, snapshot_backfilled FROM lead_stage_history WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [leadId])).rows[0];
    expect(r).toEqual({ to_stage_name: 'New', snapshot_backfilled: false });
  });

  it('Nurture now has exits to every stage except itself and Won; moves are still restricted elsewhere', async () => {
    expect(await exits(nurtureRestricted)).toBe(11);
    const targets = (await admin.query(`SELECT to_stage_key FROM pipeline_stage_transitions WHERE from_stage_id = $1 ORDER BY 1`, [nurtureRestricted])).rows.map((r) => r.to_stage_key);
    expect(targets).not.toContain('won');
    expect(targets).not.toContain('nurture');
    expect(targets).toEqual(expect.arrayContaining(['new', 'qualified', 'lost', 'unqualified', 'invalid']));
    // an unrelated rule is unchanged: New still cannot jump to Qualified
    expect((await admin.query(`SELECT 1 FROM pipeline_stage_transitions WHERE pipeline_id = $1 AND from_stage_key = 'new' AND to_stage_key = 'qualified'`, [p.restricted])).rowCount).toBe(0);
  });

  it('a pipeline that allows every move gets no rules; one where Nurture already had an exit keeps exactly that exit', async () => {
    expect((await admin.query(`SELECT count(*)::int AS n FROM pipeline_stage_transitions WHERE pipeline_id = $1`, [p.free])).rows[0].n).toBe(0);
    const nurtureExit = await stageId(p.hasExit, 'nurture');
    expect(await exits(nurtureExit)).toBe(1);
  });

  it('the new database objects exist and the application role cannot reach the unguarded seed', async () => {
    expect((await admin.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stage_history_snapshot'`)).rowCount).toBe(1);
    expect((await admin.query(`SELECT has_function_privilege('crm_app_user', 'app.seed_beginner_pipeline_unsafe(uuid, text, boolean)', 'EXECUTE') AS u, has_function_privilege('crm_app_user', 'app.seed_beginner_pipeline(uuid, text, boolean)', 'EXECUTE') AS g`)).rows[0]).toEqual({ u: false, g: true });
  });

  it('re-running the whole set is a no-op (no duplicate exits, nothing re-flagged)', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied).toEqual([]);
    expect(await exits(nurtureRestricted)).toBe(11);
    expect((await admin.query(`SELECT count(*)::int AS n FROM lead_stage_history WHERE snapshot_backfilled`)).rows[0].n).toBe(2);
  });
});
