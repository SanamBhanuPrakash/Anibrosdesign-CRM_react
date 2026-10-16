// READ-ONLY audit probe: legacy member endpoints vs rebuilt invariants; permission changes during active sessions. Disposable DB.
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
const { bootApi } = await import(ROOT + 'server/src/tests/support/app-harness.ts');
const h = await bootApi({ restricted: true });
const out: Record<string, unknown> = {};
const st = (r: any) => ({ status: r.status, msg: (r.body?.error ?? r.body?.detail ?? r.body?.data?.message ?? '').toString().slice(0, 120) });
try {
  const ownerA = await h.register({ emailPrefix: 'iwa', organisationName: 'Identity A' });
  const ownerB = await h.register({ emailPrefix: 'iwb', organisationName: 'Identity B' });
  const W = { 'X-Tenant-Id': ownerA.tenantId };
  const admin = await h.register({ emailPrefix: 'iwadm' });
  await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'tenant_admin','active',true)`, [ownerA.tenantId, admin.userId]);

  // 1. legacy invite of an existing user from another workspace: immediate membership, no consent, different response than unknown email
  const stranger = await h.register({ emailPrefix: 'strng', organisationName: 'Stranger Co' });
  out['legacy invite: existing user (other workspace) → added at once, any role'] = st(await ownerA.post('/api/tenant/members/invite', { email: stranger.email, role: 'sales_manager' }, W));
  out['legacy invite: unknown address → different message (user enumeration)'] = st(await ownerA.post('/api/tenant/members/invite', { email: `nobody${Date.now()}@example.com`, role: 'sales_agent' }, W));
  out['membership row created for the stranger without any acceptance'] = (await h.admin.query(`SELECT role, status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [ownerA.tenantId, stranger.userId])).rows;
  out['mail jobs queued by the legacy invite'] = (await h.admin.query(`SELECT count(*)::int AS n FROM jobs WHERE type='mail.send' AND created_at > now() - interval '1 minute' AND payload::text LIKE '%invit%'`)).rows[0].n;
  out['audit rows written by the legacy invite'] = (await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action ILIKE '%invit%' OR action ILIKE '%member%'`, [ownerA.tenantId])).rows[0].n;

  // 2. last-owner invariant under a race (two owners revoke each other at once)
  const second = await h.register({ emailPrefix: 'own2' });
  await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'tenant_owner','active',true)`, [ownerA.tenantId, second.userId]);
  const memOf = async (uid: string) => (await h.admin.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [ownerA.tenantId, uid])).rows[0].id;
  const [m1, m2] = [await memOf(ownerA.userId), await memOf(second.userId)];
  const race = await Promise.all([
    ownerA.delete(`/api/tenant/members/${m2}`, W),
    second.delete(`/api/tenant/members/${m1}`, W),
  ]);
  out['legacy revoke race (two owners revoke each other) → statuses'] = race.map((r: any) => r.status);
  out['active owners left after the race (v1 guarantees ≥ 1)'] = (await h.admin.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='tenant_owner' AND status='active'`, [ownerA.tenantId])).rows[0].n;
  // restore for later checks
  await h.admin.query(`UPDATE tenant_memberships SET status='active', is_active=true, role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2`, [ownerA.tenantId, ownerA.userId]);

  // 3. sessions after a legacy revoke (v1 revokes sessions; legacy only flips the membership)
  const victim = await h.register({ emailPrefix: 'victim' });
  await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'sales_agent','active',true)`, [ownerA.tenantId, victim.userId]);
  const before = await victim.get('/api/v1/tasks', W);
  const vm = await memOf(victim.userId);
  await ownerA.delete(`/api/tenant/members/${vm}`, W);
  const afterRevoke = await victim.get('/api/v1/tasks', W);
  out['revoked member: request right after legacy revoke'] = { before: before.status, after: afterRevoke.status };

  // 4. role change takes effect on the very next request (no stale role in the session)
  const agent = await h.register({ emailPrefix: 'rolechg' });
  await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'sales_agent','active',true)`, [ownerA.tenantId, agent.userId]);
  const r1 = await agent.get('/api/v1/lead-sources', W);
  await h.admin.query(`UPDATE tenant_memberships SET role='marketing_manager' WHERE tenant_id=$1 AND user_id=$2`, [ownerA.tenantId, agent.userId]);
  const r2 = await agent.get('/api/v1/lead-sources', W);
  await h.admin.query(`UPDATE tenant_memberships SET status='revoked', is_active=false WHERE tenant_id=$1 AND user_id=$2`, [ownerA.tenantId, agent.userId]);
  const r3 = await agent.get('/api/v1/lead-sources', W);
  out['role change mid-session: agent → marketing_manager → revoked'] = [r1.status, r2.status, r3.status];

  // 5. spoofing the tenant header
  out['other workspace owner sends X-Tenant-Id of A'] = st(await ownerB.get('/api/v1/leads', W));

  console.log('AUDIT_RESULT ' + JSON.stringify(out, null, 1));
} finally {
  await h.close();
  process.exit(0);
}
