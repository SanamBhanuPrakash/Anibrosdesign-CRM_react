import pg from 'pg';
import crypto from 'crypto';
import net from 'net';
import { config } from '../config';
import { logger } from '../../logger';

/**
 * Database access layer — the ONLY place pools are created and transactions are opened.
 *
 *  db.withTenant(ctx, fn)   tenant-scoped transaction. Sets `app.current_tenant_id` / `app.current_user_id`
 *                           with SET LOCAL semantics in the same round-trip as BEGIN, so Row-Level Security has a
 *                           trusted context and nothing can leak to the next pooled use of the connection.
 *  db.readTenant(ctx, fn)   same, READ ONLY (safe to route to a replica later).
 *  db.tx(fn)                transaction WITHOUT tenant context: identity tables (users, sessions, tokens) and
 *                           SECURITY DEFINER functions only. Under RLS, tenant tables return zero rows here.
 *  db.query(sql, params)    single statement without tenant context.
 *  db.identity              sign-in, sign-up, sessions, tokens, invitations: marks the transaction `app.identity_flow`, the only context in which
 *                           the identity tables (users, tenants, memberships, sessions, tokens) may be looked up by e-mail or token.
 *  db.asUser(userId)        a transaction that knows WHO is asking but not which workspace (the agency layer, which looks across clients).
 *                           Row-level security then shows only what that person may see (their workspaces, and every client of an agency
 *                           they own or administer).
 *  Outside these, a query on an identity table sees no rows: the policies live in migration 034.
 *
 * Rules: no raw `new pg.Pool` elsewhere; no external I/O inside a transaction callback (we retry on serialization
 * failures, so callbacks must be re-runnable); never interpolate user input into SQL.
 */

export interface DbContext {
  tenantId: string;
  userId?: string | null;
  requestId?: string;
  ip?: string;
}

export interface TxOptions {
  /** Retries on serialization_failure / deadlock_detected. Default 2. */
  retries?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function assertUuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw new Error(`[db] invalid ${what}`);
  return value;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createPool(connectionString: string, applicationName: string, max = config.DB_POOL_MAX): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 30_000,
    application_name: applicationName,
    allowExitOnIdle: false,
  });
  pool.on('error', (err) => logger.error('Idle database client error', { error: err.message }));
  return pool;
}

/** A handle with the same query/tx shape as Database, whose transactions start with an identity context. */
export interface ScopedDb {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>, opts?: TxOptions): Promise<T>;
}

class Scope implements ScopedDb {
  constructor(
    private db: Database,
    private begin: (client: pg.PoolClient) => string
  ) {}
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    return this.db.runScoped(this.begin, (c) => c.query<T>(text, params as any[]), { retries: 0 });
  }
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.db.runScoped(this.begin, fn, opts);
  }
}

export class Database {
  constructor(readonly pool: pg.Pool) {}

  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /** The identity flow (see the header). Use only for sign-in, sign-up, sessions, tokens and invitations. */
  get identity(): ScopedDb {
    return new Scope(this, () => `BEGIN; SELECT set_config('app.identity_flow', 'on', true)`);
  }

  /** Who is asking, without a workspace (see the header). */
  asUser(userId: string): ScopedDb {
    const user = assertUuid(userId, 'userId');
    return new Scope(this, (client) => `BEGIN; SELECT set_config('app.current_user_id', ${client.escapeLiteral(user)}, true)`);
  }

  /** @internal used by the scoped handles above */
  runScoped<T>(begin: (client: pg.PoolClient) => string, fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions): Promise<T> {
    return this.run(begin, fn, opts);
  }

  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.run('BEGIN', fn, opts);
  }

  async withTenant<T>(ctx: DbContext, fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.run((client) => this.beginSql(client, ctx, false), fn, opts);
  }

  async readTenant<T>(ctx: DbContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.run((client) => this.beginSql(client, ctx, true), fn, { retries: 0 });
  }

  private beginSql(client: pg.PoolClient, ctx: DbContext, readOnly: boolean): string {
    const tenant = assertUuid(ctx.tenantId, 'tenantId');
    const user = ctx.userId ? assertUuid(ctx.userId, 'userId') : '';
    const reqId = ctx.requestId && REQUEST_ID_RE.test(ctx.requestId) ? ctx.requestId : crypto.randomUUID();
    const ip = ctx.ip && net.isIP(ctx.ip) ? ctx.ip : '';
    const lit = (v: string) => client.escapeLiteral(v);
    // One round-trip: BEGIN + all context GUCs (transaction-local, third arg = true).
    return (
      `BEGIN${readOnly ? ' READ ONLY' : ''}; SELECT ` +
      `set_config('app.current_tenant_id', ${lit(tenant)}, true), ` +
      `set_config('app.current_user_id', ${lit(user)}, true), ` +
      `set_config('app.current_request_id', ${lit(reqId)}, true), ` +
      `set_config('app.current_ip', ${lit(ip)}, true)`
    );
  }

  private async run<T>(
    begin: string | ((client: pg.PoolClient) => string),
    fn: (client: pg.PoolClient) => Promise<T>,
    opts: TxOptions
  ): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let destroy = false;
      try {
        await client.query(typeof begin === 'string' ? begin : begin(client));
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err: any) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroy = true; // connection state unknown → never return it to the pool
        }
        const retryable = err?.code === '40001' || err?.code === '40P01';
        if (retryable && attempt < retries) {
          await sleep(20 * 2 ** attempt + Math.random() * 30);
          continue;
        }
        throw err;
      } finally {
        client.release(destroy);
      }
    }
  }

  stats() {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, max: (this.pool as any).options?.max };
  }

  /** Refuse (production) or warn (dev) when the runtime role would bypass RLS. */
  async assertRuntimeRoleSafe(processName: string): Promise<{ role: string; superuser: boolean; bypassRls: boolean; ownsTables: boolean }> {
    const { rows } = await this.pool.query<{ role: string; superuser: boolean; bypass: boolean; owns: boolean }>(
      `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relowner = r.oid) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`
    );
    // A table owner is exempt from row-level security unless FORCE is set, so owning tables is as unsafe as BYPASSRLS.
    const info = { role: rows[0].role, superuser: rows[0].superuser, bypassRls: rows[0].bypass, ownsTables: rows[0].owns };
    if (info.superuser || info.bypassRls || info.ownsTables) {
      const why = info.superuser ? 'a SUPERUSER' : info.bypassRls ? 'BYPASSRLS' : 'the OWNER of the tables';
      const msg = `[${processName}] database role "${info.role}" is ${why}: row-level security is NOT enforced`;
      if (config.isProduction) throw new Error(msg);
      if (!config.ALLOW_PRIVILEGED_RUNTIME_ROLE && !config.isTest) {
        logger.warn(`${msg}. Use scripts/db provisioning (crm_api_login) to enforce isolation.`);
      }
    }
    return info;
  }

  async end() {
    await this.pool.end();
  }
}

let defaultDb: Database | undefined;

/** Lazily created so tests can set DATABASE_URL before first use. */
export function getDb(): Database {
  if (!defaultDb) defaultDb = new Database(createPool(config.databaseUrl, 'anibros-api'));
  return defaultDb;
}

/** Convenience handle bound to the API pool. */
export const db: Database = new Proxy({} as Database, {
  get(_t, prop) {
    const target = getDb() as any;
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

export function createWorkerDb(): Database {
  return new Database(createPool(config.workerDatabaseUrl, 'anibros-worker', Math.max(4, Math.floor(config.DB_POOL_MAX / 2))));
}
