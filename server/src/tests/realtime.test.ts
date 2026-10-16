import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import WebSocket from 'ws';
import { bootApi, type ApiHarness, type AuthedUser } from './support/app-harness';

/**
 * Realtime hub, end to end with real sockets: handshake auth, origin check, tenant binding, per-role event filtering,
 * session revocation and connection caps. Events are produced exactly as production does: emit() inside a transaction.
 */
let h: ApiHarness;
let server: http.Server;
let port: number;
let hub: typeof import('../realtime/ws-server').realtimeHub;
let emitEvent: typeof import('../platform/events').emit;
let db: ReturnType<typeof import('../platform/db').getDb>;
const ORIGIN = 'http://127.0.0.1:5274';

beforeAll(async () => {
  h = await bootApi({ restricted: true });
  ({ realtimeHub: hub } = await import('../realtime/ws-server'));
  ({ emit: emitEvent } = await import('../platform/events'));
  db = (await import('../platform/db')).getDb();
  server = http.createServer(h.app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as any).port;
  hub.initialize(server);
  await new Promise((r) => setTimeout(r, 300)); // let LISTEN attach
}, 90_000);

afterAll(async () => {
  hub.shutdown();
  server.close();
  await h?.close();
});

interface Sock {
  ws: WebSocket;
  messages: any[];
  closed: Promise<number>;
  waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>;
}

function connect(user: Pick<AuthedUser, 'cookies'> | null, opts: { origin?: string | null; tenant?: string } = {}): Promise<Sock> {
  const headers: Record<string, string> = {};
  if (user) headers.Cookie = user.cookies.join('; ');
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime${opts.tenant ? `?tenant=${opts.tenant}` : ''}`, { headers });
  const messages: any[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    messages.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const sock: Sock = {
    ws,
    messages,
    closed,
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timeout; saw ${JSON.stringify(messages)}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
  return new Promise((resolve) => {
    ws.on('open', () => resolve(sock));
    ws.on('error', () => resolve(sock)); // rejected upgrades are asserted via `closed`/messages
    ws.on('unexpected-response', () => resolve(sock));
  });
}

const produce = (u: AuthedUser, type: 'lead.created' | 'member.updated', aggregateId = '00000000-0000-4000-8000-000000000001') =>
  db.withTenant({ tenantId: u.tenantId, userId: u.userId }, (tx) => emitEvent(tx, { type, aggregateId, payload: { n: 1 } }));

describe('realtime hub', () => {
  it('rejects unauthenticated sockets (4401) and foreign origins (4403)', async () => {
    const anon = await connect(null);
    expect(await anon.closed).toBe(4401);
    const owner = await h.register({ emailPrefix: 'rtauth' });
    const evil = await connect(owner, { origin: 'https://evil.example' });
    expect(await evil.closed).toBe(4403);
  });

  it('authenticated user gets `hello`, then pushes for events of their own workspace', async () => {
    const owner = await h.register({ emailPrefix: 'rtown' });
    const s = await connect(owner);
    await s.waitFor((m) => m.type === 'hello' && m.tenantId === owner.tenantId);
    await produce(owner, 'lead.created');
    const ev = await s.waitFor((m) => m.type === 'event' && m.event === 'lead.created');
    expect(ev.aggregate).toMatchObject({ type: 'lead' });
    expect(ev.cursor).toBeTypeOf('number');
    // A push carries identifiers and routing hints only — never business data.
    const allowed = new Set(['type', 'event', 'aggregate', 'cursor', 'at', 'topic', 'action', 'entityId']); // topic/action/entityId: deprecated legacy aliases
    expect(Object.keys(ev).filter((k) => !allowed.has(k))).toEqual([]);
    expect(JSON.stringify(ev)).not.toMatch(/email|phone|name|payload/i);
    s.ws.close();
  });

  it('events never cross tenants', async () => {
    const a = await h.register({ emailPrefix: 'rta' });
    const b = await h.register({ emailPrefix: 'rtb' });
    const sa = await connect(a);
    const sb = await connect(b);
    await Promise.all([sa.waitFor((m) => m.type === 'hello'), sb.waitFor((m) => m.type === 'hello')]);
    await produce(a, 'lead.created');
    await sa.waitFor((m) => m.event === 'lead.created');
    await new Promise((r) => setTimeout(r, 300));
    expect(sb.messages.filter((m) => m.type === 'event')).toHaveLength(0);
    sa.ws.close();
    sb.ws.close();
  });

  it('per-role filtering: an auditor (no leads:read) does not receive lead events but does receive membership events', async () => {
    const owner = await h.register({ emailPrefix: 'rtroles' });
    const auditor = await h.register({ emailPrefix: 'rtaud' });
    await h.admin.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active) VALUES ($1,$2,'auditor','active',true)`, [owner.tenantId, auditor.userId]);
    const sock = await connect(auditor, { tenant: owner.tenantId });
    await sock.waitFor((m) => m.type === 'hello' && m.tenantId === owner.tenantId);
    await produce(owner, 'lead.created');
    await produce(owner, 'member.updated');
    await sock.waitFor((m) => m.event === 'member.updated');
    await new Promise((r) => setTimeout(r, 200));
    expect(sock.messages.some((m) => m.event === 'lead.created')).toBe(false);
    sock.ws.close();
  });

  it('tenant must be an explicit, verified membership (4403) — never "first membership wins"', async () => {
    const a = await h.register({ emailPrefix: 'rtt1' });
    const b = await h.register({ emailPrefix: 'rtt2' });
    const s = await connect(a, { tenant: b.tenantId });
    expect(await s.closed).toBe(4403);
  });

  it('unknown event types are never forwarded', async () => {
    const owner = await h.register({ emailPrefix: 'rtunk' });
    const s = await connect(owner);
    await s.waitFor((m) => m.type === 'hello');
    await db.withTenant({ tenantId: owner.tenantId, userId: owner.userId }, (tx) =>
      tx.query(`INSERT INTO domain_events (type, aggregate_type, aggregate_id) VALUES ('internal.secret','x','00000000-0000-4000-8000-000000000002')`)
    );
    await produce(owner, 'lead.created');
    await s.waitFor((m) => m.event === 'lead.created');
    expect(s.messages.some((m) => m.event === 'internal.secret')).toBe(false);
    s.ws.close();
  });

  it('revoking the session closes the socket (4401)', async () => {
    const owner = await h.register({ emailPrefix: 'rtrev' });
    const second = await h.loginAs(owner.email, owner.password);
    const s = await connect(second);
    await s.waitFor((m) => m.type === 'hello');
    await h.admin.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [owner.userId]);
    await hub.revalidateNow();
    expect(await s.closed).toBe(4401);
  });

  it('deactivating the user closes their sockets', async () => {
    const owner = await h.register({ emailPrefix: 'rtdeact' });
    const s = await connect(owner);
    await s.waitFor((m) => m.type === 'hello');
    await h.admin.query(`UPDATE users SET is_active = false WHERE id = $1`, [owner.userId]);
    await hub.revalidateNow();
    expect(await s.closed).toBe(4401);
  });

  it('caps concurrent connections per user', async () => {
    const owner = await h.register({ emailPrefix: 'rtcap' });
    const socks: Sock[] = [];
    for (let i = 0; i < 6; i++) {
      const s = await connect(owner);
      await s.waitFor((m) => m.type === 'hello');
      socks.push(s);
    }
    const seventh = await connect(owner);
    expect(await seventh.closed).toBe(1013);
    socks.forEach((s) => s.ws.close());
  });

  it('clients cannot inject events or subscribe to anything: only ping is understood', async () => {
    const owner = await h.register({ emailPrefix: 'rtping' });
    const s = await connect(owner);
    await s.waitFor((m) => m.type === 'hello');
    s.ws.send(JSON.stringify({ action: 'subscribe', topics: ['*'], tenant: 'x' }));
    s.ws.send('ping');
    await s.waitFor((m) => m.type === 'pong');
    expect(s.messages.filter((m) => m.type === 'event')).toHaveLength(0);
    s.ws.close();
  });
});
