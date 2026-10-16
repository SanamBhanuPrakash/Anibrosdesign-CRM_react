import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Slice 1 acceptance: "Follow up every new lead".
 * Runs as the restricted database roles (API and worker), so row-level security is real. The worker is driven in-process:
 * the event consumer and the job runner are exactly the production objects.
 */
let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let manager: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
let auditor: AuthedUser;
let marketing: AuthedUser;
let workerDb: any;
let dispatcher: any;
let JobRunnerCls: typeof import('../platform/jobs').JobRunner;
let jobHandlers: Record<string, any>;
let engine: typeof import('../modules/automation/engine');
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);
/** Members have their own home workspace; every call names the workspace they are acting in. */
const inOwnerWs = (u: AuthedUser): AuthedUser => {
  const hdr = { 'X-Tenant-Id': owner.tenantId };
  return { ...u, get: (p, x) => u.get(p, { ...hdr, ...x }), post: (p, b, x) => u.post(p, b, { ...hdr, ...x }), patch: (p, b, x) => u.patch(p, b, { ...hdr, ...x }), put: (p, b, x) => u.put(p, b, { ...hdr, ...x }), delete: (p, x) => u.delete(p, { ...hdr, ...x }) };
};

/** One full pass of the worker: consume new events, run the jobs they produce, repeat until quiet. */
async function pump() {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 20; j++) {
      const r = await dispatcher.runOnce();
      if (!Object.values(r).some((c) => (c as number) > 0)) break;
    }
    await h.runJobs();
  }
}

async function newLead(u: AuthedUser, extra: Record<string, unknown> = {}) {
  const res = await u.post('/api/v1/leads', { contact: { firstName: `Buyer${uniq()}`, lastName: 'Rao', email: `b${uniq()}@x.test` }, source: 'website', ...extra });
  if (res.status !== 201) throw new Error(`lead create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as any;
}
const tasksOf = async (leadId: string) => (await h.admin.query(`SELECT * FROM tasks WHERE lead_id = $1 ORDER BY created_at`, [leadId])).rows;
const execsOf = async (leadId: string) => (await h.admin.query(`SELECT * FROM automation_executions WHERE trigger_entity_id = $1 ORDER BY created_at`, [leadId])).rows;
const leadNotes = async (leadId: string, userId: string) => (await h.admin.query(`SELECT * FROM notifications WHERE entity_type = 'lead' AND entity_id = $1 AND user_id = $2`, [leadId, userId])).rows;
const ownerOf = async (leadId: string) => (await h.admin.query(`SELECT owner_id FROM leads WHERE id = $1`, [leadId])).rows[0].owner_id as string | null;
const setMode = async (mode: 'creator' | 'balanced' | 'unassigned') => expect((await owner.patch('/api/v1/workspace', { leadAssignment: mode })).status).toBe(200);

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  const platform = await import('../platform/db');
  const worker = await import('../worker');
  const events = await import('../platform/events');
  JobRunnerCls = (await import('../platform/jobs')).JobRunner;
  engine = await import('../modules/automation/engine');
  jobHandlers = worker.jobHandlers;
  workerDb = platform.createWorkerDb();
  dispatcher = new events.EventDispatcher(workerDb, worker.eventConsumers);

  owner = await h.register({ emailPrefix: 'aown', organisationName: 'Automation Co' });
  other = await h.register({ emailPrefix: 'aoth', organisationName: 'Other Automation Co' });
  const roles = { manager: 'sales_manager', agent: 'sales_agent', agent2: 'sales_agent', auditor: 'auditor', marketing: 'marketing_manager' } as const;
  const made: Record<string, AuthedUser> = {};
  for (const [k, role] of Object.entries(roles)) {
    const u = await h.register({ emailPrefix: `a${k}` });
    await addMember(u, owner.tenantId, role);
    made[k] = inOwnerWs(u);
  }
  ({ manager, agent, agent2, auditor, marketing } = made as Record<keyof typeof roles, AuthedUser>);
  for (const u of [owner, other]) {
    const pl = (await u.get('/api/v1/pipelines')).body.data[0];
    await u.put(`/api/v1/pipelines/${pl.id}/transitions`, { restricted: false, transitions: [] });
  }
  await pump(); // drain the setup events before any rule exists
}, 240_000);

afterAll(async () => {
  await workerDb?.end();
  await h?.close();
});

describe('turning it on and off', () => {
  it('starts with the template available and no rule', async () => {
    const res = await owner.get('/api/v1/automations');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ key: 'new_lead_follow_up', trigger: 'lead_created', rule: null, failedRuns: 0 });
    expect(res.body.data[0].steps.map((s: any) => s.id)).toEqual(['owner', 'task', 'notify']);
    expect(res.body.data[0].usesSettings).toEqual(['leadAssignment', 'firstResponseMinutes']);
  });

  it('who may read and who may change it follows the permission matrix', async () => {
    expect((await agent.get('/api/v1/automations')).status).toBe(403);
    expect((await auditor.get('/api/v1/automations')).status).toBe(403);
    expect((await manager.get('/api/v1/automations')).status).toBe(200);
    expect((await manager.post('/api/v1/automations/new_lead_follow_up/enable')).status).toBe(403);
    expect((await agent.post('/api/v1/automations/new_lead_follow_up/enable')).status).toBe(403);
    expect((await request(h.app).get('/api/v1/automations')).status).toBe(401);
    expect((await owner.get('/api/v1/automations')).body.data[0].rule).toBeNull(); // the refusals changed nothing
  });

  it('only known templates exist', async () => {
    expect((await owner.post('/api/v1/automations/send_whatsapp/enable')).status).toBe(400);
    expect((await owner.post('/api/v1/automations/new_lead_follow_up%27%3B--/enable')).status).toBe(400);
  });

  it('turning on creates the rule once; repeating it changes nothing and is audited once', async () => {
    const a = await owner.post('/api/v1/automations/new_lead_follow_up/enable');
    expect(a.status).toBe(200);
    expect(a.body.data.rule).toMatchObject({ status: 'active', version: 1, runCount: 0, lastRunAt: null });
    const b = await owner.post('/api/v1/automations/new_lead_follow_up/enable');
    expect(b.body.data.rule.version).toBe(1);
    expect(b.body.data.rule.id).toBe(a.body.data.rule.id);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM automation_rules WHERE tenant_id = $1 AND template = 'new_lead_follow_up'`, [owner.tenantId])).rows[0].n).toBe(1);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'automation.enable'`, [owner.tenantId])).rows[0].n).toBe(1);
  });

  it('a workspace can only have one rule per template, enforced by the database', async () => {
    await expect(
      h.admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, status, template) VALUES ($1, 'dup', 'lead_created', 'active', 'new_lead_follow_up')`, [owner.tenantId])
    ).rejects.toThrow(/uq_automation_rule_template/);
  });

  it('the application role can neither delete nor truncate run history', async () => {
    const { rows } = await h.admin.query(`SELECT has_table_privilege('crm_app_user', 'automation_executions', 'DELETE') AS d, has_table_privilege('crm_app_user', 'automation_executions', 'TRUNCATE') AS t, has_table_privilege('crm_app_user', 'automation_executions', 'INSERT') AS i`);
    expect(rows[0]).toEqual({ d: false, t: false, i: true });
  });
});

describe('what it does to a new lead', () => {
  it('a salesperson creates their own lead: owner kept, one call task due in the first-reply time, nobody notified about their own lead', async () => {
    const lead = await newLead(agent);
    expect(lead.ownerId).toBe(agent.userId);
    await pump();
    const tasks = await tasksOf(lead.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'call', priority: 'high', assigned_to: agent.userId, status: 'pending' });
    expect(tasks[0].title).toContain(lead.contactName);
    const due = new Date(tasks[0].due_date).getTime();
    expect(Math.abs(due - (new Date(lead.createdAt).getTime() + 30 * 60_000))).toBeLessThan(2000); // default first-reply time is 30 minutes
    expect(await ownerOf(lead.id)).toBe(agent.userId);
    expect(await leadNotes(lead.id, agent.userId)).toHaveLength(0);
    const ex = await execsOf(lead.id);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(ex[0].execution_log.map((s: any) => `${s.step}:${s.status}`)).toEqual(['owner:kept', 'task:done', 'notify:skipped']);
    // the lead's next follow-up now points at the task
    expect((await h.admin.query(`SELECT next_followup_at FROM leads WHERE id = $1`, [lead.id])).rows[0].next_followup_at.getTime()).toBe(due);
  });

  it('a manager assigns the lead to someone explicitly: that owner is preserved and gets exactly one notification', async () => {
    const lead = await newLead(manager, { ownerId: agent2.userId });
    await pump();
    expect(await ownerOf(lead.id)).toBe(agent2.userId);
    const t = await tasksOf(lead.id);
    expect(t).toHaveLength(1);
    expect(t[0].assigned_to).toBe(agent2.userId);
    const notes = await leadNotes(lead.id, agent2.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'lead_assigned', link: `/leads/${lead.id}` });
    expect(notes[0].title).toContain(lead.contactName);
    // nobody else was told
    expect(await leadNotes(lead.id, agent.userId)).toHaveLength(0);
  });

  it('created on purpose without an owner: left unassigned; the task exists unassigned; nobody is notified', async () => {
    await setMode('balanced');
    const lead = await newLead(manager, { ownerId: null });
    await pump();
    expect(await ownerOf(lead.id)).toBeNull();
    const t = await tasksOf(lead.id);
    expect(t).toHaveLength(1);
    expect(t[0].assigned_to).toBeNull();
    const ex = (await execsOf(lead.id))[0];
    expect(ex.execution_log.find((s: any) => s.step === 'owner').detail).toMatch(/on purpose/);
    expect(ex.execution_log.find((s: any) => s.step === 'notify').status).toBe('skipped');
    await setMode('creator');
  });

  it('the first-reply time and the assignment rule come from workspace settings', async () => {
    expect((await owner.patch('/api/v1/workspace', { firstResponseMinutes: 90 })).status).toBe(200);
    const lead = await newLead(agent);
    await pump();
    const [t] = await tasksOf(lead.id);
    expect(Math.abs(new Date(t.due_date).getTime() - (new Date(lead.createdAt).getTime() + 90 * 60_000))).toBeLessThan(2000);
    expect(t.remind_before_minutes).toBe(5);
    expect((await owner.patch('/api/v1/workspace', { firstResponseMinutes: 30 })).status).toBe(200);
  });

  describe('leads that arrive without a person creating them (a lead source)', () => {
    let endpoint: any;
    let key: string;
    const deliver = async () => {
      const email = `g${uniq()}@example.com`;
      const res = await request(h.app).post(`/hooks/${endpoint.id}`).send({
        lead_id: `G-${uniq()}`, form_id: 'F1', campaign_id: '42', google_key: key,
        user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Ravi Kumar' }, { column_id: 'EMAIL', string_value: email }, { column_id: 'PHONE_NUMBER', string_value: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }],
      });
      expect(res.status).toBe(200);
      await pump();
      return (await h.admin.query(`SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email = $1`, [email])).rows[0].id as string;
    };
    beforeAll(async () => {
      const r = await owner.post('/api/v1/lead-sources', { provider: 'google', name: 'Google brand' });
      endpoint = r.body.data.endpoint;
      key = r.body.data.secret;
    });

    it('with a balanced rule the lead gets an owner at arrival; the automation keeps it, adds one task, and does not notify twice', async () => {
      await setMode('balanced');
      const id = await deliver();
      const owned = await ownerOf(id);
      expect(owned).toBeTruthy();
      expect(await tasksOf(id)).toHaveLength(1);
      expect((await tasksOf(id))[0].assigned_to).toBe(owned);
      // the lead source already told the owner; the automation recognises that and stays quiet
      expect(await leadNotes(id, owned!)).toHaveLength(1);
      expect((await execsOf(id))[0].execution_log.find((s: any) => s.step === 'notify').detail).toMatch(/already notified/);
    });

    it('with the rule set to "leave unassigned" it stays unassigned, with a task and no notification', async () => {
      await setMode('unassigned');
      const id = await deliver();
      expect(await ownerOf(id)).toBeNull();
      expect(await tasksOf(id)).toHaveLength(1);
      expect((await tasksOf(id))[0].assigned_to).toBeNull();
      expect((await execsOf(id))[0].execution_log.find((s: any) => s.step === 'owner').detail).toMatch(/leave leads unassigned/);
      await setMode('creator');
    });

    it('when nobody was available at arrival, the automation applies the rule later and notifies the new owner', async () => {
      await setMode('balanced');
      const id = await deliver();
      // simulate "no one was assignable when the lead arrived": remove the owner behind the application's back, then re-run on a fresh event
      await h.admin.query(`UPDATE leads SET owner_id = NULL, assigned_at = NULL WHERE id = $1`, [id]);
      await h.admin.query(`DELETE FROM tasks WHERE lead_id = $1`, [id]);
      await h.admin.query(`DELETE FROM notifications WHERE entity_id = $1`, [id]);
      const ev = (await h.admin.query(`SELECT id::text FROM domain_events WHERE type = 'lead.created' AND aggregate_id = $1`, [id])).rows[0].id;
      const oldRuns = (await h.admin.query(`SELECT id FROM automation_executions WHERE trigger_entity_id = $1`, [id])).rows.map((r) => r.id);
      await h.admin.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [oldRuns]);
      await h.admin.query(`DELETE FROM automation_executions WHERE trigger_entity_id = $1`, [id]);
      await workerDbRun(owner.tenantId, ev);
      const after = await ownerOf(id);
      expect(after).toBeTruthy();
      expect((await tasksOf(id))[0].assigned_to).toBe(after);
      expect(await leadNotes(id, after!)).toHaveLength(1);
      expect((await execsOf(id))[0].execution_log.find((s: any) => s.step === 'owner').status).toBe('done');
      await setMode('creator');
    });
  });
});

/** Run the dispatch handler for one event directly, as a job would. */
async function workerDbRun(tenantId: string, eventId: string, attempts = 1) {
  const job = { id: 'job-' + uniq(), tenantId, type: 'automation.dispatch', payload: { eventId }, attempts, maxAttempts: 6, correlationId: null };
  const ctx = { db: workerDb, log: console as any, signal: new AbortController().signal, withTenant: (fn: any) => workerDb.withTenant({ tenantId }, fn) };
  return jobHandlers['automation.dispatch'](job, ctx);
}

describe('exactly once', () => {
  it('replaying every event from the beginning creates no second task, execution or notification', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    await pump();
    const snapshot = async () => ({
      tasks: (await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1`, [owner.tenantId])).rows[0].n,
      execs: (await h.admin.query(`SELECT count(*)::int AS n FROM automation_executions WHERE tenant_id = $1`, [owner.tenantId])).rows[0].n,
      notes: (await h.admin.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1`, [owner.tenantId])).rows[0].n,
    });
    const before = await snapshot();
    await h.admin.query(`UPDATE event_consumers SET last_tx_id = '0'::xid8, last_event_id = 0 WHERE name = 'automation'`);
    await h.admin.query(`UPDATE jobs SET dedupe_key = dedupe_key || ':old:' || id WHERE type = 'automation.dispatch' AND dedupe_key NOT LIKE '%:old:%'`); // as if the old job rows had been purged
    await pump();
    expect(await snapshot()).toEqual(before);
    expect(await tasksOf(lead.id)).toHaveLength(1);
  });

  it('six workers handling the same event at the same moment: one execution, one task', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    const ev = (await h.admin.query(`SELECT id::text FROM domain_events WHERE type = 'lead.created' AND aggregate_id = $1`, [lead.id])).rows[0].id;
    await Promise.all(Array.from({ length: 6 }, () => workerDbRun(owner.tenantId, ev)));
    expect(await execsOf(lead.id)).toHaveLength(1);
    expect(await tasksOf(lead.id)).toHaveLength(1);
    expect(await leadNotes(lead.id, agent.userId)).toHaveLength(1);
    expect((await execsOf(lead.id))[0].status).toBe('completed');
  });

  it('two job runners draining a burst of leads: every lead gets exactly one task and one execution', async () => {
    const leads = [];
    for (let i = 0; i < 24; i++) leads.push(await newLead(manager, { ownerId: i % 2 ? agent.userId : agent2.userId }));
    for (let j = 0; j < 20; j++) {
      const r = await dispatcher.runOnce();
      if (!Object.values(r).some((c) => (c as number) > 0)) break;
    }
    const a = new JobRunnerCls(workerDb, jobHandlers, { concurrency: 4 });
    const b = new JobRunnerCls(workerDb, jobHandlers, { concurrency: 4 });
    await Promise.all([a.drain(), b.drain()]);
    for (const l of leads) {
      expect(await tasksOf(l.id), l.id).toHaveLength(1);
      expect(await execsOf(l.id), l.id).toHaveLength(1);
    }
    expect(a.counters.dead + b.counters.dead).toBe(0);
  });

  it('a worker that died after committing but before finishing its job: the re-run duplicates nothing', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    for (let j = 0; j < 20; j++) {
      const r = await dispatcher.runOnce();
      if (!Object.values(r).some((c) => (c as number) > 0)) break;
    }
    // run the job's work, then "crash" before it is marked done
    const runner = new JobRunnerCls(workerDb, jobHandlers, { concurrency: 1, leaseSeconds: 60 });
    const claimed = [];
    for (let i = 0; i < 50; i++) {
      const got = await runner.claim(10);
      claimed.push(...got);
      if (!got.length) break;
    }
    expect(claimed.some((j) => j.type === 'automation.dispatch')).toBe(true);
    for (const j of claimed) {
      const ctx = { db: workerDb, log: console as any, signal: new AbortController().signal, withTenant: (fn: any) => workerDb.withTenant({ tenantId: j.tenantId }, fn) };
      if (jobHandlers[j.type]) await jobHandlers[j.type](j, ctx); // effects committed...
    }
    await h.admin.query(`UPDATE jobs SET lease_until = now() - interval '1 minute' WHERE status = 'running'`); // ...but the worker vanished
    expect(await runner.reap()).toBeGreaterThan(0);
    await h.runJobs(); // another worker picks the jobs up again
    expect(await tasksOf(lead.id)).toHaveLength(1);
    expect(await execsOf(lead.id)).toHaveLength(1);
    expect(await leadNotes(lead.id, agent.userId)).toHaveLength(1);
  });
});

describe('failure and recovery', () => {
  const install = (sql: string) => h.admin.query(sql);
  const removeTrigger = () => h.admin.query(`DROP TRIGGER IF EXISTS test_boom_trg ON tasks; DROP FUNCTION IF EXISTS test_boom();`);

  it('a temporary failure rolls everything back, is recorded, and a later retry completes it exactly once', async () => {
    await setMode('balanced');
    await install(`CREATE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$;
                   CREATE TRIGGER test_boom_trg BEFORE INSERT ON tasks FOR EACH ROW WHEN (NEW.dedupe_key LIKE 'automation:%') EXECUTE FUNCTION test_boom();`);
    // a system-style lead with no owner, so the engine has to assign one (a step that happens BEFORE the failing task step)
    const lead = await newLead(manager); // no owner requested: the workspace rule picks one
    await h.admin.query(`UPDATE leads SET owner_id = NULL, assigned_at = NULL WHERE id = $1`, [lead.id]);
    await pump();
    // nothing half-done: no owner assigned by the engine, no task, no notification
    expect(await ownerOf(lead.id)).toBeNull();
    expect(await tasksOf(lead.id)).toHaveLength(0);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1`, [lead.id])).rows[0].n).toBe(0);
    const [ex] = await execsOf(lead.id);
    expect(ex).toMatchObject({ status: 'pending', attempts: 1 });
    expect(ex.error_message).toMatch(/simulated outage/);
    // the job is waiting to retry, not dead
    const job = (await h.admin.query(`SELECT status, attempts FROM jobs WHERE type = 'automation.dispatch' AND payload->>'eventId' = (SELECT trigger_event_id::text FROM automation_executions WHERE id = $1)`, [ex.id])).rows[0];
    expect(job.status).toBe('queued');
    // the outage ends; the job's backoff elapses
    await removeTrigger();
    await h.admin.query(`UPDATE jobs SET run_at = now() WHERE type = 'automation.dispatch' AND status = 'queued'`);
    await h.runJobs();
    const [done] = await execsOf(lead.id);
    expect(done).toMatchObject({ status: 'completed', attempts: 2, error_message: null });
    expect(await tasksOf(lead.id)).toHaveLength(1);
    expect(await ownerOf(lead.id)).toBeTruthy();
    expect(await execsOf(lead.id)).toHaveLength(1);
    await setMode('creator');
  });

  it('a permanent failure is recorded as failed (not retried forever), is visible in the activity log, and can be retried by a person', async () => {
    await install(`CREATE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rejected by a data rule' USING ERRCODE = '23514'; END $$;
                   CREATE TRIGGER test_boom_trg BEFORE INSERT ON tasks FOR EACH ROW WHEN (NEW.dedupe_key LIKE 'automation:%') EXECUTE FUNCTION test_boom();`);
    const lead = await newLead(manager, { ownerId: agent.userId });
    await pump();
    const [ex] = await execsOf(lead.id);
    expect(ex.status).toBe('failed');
    expect(ex.attempts).toBe(1);
    expect(ex.error_message).toBeTruthy();
    expect(await tasksOf(lead.id)).toHaveLength(0);
    expect((await h.admin.query(`SELECT status FROM jobs WHERE type = 'automation.dispatch' AND payload->>'eventId' = $1::text`, [String(ex.trigger_event_id)])).rows[0].status).toBe('done');
    const { flushEvents } = await import('../platform/observability/event-log');
    await flushEvents();
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM operational_logs WHERE tenant_id = $1 AND component = 'worker' AND severity = 'error' AND message = 'An automation run failed'`, [owner.tenantId])).rows[0].n).toBeGreaterThan(0);

    // the history shows it, with the reason
    const list = await owner.get(`/api/v1/automations/executions?status=failed`);
    expect(list.body.data.map((e: any) => e.id)).toContain(ex.id);
    expect((await owner.get('/api/v1/automations')).body.data[0].failedRuns).toBeGreaterThan(0);

    // permissions on retry
    expect((await agent.post(`/api/v1/automations/executions/${ex.id}/retry`)).status).toBe(403);
    expect((await manager.post(`/api/v1/automations/executions/${ex.id}/retry`)).status).toBe(403);
    // the cause is fixed; a person presses Retry
    await removeTrigger();
    const retried = await owner.post(`/api/v1/automations/executions/${ex.id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.data.status).toBe('pending');
    await pump();
    const [after] = await execsOf(lead.id);
    expect(after).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await tasksOf(lead.id)).toHaveLength(1);
    // retrying something that is not failed is refused
    expect((await owner.post(`/api/v1/automations/executions/${ex.id}/retry`)).status).toBe(409);
    expect((await owner.post(`/api/v1/automations/executions/00000000-0000-4000-8000-000000000000/retry`)).status).toBe(404);
  });

  it('a lead archived before the automation runs is skipped, with the reason recorded', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    for (let j = 0; j < 20; j++) {
      const r = await dispatcher.runOnce();
      if (!Object.values(r).some((c) => (c as number) > 0)) break;
    }
    expect((await owner.delete(`/api/v1/leads/${lead.id}`)).status).toBe(204);
    await h.runJobs();
    const [ex] = await execsOf(lead.id);
    expect(ex.status).toBe('skipped');
    expect(ex.summary).toMatch(/archived/);
    expect(await tasksOf(lead.id)).toHaveLength(0);
  });
});

describe('pausing', () => {
  it('a paused automation does nothing for new leads; turning it on again resumes it without touching old leads', async () => {
    const paused = await owner.post('/api/v1/automations/new_lead_follow_up/pause');
    expect(paused.status).toBe(200);
    expect(paused.body.data.rule).toMatchObject({ status: 'paused', version: expect.any(Number) });
    expect((await owner.post('/api/v1/automations/new_lead_follow_up/pause')).status).toBe(200); // repeating is harmless
    const while_paused = await newLead(manager, { ownerId: agent.userId });
    await pump();
    expect(await execsOf(while_paused.id)).toHaveLength(0);
    expect(await tasksOf(while_paused.id)).toHaveLength(0);

    await owner.post('/api/v1/automations/new_lead_follow_up/enable');
    await pump();
    expect(await execsOf(while_paused.id)).toHaveLength(0); // it does not run on leads that already existed
    const after = await newLead(manager, { ownerId: agent.userId });
    await pump();
    expect(await execsOf(after.id)).toHaveLength(1);
  });

  it('a run that was queued before the pause but had not started is recorded as skipped and does nothing', async () => {
    const lead = await newLead(manager, { ownerId: agent.userId });
    const ev = (await h.admin.query(`SELECT id::text FROM domain_events WHERE type = 'lead.created' AND aggregate_id = $1`, [lead.id])).rows[0].id;
    const rule = (await h.admin.query(`SELECT id FROM automation_rules WHERE tenant_id = $1 AND template = 'new_lead_follow_up'`, [owner.tenantId])).rows[0].id;
    await owner.post('/api/v1/automations/new_lead_follow_up/pause');
    const out = await workerDb.withTenant({ tenantId: owner.tenantId }, (tx: any) => engine.executeInTx(tx, { leads: undefined as any, tasks: undefined as any }, owner.tenantId, rule, { id: ev, aggregateId: lead.id, type: 'lead.created', payload: {} }));
    expect(out.outcome).toBe('skipped');
    const [ex] = await execsOf(lead.id);
    expect(ex).toMatchObject({ status: 'skipped' });
    expect(ex.summary).toMatch(/paused/);
    expect(await tasksOf(lead.id)).toHaveLength(0);
    await owner.post('/api/v1/automations/new_lead_follow_up/enable');
  });
});

describe('workspaces never touch each other', () => {
  it('another workspace’s rule never fires for this workspace’s leads, and its history and tasks stay empty', async () => {
    expect((await other.post('/api/v1/automations/new_lead_follow_up/enable')).status).toBe(200);
    const mine = await newLead(manager, { ownerId: agent.userId });
    const theirs = await newLead(other, { source: 'website' });
    await pump();
    expect(await execsOf(mine.id)).toHaveLength(1);
    expect((await h.admin.query(`SELECT r.tenant_id FROM automation_executions e JOIN automation_rules r ON r.id = e.rule_id WHERE e.trigger_entity_id = $1`, [mine.id])).rows[0].tenant_id).toBe(owner.tenantId);
    expect(await execsOf(theirs.id)).toHaveLength(1);
    expect((await h.admin.query(`SELECT r.tenant_id FROM automation_executions e JOIN automation_rules r ON r.id = e.rule_id WHERE e.trigger_entity_id = $1`, [theirs.id])).rows[0].tenant_id).toBe(other.tenantId);
    // tasks belong to the right workspace
    expect((await tasksOf(mine.id))[0].tenant_id).toBe(owner.tenantId);
    expect((await tasksOf(theirs.id))[0].tenant_id).toBe(other.tenantId);
    // the API only ever shows a workspace its own runs
    const theirList = await other.get('/api/v1/automations/executions?limit=200');
    expect(theirList.body.data.map((e: any) => e.leadId)).toContain(theirs.id);
    expect(theirList.body.data.map((e: any) => e.leadId)).not.toContain(mine.id);
    const myExec = (await owner.get(`/api/v1/automations/executions?leadId=${mine.id}`)).body.data[0];
    expect((await other.get(`/api/v1/automations/executions/${myExec.id}`)).status).toBe(404);
    expect((await other.post(`/api/v1/automations/executions/${myExec.id}/retry`)).status).toBe(404);
    // pausing theirs does not pause ours
    await other.post('/api/v1/automations/new_lead_follow_up/pause');
    expect((await owner.get('/api/v1/automations')).body.data[0].rule.status).toBe('active');
  });

  it('a job carrying another workspace’s event id cannot make the engine act on it', async () => {
    const foreign = await newLead(other, { source: 'website' });
    const foreignEvent = (await h.admin.query(`SELECT id::text FROM domain_events WHERE type = 'lead.created' AND aggregate_id = $1`, [foreign.id])).rows[0].id;
    const before = (await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1`, [foreign.id])).rows[0].n;
    const out = await workerDbRun(owner.tenantId, foreignEvent); // run in OUR tenant context with THEIR event id
    expect(out).toEqual({ ignored: 'event no longer available' });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1`, [foreign.id])).rows[0].n).toBe(before);
    expect(await execsOf(foreign.id)).toHaveLength(0);
  });
});

describe('history is accurate and complete', () => {
  it('lists newest first, pages by cursor, filters by status and lead, and reconciles with the effects', async () => {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await owner.get(`/api/v1/automations/executions?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      all.push(...r.body.data);
      if (!r.body.page.hasMore) break;
      cursor = r.body.page.next;
    }
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
    const times = all.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const dbCount = (await h.admin.query(`SELECT count(*)::int AS n FROM automation_executions WHERE tenant_id = $1`, [owner.tenantId])).rows[0].n;
    expect(all.length).toBe(dbCount);

    const completed = all.filter((e) => e.status === 'completed');
    const tasksCreated = (await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND dedupe_key LIKE 'automation:%'`, [owner.tenantId])).rows[0].n;
    expect(tasksCreated).toBe(completed.length); // one task per completed run, no more, no fewer
    const rule = (await owner.get('/api/v1/automations')).body.data[0].rule;
    expect(rule.runCount).toBe(completed.length);
    expect(rule.lastRunAt).toBeTruthy();

    const one = completed[0];
    const detail = await owner.get(`/api/v1/automations/executions/${one.id}`);
    expect(detail.body.data.steps.length).toBe(3);
    expect(detail.body.data.summary).toBeTruthy();
    expect(detail.body.data.leadName).toBeTruthy();
    expect((await owner.get(`/api/v1/automations/executions?status=completed&leadId=${one.leadId}`)).body.data).toHaveLength(1);
    expect((await owner.get('/api/v1/automations/executions?status=bogus')).status).toBe(400);
    expect((await agent.get('/api/v1/automations/executions')).status).toBe(403);
    expect((await marketing.get('/api/v1/automations/executions')).status).toBe(200);
  });

  it('every run and every turn on or off is in the audit trail', async () => {
    const runs = (await h.admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'automation.run'`, [owner.tenantId])).rows[0].n;
    const completed = (await h.admin.query(`SELECT count(*)::int AS n FROM automation_executions WHERE tenant_id = $1 AND status = 'completed'`, [owner.tenantId])).rows[0].n;
    expect(runs).toBe(completed);
    const toggles = (await h.admin.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND action IN ('automation.enable','automation.pause') ORDER BY created_at`, [owner.tenantId])).rows.map((r) => r.action);
    expect(toggles[0]).toBe('automation.enable');
    expect(toggles).toContain('automation.pause');
  });
});

describe('leads created by a CSV import', () => {
  it('every imported lead gets exactly one execution and one task, and a replay of the import events adds nothing', async () => {
    await setMode('balanced');
    const tag = uniq();
    const csv = ['Name,Email', `Asha One,asha.${tag}@import.test`, `Bala Two,bala.${tag}@import.test`, `Chitra Three,chitra.${tag}@import.test`].join('\n');
    const res = await owner.post('/api/v1/leads/imports', { fileName: `batch-${tag}.csv`, csv });
    expect(res.status).toBe(202);
    await pump();
    const leads = (await h.admin.query(`SELECT l.id, l.owner_id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email LIKE $1`, [`%.${tag}@import.test`])).rows;
    expect(leads).toHaveLength(3);
    for (const l of leads) {
      const tasks = await tasksOf(l.id);
      expect(tasks, l.id).toHaveLength(1);
      expect(tasks[0].assigned_to).toBe(l.owner_id); // the engine kept the owner the import chose
      expect(await execsOf(l.id), l.id).toHaveLength(1);
    }
    await h.admin.query(`UPDATE event_consumers SET last_tx_id = '0'::xid8, last_event_id = 0 WHERE name = 'automation'`);
    await h.admin.query(`UPDATE jobs SET dedupe_key = dedupe_key || ':old:' || id WHERE type = 'automation.dispatch' AND dedupe_key NOT LIKE '%:old:%'`);
    await pump();
    for (const l of leads) expect(await tasksOf(l.id), l.id).toHaveLength(1);
    await setMode('creator');
  });
});

describe('rules left by the retired editor', () => {
  it('an active legacy rule (no template) is never executed and never shown', async () => {
    const legacy = (await h.admin.query(`INSERT INTO automation_rules (tenant_id, name, trigger_type, actions, status) VALUES ($1, 'Old WhatsApp rule', 'lead_created', '[{"type":"send_whatsapp"}]'::jsonb, 'active') RETURNING id`, [owner.tenantId])).rows[0].id;
    const lead = await newLead(manager, { ownerId: agent.userId });
    await pump();
    const runs = await execsOf(lead.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].rule_id).not.toBe(legacy);
    const listed = (await owner.get('/api/v1/automations')).body.data;
    expect(listed).toHaveLength(1);
    expect(listed[0].rule.id).not.toBe(legacy);
    expect((await owner.get('/api/v1/automations/executions?limit=200')).body.data.every((e: any) => e.ruleId !== legacy)).toBe(true);
  });
});

describe('only leads created after it was turned on', () => {
  it('a lead created just before turning it on is never processed, however late the worker gets to it', async () => {
    const ws2 = await h.register({ emailPrefix: 'aearly', organisationName: 'Early Co' });
    const early = await newLead(ws2);
    expect((await ws2.post('/api/v1/automations/new_lead_follow_up/enable')).status).toBe(200); // the worker has not looked at `early` yet
    const later = await newLead(ws2);
    await pump();
    expect(await execsOf(early.id)).toHaveLength(0);
    expect(await tasksOf(early.id)).toHaveLength(0);
    expect(await execsOf(later.id)).toHaveLength(1);
    expect(await tasksOf(later.id)).toHaveLength(1);
  });

  it('turning it on again after a pause also only covers leads from that moment on', async () => {
    const ws3 = await h.register({ emailPrefix: 'aagain', organisationName: 'Again Co' });
    await ws3.post('/api/v1/automations/new_lead_follow_up/enable');
    await ws3.post('/api/v1/automations/new_lead_follow_up/pause');
    const gap = await newLead(ws3);
    await ws3.post('/api/v1/automations/new_lead_follow_up/enable');
    const fresh = await newLead(ws3);
    await pump();
    expect(await execsOf(gap.id)).toHaveLength(0);
    expect(await execsOf(fresh.id)).toHaveLength(1);
  });
});

describe('what the history says', () => {
  it('shows the due time in the workspace’s own time zone, not UTC', async () => {
    const ws4 = await h.register({ emailPrefix: 'azone', organisationName: 'Zone Co' });
    expect((await ws4.patch('/api/v1/workspace', { timezone: 'Asia/Kolkata' })).status).toBe(200);
    await ws4.post('/api/v1/automations/new_lead_follow_up/enable');
    const lead = await newLead(ws4);
    await pump();
    const [ex] = await execsOf(lead.id);
    expect(ex.summary).toMatch(/due \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} \(Asia\/Kolkata\)/);
    expect(ex.summary).not.toMatch(/UTC/);
  });

  it('formats a date in any zone and falls back safely for an invalid one', () => {
    const d = new Date('2026-10-14T11:08:00Z');
    expect(engine.formatInZone(d, 'Asia/Kolkata')).toBe('14 Oct, 16:38 (Asia/Kolkata)');
    expect(engine.formatInZone(d, 'America/New_York')).toBe('14 Oct, 07:08 (America/New_York)');
    expect(engine.formatInZone(d, 'Not/AZone')).toBe('2026-10-14 11:08 UTC');
  });
});
