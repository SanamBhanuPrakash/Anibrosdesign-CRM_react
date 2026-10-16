import type pg from 'pg';
import crypto from 'crypto';

/** Minimal tenant fixture inserted with the privileged (migrator) connection. */
export interface SeededTenant {
  tenantId: string;
  userId: string;
  email: string;
  pipelineId: string;
  firstStageId: string;
  stageIds: Record<string, string>;
}

export async function seedTenant(admin: pg.Client, slug: string, role = 'tenant_owner'): Promise<SeededTenant> {
  const email = `${slug}-${crypto.randomBytes(3).toString('hex')}@test.local`;
  const user = await admin.query(
    `INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1, 'not-a-real-hash', $2, true) RETURNING id`,
    [email, `User ${slug}`]
  );
  const userId = user.rows[0].id as string;
  const org = await admin.query(`INSERT INTO organisations (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`, [
    `Org ${slug}`,
    `${slug}-${crypto.randomBytes(3).toString('hex')}`,
    userId,
  ]);
  const tenant = await admin.query(
    `INSERT INTO tenants (organisation_id, name, slug) VALUES ($1, $2, 'main') RETURNING id`,
    [org.rows[0].id, `Tenant ${slug}`]
  );
  const tenantId = tenant.rows[0].id as string;
  await admin.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1, $2, $3::tenant_role, 'active', true)`,
    [tenantId, userId, role]
  );

  // The seed function is guarded by tenant context (migration 010).
  await admin.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
  const seeded = await admin.query(`SELECT app.seed_default_pipeline($1) AS id`, [tenantId]);
  await admin.query(`SELECT set_config('app.current_tenant_id', '', false)`);
  const pipelineId = seeded.rows[0].id as string;
  const stages = await admin.query(`SELECT id, stage_key FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY order_index`, [pipelineId]);
  const stageIds = Object.fromEntries(stages.rows.map((r) => [r.stage_key as string, r.id as string]));
  return { tenantId, userId, email, pipelineId, firstStageId: stages.rows[0].id, stageIds };
}

export async function seedLead(admin: pg.Client, t: SeededTenant, firstName = 'Test'): Promise<{ leadId: string; contactId: string }> {
  const c = await admin.query(`INSERT INTO contacts (tenant_id, first_name, email) VALUES ($1, $2, $3) RETURNING id`, [
    t.tenantId,
    firstName,
    `${firstName.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}@contact.test`,
  ]);
  const l = await admin.query(
    `INSERT INTO leads (tenant_id, contact_id, pipeline_id, stage_id, stage_key, source, owner_id)
     VALUES ($1, $2, $3, $4, 'new', 'website', $5) RETURNING id`,
    [t.tenantId, c.rows[0].id, t.pipelineId, t.firstStageId, t.userId]
  );
  return { leadId: l.rows[0].id, contactId: c.rows[0].id };
}
