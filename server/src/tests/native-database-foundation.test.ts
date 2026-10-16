import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { runMigrations } from '../db/migrate';
import { createTestDatabase, type TestDatabase } from './support/test-db';

const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
const expectedMigrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

describe('Native PostgreSQL Database Foundation Integration Test Suite', () => {
  let db: TestDatabase;
  let adminClient: pg.Client;
  let apiUrl: string;

  beforeAll(async () => {
    // Fresh, empty, uniquely named database. Migrations are applied by test 1 so bootstrap is itself under test.
    db = await createTestDatabase({ migrate: false });
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    const dbName = (await adminClient.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!dbName.toLowerCase().includes('test')) throw new Error('[SAFETY] target database must contain "test"');
  });

  afterAll(async () => {
    await adminClient.end();
    await db.drop();
  });

  it('1. Bootstraps a completely empty database from new migrations in correct order', async () => {
    const res = await runMigrations({
      connectionString: db.adminUrl,
      migrationsDir,
      verbose: false,
    });

    expect(res.totalFound).toBe(expectedMigrationFiles.length);
    expect(res.applied.length).toBe(expectedMigrationFiles.length);
    expect(res.skipped.length).toBe(0);

    const check = await adminClient.query('SELECT filename FROM schema_migrations ORDER BY version ASC');
    expect(check.rows.map((r) => r.filename)).toEqual(expectedMigrationFiles);

    // Runtime login roles are provisioned out-of-band (no credentials in git)
    await db.provision();
    apiUrl = db.apiUrl;
  });

  it('2. Idempotent re-run does not duplicate or reapply already-applied migrations', async () => {
    const res = await runMigrations({
      connectionString: db.adminUrl,
      migrationsDir,
      verbose: false,
    });

    expect(res.totalFound).toBe(expectedMigrationFiles.length);
    expect(res.applied.length).toBe(0);
    expect(res.skipped.length).toBe(expectedMigrationFiles.length);
  });

  it('3. Detects checksum tampering on previously applied migrations and halts', async () => {
    // Tamper with checksum in schema_migrations
    await adminClient.query(
      "UPDATE schema_migrations SET checksum = 'tampered_sha256_hash_12345' WHERE version = '001'"
    );

    let caughtError: Error | null = null;
    try {
      await runMigrations({
        connectionString: db.adminUrl,
        migrationsDir,
        verbose: false,
      });
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Tamper detected');

    // Restore legitimate checksum
    const sqlContent = fs.readFileSync(path.join(migrationsDir, '001_core_identity_and_tenancy.sql'), 'utf-8');
    const crypto = await import('crypto');
    const validChecksum = crypto.createHash('sha256').update(sqlContent, 'utf-8').digest('hex');
    await adminClient.query(
      'UPDATE schema_migrations SET checksum = $1 WHERE version = $2',
      [validChecksum, '001']
    );
  });

  it('4. Enforces tenant boundary integrity via composite foreign keys (cross-tenant rejection)', async () => {
    // 1. Create two distinct users
    const u1 = await adminClient.query(
      "INSERT INTO users (email, password_hash, name) VALUES ('alice@tenant1.com', 'hash1', 'Alice') RETURNING id"
    );
    const u2 = await adminClient.query(
      "INSERT INTO users (email, password_hash, name) VALUES ('bob@tenant2.com', 'hash2', 'Bob') RETURNING id"
    );

    // 2. Create two organisations and two tenants
    const org1 = await adminClient.query(
      "INSERT INTO organisations (name, slug, owner_id) VALUES ('Org One', 'org-1', $1) RETURNING id",
      [u1.rows[0].id]
    );
    const org2 = await adminClient.query(
      "INSERT INTO organisations (name, slug, owner_id) VALUES ('Org Two', 'org-2', $1) RETURNING id",
      [u2.rows[0].id]
    );

    const t1 = await adminClient.query(
      "INSERT INTO tenants (organisation_id, name, slug) VALUES ($1, 'Tenant One', 't1') RETURNING id",
      [org1.rows[0].id]
    );
    const t2 = await adminClient.query(
      "INSERT INTO tenants (organisation_id, name, slug) VALUES ($1, 'Tenant Two', 't2') RETURNING id",
      [org2.rows[0].id]
    );

    const tenant1Id = t1.rows[0].id;
    const tenant2Id = t2.rows[0].id;

    // Seeding is guarded: a session may only seed the tenant it is currently scoped to (migration 010).
    await adminClient.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenant1Id]);
    let crossSeedError: any = null;
    try {
      await adminClient.query('SELECT app.seed_default_pipeline($1)', [tenant2Id]);
    } catch (err: any) {
      crossSeedError = err;
    }
    expect(crossSeedError?.message).toContain('FORBIDDEN');

    const p1Res = await adminClient.query("SELECT app.seed_default_pipeline($1) AS p_id", [tenant1Id]);
    await adminClient.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenant2Id]);
    const p2Res = await adminClient.query("SELECT app.seed_default_pipeline($1) AS p_id", [tenant2Id]);
    await adminClient.query("SELECT set_config('app.current_tenant_id', '', false)");

    const pipeline1Id = p1Res.rows[0].p_id;
    const pipeline2Id = p2Res.rows[0].p_id;

    const s1Res = await adminClient.query(
      "SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'new'",
      [pipeline1Id]
    );
    const s2Res = await adminClient.query(
      "SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'new'",
      [pipeline2Id]
    );

    const stage1Id = s1Res.rows[0].id;
    const stage2Id = s2Res.rows[0].id;

    // 3. Create contact in Tenant 1, contact in Tenant 2
    const c1 = await adminClient.query(
      "INSERT INTO contacts (tenant_id, first_name, email) VALUES ($1, 'John', 'john@c1.com') RETURNING id",
      [tenant1Id]
    );
    const c2 = await adminClient.query(
      "INSERT INTO contacts (tenant_id, first_name, email) VALUES ($1, 'Mary', 'mary@c2.com') RETURNING id",
      [tenant2Id]
    );

    // 4. ATTEMPT CROSS-TENANT INSERT: Lead in Tenant 1 referencing Contact from Tenant 2
    let crossTenantContactError: any = null;
    try {
      await adminClient.query(
        `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, source)
         VALUES ($1, $2, $3, $4, 'website')`,
        [tenant1Id, c2.rows[0].id, pipeline1Id, stage1Id]
      );
    } catch (err: any) {
      crossTenantContactError = err;
    }

    expect(crossTenantContactError).not.toBeNull();
    expect(crossTenantContactError.message).toContain('violates foreign key constraint');

    // 5. ATTEMPT CROSS-TENANT INSERT: Lead in Tenant 1 referencing Stage from Tenant 2
    let crossTenantStageError: any = null;
    try {
      await adminClient.query(
        `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, source)
         VALUES ($1, $2, $3, $4, 'website')`,
        [tenant1Id, c1.rows[0].id, pipeline1Id, stage2Id]
      );
    } catch (err: any) {
      crossTenantStageError = err;
    }

    expect(crossTenantStageError).not.toBeNull();
    expect(crossTenantStageError.message).toContain('violates foreign key constraint');

    // 6. Legitimate insert in Tenant 1 succeeds
    const lead1 = await adminClient.query(
      `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, stage_key, source, estimated_value)
       VALUES ($1, $2, $3, $4, 'new', 'website', 500000) RETURNING id`,
      [tenant1Id, c1.rows[0].id, pipeline1Id, stage1Id]
    );
    expect(lead1.rows[0].id).toBeDefined();
  });

  it('5. Enforces real-estate viewing scheduling invariants (interval overlap & availability)', async () => {
    const tenantRes = await adminClient.query("SELECT id FROM tenants WHERE slug = 't1'");
    const tenantId = tenantRes.rows[0].id;
    const userRes = await adminClient.query("SELECT id FROM users WHERE email = 'alice@tenant1.com'");
    const userId = userRes.rows[0].id;
    const leadRes = await adminClient.query("SELECT id FROM leads WHERE tenant_id = $1 LIMIT 1", [tenantId]);
    const leadId = leadRes.rows[0].id;

    // Create property in Tenant 1
    const prop = await adminClient.query(
      "INSERT INTO properties (tenant_id, title, price, status) VALUES ($1, 'Luxury Villa 101', 25000000, 'available') RETURNING id",
      [tenantId]
    );
    const propertyId = prop.rows[0].id;

    // The person booking must be an active member of the workspace (migration 021 refuses anyone else as the agent)
    await adminClient.query(
      "INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1, $2, 'sales_agent', 'active', true) ON CONFLICT DO NOTHING",
      [tenantId, userId]
    );

    // Set tenant context for app functions
    await adminClient.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
    await adminClient.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);

    // 1. Schedule initial viewing: 10:00 to 10:30 (30 minutes)
    const viewing1Res = await adminClient.query(
      "SELECT app.schedule_viewing($1, $2, '2026-11-01T10:00:00Z', 30, 'First viewing') AS res",
      [leadId, propertyId]
    );
    expect(viewing1Res.rows[0].res.success).toBe(true);

    // 2. ATTEMPT OVERLAPPING BOOKING WITH DIFFERENT START TIME: 10:15 to 10:45 (Overlaps 10:00-10:30)
    let overlapError: any = null;
    try {
      await adminClient.query(
        "SELECT app.schedule_viewing($1, $2, '2026-11-01T10:15:00Z', 30, 'Overlapping viewing') AS res",
        [leadId, propertyId]
      );
    } catch (err: any) {
      overlapError = err;
    }
    expect(overlapError).not.toBeNull();
    expect(overlapError.message).toContain('SLOT_OCCUPIED');

    // 3. ATTEMPT NON-OVERLAPPING BOOKING: 10:30 to 11:00 (Starts when first viewing ends) -> MUST SUCCEED
    const nonOverlapRes = await adminClient.query(
      "SELECT app.schedule_viewing($1, $2, '2026-11-01T10:30:00Z', 30, 'Second contiguous viewing') AS res",
      [leadId, propertyId]
    );
    expect(nonOverlapRes.rows[0].res.success).toBe(true);

    // 4a. An 'under_offer' unit can still be viewed (decision D6)
    const underOffer = await adminClient.query(
      "INSERT INTO properties (tenant_id, title, price, status) VALUES ($1, 'Penthouse 201', 45000000, 'under_offer') RETURNING id",
      [tenantId]
    );
    const underOfferRes = await adminClient.query(
      "SELECT app.schedule_viewing($1, $2, '2026-11-01T13:00:00Z', 30, 'Under offer viewing') AS res",
      [leadId, underOffer.rows[0].id]
    );
    expect(underOfferRes.rows[0].res.success).toBe(true);

    // 4b. ATTEMPT BOOKING ON UNAVAILABLE PROPERTY: a 'reserved' unit is refused
    const prop2 = await adminClient.query(
      "INSERT INTO properties (tenant_id, title, price, status) VALUES ($1, 'Penthouse 202', 45000000, 'reserved') RETURNING id",
      [tenantId]
    );
    let unavailableError: any = null;
    try {
      await adminClient.query(
        "SELECT app.schedule_viewing($1, $2, '2026-11-01T14:00:00Z', 30, 'Booking unavailable') AS res",
        [leadId, prop2.rows[0].id]
      );
    } catch (err: any) {
      unavailableError = err;
    }
    expect(unavailableError).not.toBeNull();
    expect(unavailableError.message).toContain('PROPERTY_UNAVAILABLE');
  });

  it('6. Enforces least-privilege on application runtime role (crm_app_user)', async () => {
    const appClient = new pg.Client({
      connectionString: apiUrl,
    });
    await appClient.connect();

    try {
      // 1. DDL MUST FAIL (permission denied for table creation)
      let ddlError: any = null;
      try {
        await appClient.query('CREATE TABLE unauthorized_test_table (id INT);');
      } catch (err: any) {
        ddlError = err;
      }
      expect(ddlError).not.toBeNull();
      expect(ddlError.message).toContain('permission denied');

      // 2. Audit logs mutation MUST FAIL (append-only security requirement)
      let auditDeleteError: any = null;
      try {
        await appClient.query('DELETE FROM audit_logs;');
      } catch (err: any) {
        auditDeleteError = err;
      }
      expect(auditDeleteError).not.toBeNull();
      expect(auditDeleteError.message).toContain('permission denied');
    } finally {
      await appClient.end();
    }
  });

  it('7. Enforces Row-Level Security (RLS) under runtime role crm_app_user', async () => {
    const appClient = new pg.Client({
      connectionString: apiUrl,
    });
    await appClient.connect();

    try {
      const t1Res = await adminClient.query("SELECT id FROM tenants WHERE slug = 't1'");
      const tenant1Id = t1Res.rows[0].id;
      const t2Res = await adminClient.query("SELECT id FROM tenants WHERE slug = 't2'");
      const tenant2Id = t2Res.rows[0].id;

      // 1. Query without setting tenant context -> RLS yields 0 rows
      const unauthLeads = await appClient.query('SELECT * FROM leads');
      expect(unauthLeads.rows.length).toBe(0);

      // 2. Query within transaction with Tenant 1 context -> yields Tenant 1 leads
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant1Id]);
      const t1Leads = await appClient.query('SELECT * FROM leads');
      expect(t1Leads.rows.length).toBe(1);
      await appClient.query('COMMIT');

      // 3. Query within transaction with Tenant 2 context -> yields 0 rows (isolation verified)
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant2Id]);
      const t2Leads = await appClient.query('SELECT * FROM leads');
      expect(t2Leads.rows.length).toBe(0);
      await appClient.query('COMMIT');
    } finally {
      await appClient.end();
    }
  });

  it('8. Enforces pipeline stage transitions (allows legal, rejects illegal transitions)', async () => {
    const t1Res = await adminClient.query("SELECT id FROM tenants WHERE slug = 't1'");
    const tenant1Id = t1Res.rows[0].id;
    const leadRes = await adminClient.query("SELECT id, pipeline_id, stage_id FROM leads WHERE tenant_id = $1 LIMIT 1", [tenant1Id]);
    const leadId = leadRes.rows[0].id;
    const pipelineId = leadRes.rows[0].pipeline_id;

    // Get stage IDs for 'contact_attempted' and 'won'
    const sContactAttempted = await adminClient.query(
      "SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'contact_attempted'",
      [pipelineId]
    );
    const sWon = await adminClient.query(
      "SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND stage_key = 'won'",
      [pipelineId]
    );

    await adminClient.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenant1Id]);

    // 1. ATTEMPT ILLEGAL DIRECT TRANSITION: from 'new' directly to 'won' -> MUST BE REJECTED
    let illegalTransitionError: any = null;
    try {
      await adminClient.query(
        'SELECT app.transition_lead_stage($1, $2, $3) AS res',
        [leadId, sWon.rows[0].id, 'Illegal skip']
      );
    } catch (err: any) {
      illegalTransitionError = err;
    }
    expect(illegalTransitionError).not.toBeNull();
    expect(illegalTransitionError.message).toContain('ILLEGAL_TRANSITION');

    // 2. ATTEMPT LEGAL TRANSITION: from 'new' to 'contact_attempted' -> MUST SUCCEED
    const validRes = await adminClient.query(
      'SELECT app.transition_lead_stage($1, $2, $3) AS res',
      [leadId, sContactAttempted.rows[0].id, 'Agent called lead']
    );
    expect(validRes.rows[0].res.success).toBe(true);

    // Verify lead stage updated and audit log inserted
    const updatedLead = await adminClient.query('SELECT stage_id, stage_key FROM leads WHERE id = $1', [leadId]);
    expect(updatedLead.rows[0].stage_id).toBe(sContactAttempted.rows[0].id);
    expect(updatedLead.rows[0].stage_key).toBe('contact_attempted');
  });
});
