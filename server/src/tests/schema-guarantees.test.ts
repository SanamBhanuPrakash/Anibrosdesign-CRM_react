import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { seedTenant, seedLead, type SeededTenant } from './support/fixtures';

/**
 * Schema-wide guarantees, enumerated from the catalog rather than from a hand-kept list of tables. A table added by a future
 * migration is covered automatically: if it carries a tenant_id and forgets row-level security, this suite fails.
 */
let tdb: TestDatabase;
let admin: pg.Client;
let api: pg.Client;
let worker: pg.Client;
let a: SeededTenant;
let b: SeededTenant;
let tenantTables: string[] = [];
const apiRole = () => decodeURIComponent(new URL(tdb.apiUrl).username);
const workerRole = () => decodeURIComponent(new URL(tdb.workerUrl).username);

beforeAll(async () => {
  tdb = await createTestDatabase();
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();
  api = new pg.Client({ connectionString: tdb.apiUrl });
  await api.connect();
  worker = new pg.Client({ connectionString: tdb.workerUrl });
  await worker.connect();
  a = await seedTenant(admin, 'guard-a');
  b = await seedTenant(admin, 'guard-b');
  await seedLead(admin, a, 'Asha');
  await seedLead(admin, b, 'Bela');
  tenantTables = (
    await admin.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`
    )
  ).rows.map((r) => r.table_name);
}, 120_000);

afterAll(async () => {
  await api?.end();
  await worker?.end();
  await admin?.end();
  await tdb?.drop();
});

/** Tenant-scoped tables that are deliberately not protected by RLS, with the reason. Keep this empty unless a reason is written down. */
const RLS_EXEMPT: Record<string, string> = {};

/** Every table in the public schema that has no RLS, with the reason. A new table must be added here consciously or get a policy. */
const NO_RLS_TABLES: Record<string, string> = {
  ...RLS_EXEMPT,
  schema_migrations: 'migration history: not writable by the runtime roles, holds no personal data (the identity tables are covered by identity-rls.test.ts, migration 034)',
};

describe('every tenant-scoped table is protected by row-level security', () => {
  it('the catalog scan finds the tenant tables (guard against the scan silently matching nothing)', () => {
    expect(tenantTables.length).toBeGreaterThan(30);
    for (const t of ['leads', 'contacts', 'tasks', 'properties', 'reservations', 'marketing_attribution', 'marketing_spend']) expect(tenantTables).toContain(t);
  });

  it('each one has RLS enabled and at least one policy', async () => {
    const rls = (await admin.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')`)).rows;
    const policies = new Map<string, number>();
    for (const r of (await admin.query<{ tablename: string; n: number }>(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY 1`)).rows) policies.set(r.tablename, r.n);
    const bad = tenantTables.filter((t) => !RLS_EXEMPT[t] && !(rls.find((r) => r.relname === t)?.relrowsecurity && (policies.get(t) ?? 0) > 0));
    expect(bad, `tenant tables without RLS or without a policy: ${bad.join(', ')}`).toEqual([]);
  });

  it('the set of public tables without RLS is exactly the documented identity/bookkeeping set', async () => {
    const none = (await admin.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND NOT relrowsecurity ORDER BY 1`)).rows.map((r) => r.relname);
    expect(none).toEqual(Object.keys(NO_RLS_TABLES).sort());
  });

  it('with no tenant context the API role sees no row of any tenant table (fails closed)', async () => {
    const leaks: string[] = [];
    for (const t of tenantTables.filter((x) => !RLS_EXEMPT[x])) {
      const n = (await api.query(`SELECT count(*)::int AS n FROM public."${t}"`)).rows[0].n as number;
      if (n !== 0) leaks.push(`${t}=${n}`);
    }
    expect(leaks).toEqual([]);
  });

  it("in tenant B's context the API role sees no row that belongs to tenant A, in any tenant table", async () => {
    const leaks: string[] = [];
    await api.query('BEGIN');
    try {
      await api.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [b.tenantId]);
      for (const t of tenantTables.filter((x) => !RLS_EXEMPT[x])) {
        const n = (await api.query(`SELECT count(*)::int AS n FROM public."${t}" WHERE tenant_id <> $1`, [b.tenantId])).rows[0].n as number;
        if (n !== 0) leaks.push(`${t}=${n}`);
      }
    } finally {
      await api.query('ROLLBACK');
    }
    expect(leaks).toEqual([]);
    // and the scan above is not vacuous: tenant A's lead really exists
    expect((await admin.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1`, [a.tenantId])).rows[0].n).toBe(1);
  });

  it('the API role cannot insert a row for another tenant, nor move one of its own rows to another tenant (WITH CHECK)', async () => {
    await api.query('BEGIN');
    try {
      await api.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [b.tenantId]);
      await api.query('SAVEPOINT s1');
      await expect(api.query(`INSERT INTO contacts (tenant_id, first_name) VALUES ($1, 'Intruder')`, [a.tenantId])).rejects.toThrow(/row-level security/);
      await api.query('ROLLBACK TO s1');
      await expect(api.query(`UPDATE contacts SET tenant_id = $1 WHERE tenant_id = $2`, [a.tenantId, b.tenantId])).rejects.toThrow(/row-level security/);
    } finally {
      await api.query('ROLLBACK');
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND first_name = 'Intruder'`, [a.tenantId])).rows[0].n).toBe(0);
  });
});

describe('the runtime roles can only do what the application needs', () => {
  it('neither is a superuser, BYPASSRLS, CREATEDB or CREATEROLE, and neither owns any table, function or schema object', async () => {
    for (const role of [apiRole(), workerRole()]) {
      const r = (await admin.query(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1`, [role])).rows[0];
      expect(r, role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
      const owned = (await admin.query(`SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND pg_get_userbyid(c.relowner) = $1`, [role])).rows[0].n;
      expect(owned, `${role} owns relations (owners bypass RLS)`).toBe(0);
    }
  });

  it('neither can TRUNCATE, nor write to the migration history', async () => {
    const tables = (await admin.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')`)).rows.map((r) => r.relname);
    for (const role of [apiRole(), workerRole()]) {
      const can = (
        await admin.query<{ t: string }>(`SELECT t FROM unnest($1::text[]) AS t WHERE has_table_privilege($2, format('public.%I', t), 'TRUNCATE')`, [tables, role])
      ).rows.map((r) => r.t);
      expect(can, `${role} may TRUNCATE`).toEqual([]);
    }
    for (const c of [api, worker]) {
      await expect(c.query(`DELETE FROM schema_migrations`)).rejects.toThrow(/permission denied|does not exist/);
    }
  });

  it('neither can DELETE identity rows (memberships are revoked by status, never deleted)', async () => {
    for (const role of [apiRole(), workerRole()]) {
      for (const tbl of ['tenant_memberships', 'tenants', 'organisations', 'users']) {
        const ok = (await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), 'DELETE') AS ok`, [role, tbl])).rows[0].ok;
        expect(ok, `${role} DELETE on ${tbl}`).toBe(false);
      }
    }
  });

  it('every SECURITY DEFINER function pins its search_path, and the ones that take a tenant id are not callable by the runtime roles', async () => {
    const fns = (
      await admin.query<{ schema: string; name: string; args: string; oid: number; config: string[] | null }>(
        `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.oid::int AS oid, p.proconfig AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname IN ('public','app')`
      )
    ).rows;
    expect(fns.length).toBeGreaterThan(0);
    const unpinned = fns.filter((f) => !(f.config ?? []).some((c) => c.startsWith('search_path='))).map((f) => `${f.schema}.${f.name}(${f.args})`);
    expect(unpinned, 'SECURITY DEFINER functions without a pinned search_path').toEqual([]);
    // the privileged *_unsafe variants are not callable by the runtime roles at all
    const callable: string[] = [];
    for (const f of fns.filter((x) => /unsafe/.test(x.name))) {
      for (const role of [apiRole(), workerRole()]) {
        if ((await admin.query(`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`, [role, f.oid])).rows[0].ok) callable.push(`${role} -> ${f.name}`);
      }
    }
    expect(callable, 'runtime roles can execute privileged seeding functions').toEqual([]);
    // the wrappers they may call refuse any tenant other than the one in the transaction context
    const wrappers = fns.filter((x) => /^seed_/.test(x.name) && !/unsafe/.test(x.name));
    expect(wrappers.map((w) => w.name).sort()).toEqual(['seed_beginner_pipeline', 'seed_default_pipeline', 'seed_lead_scoring_config']);
    for (const w of wrappers) {
      await api.query('BEGIN');
      try {
        await api.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [b.tenantId]);
        await expect(api.query(`SELECT app.${w.name}($1)`, [a.tenantId]), w.name).rejects.toThrow(/tenant context mismatch/);
      } finally {
        await api.query('ROLLBACK');
      }
    }
  });
});
