// READ-ONLY audit probe: legacy (pre-rebuild) routes — behaviour under the production-style restricted DB role vs the privileged dev role,
// authorisation by role, cross-tenant references, concurrency. Disposable database only. Usage: tsx audit_legacy.mts restricted|privileged
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
const { bootApi } = await import(ROOT + 'server/src/tests/support/app-harness.ts');
const restricted = process.argv[2] !== 'privileged';
const out: Record<string, unknown> = { mode: restricted ? 'restricted-db-role' : 'privileged-db-role' };
const h = await bootApi({ restricted });
const brief = (r: any) => {
  const b = r.body;
  const data = b?.data;
  return { status: r.status, shape: Array.isArray(data) ? `array(${data.length})` : data && typeof data === 'object' ? `object{${Object.keys(data).slice(0, 6).join(',')}}` : (typeof b === 'object' ? Object.keys(b ?? {}).join(',') : typeof b), err: b?.error ?? b?.detail };
};
try {
  const owner = await h.register({ emailPrefix: 'lown', organisationName: 'Legacy A' });
  const other = await h.register({ emailPrefix: 'loth', organisationName: 'Legacy B' });
  const mk = async (role: string) => {
    const u = await h.register({ emailPrefix: role.slice(0, 4) });
    await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [owner.tenantId, u.userId, role]);
    return u;
  };
  const agent = await mk('sales_agent');
  const auditor = await mk('auditor');
  const exec = await mk('executive_readonly');
  const W = { 'X-Tenant-Id': owner.tenantId };
  await owner.put(`/api/v1/pipelines/${(await owner.get('/api/v1/pipelines')).body.data[0].id}/transitions`, { restricted: false, transitions: [] });

  // seed through the rebuilt v1 API
  const lead = (await owner.post('/api/v1/leads', { contact: { firstName: 'Seed', email: `s${Date.now()}@x.test`, phone: '+919800000001' }, budgetMax: 9_000_000 })).body.data;
  const leadB = (await other.post('/api/v1/leads', { contact: { firstName: 'Bee', email: `b${Date.now()}@x.test` } })).body.data;
  const prop = (await owner.post('/api/v1/properties', { title: 'Seed flat', price: 8_000_000, propertyType: 'apartment', bedrooms: 3 })).body.data;
  const agentLead = (await agent.post('/api/v1/leads', { contact: { firstName: 'AgentOwn', email: `a${Date.now()}@x.test` } }, W)).body.data;

  // A. every legacy read as the owner
  const reads = ['/api/dashboard/metrics', '/api/dashboard/attribution', '/api/reports/overview', '/api/reports/attribution', '/api/reports/pipeline-velocity', '/api/viewings', '/api/integrations', '/api/integrations/providers', '/api/custom-fields', '/api/tenant/members', '/api/tenant/audit-logs', '/api/tenant/config'];
  const A: Record<string, unknown> = {};
  for (const p of reads) A[`GET ${p}`] = brief(await owner.get(p, W));
  A['POST /api/properties/match'] = brief(await owner.post('/api/properties/match', { budgetMax: 9_000_000, bedrooms: 3 }, W));
  out.ownerReads = A;

  // B. viewings: scheduling, listing, role checks, concurrency, cross-tenant
  const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const v1 = await owner.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: slot, durationMinutes: 30 }, W);
  const B: Record<string, unknown> = { 'owner schedules': brief(v1) };
  B['owner lists'] = brief(await owner.get('/api/viewings', W));
  B['agent lists (sees leads that are not theirs?)'] = (() => 0)();
  const agentList = await agent.get('/api/viewings', W);
  B['agent lists'] = { ...brief(agentList), rows: agentList.body?.data?.length, includesContactPII: JSON.stringify(agentList.body).includes('phone') };
  B['auditor schedules a viewing'] = brief(await auditor.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }, W));
  B['executive_readonly schedules a viewing'] = brief(await exec.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: new Date(Date.now() + 6 * 86_400_000).toISOString() }, W));
  B['other tenant schedules on owner lead+property'] = brief(await other.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: slot }));
  B['other tenant lists with owner lead filter'] = brief(await other.get(`/api/viewings?leadId=${lead.id}`));
  const racing = new Date(Date.now() + 9 * 86_400_000).toISOString();
  const race = await Promise.all(Array.from({ length: 6 }, () => owner.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: racing, durationMinutes: 30 }, W)));
  B['6 concurrent bookings of one slot → statuses'] = race.map((r: any) => r.status).sort();
  B['viewing events emitted (domain_events)'] = (await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE type LIKE 'viewing.%'`)).rows[0].n;
  B['cancel/reschedule/no-show endpoints'] = 'none registered (only GET / and POST / exist in routes/viewings.ts)';
  out.viewings = B;

  // C. integrations: secrets in config, hard-coded hasCredentials, roles, cross-tenant
  const C: Record<string, unknown> = {};
  const integ = await owner.post('/api/integrations', { provider: 'whatsapp', config: { phoneNumberId: '123', accessToken: 'EAAB-secret-token-value' } }, W);
  C['create with a token inside config'] = brief(integ);
  const listed = await owner.get('/api/integrations', W);
  C['GET returns the token in clear?'] = JSON.stringify(listed.body).includes('EAAB-secret-token-value');
  C['hasCredentials value for an integration that has no credentials stored'] = listed.body?.data?.[0]?.hasCredentials;
  C['credentials_enc column populated'] = (await h.admin.query(`SELECT (credentials_enc IS NOT NULL) AS has FROM integrations WHERE tenant_id=$1`, [owner.tenantId])).rows[0]?.has;
  C['agent lists integrations'] = brief(await agent.get('/api/integrations', W));
  const iid = integ.body?.data?.id;
  C['other tenant PATCH owner integration'] = iid ? brief(await other.patch(`/api/integrations/${iid}`, { isActive: false })) : 'n/a';
  out.integrations = C;

  // D. custom fields: validation, cross-tenant references
  const D: Record<string, unknown> = {};
  const fld = await owner.post('/api/custom-fields', { entityType: 'lead', name: 'Budget band', label: 'Budget band', fieldKey: 'budget_band', fieldType: 'number', isRequired: true, validationRegex: '^[0-9]+$' }, W);
  D['create number field (required, regex)'] = brief(fld);
  const fid = fld.body?.data?.id;
  if (fid) {
    D['save text "abc" into a number field with a digits-only regex'] = brief(await owner.put('/api/custom-fields/values', { entityType: 'lead', entityId: lead.id, values: [{ fieldId: fid, value: 'abc' }] }, W));
    D['save value for a lead id that does not exist'] = brief(await owner.put('/api/custom-fields/values', { entityType: 'lead', entityId: crypto.randomUUID(), values: [{ fieldId: fid, value: '1' }] }, W));
    await owner.put('/api/custom-fields/values', { entityType: 'lead', entityId: lead.id, values: [{ fieldId: fid, value: '42' }] }, W);
    D['other tenant writes a value using OWNER field id on its own lead'] = brief(await other.put('/api/custom-fields/values', { entityType: 'lead', entityId: leadB.id, values: [{ fieldId: fid, value: 'cross' }] }));
    D['rows tied to the owner field id from another tenant'] = (await h.admin.query(`SELECT tenant_id::text = $2 AS is_owner_tenant, count(*)::int AS n FROM custom_field_values WHERE field_id = $1 GROUP BY 1`, [fid, owner.tenantId])).rows;
    D['other tenant deletes the owner value (empty value, owner lead id)'] = brief(await other.put('/api/custom-fields/values', { entityType: 'lead', entityId: lead.id, values: [{ fieldId: fid, value: '' }] }));
    D['owner value still present afterwards'] = (await h.admin.query(`SELECT count(*)::int AS n FROM custom_field_values WHERE field_id=$1 AND entity_id=$2`, [fid, lead.id])).rows[0].n;
    D['other tenant reads owner lead values'] = brief(await other.get(`/api/custom-fields/values/lead/${lead.id}`));
    D['agent saves a value on a lead they do not own'] = brief(await agent.put('/api/custom-fields/values', { entityType: 'lead', entityId: lead.id, values: [{ fieldId: fid, value: '7' }] }, W));
  }
  out.customFields = D;

  // E. dashboard / reports scoping for an agent
  const E: Record<string, unknown> = {};
  const agentDash = await agent.get('/api/dashboard/metrics', W);
  E['agent dashboard'] = { ...brief(agentDash), totalLeadsShown: agentDash.body?.data?.totalLeads ?? agentDash.body?.data?.leads?.total ?? JSON.stringify(agentDash.body).slice(0, 120) };
  E['agent reports/overview'] = brief(await agent.get('/api/reports/overview', W));
  E['executive reports/overview'] = brief(await exec.get('/api/reports/overview', W));
  E['auditor tenant/audit-logs'] = brief(await auditor.get('/api/tenant/audit-logs', W));
  E['agent tenant/members'] = brief(await agent.get('/api/tenant/members', W));
  out.scoping = E;

  console.log('AUDIT_RESULT ' + JSON.stringify(out, null, 1));
} finally {
  await h.close();
  process.exit(0);
}
