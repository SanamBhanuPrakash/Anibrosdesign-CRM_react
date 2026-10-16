import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load .env.native if present, otherwise .env
const nativeEnvPath = path.resolve(process.cwd(), '.env.native');
if (fs.existsSync(nativeEnvPath)) {
  dotenv.config({ path: nativeEnvPath });
} else {
  dotenv.config();
}

const ADVISORY_LOCK_ID = 894723984;

export interface MigrationResult {
  version: string;
  filename: string;
  checksum: string;
  status: 'APPLIED' | 'SKIPPED' | 'FAILED';
  durationMs: number;
}

export interface RunnerOptions {
  connectionString?: string;
  migrationsDir?: string;
  verbose?: boolean;
}

export async function runMigrations(options: RunnerOptions = {}): Promise<{
  totalFound: number;
  applied: MigrationResult[];
  skipped: MigrationResult[];
}> {
  const connectionString =
    options.connectionString ||
    process.env.MIGRATOR_DATABASE_URL || // the privileged role; DATABASE_URL is the restricted runtime role when the API runs under RLS
    process.env.DATABASE_URL ||
    'postgresql://anibros:dev-only-not-a-secret@127.0.0.1:5542/anibrosdesign';

  const migrationsDir =
    options.migrationsDir || path.resolve(process.cwd(), 'database/migrations');
  const verbose = options.verbose ?? true;

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  if (verbose) {
    console.log(`[Migrate] Connected to PostgreSQL. Acquiring advisory lock (${ADVISORY_LOCK_ID})...`);
  }

  // 1. Acquire advisory lock to prevent concurrent runs
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

  try {
    // 2. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_time_ms INTEGER NOT NULL
      );
    `);

    // 3. Read migration files sorted deterministically
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // 4. Fetch already applied migrations
    const res = await client.query<{
      version: string;
      filename: string;
      checksum: string;
    }>('SELECT version, filename, checksum FROM schema_migrations ORDER BY version ASC');
    const appliedMap = new Map<string, { filename: string; checksum: string }>();
    for (const row of res.rows) {
      appliedMap.set(row.version, { filename: row.filename, checksum: row.checksum });
    }

    const appliedResults: MigrationResult[] = [];
    const skippedResults: MigrationResult[] = [];

    // 5. Process each migration in transaction
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(sqlContent, 'utf-8').digest('hex');
      const version = file.split('_')[0];

      if (appliedMap.has(version)) {
        const existing = appliedMap.get(version)!;
        if (existing.checksum !== checksum) {
          throw new Error(
            `[FATAL] Tamper detected! Migration ${file} (version ${version}) checksum mismatch.\n` +
            `  Recorded in database: ${existing.checksum}\n` +
            `  Current file hash:     ${checksum}\n` +
            `Schema history cannot be silently rewritten.`
          );
        }
        if (verbose) {
          console.log(`[Migrate] Skipping already applied: ${file} (checksum verified)`);
        }
        skippedResults.push({
          version,
          filename: file,
          checksum,
          status: 'SKIPPED',
          durationMs: 0,
        });
        continue;
      }

      if (verbose) {
        console.log(`[Migrate] Applying migration: ${file}...`);
      }
      const startTime = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(sqlContent);
        const durationMs = Date.now() - startTime;

        await client.query(
          `INSERT INTO schema_migrations (version, filename, checksum, execution_time_ms)
           VALUES ($1, $2, $3, $4)`,
          [version, file, checksum, durationMs]
        );
        await client.query('COMMIT');

        if (verbose) {
          console.log(`[Migrate] Successfully applied: ${file} (${durationMs}ms)`);
        }

        appliedResults.push({
          version,
          filename: file,
          checksum,
          status: 'APPLIED',
          durationMs,
        });
      } catch (migrationError: any) {
        await client.query('ROLLBACK');
        console.error(`[Migrate ERROR] Failed applying migration: ${file}`);
        console.error(`Reason: ${migrationError.message}`);
        throw migrationError;
      }
    }

    if (verbose) {
      console.log(`[Migrate] Migration run complete. Found=${files.length}, Applied=${appliedResults.length}, Skipped=${skippedResults.length}`);
    }

    return {
      totalFound: files.length,
      applied: appliedResults,
      skipped: skippedResults,
    };
  } finally {
    // Release advisory lock and close client
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    await client.end();
  }
}

// Direct execution from CLI
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations()
    .then((res) => {
      console.log(`Migration runner finished successfully. Applied ${res.applied.length} new migrations.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration Runner Fatal Error]:', err);
      process.exit(1);
    });
}
