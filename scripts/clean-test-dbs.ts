/**
 * Remove orphaned disposable databases/roles left behind by crashed or killed test runs.
 *   npm run test:db:clean
 * Only touches databases named `anibros_test_<pid>_<ts>_<rand>` and roles named `crm_api_t_*` / `crm_wrk_t_*`
 * (the exact patterns produced by server/src/tests/support/test-db.ts). Never touches the dev database.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ path: fs.existsSync('.env.native') ? '.env.native' : undefined, quiet: true });
const raw = process.env.DATABASE_TEST_URL || process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL;
if (!raw) throw new Error('No database URL configured');
const url = new URL(raw);
url.pathname = '/postgres';

const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
const dbs = await c.query(`SELECT datname FROM pg_database WHERE datname ~ '^anibros_test_[0-9]+_[a-z0-9]+_[0-9a-f]{4}$'`);
for (const { datname } of dbs.rows) await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(datname)} WITH (FORCE)`);
const roles = await c.query(`SELECT rolname FROM pg_roles WHERE rolname ~ '^(crm_api_t_|crm_wrk_t_)[0-9a-f]+$'`);
let dropped = 0;
for (const { rolname } of roles.rows) {
  try {
    await c.query(`DROP ROLE IF EXISTS ${c.escapeIdentifier(rolname)}`);
    dropped++;
  } catch (e) {
    console.warn(`could not drop role ${rolname}: ${(e as Error).message}`);
  }
}
await c.end();
console.log(`test-db cleanup: dropped ${dbs.rowCount} database(s), ${dropped} role(s)`);
