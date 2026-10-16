import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';
import { unzip } from '../modules/agency/xlsx';

/**
 * "No issues even with 10 clients and 10 employees on each, all working at once."
 *
 * 10 clients, 20 employees; every client has exactly 10 of them (one team lead + nine callers) and every employee works in 5 clients.
 * Everybody works at the same time, against the restricted database role (row-level security enforced): they add leads, list their own leads
 * across clients, log calls and WhatsApp messages, edit custom fields, and open several clients at once the way browser tabs would.
 * Afterwards the database is audited: nothing lost, nothing duplicated, nothing in the wrong client, nobody saw a client they do not belong to.
 */
const CLIENTS = 10;
const EMPLOYEES = 20;
const TEAM = 10; // employees per client
const LEADS_EACH = 4; // leads each employee adds in each of their clients

let h: ApiHarness;
let boss: AuthedUser;
let hq: string;
const clients: Array<{ id: string; name: string; industry: string }> = [];
const staff: AuthedUser[] = [];
const memberOf: number[][] = []; // employee index → client indexes
const teamOf: number[][] = []; // client index → employee indexes (first = team lead)
const statuses = new Map<number, number>();
const timings: Record<string, number> = {};

const note = <T extends { status: number }>(r: T): T => {
  statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  return r;
};
const H = (clientId: string) => ({ 'X-Tenant-Id': clientId });
const AG = (id: string) => ({ 'X-Tenant-Id': id }); // agency calls are made from the agency HQ
const A = '/api/v1/agency';

/** Run `fn` over `items` with at most `limit` running at once. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}
const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = Date.now() - t0;
  }
};
const db = async (sql: string, params: unknown[] = []) => (await h.admin.query(sql, params)).rows;

const INDUSTRIES = ['healthcare', 'restaurant', 'finance', 'retail', 'education', 'beauty_wellness', 'automotive', 'travel', 'professional_services', 'other'];

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  boss = await h.register({ emailPrefix: 'scaleboss', name: 'Scale Boss', organisationName: 'Scale Agency' });
  hq = boss.tenantId;

  await timed('create 10 clients', async () => {
    for (let c = 0; c < CLIENTS; c++) {
      const r = await boss.post(`${A}/clients`, { name: `Client ${c}`, industry: INDUSTRIES[c] });
      if (r.status !== 201) throw new Error(`client ${c}: ${r.status} ${JSON.stringify(r.body)}`);
      clients.push(r.body.data);
    }
  });

  await timed('register 20 employees', async () => {
    for (let e = 0; e < EMPLOYEES; e++) staff.push(await h.register({ emailPrefix: `scaleemp${e}_`, name: `Employee ${e}` }));
  });

  // Assign: client c gets employees (2c .. 2c+9) mod 20; the first of them is the team lead. Done through the product's own API
  // as the agency admin would, after adding each person to the agency (HQ) directly (the invitation flow is covered elsewhere).
  for (let e = 0; e < EMPLOYEES; e++) memberOf.push([]);
  for (let c = 0; c < CLIENTS; c++) teamOf.push(Array.from({ length: TEAM }, (_, k) => (2 * c + k) % EMPLOYEES));
  await timed('assign teams', async () => {
    for (const s of staff) await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'sales_agent','active',true)`, [hq, s.userId]);
    for (let c = 0; c < CLIENTS; c++) {
      for (const [k, e] of teamOf[c]!.entries()) {
        memberOf[e]!.push(c);
        const r = await boss.put(`${A}/clients/${clients[c]!.id}/team/${staff[e]!.userId}`, { role: k === 0 ? 'sales_manager' : 'sales_agent' });
        if (r.status !== 200) throw new Error(`assign: ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
  });
  // two custom fields in client 0 for the concurrent-edit scenario
  for (const label of ['Alpha detail', 'Beta detail']) expect((await boss.post('/api/v1/custom-fields', { label, type: 'text' }, H(clients[0]!.id))).status).toBe(201);
}, 300_000);
afterAll(async () => h?.close());

describe('10 clients × 10 employees, everyone working at once', () => {
  it('the setup is what the scenario says it is', async () => {
    expect(memberOf.every((m) => m.length === 5)).toBe(true);
    expect(teamOf.every((t) => new Set(t).size === TEAM)).toBe(true);
    const rows = await db(`SELECT tenant_id, count(*)::int AS n FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[]) AND status = 'active' AND role <> 'tenant_owner' GROUP BY tenant_id`, [clients.map((c) => c.id)]);
    expect(rows).toHaveLength(CLIENTS);
    expect(rows.every((r) => r.n === TEAM)).toBe(true);
  });

  it('all employees add leads in all their clients at the same moment: none lost, none doubled, none in the wrong client', async () => {
    await timed('add leads', () =>
      pool(staff, EMPLOYEES, async (s, e) => {
        // every employee works their 5 clients at once (like five browser tabs)
        await Promise.all(
          memberOf[e]!.map(async (c) => {
            for (let k = 0; k < LEADS_EACH; k++) {
              const r = note(await s.post('/api/v1/leads', { contact: { firstName: `C${c}E${e}L${k}`, email: `c${c}-e${e}-${k}@scale.test` }, source: 'meta_ads', campaign: `Camp ${c}` }, H(clients[c]!.id)));
              if (r.status !== 201) throw new Error(`lead c${c} e${e} k${k}: ${r.status} ${JSON.stringify(r.body)}`);
            }
          })
        );
      })
    );
    const perClient = await db(`SELECT tenant_id, count(*)::int AS n FROM leads WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id`, [clients.map((c) => c.id)]);
    expect(perClient).toHaveLength(CLIENTS);
    for (const r of perClient) expect(r.n, 'leads per client').toBe(TEAM * LEADS_EACH);
    expect((await db(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = ANY($1::uuid[])`, [clients.map((c) => c.id)]))[0].n).toBe(CLIENTS * TEAM * LEADS_EACH);

    // nothing in the wrong client: every lead's contact tag names the client it lives in
    for (const [c, cl] of clients.entries()) {
      const wrong = await db(`SELECT count(*)::int AS n FROM leads l JOIN contacts k ON k.id = l.contact_id AND k.tenant_id = l.tenant_id WHERE l.tenant_id = $1 AND k.email::text NOT LIKE $2`, [cl.id, `c${c}-%`]);
      expect(wrong[0].n, `client ${c} holds a foreign lead`).toBe(0);
      const foreign = await db(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id <> $1 AND l.contact_id IN (SELECT id FROM contacts WHERE tenant_id = $1)`, [cl.id]);
      expect(foreign[0].n).toBe(0);
    }
    // no lead was created twice
    expect((await db(`SELECT count(*)::int AS n FROM (SELECT contact_id FROM leads WHERE tenant_id = ANY($1::uuid[]) GROUP BY contact_id HAVING count(*) > 1) d`, [clients.map((c) => c.id)]))[0].n).toBe(0);
  }, 300_000);

  it('new leads were shared fairly among each client’s callers, never to the wrong people', async () => {
    for (const [c, cl] of clients.entries()) {
      const callers = teamOf[c]!.slice(1).map((e) => staff[e]!.userId);
      const rows = await db(`SELECT owner_id, count(*)::int AS n FROM leads WHERE tenant_id = $1 GROUP BY owner_id`, [cl.id]);
      expect(rows.every((r) => r.owner_id && callers.includes(r.owner_id)), `client ${c}: every lead belongs to one of its callers`).toBe(true);
      const counts = callers.map((id) => rows.find((r) => r.owner_id === id)?.n ?? 0);
      expect(Math.max(...counts) - Math.min(...counts), `client ${c}: spread ${counts.join(',')}`).toBeLessThanOrEqual(1);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(TEAM * LEADS_EACH);
    }
  });

  it('every employee sees exactly their own leads across their clients, and all of them log calls and messages at once', async () => {
    const expected = new Map<string, number>();
    for (const r of await db(`SELECT owner_id, count(*)::int AS n FROM leads WHERE tenant_id = ANY($1::uuid[]) GROUP BY owner_id`, [clients.map((c) => c.id)])) expected.set(r.owner_id, r.n);
    let logged = 0;
    await timed('list + log work', () =>
      pool(staff, EMPLOYEES, async (s, e) => {
        const mine = note(await s.get(`${A}/leads?ownerId=me&pageSize=100`, AG(hq)));
        expect(mine.status).toBe(200);
        const items = mine.body.data.items as Array<{ id: string; client: { id: string }; ownerId: string }>;
        expect(items.length, `employee ${e} sees exactly their own leads`).toBe(expected.get(s.userId) ?? 0);
        expect(items.every((i) => i.ownerId === s.userId)).toBe(true);
        expect(items.every((i) => memberOf[e]!.some((c) => clients[c]!.id === i.client.id))).toBe(true); // only clients they belong to
        // log a call and a WhatsApp on each of their leads, in parallel across clients
        await pool(items, 5, async (it) => {
            const call = note(await s.post(`/api/v1/leads/${it.id}/activities`, { type: 'call', outcome: 'connected', durationMinutes: 3, description: 'Spoke about the offer' }, H(it.client.id)));
            const wa = note(await s.post(`/api/v1/leads/${it.id}/activities`, { type: 'whatsapp', outcome: 'sent', description: 'Sent details' }, H(it.client.id)));
            expect([call.status, wa.status]).toEqual([201, 201]);
            logged += 2;
        });
      })
    );
    expect(logged).toBe(2 * CLIENTS * TEAM * LEADS_EACH);
    const acts = await db(`SELECT type::text AS type, count(*)::int AS n FROM activities WHERE tenant_id = ANY($1::uuid[]) AND type IN ('call','whatsapp') GROUP BY type`, [clients.map((c) => c.id)]);
    expect(Object.fromEntries(acts.map((a) => [a.type, a.n]))).toEqual({ call: CLIENTS * TEAM * LEADS_EACH, whatsapp: CLIENTS * TEAM * LEADS_EACH });
    // every activity is in the same client as its lead and was logged by the lead's owner
    expect((await db(`SELECT count(*)::int AS n FROM activities a JOIN leads l ON l.id = a.lead_id WHERE a.tenant_id = ANY($1::uuid[]) AND a.type IN ('call','whatsapp') AND (a.tenant_id <> l.tenant_id OR a.user_id IS DISTINCT FROM l.owner_id)`, [clients.map((c) => c.id)]))[0].n).toBe(0);
    // each lead was answered exactly once in the first-response sense
    expect((await db(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = ANY($1::uuid[]) AND first_response_at IS NULL`, [clients.map((c) => c.id)]))[0].n).toBe(0);
  }, 300_000);

  it('many people logging on the same lead at once, and two people editing different custom fields of it, lose nothing', async () => {
    const c0 = clients[0]!;
    const lead = (await db(`SELECT id, owner_id FROM leads WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [c0.id]))[0];
    const ownerIdx = staff.findIndex((s) => s.userId === lead.owner_id);
    const lead0Team = [staff[teamOf[0]![0]!]!, staff[ownerIdx]!]; // the team lead and the owning caller may both work this lead
    const before = (await db(`SELECT count(*)::int AS n FROM activities WHERE lead_id = $1`, [lead.id]))[0].n;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => lead0Team[i % 2]!.post(`/api/v1/leads/${lead.id}/activities`, { type: 'note', description: `parallel note ${i}` }, H(c0.id)).then(note))
    );
    expect(results.map((r) => r.status)).toEqual(Array(30).fill(201));
    expect((await db(`SELECT count(*)::int AS n FROM activities WHERE lead_id = $1`, [lead.id]))[0].n).toBe(before + 30);

    const [a, b] = await Promise.all([
      lead0Team[0]!.patch(`/api/v1/leads/${lead.id}`, { customFields: { alpha_detail: 'from the team lead' } }, H(c0.id)),
      lead0Team[1]!.patch(`/api/v1/leads/${lead.id}`, { customFields: { beta_detail: 'from the caller' } }, H(c0.id)),
    ]);
    note(a);
    note(b);
    expect([a.status, b.status]).toEqual([200, 200]);
    const cf = (await db(`SELECT custom_fields FROM leads WHERE id = $1`, [lead.id]))[0].custom_fields;
    expect(cf).toEqual({ alpha_detail: 'from the team lead', beta_detail: 'from the caller' });
  }, 120_000);

  it('browser-tab mode: one employee with five clients open at once is never shown another client’s data', async () => {
    const e = 0;
    const s = staff[e]!;
    const mine = memberOf[e]!;
    const idsByClient = new Map<string, Set<string>>();
    for (const c of clients) idsByClient.set(c.id, new Set((await db(`SELECT id FROM leads WHERE tenant_id = $1`, [c.id])).map((r) => r.id)));
    const calls = Array.from({ length: 100 }, (_, i) => mine[i % mine.length]!);
    const rs = await timed('tabs', () => Promise.all(calls.map((c) => s.get('/api/v1/leads?limit=100', H(clients[c]!.id)).then(note))));
    rs.forEach((r, i) => {
      const cid = clients[calls[i]!]!.id;
      expect(r.status).toBe(200);
      expect(r.body.data.length).toBeGreaterThan(0);
      for (const l of r.body.data as Array<{ id: string }>) expect(idsByClient.get(cid)!.has(l.id), 'a lead of another client appeared').toBe(true);
    });
    // clients this employee does NOT belong to are closed to them, however many tabs ask
    const notMine = clients.map((_, c) => c).filter((c) => !mine.includes(c));
    const denied = await Promise.all(notMine.flatMap((c) => Array.from({ length: 10 }, () => s.get('/api/v1/leads', H(clients[c]!.id)).then(note))));
    expect(denied.every((r) => r.status === 403)).toBe(true);
    const sneaky = await s.get(`/api/v1/leads/${[...idsByClient.get(clients[notMine[0]!]!.id)!][0]}`, H(clients[mine[0]!]!.id)); // a foreign lead id inside one of my clients
    expect(note(sneaky).status).toBe(404);
  }, 120_000);

  it('the admin sees every lead of every client, consistently, and the numbers add up', async () => {
    const total = CLIENTS * TEAM * LEADS_EACH;
    const first = note(await boss.get(`${A}/leads?pageSize=100`));
    expect(first.body.data.page).toMatchObject({ total, totalPages: total / 100 });
    expect(first.body.data.byClient).toHaveLength(CLIENTS);
    expect(first.body.data.byClient.every((b: any) => b.total === TEAM * LEADS_EACH)).toBe(true);
    const seen = new Set<string>();
    for (let p = 1; p <= total / 100; p++) for (const i of (note(await boss.get(`${A}/leads?pageSize=100&page=${p}`)).body.data.items as Array<{ id: string }>)) seen.add(i.id);
    expect(seen.size).toBe(total);
    const o = note(await timed('overview', () => boss.get(`${A}/overview`))).body.data;
    expect(o.clients.active).toBe(CLIENTS);
    expect(o.totals.totalLeads).toBe(total);
    expect(o.staff).toBe(EMPLOYEES + 1);
    const list = note(await boss.get(`${A}/clients`)).body.data as Array<{ stats: { totalLeads: number }; assignedStaff: number }>;
    expect(list.every((c) => c.stats.totalLeads === TEAM * LEADS_EACH && c.assignedStaff === TEAM)).toBe(true);

    const act = note(await boss.get(`${A}/activity`)).body.data;
    expect(act.totals).toMatchObject({ calls: total, connected: total, whatsapp: total });
    expect(act.rows).toHaveLength(CLIENTS * (TEAM - 1)); // every caller of every client has a row; the team leads logged no calls

    const x = await timed('export 400 leads', () => binaryGet(boss.get(`${A}/leads/export`)));
    expect(x.status).toBe(200);
    const sheet = unzip(x.body as Buffer).find((p) => p.name === 'xl/worksheets/sheet1.xml')!.data.toString('utf8');
    expect((sheet.match(/<row /g) ?? []).length).toBe(total + 1);
    // an employee's own downloads and lists never include a client they are not in
    const emp = staff[3]!;
    const own = note(await emp.get(`${A}/leads?pageSize=100`, AG(hq))).body.data;
    expect(own.byClient.map((b: any) => b.clientId).sort()).toEqual(memberOf[3]!.map((c) => clients[c]!.id).sort());
  }, 180_000);

  it('through all of it: no server errors, and it was quick enough', () => {
    const bad = [...statuses.entries()].filter(([s]) => s >= 500);
    expect(bad, `server errors: ${JSON.stringify(bad)}`).toEqual([]);
    const unexpected = [...statuses.entries()].filter(([s]) => ![200, 201, 403, 404].includes(s));
    expect(unexpected).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[scale] requests by status ${JSON.stringify(Object.fromEntries(statuses))}; timings (ms) ${JSON.stringify(timings)}`);
    expect(timings['add leads']!).toBeLessThan(120_000);
    expect(timings['list + log work']!).toBeLessThan(120_000);
    expect(timings['tabs']!).toBeLessThan(30_000);
  });
});

function binaryGet(t: request.Test) {
  return t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}
