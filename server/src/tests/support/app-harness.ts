import request from 'supertest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from './test-db';

/**
 * Boots the real Express app against a disposable database.
 *  restricted: true  → the app connects as the production-style restricted role (RLS enforced). Default for new modules.
 *  restricted: false → legacy mode (superuser) for routes that still use un-scoped queries; shrinks to zero as modules are ported.
 */
export interface AuthedUser {
  email: string;
  password: string;
  name: string;
  userId: string;
  tenantId: string;
  cookies: string[];
  csrf: string;
  /** supertest helpers pre-loaded with this user's session cookie + CSRF header */
  get(path: string, headers?: Record<string, string>): request.Test;
  post(path: string, body?: object, headers?: Record<string, string>): request.Test;
  patch(path: string, body?: object, headers?: Record<string, string>): request.Test;
  put(path: string, body?: object, headers?: Record<string, string>): request.Test;
  delete(path: string, headers?: Record<string, string>): request.Test;
}

export interface ApiHarness {
  app: import('express').Express;
  tdb: TestDatabase;
  admin: pg.Client;
  mail: import('../../platform/mail').MemoryTransport;
  /** Run all runnable background jobs (mail delivery, …) to completion on the WORKER role. */
  runJobs(): Promise<void>;
  /** Sign up + verify a brand-new user/workspace through the public API. */
  register(opts?: { name?: string; organisationName?: string; password?: string; emailPrefix?: string; legacyPipeline?: boolean }): Promise<AuthedUser>;
  loginAs(email: string, password: string): Promise<AuthedUser>;
  as(user: Pick<AuthedUser, 'cookies' | 'csrf'>): Pick<AuthedUser, 'get' | 'post' | 'patch' | 'put' | 'delete'>;
  close(): Promise<void>;
}

export function cookiesFrom(res: request.Response): { cookies: string[]; csrf: string } {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const pairs = list.map((c) => c.split(';')[0]);
  const csrf = pairs.find((c) => c.startsWith('anibrosdesign_csrf='))?.split('=')[1] ?? '';
  return { cookies: pairs, csrf };
}

export async function bootApi(opts: { restricted?: boolean } = {}): Promise<ApiHarness> {
  const restricted = opts.restricted ?? true;
  const tdb = await createTestDatabase();
  const admin = new pg.Client({ connectionString: tdb.adminUrl });
  await admin.connect();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = restricted ? tdb.apiUrl : tdb.adminUrl;
  process.env.WORKER_DATABASE_URL = tdb.workerUrl;
  process.env.MIGRATOR_DATABASE_URL = tdb.adminUrl;

  const { app } = await import('../../app');
  const { getDb, createWorkerDb } = await import('../../platform/db');
  const { memoryTransport, mailSendHandler } = await import('../../platform/mail');
  const { JobRunner } = await import('../../platform/jobs');
  const { jobHandlers } = await import('../../worker');
  const workerDb = createWorkerDb();
  memoryTransport.clear();

  const runJobs = async () => {
    await new JobRunner(workerDb, { ...jobHandlers, 'mail.send': mailSendHandler }, { concurrency: 4 }).drain();
  };

  const as = (u: Pick<AuthedUser, 'cookies' | 'csrf'>) => {
    const withAuth = (t: request.Test, headers?: Record<string, string>) => {
      t.set('Cookie', u.cookies).set('x-csrf-token', u.csrf);
      for (const [k, v] of Object.entries(headers ?? {})) t.set(k, v);
      return t;
    };
    return {
      get: (p: string, h?: Record<string, string>) => withAuth(request(app).get(p), h),
      post: (p: string, b?: object, h?: Record<string, string>) => withAuth(request(app).post(p).send(b ?? {}), h),
      patch: (p: string, b?: object, h?: Record<string, string>) => withAuth(request(app).patch(p).send(b ?? {}), h),
      put: (p: string, b?: object, h?: Record<string, string>) => withAuth(request(app).put(p).send(b ?? {}), h),
      delete: (p: string, h?: Record<string, string>) => withAuth(request(app).delete(p), h),
    };
  };

  const toUser = (res: request.Response, email: string, password: string, name: string): AuthedUser => {
    const { cookies, csrf } = cookiesFrom(res);
    return { email, password, name, userId: res.body.data.user.id, tenantId: res.body.data.activeTenantId, cookies, csrf, ...as({ cookies, csrf }) };
  };

  let counter = 0;
  const register: ApiHarness['register'] = async (o = {}) => {
    const email = `${o.emailPrefix ?? 'user'}${Date.now().toString(36)}${counter++}@anibros.test`;
    const password = o.password ?? 'Horse-Battery-Staple-9';
    const name = o.name ?? 'Test Person';
    const s = await request(app).post('/api/v1/auth/signup').send({ email, password, name, organisationName: o.organisationName ?? `Org ${counter}` });
    if (s.status !== 202) throw new Error(`signup failed: ${s.status} ${JSON.stringify(s.body)}`);
    await runJobs();
    const token = memoryTransport.tokenFor(email, 'Verify');
    if (!token) throw new Error('verification email was not delivered');
    const v = await request(app).post('/api/v1/auth/verify-email').send({ token });
    if (v.status !== 200) throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
    const user = toUser(v, email, password, name);
    // New workspaces start with the recommended pipeline. Suites about the ORIGINAL seeded rules (an existing workspace) ask for that one instead.
    if (o.legacyPipeline) {
      await admin.query(`UPDATE pipelines SET is_default = false, archived_at = now() WHERE tenant_id = $1 AND archived_at IS NULL`, [user.tenantId]);
      await admin.query(`SELECT app.seed_default_pipeline_unsafe($1)`, [user.tenantId]);
    }
    return user;
  };

  const loginAs: ApiHarness['loginAs'] = async (email, password) => {
    const r = await request(app).post('/api/v1/auth/login').send({ email, password });
    if (r.status !== 200 || r.body.data.status !== 'authenticated') throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return toUser(r, email, password, '');
  };

  return {
    app,
    tdb,
    admin,
    mail: memoryTransport,
    runJobs,
    register,
    loginAs,
    as,
    async close() {
      await admin.end();
      await workerDb.end();
      await getDb().end();
      await tdb.drop();
    },
  };
}
