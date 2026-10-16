// READ-ONLY audit probe: automation feature behaviour against a disposable database. Prints JSON evidence lines.
// Usage: tsx audit_automation.ts restricted|privileged
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
const { bootApi } = await import(ROOT + 'server/src/tests/support/app-harness.ts');

const mode = process.argv[2] === 'privileged' ? false : true;
const out: Record<string, unknown> = { mode: mode ? 'restricted-db-role' : 'privileged-db-role' };
const rec = (k: string, v: unknown) => { out[k] = v; };

const h = await bootApi({ restricted: mode });
try {
  const owner = await h.register({ emailPrefix: 'aown', organisationName: 'Audit A' });
  const other = await h.register({ emailPrefix: 'aoth', organisationName: 'Audit B' });
  const roles: Record<string, any> = {};
  for (const r of ['sales_manager', 'marketing_manager', 'sales_agent', 'auditor', 'executive_readonly']) {
    const u = await h.register({ emailPrefix: r.slice(0, 4) });
    await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [owner.tenantId, u.userId, r]);
    roles[r] = u;
  }
  const W = { 'X-Tenant-Id': owner.tenantId };
  const st = (r: any) => ({ status: r.status, body: JSON.stringify(r.body).slice(0, 160) });

  // 1. the legacy CRUD API (what the backend offers)
  const rule = { name: 'Auto-assign new leads', triggerType: 'lead_created', actions: [{ type: 'assign_lead', config: {} }], status: 'active' };
  const created = await owner.post('/api/automation', rule, W);
  rec('crud.create', st(created));
  const ruleId = created.body?.data?.id;
  rec('crud.list', st(await owner.get('/api/automation', W)));
  rec('crud.patch', ruleId ? st(await owner.patch(`/api/automation/${ruleId}`, { status: 'paused' }, W)) : 'no rule created');
  rec('crud.executions', ruleId ? st(await owner.get(`/api/automation/${ruleId}/executions`, W)) : 'no rule created');
  rec('crud.delete', ruleId ? st(await owner.delete(`/api/automation/${ruleId}`, W)) : 'no rule created');

  // 2. does an event ever become an execution? (privileged mode only creates the rule reliably)
  await owner.put(`/api/v1/pipelines/${(await owner.get('/api/v1/pipelines')).body.data[0].id}/transitions`, { restricted: false, transitions: [] });
  await h.admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, actions, status) VALUES ($1,'probe rule','lead_created','[{"type":"create_task","config":{"title":"x"}}]'::jsonb,'active')`, [owner.tenantId]);
  const lead = await owner.post('/api/v1/leads', { contact: { firstName: 'Probe', email: `p${Date.now()}@x.test` } });
  rec('lead.created', lead.status);
  await h.runJobs();
  const { eventConsumers, jobHandlers } = await import(ROOT + 'server/src/worker.ts');
  rec('worker.eventConsumers', eventConsumers.map((c: any) => c.name));
  rec('worker.jobHandlerTypes', Object.keys(jobHandlers));
  rec('db.domain_events.lead_created', (await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE type='lead.created' AND tenant_id=$1`, [owner.tenantId])).rows[0].n);
  rec('db.automation_executions', (await h.admin.query(`SELECT count(*)::int AS n FROM automation_executions`)).rows[0].n);
  rec('db.automation_rules.run_count', (await h.admin.query(`SELECT name, status, run_count, last_run_at FROM automation_rules WHERE tenant_id=$1`, [owner.tenantId])).rows);
  rec('db.tasks_created_by_rule', (await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1 AND title='x'`, [owner.tenantId])).rows[0].n);
  rec('db.jobs_for_automation', (await h.admin.query(`SELECT count(*)::int AS n FROM jobs WHERE type LIKE 'automation%'`)).rows[0].n);

  // 3. parameter validation (legacy create)
  const bad1 = await owner.post('/api/automation', { name: 'x', triggerType: 'lead_created', actions: [{ type: 'drop_everything', config: { sql: 'DROP TABLE leads', url: 'http://169.254.169.254/latest/meta-data' } }], status: 'active' }, W);
  rec('validate.unknownActionType', st(bad1));
  const bad2 = await owner.post('/api/automation', { name: 'loop', triggerType: 'lead_stage_changed', actions: [{ type: 'change_lead_stage', config: { stage_key: 'new' } }], status: 'active' }, W);
  rec('validate.selfTriggeringRule(stage change → stage change)', st(bad2));
  const bad3 = await owner.post('/api/automation', { name: 'big', triggerType: 'lead_created', actions: Array.from({ length: 500 }, () => ({ type: 'send_whatsapp', config: { to: 'all' } })), status: 'active' }, W);
  rec('validate.500actions', st(bad3));

  // 4. who may create rules (backend vs central matrix vs UI)
  const roleResults: Record<string, unknown> = {};
  for (const [role, u] of Object.entries(roles)) {
    const c = await u.post('/api/automation', { ...rule, name: `by ${role}` }, W);
    const cfg = await u.patch('/api/tenant/config', { settings: { probe: role } }, W);
    roleResults[role] = { 'POST /api/automation': c.status, 'PATCH /api/tenant/config (what the UI uses)': cfg.status };
  }
  rec('roles', roleResults);

  // 5. cross-tenant
  const rid = (await h.admin.query(`SELECT id FROM automation_rules WHERE tenant_id=$1 LIMIT 1`, [owner.tenantId])).rows[0].id;
  rec('crosstenant', {
    patch: (await other.patch(`/api/automation/${rid}`, { status: 'paused' })).status,
    delete: (await other.delete(`/api/automation/${rid}`)).status,
    executions: st(await other.get(`/api/automation/${rid}/executions`)),
    list: st(await other.get('/api/automation')),
    status_after: (await h.admin.query(`SELECT status FROM automation_rules WHERE id=$1`, [rid])).rows[0].status,
  });

  // 6. what the UI actually does: rules live in tenants.settings.automation_rules (no table, no executor)
  const cur = (await owner.get('/api/tenant/config', W)).body.data;
  const a = { id: 'r-A', name: 'UI rule A', trigger_type: 'lead_created', action_type: 'assign_lead', is_active: true };
  const b = { id: 'r-B', name: 'UI rule B', trigger_type: 'stage_changed', action_type: 'send_whatsapp', is_active: true };
  // two admins save at the same moment, each from the same starting list (read-modify-write of the whole blob)
  await Promise.all([
    owner.patch('/api/tenant/config', { settings: { ...cur.settings, automation_rules: [a] } }, W),
    owner.patch('/api/tenant/config', { settings: { ...cur.settings, automation_rules: [b] } }, W),
  ]);
  const after = (await h.admin.query(`SELECT settings->'automation_rules' AS r FROM tenants WHERE id=$1`, [owner.tenantId])).rows[0].r;
  rec('ui.lostUpdate.finalRules', after.map((x: any) => x.name));
  rec('ui.rulesTableRowsForUiRules', (await h.admin.query(`SELECT count(*)::int AS n FROM automation_rules WHERE name LIKE 'UI rule%'`)).rows[0].n);
  // trigger a "stage_changed" event; nothing consumes the UI rule
  rec('ui.settingsAcceptsAnyShape', st(await owner.patch('/api/tenant/config', { settings: { automation_rules: 'not even a list', x: { deep: { deeper: 1 } } } }, W)));

  console.log('AUDIT_RESULT ' + JSON.stringify(out, null, 1));
} finally {
  await h.close();
  process.exit(0);
}
