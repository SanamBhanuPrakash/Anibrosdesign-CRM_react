import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/** Upgrade from the PREVIOUS supported schema (001–024) to 025 (buyer interest, reservations, deal value), with data in place. */
let tdb: TestDatabase;
let admin: pg.Client;
let prevDir: string;
let upToDir: string;
const fullDir = path.resolve(process.cwd(), 'database/migrations');
const ids = { tenant: '', otherTenant: '', legacyPipeline: '', beginnerPipeline: '', lead: '', otherLead: '', prop: '', otherProp: '', wonLead: '' };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  prevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-025-'));
  upToDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-upto-025-'));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '025')) fs.copyFileSync(path.join(fullDir, f), path.join(prevDir, f));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '026')) fs.copyFileSync(path.join(fullDir, f), path.join(upToDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: prevDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade4-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  const mk = async (slug: string) => {
    const org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1,$1,$2) RETURNING id`, [slug, owner])).rows[0].id as string;
    return (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,$2,$2) RETURNING id`, [org, slug])).rows[0].id as string;
  };
  ids.tenant = await mk('deal-ws');
  ids.otherTenant = await mk('other-deal-ws');
  ids.legacyPipeline = (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [ids.tenant])).rows[0].id as string;
  ids.beginnerPipeline = (await admin.query(`SELECT app.seed_beginner_pipeline_unsafe($1, 'Recommended', false) AS id`, [ids.tenant])).rows[0].id as string;
  const stage = async (pipeline: string, key: string) => (await admin.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = $2`, [pipeline, key])).rows[0].id as string;
  ids.lead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'website') RETURNING id`, [ids.tenant, ids.legacyPipeline, await stage(ids.legacyPipeline, 'new')])).rows[0].id as string;
  ids.wonLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source, estimated_value) VALUES ($1,$2,$3,'website', 5000000) RETURNING id`, [ids.tenant, ids.legacyPipeline, await stage(ids.legacyPipeline, 'won')])).rows[0].id as string;
  const otherPipeline = (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [ids.otherTenant])).rows[0].id as string;
  ids.otherLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'website') RETURNING id`, [ids.otherTenant, otherPipeline, await stage(otherPipeline, 'new')])).rows[0].id as string;
  ids.prop = (await admin.query(`INSERT INTO properties (tenant_id, title, price, status) VALUES ($1,'Flat',1000000,'available') RETURNING id`, [ids.tenant])).rows[0].id as string;
  ids.otherProp = (await admin.query(`INSERT INTO properties (tenant_id, title, price, status) VALUES ($1,'Foreign flat',1000000,'available') RETURNING id`, [ids.otherTenant])).rows[0].id as string;
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.rmSync(upToDir, { recursive: true, force: true });
  await tdb?.drop();
});

describe('upgrade 024 → 025 with data in place', () => {
  it('applies cleanly; earlier migrations are verified, not re-run', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toEqual(['025']);
    expect(r.skipped.length).toBe(24);
  });

  it('existing pipelines are untouched; only the recommended template requires a deal value', async () => {
    const p = (await admin.query(`SELECT id, deal_value_required, template FROM pipelines WHERE tenant_id = $1`, [ids.tenant])).rows;
    expect(p.find((x) => x.id === ids.legacyPipeline)).toMatchObject({ deal_value_required: false, template: null });
    expect(p.find((x) => x.id === ids.beginnerPipeline)).toMatchObject({ deal_value_required: true, template: 'beginner_v1' });
    // a recommended pipeline created from now on follows the same rule without any code change
    const fresh = (await admin.query(`SELECT app.seed_beginner_pipeline_unsafe($1, 'Second', false) AS id`, [ids.otherTenant])).rows[0].id as string;
    expect((await admin.query(`SELECT deal_value_required FROM pipelines WHERE id = $1`, [fresh])).rows[0].deal_value_required).toBe(true);
  });

  it('leads, properties and their statuses are exactly as they were; a lead won earlier has no recorded sale', async () => {
    expect((await admin.query(`SELECT status::text AS status, estimated_value::float8 AS v FROM leads WHERE id = $1`, [ids.wonLead])).rows[0]).toEqual({ status: 'won', v: 5_000_000 });
    expect((await admin.query(`SELECT status FROM properties WHERE id = $1`, [ids.prop])).rows[0].status).toBe('available');
    expect((await admin.query(`SELECT count(*)::int AS n FROM reservations`)).rows[0].n).toBe(0);
  });

  it('a deal is always the same workspace’s lead and unit, and each state carries its facts', async () => {
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency) VALUES ($1,$2,$3,'INR')`, [ids.tenant, ids.otherLead, ids.prop])).rejects.toThrow(/fk_reservation_lead/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency) VALUES ($1,$2,$3,'INR')`, [ids.tenant, ids.lead, ids.otherProp])).rejects.toThrow(/fk_reservation_property/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency, status) VALUES ($1,$2,$3,'INR','reserved')`, [ids.tenant, ids.lead, ids.prop])).rejects.toThrow(/ck_reservation_reserved/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency, status, completed_at) VALUES ($1,$2,$3,'INR','completed', now())`, [ids.tenant, ids.lead, ids.prop])).rejects.toThrow(/ck_reservation_completed/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency, status, deal_value, completed_at) VALUES ($1,$2,$3,'INR','completed', 0, now())`, [ids.tenant, ids.lead, ids.prop])).rejects.toThrow(/ck_reservation_completed/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency, status) VALUES ($1,$2,$3,'INR','closed')`, [ids.tenant, ids.lead, ids.prop])).rejects.toThrow(/ck_reservation_closed/);
    await expect(admin.query(`INSERT INTO reservations (tenant_id, lead_id, property_id, currency, offer_price) VALUES ($1,$2,$3,'INR', -1)`, [ids.tenant, ids.lead, ids.prop])).rejects.toThrow(/ck_reservation_amounts/);
  });

  it('the application role can read and write deals but never delete them; both tables are tenant-isolated', async () => {
    const grants = async (table: string) =>
      (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = 'crm_app_user' ORDER BY 1`, [table])).rows.map((r) => r.privilege_type);
    expect(await grants('reservations')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await grants('lead_properties')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    const pol = (await admin.query(`SELECT tablename FROM pg_policies WHERE tablename IN ('reservations','lead_properties') ORDER BY 1`)).rows.map((r) => r.tablename);
    expect(pol).toEqual(['lead_properties', 'reservations']);
    const rls = (await admin.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('reservations','lead_properties') ORDER BY 1`)).rows;
    expect(rls).toEqual([
      { relname: 'lead_properties', relrowsecurity: true },
      { relname: 'reservations', relrowsecurity: true },
    ]);
  });

  it('re-running the whole set is a no-op', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied).toEqual([]);
  });
});
