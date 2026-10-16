// READ-ONLY audit probe: what does the business workflow really do? (stages → tasks/viewings, pipeline semantics, foreign agent id.) Disposable DB.
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
const { bootApi } = await import(ROOT + 'server/src/tests/support/app-harness.ts');
const h = await bootApi({ restricted: false });
const out: Record<string, unknown> = {};
const st = (r: any) => ({ status: r.status, msg: (r.body?.detail ?? r.body?.error ?? '').toString().slice(0, 140) });
try {
  const owner = await h.register({ emailPrefix: 'wfa', organisationName: 'Workflow A' });
  const other = await h.register({ emailPrefix: 'wfb', organisationName: 'Workflow B' });
  const W = { 'X-Tenant-Id': owner.tenantId };
  const pl = (await owner.get('/api/v1/pipelines')).body.data[0];
  out.defaultPipelineStages = pl.stages.map((s: any) => `${s.name} → status=${s.mapsToStatus}, prob=${s.probability}%, closed=${s.isClosed}`);
  out.seededTransitions = (await h.admin.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE required_fields <> '{}' AND required_fields IS NOT NULL)::int AS withRequired FROM pipeline_stage_transitions WHERE tenant_id=$1`, [owner.tenantId])).rows[0];
  const lead = (await owner.post('/api/v1/leads', { contact: { firstName: 'Buyer', email: `b${Date.now()}@x.test`, phone: '+919811111111' }, budgetMax: 9_000_000 })).body.data;
  const prop = (await owner.post('/api/v1/properties', { title: 'Tower A 1204', price: 8_000_000, propertyType: 'apartment', bedrooms: 3 })).body.data;
  const counts = async () => ({
    tasks: (await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1`, [owner.tenantId])).rows[0].n,
    activities: (await h.admin.query(`SELECT count(*)::int AS n FROM activities WHERE tenant_id=$1 AND lead_id=$2`, [owner.tenantId, lead.id])).rows[0].n,
    notifications: (await h.admin.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1`, [owner.tenantId])).rows[0].n,
  });
  out.afterLeadCreated = await counts();
  const leadNow = async () => (await owner.get(`/api/v1/leads/${lead.id}`)).body.data;

  // viewing → does the lead move, does a task or timeline entry appear?
  const v = await owner.post('/api/viewings', { leadId: lead.id, propertyId: prop.id, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, W);
  out.scheduleViewing = st(v);
  const after = await leadNow();
  out.afterViewingScheduled = { ...(await counts()), leadStage: after.stageName, nextFollowupAt: after.nextFollowupAt };
  out.viewingStatusVocabulary = (await h.admin.query(`SELECT enum_range(NULL::viewing_status) AS r`).catch(() => ({ rows: [{ r: 'n/a' }] }))).rows[0].r;

  // moving through stages: does anything get created automatically?
  const byName = (n: string) => pl.stages.find((s: any) => s.name === n);
  const moves: Record<string, unknown> = {};
  for (const name of ['Contacted', 'Qualified', 'Viewing Scheduled', 'Viewing Completed', 'Negotiation']) {
    const r = await owner.post(`/api/v1/leads/${lead.id}/stage`, { stageId: byName(name).id });
    moves[name] = { ...st(r), tasksNow: (await counts()).tasks };
  }
  out.stageMoves = moves;
  // outcome semantics
  const closed: Record<string, unknown> = {};
  for (const name of ['Lost', 'Invalid', 'Unqualified', 'Won']) {
    const l2 = (await owner.post('/api/v1/leads', { contact: { firstName: `C${name}`, email: `c${name}${Date.now()}@x.test` } })).body.data;
    const bare = await owner.post(`/api/v1/leads/${l2.id}/stage`, { stageId: byName(name).id });
    const withReason = bare.status === 200 ? bare : await owner.post(`/api/v1/leads/${l2.id}/stage`, { stageId: byName(name).id, lossReason: 'Budget too low' });
    closed[name] = { withoutDetails: st(bare), withReason: st(withReason), statusAfter: withReason.body?.data?.status, closedAt: Boolean(withReason.body?.data?.closedAt) };
  }
  out.closeOutcomes = closed;

  // foreign agent id on a viewing (cross-tenant reference)
  const lead2 = (await owner.post('/api/v1/leads', { contact: { firstName: 'Second', email: `s${Date.now()}@x.test` } })).body.data;
  const fv = await owner.post('/api/viewings', { leadId: lead2.id, propertyId: prop.id, scheduledAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), agentId: other.userId }, W);
  out.viewingWithAgentFromAnotherWorkspace = st(fv);
  const list = await owner.get('/api/viewings', W);
  out.agentDetailsLeakedInList = list.body?.data?.map((x: any) => x.agent).filter(Boolean).map((a: any) => ({ nameShown: Boolean(a.name), emailShown: Boolean(a.email) }));

  // archived records still usable?
  await owner.delete(`/api/v1/properties/${prop.id}`);
  const lead3 = (await owner.post('/api/v1/leads', { contact: { firstName: 'Third', email: `t${Date.now()}@x.test` } })).body.data;
  out.scheduleViewingOnArchivedProperty = st(await owner.post('/api/viewings', { leadId: lead3.id, propertyId: prop.id, scheduledAt: new Date(Date.now() + 6 * 86_400_000).toISOString() }, W));
  const matches = await owner.post('/api/properties/match', { budgetMax: 9_000_000 }, W);
  out.matchIncludesArchivedProperty = JSON.stringify(matches.body).includes(prop.id);
  await owner.delete(`/api/v1/leads/${lead3.id}`);
  out.scheduleViewingOnArchivedLead = st(await owner.post('/api/viewings', { leadId: lead3.id, propertyId: (await owner.post('/api/v1/properties', { title: 'Second unit', price: 5_000_000 })).body.data.id, scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, W));

  // test leads pollute reports?
  const src = (await owner.post('/api/v1/lead-sources', { provider: 'generic', name: 'T' })).body.data.endpoint;
  await owner.post(`/api/v1/lead-sources/${src.id}/test`);
  await h.runJobs();
  const attr = (await owner.get('/api/dashboard/attribution', W)).body.data;
  out.attributionTotals = { total_attributed: attr.total_attributed, bySource: attr.source_breakdown, liveLeadsInList: (await owner.get('/api/v1/leads?limit=200')).body.data.length, testLeadsInList: (await owner.get('/api/v1/leads?limit=200&tag=test')).body.data.length };

  console.log('AUDIT_RESULT ' + JSON.stringify(out, null, 1));
} finally {
  await h.close();
  process.exit(0);
}
