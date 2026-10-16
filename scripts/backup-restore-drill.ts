/**
 * Backup and restore drill. Proves a backup of the configured database can actually be restored, and that nothing was lost.
 *
 *   npm run db:restore-drill                 # uses MIGRATOR_DATABASE_URL / DATABASE_URL from .env.native
 *   PG_BIN=/usr/lib/postgresql/17/bin BACKUP_DIR=./backups npm run db:restore-drill
 *
 * What it does, in order:
 *   1. pg_dump (custom format) of the source database. The source is only READ.
 *   2. Creates a disposable database (anibros_restore_drill_<time>) on the same server and pg_restore --exit-on-error into it.
 *   3. Compares the source with the restored copy: every table's row count, the migration ledger, and the number of indexes,
 *      row-level-security policies and functions. Counts only; it never prints record contents or connection strings.
 *   4. Drops the disposable database (always, even on failure). The dump file is kept for you: it IS a usable backup.
 *
 * Exit code 0 only when the restore succeeded and every comparison matched. The role needs CREATEDB (the migrator role has it).
 * Dumps contain customer data: keep BACKUP_DIR on an encrypted volume and delete drill dumps you do not need.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: fs.existsSync('.env.native') ? '.env.native' : undefined, quiet: true });
const raw = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL;
if (!raw) throw new Error('No database URL configured (MIGRATOR_DATABASE_URL or DATABASE_URL)');

const src = new URL(raw);
const sourceDb = src.pathname.slice(1);
const bin = (name: string) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);
const outDir = path.resolve(process.env.BACKUP_DIR ?? os.tmpdir());
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const dumpFile = path.join(outDir, `anibros_${sourceDb}_${stamp}.dump`);
const drillDb = `anibros_restore_drill_${Date.now().toString(36)}`;

const conn = (database: string): pg.ClientConfig => ({
  host: src.hostname,
  port: Number(src.port || 5432),
  user: decodeURIComponent(src.username),
  password: decodeURIComponent(src.password),
  database,
});
const pgArgs = ['-h', src.hostname, '-p', src.port || '5432', '-U', decodeURIComponent(src.username)];
const env = { ...process.env, PGPASSWORD: decodeURIComponent(src.password) };

function run(tool: string, args: string[]) {
  const started = Date.now();
  const r = spawnSync(bin(tool), args, { env, encoding: 'utf8' });
  if (r.error) throw new Error(`${tool} could not be started (${r.error.message}). Install the PostgreSQL client tools or set PG_BIN.`);
  const err = (r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ');
  return { code: r.status, ms: Date.now() - started, err };
}

async function snapshot(database: string) {
  const c = new pg.Client(conn(database));
  await c.connect();
  try {
    const tables = (await c.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
    const rows: Record<string, number> = {};
    for (const t of tables) rows[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t}"`)).rows[0].n;
    const ledger = (await c.query<{ n: number; latest: string }>(`SELECT count(*)::int AS n, max(version) AS latest FROM schema_migrations`)).rows[0];
    const one = async (sql: string) => (await c.query<{ n: number }>(sql)).rows[0].n;
    return {
      rows,
      ledger,
      indexes: await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`),
      policies: await one(`SELECT count(*)::int AS n FROM pg_policies`),
      functions: await one(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname IN ('public','app')`),
    };
  } finally {
    await c.end();
  }
}

let ok = false;
const dump = run('pg_dump', [...pgArgs, '-Fc', '-f', dumpFile, sourceDb]);
const size = fs.existsSync(dumpFile) ? fs.statSync(dumpFile).size : 0;
console.log(`dump:    exit ${dump.code}, ${dump.ms} ms, ${(size / 1024).toFixed(0)} KiB -> ${dumpFile} ${dump.err}`);
if (dump.code !== 0) process.exit(1);

const admin = new pg.Client(conn('postgres'));
await admin.connect();
await admin.query(`CREATE DATABASE "${drillDb}"`);
try {
  const restore = run('pg_restore', [...pgArgs, '-d', drillDb, '--no-owner', '--exit-on-error', dumpFile]);
  console.log(`restore: exit ${restore.code}, ${restore.ms} ms into ${drillDb} ${restore.err}`);
  const a = await snapshot(sourceDb);
  const b = await snapshot(drillDb);
  const differing = Object.keys(a.rows).filter((t) => a.rows[t] !== b.rows[t] || !(t in b.rows));
  const total = (s: typeof a) => Object.values(s.rows).reduce((x, y) => x + y, 0);
  console.log(`tables:  ${Object.keys(a.rows).length} source, ${Object.keys(b.rows).length} restored; rows ${total(a)} / ${total(b)}; differing: ${differing.length ? differing.join(', ') : 'none'}`);
  console.log(`ledger:  ${a.ledger.n} migrations (latest ${a.ledger.latest}) / ${b.ledger.n} (latest ${b.ledger.latest})`);
  console.log(`schema:  indexes ${a.indexes}/${b.indexes}, policies ${a.policies}/${b.policies}, functions ${a.functions}/${b.functions}`);
  ok =
    restore.code === 0 && differing.length === 0 && a.ledger.n === b.ledger.n && a.ledger.latest === b.ledger.latest &&
    a.indexes === b.indexes && a.policies === b.policies && a.functions === b.functions;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${drillDb}" WITH (FORCE)`);
  await admin.end();
  console.log(`cleanup: ${drillDb} dropped; the backup file was kept`);
}
console.log(ok ? 'RESTORE DRILL: PASS' : 'RESTORE DRILL: FAIL');
process.exit(ok ? 0 : 1);
