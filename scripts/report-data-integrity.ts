/**
 * READ-ONLY data-integrity report. Changes nothing, prints counts and ids only (never record contents).
 *
 *   npm run db:report-integrity          # uses MIGRATOR_DATABASE_URL / DATABASE_URL from .env.native
 *
 * Run it BEFORE applying migration 021 (which refuses to continue when cross-workspace custom-field links exist) and any time you
 * want to know whether old code paths left inconsistent rows behind. It never repairs anything: repairs are explicit, reviewed steps.
 *
 * Findings reported:
 *   1. custom_field_values rows whose field definition belongs to ANOTHER workspace (cross-tenant link; audit finding S-1)
 *   2. leads whose status disagrees with the status of their stage (the old viewing function set the status directly)
 *   3. viewings that reference archived leads/properties, or an agent who is not an active member of the workspace
 *   4. settings blobs written by the retired Automation / Integrations / Custom Fields screens (preserved, listed for the owner)
 *   5. workspaces whose settings.timezone (written by the old Tenant Configuration page) differs from the tenants.timezone column
 */
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ path: fs.existsSync('.env.native') ? '.env.native' : undefined, quiet: true });
const raw = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL;
if (!raw) throw new Error('No database URL configured (MIGRATOR_DATABASE_URL or DATABASE_URL)');

const c = new pg.Client({ connectionString: raw });
await c.connect();
await c.query('SET default_transaction_read_only = on');

const sample = (rows: Array<Record<string, unknown>>, key: string) => rows.slice(0, 10).map((r) => String(r[key]));
let problems = 0;

async function report(title: string, sql: string, key: string, note: string) {
  const { rows } = await c.query(sql);
  const n = rows.length;
  if (n) problems++;
  console.log(`${n === 0 ? 'OK   ' : 'FOUND'}  ${title}: ${n}${n ? `   e.g. ${sample(rows, key).join(', ')}${n > 10 ? ' …' : ''}` : ''}`);
  if (n) console.log(`        → ${note}`);
}

const hasTable = async (t: string) => (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`])).rows[0].ok as boolean;

if (await hasTable('custom_field_values')) {
  await report(
    '1. custom-field values linked to another workspace’s field definition',
    `SELECT v.id FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_id WHERE d.tenant_id <> v.tenant_id`,
    'id',
    'Migration 021 will REFUSE to run until these rows are reviewed. They are not deleted automatically.'
  );
}
await report(
  '2. leads whose status differs from their stage’s status',
  `SELECT l.id FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id WHERE l.status IS DISTINCT FROM s.maps_to_status`,
  'id',
  'The stage is authoritative. Migration 021 stops new drift; existing rows are repaired only by an explicit, audited step.'
);
if (await hasTable('viewings')) {
  await report(
    '3a. viewings on archived leads or properties',
    `SELECT v.id FROM viewings v LEFT JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id LEFT JOIN properties p ON p.id = v.property_id AND p.tenant_id = v.tenant_id
      WHERE l.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL`,
    'id',
    'Informational: archived after booking is legitimate; the new rules only stop NEW bookings on archived records.'
  );
  await report(
    '3b. viewings whose agent is not an active member of the workspace',
    `SELECT v.id FROM viewings v WHERE v.agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = v.tenant_id AND m.user_id = v.agent_id AND m.status = 'active' AND m.is_active)`,
    'id',
    'Possible cross-workspace agent reference (or a member removed later). Review before relying on agent names.'
  );
}
for (const key of ['automation_rules', 'integrations', 'custom_fields']) {
  await report(
    `4. settings blob "${key}" written by a retired screen`,
    `SELECT id FROM tenants WHERE settings ? '${key}'`,
    'id',
    'Preserved untouched. Nothing reads it; the rebuilt features will not import it silently.'
  );
}
await report(
  '5. settings.timezone differs from the tenants.timezone column',
  `SELECT id FROM tenants WHERE settings ? 'timezone' AND settings->>'timezone' IS DISTINCT FROM timezone`,
  'id',
  'Reminders use the column. The workspace owner should confirm which value is right.'
);

await c.end();
console.log(problems ? `\n${problems} finding group(s). Nothing was changed.` : '\nNo findings.');
process.exit(0);
