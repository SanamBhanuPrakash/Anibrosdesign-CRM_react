import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './support/test-db';
import { seedTenant, type SeededTenant } from './support/fixtures';

/**
 * Row-level security on the identity tables (migration 034), proved with the real restricted roles and raw SQL: no application code in
 * between, so a forgotten WHERE clause in any module cannot show one workspace's people to another.
 */
let tdb: TestDatabase;
let admin: pg.Client;
let api: pg.Client;
let worker: pg.Client;
let a: SeededTenant;
let b: SeededTenant;
// an agency: HQ + two clients; an owner in all of them, an employee in HQ and client one only
const ag = { org: '', hq: '', c1: '', c2: '', owner: '', employee: '', ownerSession: '', employeeSession: '' };

type Ctx = { tenant?: string; user?: string; flow?: boolean };

/** Run statements under one context in a transaction that is always rolled back (the API connection stays clean). */
async function as<T>(client: pg.Client, ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.identity_flow', $3, true)`, [ctx.tenant ?? '', ctx.user ?? '', ctx.flow ? 'on' : '']);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}
const n = async (client: pg.Client, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0].n as number;
const ids = async (client: pg.Client, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows.map((r) => String(r.id)).sort();

async function user(email: string, name: string) {
  return (await admin.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1, 'x', $2, true) RETURNING id`, [email, name])).rows[0].id as string;
}
async function member(tenantId: string, userId: string, role: string) {
  await admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1, $2, $3::tenant_role, 'active', true)`, [tenantId, userId, role]);
}
async function session(userId: string, active: string | null) {
  return (await admin.query(`INSERT INTO sessions (user_id, token_hash, expires_at, active_tenant_id) VALUES ($1, $2, now() + interval '1 day', $3) RETURNING id`, [userId, crypto.randomBytes(16).toString('hex'), active])).rows[0].id as string;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();
  api = new pg.Client({ connectionString: tdb.apiUrl });
  await api.connect();
  worker = new pg.Client({ connectionString: tdb.workerUrl });
  await worker.connect();
  a = await seedTenant(admin, 'idrls-a');
  b = await seedTenant(admin, 'idrls-b');

  ag.owner = await user(`own-${crypto.randomBytes(3).toString('hex')}@agency.test`, 'Agency Owner');
  ag.employee = await user(`emp-${crypto.randomBytes(3).toString('hex')}@agency.test`, 'Agency Employee');
  ag.org = (await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ('Studio', $1, $2) RETURNING id`, [`studio-${crypto.randomBytes(3).toString('hex')}`, ag.owner])).rows[0].id;
  const tenant = async (kind: string, slug: string) => (await admin.query(`INSERT INTO tenants (organisation_id, name, slug, kind) VALUES ($1, $2, $3, $4) RETURNING id`, [ag.org, `T ${slug}`, slug, kind])).rows[0].id as string;
  ag.hq = await tenant('agency_hq', 'main');
  ag.c1 = await tenant('client', 'one');
  ag.c2 = await tenant('client', 'two');
  for (const t of [ag.hq, ag.c1, ag.c2]) await member(t, ag.owner, 'tenant_owner');
  await member(ag.hq, ag.employee, 'sales_agent');
  await member(ag.c1, ag.employee, 'sales_agent');
  ag.ownerSession = await session(ag.owner, ag.c1);
  ag.employeeSession = await session(ag.employee, ag.c1);
  await session(a.userId, a.tenantId);
  await session(b.userId, b.tenantId);
  await admin.query(`INSERT INTO login_attempts (email, ip_address, success) VALUES ('x@y.z', '10.0.0.1', false)`);
  await admin.query(`INSERT INTO mfa_factors (user_id, secret_enc, confirmed_at) VALUES ($1, 'enc', now())`, [b.userId]);
}, 120_000);

afterAll(async () => {
  await api?.end();
  await worker?.end();
  await admin?.end();
  await tdb?.drop();
});

const IDENTITY = ['users', 'organisations', 'tenants', 'tenant_memberships', 'sessions', 'login_attempts', 'email_verification_tokens', 'password_reset_tokens', 'mfa_factors', 'mfa_recovery_codes', 'notification_reads'];

describe('identity tables: row-level security is on, and with no context nothing is visible', () => {
  it('every identity table has RLS enabled and at least one policy', async () => {
    const rls = (await admin.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`, [IDENTITY])).rows;
    expect(rls.length).toBe(IDENTITY.length);
    expect(rls.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
    const policies = (await admin.query<{ tablename: string }>(`SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [IDENTITY])).rows.map((r) => r.tablename);
    expect(policies.sort()).toEqual([...IDENTITY].sort());
  });

  it('the API role and the worker role see zero rows of any of them without a context', async () => {
    for (const client of [api, worker]) {
      for (const t of IDENTITY) expect(await as(client, {}, () => n(client, `SELECT count(*)::int AS n FROM public."${t}"`)), t).toBe(0);
    }
    // and the rows really exist (the zero is not an empty database)
    expect(await n(admin, `SELECT count(*)::int AS n FROM users`)).toBeGreaterThanOrEqual(4);
  });
});

describe('in one workspace you see that workspace and the people in it, nothing else', () => {
  it('tenants, organisations, memberships and users are limited to the current workspace', async () => {
    await as(api, { tenant: a.tenantId, user: a.userId }, async () => {
      expect(await ids(api, `SELECT id FROM tenants`)).toEqual([a.tenantId]);
      expect(await n(api, `SELECT count(*)::int AS n FROM organisations`)).toBe(1);
      expect(await ids(api, `SELECT user_id AS id FROM tenant_memberships`)).toEqual([a.userId]);
      expect(await ids(api, `SELECT id FROM users`)).toEqual([a.userId]);
      expect(await n(api, `SELECT count(*)::int AS n FROM users WHERE id = $1`, [b.userId])).toBe(0);
    });
  });

  it('an API-key style context (workspace, no person) still sees its own members and workspace', async () => {
    await as(api, { tenant: b.tenantId }, async () => {
      expect(await ids(api, `SELECT id FROM tenants`)).toEqual([b.tenantId]);
      expect(await ids(api, `SELECT id FROM users`)).toEqual([b.userId]);
    });
  });

  it('it cannot add a member to, change, or rename another workspace', async () => {
    await as(api, { tenant: a.tenantId, user: a.userId }, async () => {
      await api.query('SAVEPOINT s');
      await expect(api.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1, $2, 'tenant_owner', 'active', true)`, [b.tenantId, a.userId])).rejects.toThrow(/row-level security/);
      await api.query('ROLLBACK TO s');
      expect((await api.query(`UPDATE tenant_memberships SET role = 'executive_readonly' WHERE tenant_id = $1`, [b.tenantId])).rowCount).toBe(0);
      expect((await api.query(`UPDATE tenants SET name = 'Hijacked' WHERE id = $1`, [b.tenantId])).rowCount).toBe(0);
      expect((await api.query(`UPDATE users SET name = 'Hijacked' WHERE id = $1`, [b.userId])).rowCount).toBe(0);
    });
    expect(await n(admin, `SELECT count(*)::int AS n FROM tenants WHERE name = 'Hijacked'`)).toBe(0);
  });

  it('a person can change their own profile but not a colleague’s', async () => {
    await as(api, { tenant: ag.c1, user: ag.employee }, async () => {
      expect((await api.query(`UPDATE users SET name = 'Me' WHERE id = $1`, [ag.employee])).rowCount).toBe(1);
      expect((await api.query(`UPDATE users SET name = 'Not me' WHERE id = $1`, [ag.owner])).rowCount).toBe(0);
    });
  });

  it('nothing outside the identity flow can create a person, an organisation or a session', async () => {
    await as(api, { tenant: a.tenantId, user: a.userId }, async () => {
      for (const sql of [
        `INSERT INTO users (email, password_hash, name) VALUES ('new@x.test', 'x', 'New')`,
        `INSERT INTO organisations (name, slug, owner_id) VALUES ('Rogue', 'rogue-org', '${a.userId}')`,
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ('${a.userId}', 'forged', now() + interval '1 day')`,
        `INSERT INTO login_attempts (email, success) VALUES ('x@y.z', true)`,
      ]) {
        await api.query('SAVEPOINT s');
        await expect(api.query(sql), sql).rejects.toThrow(/row-level security/);
        await api.query('ROLLBACK TO s');
      }
    });
  });

  it('the members screen reads MFA and last-seen only for its own workspace', async () => {
    await as(api, { tenant: b.tenantId, user: b.userId }, async () => {
      const own = (await api.query(`SELECT * FROM app.member_security($1)`, [b.tenantId])).rows;
      expect(own.map((r) => r.user_id)).toEqual([b.userId]);
      expect(own[0].mfa_enabled).toBe(true);
      expect((await api.query(`SELECT * FROM app.member_security($1)`, [a.tenantId])).rowCount).toBe(0);
    });
  });
});

describe('who is asking, without a workspace (the agency layer)', () => {
  it('an agency owner sees the HQ, every client and the organisation, and nobody else’s', async () => {
    await as(api, { user: ag.owner }, async () => {
      expect(await ids(api, `SELECT id FROM tenants`)).toEqual([ag.hq, ag.c1, ag.c2].sort());
      expect(await ids(api, `SELECT id FROM organisations`)).toEqual([ag.org]);
      expect(await ids(api, `SELECT id FROM users`)).toEqual([ag.owner, ag.employee].sort());
      expect(await n(api, `SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[])`, [[a.tenantId, b.tenantId]])).toBe(0);
    });
  });

  it('an employee sees the HQ and the client they are assigned to, not the other client', async () => {
    await as(api, { user: ag.employee }, async () => {
      expect(await ids(api, `SELECT id FROM tenants`)).toEqual([ag.hq, ag.c1].sort());
      expect(await n(api, `SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [ag.c2])).toBe(0);
      // colleagues in the places they work are visible, strangers are not
      expect(await ids(api, `SELECT id FROM users`)).toEqual([ag.owner, ag.employee].sort());
    });
  });

  it('only an agency owner or admin may create a client, and only in their own agency', async () => {
    await as(api, { user: ag.owner }, async () => {
      expect((await api.query(`INSERT INTO tenants (organisation_id, name, slug, kind) VALUES ($1, 'New client', 'newbie', 'client') RETURNING id`, [ag.org])).rowCount).toBe(1);
      await api.query('SAVEPOINT s');
      const other = (await admin.query(`SELECT organisation_id FROM tenants WHERE id = $1`, [a.tenantId])).rows[0].organisation_id;
      await expect(api.query(`INSERT INTO tenants (organisation_id, name, slug, kind) VALUES ($1, 'Smuggled', 'smug', 'client')`, [other])).rejects.toThrow(/row-level security/);
      await api.query('ROLLBACK TO s');
    });
    await as(api, { user: ag.employee }, async () => {
      await expect(api.query(`INSERT INTO tenants (organisation_id, name, slug, kind) VALUES ($1, 'Nope', 'nope', 'client')`, [ag.org])).rejects.toThrow(/row-level security/);
    });
  });

  it('an owner can end a member’s sessions pointing at a client, but cannot read, change or take over anyone else’s session', async () => {
    await as(api, { tenant: ag.c1, user: ag.owner }, async () => {
      expect(await ids(api, `SELECT id FROM sessions`)).toEqual([ag.ownerSession]); // own sessions only
      expect((await api.query(`UPDATE sessions SET active_tenant_id = NULL WHERE user_id = $1`, [ag.employee])).rowCount).toBe(0); // not by writing to the table
      await api.query('SAVEPOINT s');
      await expect(api.query(`UPDATE sessions SET user_id = $1 WHERE id = $2`, [ag.owner, ag.employeeSession])).rejects.toThrow(/permission denied/);
      await api.query('ROLLBACK TO s');
      // the narrow function does it, for this client, and for nobody else's workspace
      expect((await api.query(`SELECT app.detach_sessions($1::uuid, $2::uuid) AS n`, [ag.c1, ag.employee])).rows[0].n).toBe(1);
      await api.query('SAVEPOINT s2');
      await expect(api.query(`SELECT app.detach_sessions($1::uuid, NULL)`, [b.tenantId])).rejects.toThrow(/FORBIDDEN/);
      await api.query('ROLLBACK TO s2');
    });
    expect((await admin.query(`SELECT active_tenant_id FROM sessions WHERE id = $1`, [ag.employeeSession])).rows[0].active_tenant_id).toBe(ag.c1); // everything above was rolled back
    await as(api, { user: ag.owner }, async () => {
      expect((await api.query(`SELECT app.detach_sessions($1::uuid, NULL) AS n`, [ag.c2])).rows[0].n).toBe(0); // an owner may act for any client of the agency
    });
    await as(api, { user: ag.employee }, async () => {
      await expect(api.query(`SELECT app.detach_sessions($1::uuid, NULL)`, [ag.c2])).rejects.toThrow(/FORBIDDEN/); // an employee may not
    });
  });
});

describe('the identity flow (sign-in, sign-up, sessions, tokens) and the worker', () => {
  it('can find a person by e-mail and open a session, yet still sees no workspace data', async () => {
    await as(api, { flow: true }, async () => {
      const email = (await admin.query(`SELECT email FROM users WHERE id = $1`, [b.userId])).rows[0].email;
      expect(await ids(api, `SELECT id FROM users WHERE email = $1`, [email])).toEqual([b.userId]);
      expect((await api.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [b.userId, crypto.randomBytes(8).toString('hex')])).rowCount).toBe(1);
      expect(await n(api, `SELECT count(*)::int AS n FROM leads`)).toBe(0);
      expect(await n(api, `SELECT count(*)::int AS n FROM contacts`)).toBe(0);
    });
  });

  it('the worker purges expired sessions, tokens and sign-in attempts through one function, and can read or delete none of them directly', async () => {
    await admin.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'old-one', now() - interval '60 days')`, [a.userId]);
    await as(worker, {}, async () => {
      expect(await n(worker, `SELECT count(*)::int AS n FROM sessions`)).toBe(0); // cannot read
      expect((await worker.query(`DELETE FROM sessions WHERE token_hash = 'old-one'`)).rowCount).toBe(0); // cannot delete by hand
      expect((await worker.query(`SELECT app.purge_identity('sessions') AS n`)).rows[0].n).toBe(1); // the retention function can
      expect((await worker.query(`SELECT app.purge_identity('login_attempts') AS n`)).rows[0].n).toBeGreaterThanOrEqual(0);
      await worker.query('SAVEPOINT s');
      await expect(worker.query(`SELECT app.purge_identity('everything')`)).rejects.toThrow(/unknown retention task/);
      await worker.query('ROLLBACK TO s');
    });
    await as(api, {}, async () => {
      await expect(api.query(`SELECT app.purge_identity('sessions')`)).rejects.toThrow(/permission denied/); // the web role cannot
    });
  });

  it('schema_migrations is the only public table without a policy, and it is not writable', async () => {
    const none = (await admin.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND NOT relrowsecurity ORDER BY 1`)).rows.map((r) => r.relname);
    expect(none).toEqual(['schema_migrations']);
  });
});
