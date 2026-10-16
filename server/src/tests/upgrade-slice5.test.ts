import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { runMigrations } from '../db/migrate';

/** Upgrade from the PREVIOUS supported schema (001–025) to 026 (attribution touches, spend, channel mapping), with leads already in place. */
let tdb: TestDatabase;
let admin: pg.Client;
let prevDir: string;
let upToDir: string;
const fullDir = path.resolve(process.cwd(), 'database/migrations');
const ids = { tenant: '', other: '', metaLead: '', plainLead: '', archivedLead: '', otherLead: '' };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  prevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-prev-026-'));
  upToDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anibros-upto-026-'));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '026')) fs.copyFileSync(path.join(fullDir, f), path.join(prevDir, f));
  for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith('.sql') && x < '027')) fs.copyFileSync(path.join(fullDir, f), path.join(upToDir, f));
  await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: prevDir, verbose: false });
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();
  const owner = (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ('upgrade5-owner@example.test', 'x', 'Owner', true) RETURNING id`)).rows[0].id as string;
  const mk = async (slug: string) => {
    const org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1,$1,$2) RETURNING id`, [slug, owner])).rows[0].id as string;
    return (await admin.query(`INSERT INTO tenants (organisation_id, name, slug) VALUES ($1,$2,$2) RETURNING id`, [org, slug])).rows[0].id as string;
  };
  ids.tenant = await mk('touch-ws');
  ids.other = await mk('other-touch-ws');
  const pipeline = (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [ids.tenant])).rows[0].id as string;
  const oPipeline = (await admin.query(`SELECT app.seed_default_pipeline_unsafe($1) AS id`, [ids.other])).rows[0].id as string;
  const stage = async (p: string) => (await admin.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'new'`, [p])).rows[0].id as string;
  const s1 = await stage(pipeline);
  ids.metaLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source, campaign, source_details) VALUES ($1,$2,$3,'meta_ads','Diwali Launch',$4::jsonb) RETURNING id`, [ids.tenant, pipeline, s1, JSON.stringify({ provider: 'meta', adsetId: 'adset-9', tracking: { utm_medium: 'paid', utm_term: 'flats', fbclid: 'fb-123' } })])).rows[0].id as string;
  ids.plainLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'other') RETURNING id`, [ids.tenant, pipeline, s1])).rows[0].id as string;
  ids.archivedLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source, deleted_at) VALUES ($1,$2,$3,'website', now()) RETURNING id`, [ids.tenant, pipeline, s1])).rows[0].id as string;
  ids.otherLead = (await admin.query(`INSERT INTO leads (tenant_id, pipeline_id, stage_id, source) VALUES ($1,$2,$3,'google_ads') RETURNING id`, [ids.other, oPipeline, await stage(oPipeline)])).rows[0].id as string;
}, 120_000);

afterAll(async () => {
  await admin?.end();
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.rmSync(upToDir, { recursive: true, force: true });
  await tdb?.drop();
});

describe('upgrade 025 → 026 with data in place', () => {
  it('applies cleanly; earlier migrations are verified, not re-run', async () => {
    expect((await admin.query(`SELECT count(*)::int AS c FROM marketing_attribution`)).rows[0].c).toBe(0); // nothing wrote touches before
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied.map((a) => a.version)).toEqual(['026']);
    expect(r.skipped.length).toBe(25);
  });

  it('every existing lead, archived ones included, gets exactly one first touch, flagged as reconstructed, from what the lead carries today', async () => {
    const rows = (await admin.query(`SELECT lead_id, touch_type, source, campaign, medium, ad_group, keyword, click_id, backfilled FROM marketing_attribution ORDER BY lead_id`)).rows;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.lead_id)).size).toBe(4);
    for (const r of rows) expect(r).toMatchObject({ touch_type: 'first_touch', backfilled: true });
    expect(rows.find((r) => r.lead_id === ids.metaLead)).toMatchObject({ source: 'meta_ads', campaign: 'Diwali Launch', medium: 'paid', ad_group: 'adset-9', keyword: 'flats', click_id: 'fb-123' });
    expect(rows.find((r) => r.lead_id === ids.plainLead)).toMatchObject({ source: 'other', campaign: null }); // unknown stays unknown
    expect(rows.find((r) => r.lead_id === ids.archivedLead)?.source).toBe('website');
  });

  it('leads themselves are untouched', async () => {
    const l = (await admin.query(`SELECT source::text AS source, campaign FROM leads WHERE id = $1`, [ids.metaLead])).rows[0];
    expect(l).toEqual({ source: 'meta_ads', campaign: 'Diwali Launch' });
  });

  it('a first touch cannot be edited, a second one cannot be added, and later touches can', async () => {
    await expect(admin.query(`UPDATE marketing_attribution SET source = 'portal' WHERE lead_id = $1`, [ids.metaLead])).rejects.toThrow(/first touch of a lead cannot be changed/);
    await expect(admin.query(`INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, source) VALUES ($1,$2,'first_touch','portal')`, [ids.tenant, ids.metaLead])).rejects.toThrow(/uq_attribution_first_touch/);
    await admin.query(`INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, source, campaign) VALUES ($1,$2,'later_touch','google_ads','Retarget')`, [ids.tenant, ids.metaLead]);
    await expect(admin.query(`INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type) VALUES ($1,$2,'weird')`, [ids.tenant, ids.metaLead])).rejects.toThrow(/ck_attribution_touch_type/);
  });

  it('spend is one figure per source, campaign and exact period, within a year, and the application role cannot delete touches', async () => {
    const ins = (campaign: string | null, start: string, end: string, amount = 100) =>
      admin.query(`INSERT INTO marketing_spend (tenant_id, source, campaign, period_start, period_end, amount, currency) VALUES ($1,'meta_ads',$2,$3,$4,$5,'INR')`, [ids.tenant, campaign, start, end, amount]);
    await ins('Diwali Launch', '2026-10-01', '2026-10-31');
    await expect(ins('diwali launch', '2026-10-01', '2026-10-31')).rejects.toThrow(/uq_marketing_spend_key/); // case-insensitive
    await ins(null, '2026-10-01', '2026-10-31'); // whole-source spend is a different row
    await expect(ins('x', '2026-10-31', '2026-10-01')).rejects.toThrow(/ck_spend_period/);
    await expect(ins('x', '2024-01-01', '2026-10-31')).rejects.toThrow(/ck_spend_period/);
    await expect(ins('x', '2026-10-01', '2026-10-02', -5)).rejects.toThrow(/ck_spend_amount/);
    const grants = async (t: string) => (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = 'crm_app_user' ORDER BY 1`, [t])).rows.map((r) => r.privilege_type);
    expect(await grants('marketing_attribution')).toEqual(['INSERT', 'SELECT']);
    expect(await grants('marketing_spend')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(await grants('channel_mappings')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    const rls = (await admin.query(`SELECT relname FROM pg_class WHERE relname IN ('marketing_spend','channel_mappings') AND relrowsecurity ORDER BY 1`)).rows.map((r) => r.relname);
    expect(rls).toEqual(['channel_mappings', 'marketing_spend']);
  });

  it('re-running the whole set is a no-op', async () => {
    const r = await runMigrations({ connectionString: tdb.adminUrl, migrationsDir: upToDir, verbose: false });
    expect(r.applied).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int AS c FROM marketing_attribution WHERE touch_type = 'first_touch'`)).rows[0].c).toBe(4);
  });
});
