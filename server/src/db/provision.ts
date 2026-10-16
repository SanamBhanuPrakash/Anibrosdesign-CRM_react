import pg from 'pg';

/**
 * Role provisioning — creates the LOGIN roles that the API and worker processes use at runtime.
 *
 * Why this is not in a SQL migration: migrations are committed to git; credentials must never be.
 * Group roles (crm_app_user, crm_worker) and all grants/policies live in migrations; this script only
 * creates the login roles, assigns their passwords (from the environment) and sets per-role safety timeouts.
 *
 * Idempotent: safe to run on every deploy. Must be run with a privileged (CREATEROLE) connection.
 */
export const API_LOGIN_ROLE = 'crm_api_login';
export const WORKER_LOGIN_ROLE = 'crm_worker_login';

export interface ProvisionOptions {
  /** Privileged connection (migrator / superuser) to the TARGET database. */
  adminConnectionString: string;
  apiPassword: string;
  workerPassword: string;
  /** Login role names; override in tests so a disposable run never touches the dev environment's credentials. */
  apiRole?: string;
  workerRole?: string;
}

const MIN_PASSWORD_LENGTH = 16;

export async function provisionRoles(opts: ProvisionOptions): Promise<void> {
  if (opts.apiPassword.length < MIN_PASSWORD_LENGTH || opts.workerPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`[provision] DB role passwords must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (opts.apiPassword === opts.workerPassword) {
    throw new Error('[provision] API and worker DB passwords must differ');
  }

  const client = new pg.Client({ connectionString: opts.adminConnectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const db = rows[0].db;
    const dbIdent = client.escapeIdentifier(db);

    const ensureLogin = async (role: string, password: string, group: string, settings: Record<string, string>) => {
      const ident = client.escapeIdentifier(role);
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const pwd = client.escapeLiteral(password);
      if (exists.rowCount === 0) {
        await client.query(
          `CREATE ROLE ${ident} LOGIN PASSWORD ${pwd} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`
        );
      } else {
        await client.query(
          `ALTER ROLE ${ident} LOGIN PASSWORD ${pwd} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`
        );
      }
      await client.query(`GRANT ${client.escapeIdentifier(group)} TO ${ident}`);
      await client.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${ident}`);
      for (const [key, value] of Object.entries(settings)) {
        // Role-level defaults: a runaway query or a leaked transaction cannot hold the database hostage.
        await client.query(`ALTER ROLE ${ident} SET ${key} = ${client.escapeLiteral(value)}`);
      }
    };

    await ensureLogin(opts.apiRole ?? API_LOGIN_ROLE, opts.apiPassword, 'crm_app_user', {
      statement_timeout: '15s',
      lock_timeout: '5s',
      idle_in_transaction_session_timeout: '30s',
      application_name: 'anibros-api',
    });
    await ensureLogin(opts.workerRole ?? WORKER_LOGIN_ROLE, opts.workerPassword, 'crm_worker', {
      statement_timeout: '60s',
      lock_timeout: '10s',
      idle_in_transaction_session_timeout: '60s',
      application_name: 'anibros-worker',
    });
  } finally {
    await client.end();
  }
}

/** Build a connection string for a login role from an admin connection string (same host/db). */
export function withCredentials(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user; // URL setters percent-encode; do not pre-encode
  url.password = password;
  return url.toString();
}
