// READ-ONLY audit probe: do legacy dashboard/report numbers reconcile with the rebuilt source records? Disposable DB.
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
const { bootApi } = await import(ROOT + 'server/src/tests/support/app-harness.ts');
const out: Record<string, unknown> = {};
for (const restricted of [process.argv[2] === 'restricted']) {
  const h = await bootApi({ restricted });
  try {
    const owner = await h.register({ emailPrefix: 'rown', organisationName: 'Reports A' });
    const pl = (await owner.get('/api/v1/pipelines')).body.data[0];
    await owner.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await owner.post('/api/v1/leads', { contact: { firstName: `R${i}`, email: `r${i}${Date.now()}@x.test` }, estimatedValue: 1_000_000 * (i + 1), source: i % 2 ? 'meta_ads' : 'referral' })).body.data.id);
    // move two leads forward, archive one, close one as lost
    const stages = pl.stages;
    await owner.post(`/api/v1/leads/${ids[0]}/stage`, { stageId: stages[1].id });
    await owner.post(`/api/v1/leads/${ids[1]}/stage`, { stageId: stages[2].id });
    await owner.delete(`/api/v1/leads/${ids[2]}`);
    const truth = {
      v1_list_total: (await owner.get('/api/v1/leads?limit=200')).body.data.length,
      db_live_leads: (await h.admin.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id=$1 AND deleted_at IS NULL`, [owner.tenantId])).rows[0].n,
      db_all_leads_including_archived: (await h.admin.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id=$1`, [owner.tenantId])).rows[0].n,
      db_status_counts: (await h.admin.query(`SELECT status::text, count(*)::int AS n FROM leads WHERE tenant_id=$1 AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`, [owner.tenantId])).rows,
      db_pipeline_value_live: Number((await h.admin.query(`SELECT COALESCE(sum(estimated_value),0) AS v FROM leads WHERE tenant_id=$1 AND deleted_at IS NULL`, [owner.tenantId])).rows[0].v),
    };
    const dash = (await owner.get('/api/dashboard/metrics', { 'X-Tenant-Id': owner.tenantId })).body;
    const rep = await owner.get('/api/reports/overview', { 'X-Tenant-Id': owner.tenantId });
    const vel = await owner.get('/api/reports/pipeline-velocity', { 'X-Tenant-Id': owner.tenantId });
    let velSql: string | null = null;
    try {
      await h.admin.query(`SELECT ps_from.name as from_stage, ps_to.name as to_stage, COUNT(*) as transitions, ROUND(AVG(EXTRACT(EPOCH FROM (lsh2.changed_at - lsh1.changed_at)) / 86400), 1) as d FROM lead_stage_history lsh1 JOIN lead_stage_history lsh2 ON lsh1.lead_id = lsh2.lead_id AND lsh2.id > lsh1.id JOIN pipeline_stages ps_from ON lsh1.to_stage_id = ps_from.id JOIN pipeline_stages ps_to ON lsh2.to_stage_id = ps_to.id WHERE lsh1.tenant_id = $1 GROUP BY 1,2`, [owner.tenantId]);
    } catch (e: any) { velSql = e.message; }
    out[restricted ? 'restricted' : 'privileged'] = {
      truth,
      dashboard: { leads: dash?.leads, stageRows: dash?.stages?.map((s: any) => [s.name, s.lead_count ?? s.leadCount]) },
      reportsOverviewSummary: rep.body?.data?.summary,
      pipelineVelocity: { status: vel.status, sqlError: velSql },
    };
  } finally {
    await h.close();
  }
}
console.log('AUDIT_RESULT ' + JSON.stringify(out, null, 1));
process.exit(0);
