import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

let h: ApiHarness;
let owner: AuthedUser;
let other: AuthedUser;
let agent: AuthedUser;
let agent2: AuthedUser;
let manager: AuthedUser;
let auditor: AuthedUser;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const inHours = (hrs: number) => new Date(Date.now() + hrs * 3_600_000).toISOString();
const as = (tenantId: string) => ({ 'X-Tenant-Id': tenantId });
const addMember = (u: AuthedUser, tenantId: string, role: string) =>
  h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,$3::tenant_role,'active',true)`, [tenantId, u.userId, role]);

async function task(u: AuthedUser, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await u.post('/api/v1/tasks', { title: `Task ${uniq()}`, ...body }, headers);
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function lead(u: AuthedUser, headers: Record<string, string> = {}) {
  const r = await u.post('/api/v1/leads', { contact: { firstName: `L${uniq()}`, email: `t${uniq()}@x.test` } }, headers);
  if (r.status !== 201) throw new Error('lead failed');
  return r.body.data;
}
/** What the worker does every few seconds. */
async function dispatch(): Promise<number> {
  const c = new pg.Client({ connectionString: h.tdb.workerUrl });
  await c.connect();
  try {
    return (await c.query('SELECT app.dispatch_task_notifications(200) AS n')).rows[0].n;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  owner = await h.register({ emailPrefix: 'town', organisationName: 'Tasks Co' });
  other = await h.register({ emailPrefix: 'toth', organisationName: 'Other Tasks Co' });
  agent = await h.register({ emailPrefix: 'tagt' });
  agent2 = await h.register({ emailPrefix: 'tagt2' });
  manager = await h.register({ emailPrefix: 'tmgr' });
  auditor = await h.register({ emailPrefix: 'taud' });
  await addMember(agent, owner.tenantId, 'sales_agent');
  await addMember(agent2, owner.tenantId, 'sales_agent');
  await addMember(manager, owner.tenantId, 'sales_manager');
  await addMember(auditor, owner.tenantId, 'auditor');
  await owner.put(`/api/v1/pipelines/${(await owner.get('/api/v1/pipelines')).body.data[0].id}/transitions`, { restricted: false, transitions: [] });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('tasks: create, read, validation', () => {
  it('creates a task assigned to the creator, with kind/priority defaults and an ETag', async () => {
    const r = await owner.post('/api/v1/tasks', { title: '  Call the architect  ', dueDate: inHours(5), kind: 'call', priority: 'high' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ title: 'Call the architect', kind: 'call', priority: 'high', status: 'pending', assignedTo: owner.userId, assigneeName: expect.any(String), isOverdue: false, version: 1 });
    expect(r.headers.etag).toMatch(/^"1.[0-9a-f]{8}"$/);
    expect((await h.admin.query(`SELECT 1 FROM domain_events WHERE type = 'task.created' AND aggregate_id = $1`, [r.body.data.id])).rowCount).toBe(1);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'task.create' AND entity_id = $1`, [r.body.data.id])).rowCount).toBe(1);
  });

  it('validates input with field paths', async () => {
    expect((await owner.post('/api/v1/tasks', { title: '   ' })).status).toBe(400);
    const noDue = await owner.post('/api/v1/tasks', { title: 'x', remindBeforeMinutes: 30 });
    expect(noDue.status).toBe(400);
    expect(noDue.body.errors[0].path).toBe('body.remindBeforeMinutes');
    expect((await owner.post('/api/v1/tasks', { title: 'x', dueDate: 'tomorrow' })).status).toBe(400);
    expect((await owner.post('/api/v1/tasks', { title: 'x', recurrence: { freq: 'hourly', interval: 1 } })).status).toBe(400);
    expect((await owner.post('/api/v1/tasks', { title: 'x', recurrence: { freq: 'daily', interval: 0 } })).status).toBe(400);
    expect((await owner.post('/api/v1/tasks', { title: 'x', assignedTo: other.userId })).body.errors[0].path).toBe('body.assignedTo'); // not a member
    expect((await owner.post('/api/v1/tasks', { title: 'x', leadId: '00000000-0000-4000-8000-000000000001' })).body.errors[0].path).toBe('body.leadId');
  });

  it('is idempotent on retry', async () => {
    const key = `idem-${uniq()}-abcdefgh`;
    const a = await owner.post('/api/v1/tasks', { title: 'Once only' }, { 'Idempotency-Key': key });
    const b = await owner.post('/api/v1/tasks', { title: 'Once only' }, { 'Idempotency-Key': key });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(b.headers['idempotent-replay']).toBe('true');
  });

  it('linking to a lead logs the lead timeline, and the lead’s follow-up date follows its open tasks', async () => {
    const l = await lead(owner);
    const t1 = await task(owner, { title: 'Send brochure', leadId: l.id, dueDate: inHours(48) });
    const t2 = await task(owner, { title: 'Call back', leadId: l.id, dueDate: inHours(24), kind: 'call' });
    let d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(new Date(d.nextFollowupAt).getTime()).toBe(new Date(t2.dueDate).getTime()); // the sooner one
    const acts = (await owner.get(`/api/v1/leads/${l.id}/activities`)).body.data;
    expect(acts.filter((a: any) => a.type === 'task_created').map((a: any) => a.description)).toEqual(expect.arrayContaining(['Task added: Send brochure', 'Task added: Call back']));

    const done = await owner.post(`/api/v1/tasks/${t2.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.task).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
    d = (await owner.get(`/api/v1/leads/${l.id}`)).body.data;
    expect(new Date(d.nextFollowupAt).getTime()).toBe(new Date(t1.dueDate).getTime());
    expect((await owner.get(`/api/v1/leads/${l.id}/activities`)).body.data.some((a: any) => a.type === 'task_completed')).toBe(true);
    await owner.post(`/api/v1/tasks/${t1.id}/cancel`);
    expect((await owner.get(`/api/v1/leads/${l.id}`)).body.data.nextFollowupAt).toBeNull();
  });

  it('a task never moves a lead’s ETag (derived data) so an open edit form is not made stale', async () => {
    const l = await lead(owner);
    const before = (await owner.get(`/api/v1/leads/${l.id}`)).body.data.version;
    await task(owner, { leadId: l.id, dueDate: inHours(3) });
    expect((await owner.get(`/api/v1/leads/${l.id}`)).body.data.version).toBe(before);
  });

  it('the lead edit form’s follow-up date is a task (one source of truth), editable and clearable', async () => {
    const l = await lead(owner);
    const when = inHours(30);
    expect((await owner.patch(`/api/v1/leads/${l.id}`, { nextFollowupAt: when })).status).toBe(200);
    let tasks = (await owner.get(`/api/v1/tasks?leadId=${l.id}`)).body.data;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'follow_up', remindBeforeMinutes: 15 });
    expect(tasks[0].title).toMatch(/^Follow up with /);
    const later = inHours(60);
    await owner.patch(`/api/v1/leads/${l.id}`, { nextFollowupAt: later });
    tasks = (await owner.get(`/api/v1/tasks?leadId=${l.id}`)).body.data;
    expect(tasks).toHaveLength(1); // moved, not duplicated
    expect(new Date(tasks[0].dueDate).getTime()).toBe(new Date(later).getTime());
    await owner.patch(`/api/v1/leads/${l.id}`, { nextFollowupAt: null });
    expect((await owner.get(`/api/v1/tasks?leadId=${l.id}`)).body.data).toHaveLength(0); // open list: cancelled one is gone
    expect((await owner.get(`/api/v1/leads/${l.id}`)).body.data.nextFollowupAt).toBeNull();
  });
});

describe('tasks: access control', () => {
  it('agents see tasks assigned to or created by them; others do not exist for them; auditors are blocked', async () => {
    const t = as(owner.tenantId);
    const mine = await task(agent, { title: 'Agent’s own' }, t);
    const theirs = await task(agent2, { title: 'Other agent’s' }, t);
    const assignedToAgent = await task(manager, { title: 'Manager hands over', assignedTo: agent.userId }, t);
    const createdForOther = await task(agent, { title: 'Agent made for self' }, t);

    const list = (await agent.get('/api/v1/tasks?limit=200&assignee=any', t)).body.data.map((x: any) => x.id);
    expect(list).toEqual(expect.arrayContaining([mine.id, assignedToAgent.id, createdForOther.id]));
    expect(list).not.toContain(theirs.id);
    expect((await agent.get(`/api/v1/tasks/${theirs.id}`, t)).status).toBe(404);
    expect((await agent.patch(`/api/v1/tasks/${theirs.id}`, { title: 'x' }, t)).status).toBe(404);
    expect((await agent.post(`/api/v1/tasks/${theirs.id}/complete`, {}, t)).status).toBe(404);
    expect((await agent.post(`/api/v1/tasks/${assignedToAgent.id}/complete`, {}, t)).status).toBe(200);

    expect((await manager.get(`/api/v1/tasks/${theirs.id}`, t)).status).toBe(200);
    expect((await auditor.get('/api/v1/tasks', t)).status).toBe(403);
    expect((await auditor.post('/api/v1/tasks', { title: 'x' }, t)).status).toBe(403);
  });

  it('only managers assign to others, and only active members; agents cannot delete', async () => {
    const t = as(owner.tenantId);
    expect((await agent.post('/api/v1/tasks', { title: 'Gift', assignedTo: agent2.userId }, t)).status).toBe(403);
    const mine = await task(agent, {}, t);
    expect((await agent.patch(`/api/v1/tasks/${mine.id}`, { assignedTo: agent2.userId }, t)).status).toBe(403);
    expect((await agent.delete(`/api/v1/tasks/${mine.id}`, t)).status).toBe(403);
    expect((await manager.patch(`/api/v1/tasks/${mine.id}`, { assignedTo: agent2.userId }, t)).body.data.assignedTo).toBe(agent2.userId);
    expect((await manager.delete(`/api/v1/tasks/${mine.id}`, t)).status).toBe(204);
    expect((await manager.get(`/api/v1/tasks/${mine.id}`, t)).status).toBe(404);
  });

  it('agents can only attach tasks to leads they can see; other workspaces see nothing', async () => {
    const t = as(owner.tenantId);
    const mgrLead = await lead(manager, t);
    const own = await lead(agent, t);
    expect((await agent.post('/api/v1/tasks', { title: 'x', leadId: mgrLead.id }, t)).status).toBe(400);
    expect((await agent.post('/api/v1/tasks', { title: 'x', leadId: own.id }, t)).status).toBe(201);

    const secret = await task(owner, { title: 'Workspace A only' });
    expect((await other.get(`/api/v1/tasks/${secret.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/tasks/${secret.id}`, { title: 'hack' })).status).toBe(404);
    expect((await other.post(`/api/v1/tasks/${secret.id}/complete`)).status).toBe(404);
    expect((await other.delete(`/api/v1/tasks/${secret.id}`)).status).toBe(404);
    expect((await other.get('/api/v1/tasks?limit=200&assignee=any&status=all')).body.data.map((x: any) => x.id)).not.toContain(secret.id);
    expect((await other.post('/api/v1/tasks', { title: 'x', leadId: own.id })).status).toBe(400);
  });
});

describe('tasks: lifecycle', () => {
  it('updates with If-Match; finished tasks cannot be edited until reopened', async () => {
    const t = await task(owner, { dueDate: inHours(4) });
    expect((await owner.patch(`/api/v1/tasks/${t.id}`, { priority: 'urgent' }, { 'If-Match': '"9"' })).status).toBe(412);
    const ok = await owner.patch(`/api/v1/tasks/${t.id}`, { priority: 'urgent', status: 'in_progress', description: 'Bring the floor plans' }, { 'If-Match': '"1"' });
    expect(ok.body.data).toMatchObject({ priority: 'urgent', status: 'in_progress', description: 'Bring the floor plans', version: 2 });
    expect((await owner.post(`/api/v1/tasks/${t.id}/complete`, {}, { 'If-Match': '"2"' })).status).toBe(200);
    expect((await owner.patch(`/api/v1/tasks/${t.id}`, { title: 'late edit' })).status).toBe(409);
    expect((await owner.post(`/api/v1/tasks/${t.id}/complete`)).status).toBe(409);
    const re = await owner.post(`/api/v1/tasks/${t.id}/reopen`);
    expect(re.body.data).toMatchObject({ status: 'pending', completedAt: null });
    expect((await owner.post(`/api/v1/tasks/${t.id}/reopen`)).status).toBe(409);
  });

  it('completing a recurring task creates exactly one next occurrence, even with parallel clicks', async () => {
    const t = await task(owner, { title: 'Weekly pipeline review', dueDate: inHours(-2), recurrence: { freq: 'weekly', interval: 1 }, remindBeforeMinutes: 30 });
    const results = await Promise.all([owner.post(`/api/v1/tasks/${t.id}/complete`), owner.post(`/api/v1/tasks/${t.id}/complete`), owner.post(`/api/v1/tasks/${t.id}/complete`)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const done = results.find((r) => r.status === 200)!.body.data;
    expect(done.next).toMatchObject({ title: 'Weekly pipeline review', status: 'pending', recurrence: { freq: 'weekly', interval: 1 }, remindBeforeMinutes: 30, assignedTo: owner.userId });
    expect(new Date(done.next.dueDate).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(done.next.dueDate).getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const copies = await h.admin.query(`SELECT count(*)::int AS n FROM tasks WHERE title = 'Weekly pipeline review' AND tenant_id = $1 AND status = 'pending' AND deleted_at IS NULL`, [owner.tenantId]);
    expect(copies.rows[0].n).toBe(1);
  });

  it('cancel, delete and the audit trail', async () => {
    const t = await task(owner);
    const c = await owner.post(`/api/v1/tasks/${t.id}/cancel`);
    expect(c.body.data.status).toBe('cancelled');
    expect((await owner.post(`/api/v1/tasks/${t.id}/cancel`)).status).toBe(409);
    expect((await owner.delete(`/api/v1/tasks/${t.id}`)).status).toBe(204);
    expect((await h.admin.query(`SELECT 1 FROM audit_logs WHERE action = 'task.delete' AND entity_id = $1`, [t.id])).rowCount).toBe(1);
  });

  it('bulk complete / reassign / cancel: each task on its own, with reasons for the ones that fail', async () => {
    const t = as(owner.tenantId);
    const a = await task(manager, {}, t);
    const b = await task(manager, {}, t);
    const gone = await task(manager, {}, t);
    await manager.post(`/api/v1/tasks/${gone.id}/complete`, {}, t);
    const ghost = '00000000-0000-4000-8000-0000000000bb';
    const done = await manager.post('/api/v1/tasks/bulk', { ids: [a.id, gone.id, ghost], action: 'complete' }, t);
    expect(done.body.data.updated).toBe(1);
    expect(done.body.data.skipped.map((s: any) => s.id).sort()).toEqual([gone.id, ghost].sort());
    const re = await manager.post('/api/v1/tasks/bulk', { ids: [b.id], action: 'reassign', assignedTo: agent.userId }, t);
    expect(re.body.data.updated).toBe(1);
    expect((await manager.get(`/api/v1/tasks/${b.id}`, t)).body.data.assignedTo).toBe(agent.userId);
    expect((await agent.post('/api/v1/tasks/bulk', { ids: [b.id], action: 'reassign', assignedTo: agent2.userId }, t)).body.data.skipped).toHaveLength(1); // agents cannot hand work over
    expect((await manager.post('/api/v1/tasks/bulk', { ids: [], action: 'complete' }, t)).status).toBe(400);
  });
});

describe('tasks: list, filters, summary', () => {
  let ws: AuthedUser;
  beforeAll(async () => {
    ws = await h.register({ emailPrefix: 'tlist' });
    const mk = (title: string, extra: Record<string, unknown> = {}) => ws.post('/api/v1/tasks', { title, ...extra });
    await mk('Overdue urgent', { dueDate: inHours(-30), priority: 'urgent' });
    await mk('Overdue low', { dueDate: inHours(-3), priority: 'low' });
    await mk('Soon', { dueDate: inHours(2), priority: 'high', kind: 'call' });
    await mk('This week', { dueDate: inHours(72), priority: 'medium' });
    await mk('Next month', { dueDate: inHours(24 * 30), priority: 'medium' });
    await mk('Whenever');
    const done = await mk('Already done', { dueDate: inHours(-5) });
    await ws.post(`/api/v1/tasks/${done.body.data.id}/complete`);
  }, 60_000);
  const titles = async (qs: string) => (await ws.get(`/api/v1/tasks?${qs}`)).body.data.map((t: any) => t.title);

  it('filters by state, due window, priority, kind and text', async () => {
    expect((await titles('')).length).toBe(6); // open only by default
    expect(await titles('status=done')).toEqual(['Already done']);
    expect((await titles('status=all')).length).toBe(7);
    expect((await titles('due=overdue')).sort()).toEqual(['Overdue low', 'Overdue urgent']);
    expect(await titles('due=none')).toEqual(['Whenever']);
    expect(await titles('priority=urgent')).toEqual(['Overdue urgent']);
    expect(await titles('kind=call')).toEqual(['Soon']);
    expect(await titles('q=week')).toEqual(['This week']);
    expect(await titles('q=%25')).toEqual([]);
    expect((await titles('assignee=unassigned')).length).toBe(0);
    expect((await ws.get('/api/v1/tasks?due=yesterday')).status).toBe(400);
  });

  it('sorts by due (undated last), priority and creation, and pages with stable cursors', async () => {
    expect((await titles('sort=due&order=asc'))[0]).toBe('Overdue urgent');
    expect((await titles('sort=due&order=asc')).at(-1)).toBe('Whenever');
    expect((await titles('sort=priority&order=desc'))[0]).toBe('Overdue urgent');
    for (const sort of ['due', 'created', 'priority'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
          const r: any = await ws.get(`/api/v1/tasks?limit=2&status=all&sort=${sort}&order=${order}${cursor ? `&cursor=${cursor}` : ''}`);
          seen.push(...r.body.data.map((x: any) => x.id));
          if (!r.body.page.hasMore) break;
          cursor = r.body.page.next;
        }
        expect(seen, `${sort} ${order}`).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      }
    }
    const first: any = await ws.get('/api/v1/tasks?limit=2&sort=due');
    expect((await ws.get(`/api/v1/tasks?limit=2&sort=priority&cursor=${first.body.page.next}`)).status).toBe(400);
  });

  it('summary counts my day and, for managers, the team', async () => {
    const sr = await ws.get('/api/v1/tasks/summary'); if (sr.status !== 200) throw new Error(JSON.stringify(sr.body)); const s = sr.body.data;
    expect(s.mine).toMatchObject({ overdue: 2, open: 6 });
    expect(s.mine.today + s.mine.upcoming).toBeGreaterThanOrEqual(1);
    expect(s.team).toMatchObject({ overdue: 2, unassigned: 0, open: 6 });
    const a = (await agent.get('/api/v1/tasks/summary', as(owner.tenantId))).body.data;
    expect(a.team).toBeNull();
  });
});

describe('notifications and reminders', () => {
  it('assigning work to someone notifies them (not yourself), once, and they can read and clear it', async () => {
    const t = as(owner.tenantId);
    await task(manager, { title: 'Prepare the offer letter', assignedTo: agent2.userId }, t);
    await task(manager, { title: 'My own thing' }, t);
    const inbox = (await agent2.get('/api/v1/notifications', t)).body.data;
    expect(inbox.filter((x: any) => x.title === 'New task for you' && x.message === 'Prepare the offer letter')).toHaveLength(1);
    expect((await manager.get('/api/v1/notifications', t)).body.data.some((x: any) => x.message === 'My own thing')).toBe(false);
    expect((await agent2.get('/api/v1/notifications/unread-count', t)).body.data.count).toBeGreaterThanOrEqual(1);

    // strictly personal
    expect((await agent.get('/api/v1/notifications', t)).body.data.some((x: any) => x.message === 'Prepare the offer letter')).toBe(false);
    const id = inbox[0].id;
    expect((await agent.post('/api/v1/notifications/read', { ids: [id] }, t)).body.data.updated).toBe(0); // not theirs
    expect((await agent2.post('/api/v1/notifications/read', { ids: [id] }, t)).body.data.updated).toBe(1);
    expect((await agent2.get('/api/v1/notifications?unread=true', t)).body.data.some((x: any) => x.id === id)).toBe(false);
    await agent2.post('/api/v1/notifications/read', { all: true }, t);
    expect((await agent2.get('/api/v1/notifications/unread-count', t)).body.data.count).toBe(0);
  });

  it('the dispatcher sends a due reminder exactly once and an overdue alert exactly once', async () => {
    const ws = await h.register({ emailPrefix: 'trem' });
    const t = await task(ws, { title: 'Show the Whitefield villa', dueDate: inHours(0.5), remindBeforeMinutes: 60 });
    expect(new Date(t.dueDate).getTime() - 3_600_000).toBeLessThan(Date.now()); // reminder time already passed
    expect(await dispatch()).toBeGreaterThanOrEqual(1);
    const n1 = (await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type === 'task_reminder');
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ title: 'Task reminder', entityType: 'task', entityId: t.id, link: '/tasks' });
    await dispatch();
    await dispatch();
    expect((await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type === 'task_reminder')).toHaveLength(1);

    await h.admin.query(`UPDATE tasks SET due_date = now() - interval '1 hour' WHERE id = $1`, [t.id]);
    await dispatch();
    await dispatch();
    const over = (await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type === 'task_overdue');
    expect(over).toHaveLength(1);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE type = 'notification.created' AND tenant_id = $1`, [ws.tenantId])).rows[0].n).toBe(2);
  });

  it('finished, cancelled and unassigned tasks never notify; rescheduling re-arms the reminder', async () => {
    const ws = await h.register({ emailPrefix: 'trem2' });
    const done = await task(ws, { dueDate: inHours(-1), remindBeforeMinutes: 10 });
    await ws.post(`/api/v1/tasks/${done.id}/complete`);
    const gone = await task(ws, { dueDate: inHours(-1) });
    await ws.post(`/api/v1/tasks/${gone.id}/cancel`);
    await h.admin.query(`UPDATE tasks SET assigned_to = NULL WHERE id = $1`, [(await task(ws, { dueDate: inHours(-1) })).id]);
    await dispatch();
    expect((await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type !== 'task_assigned')).toHaveLength(0);

    const t = await task(ws, { dueDate: inHours(0.2), remindBeforeMinutes: 30 });
    await dispatch();
    expect((await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type === 'task_reminder')).toHaveLength(1);
    await ws.patch(`/api/v1/tasks/${t.id}`, { dueDate: inHours(0.3) }); // moved → armed again
    await dispatch();
    expect((await ws.get('/api/v1/notifications')).body.data.filter((x: any) => x.type === 'task_reminder')).toHaveLength(2);
  });

  it('only the worker role may run the dispatcher (the API role is refused)', async () => {
    const api = new pg.Client({ connectionString: h.tdb.apiUrl });
    await api.connect();
    await expect(api.query('SELECT app.dispatch_task_notifications(1)')).rejects.toMatchObject({ code: '42501' });
    await api.end();
  });

  it('notification links must be in-app paths', async () => {
    await expect(h.admin.query(`INSERT INTO notifications (tenant_id, user_id, title, message, type, link) VALUES ($1,$2,'x','y','t','https://evil.example')`, [owner.tenantId, owner.userId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.admin.query(`INSERT INTO notifications (tenant_id, user_id, title, message, type, link) VALUES ($1,$2,'x','y','t','//evil.example')`, [owner.tenantId, owner.userId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('documentation', () => {
  it('publishes tasks and notifications in OpenAPI', async () => {
    const spec = (await owner.get('/api/v1/openapi.json')).body;
    for (const p of ['/api/v1/tasks', '/api/v1/tasks/{id}/complete', '/api/v1/tasks/summary', '/api/v1/tasks/bulk', '/api/v1/notifications', '/api/v1/notifications/read']) expect(spec.paths[p], p).toBeTruthy();
    expect(spec.paths['/api/v1/tasks'].get.responses['200'].content['application/json'].schema.properties.page).toBeTruthy();
  });
});
