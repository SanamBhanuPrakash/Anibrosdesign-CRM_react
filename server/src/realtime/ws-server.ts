import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pg from 'pg';
import { parseCookie } from 'cookie';
import { config } from '../platform/config';
import { db } from '../platform/db';
import { logger } from '../logger';
import { can, type Permission, type Role } from '../platform/authz/matrix';
import { EVENT_CATALOG } from '../platform/events';
import { sessions } from '../container';
import { sessionCookieName } from '../modules/identity/sessions';
import { wsConnections } from '../platform/observability/metrics';

/**
 * Realtime hub — pushes "something changed" signals to authorized browsers.
 *
 *  Source of truth: `domain_events` rows written in the business transaction; the insert trigger NOTIFYs
 *  `crm_events` at COMMIT with ids/types only (no PII). This hub LISTENs and fans out.
 *
 *  The browser never trusts a push for data: it invalidates its caches and refetches through the normal, authorized
 *  API. That makes duplicates harmless, makes missed events recoverable, and keeps authorization in exactly one place.
 *
 *  Safety properties
 *   - Origin allow-list on upgrade (cross-site WebSocket hijacking defence), session cookie required.
 *   - Tenant is explicit (?tenant=…, must be an active membership) — never "first membership wins".
 *   - Per-socket permission filter: a user only receives event types their role may read.
 *   - Slow consumers are dropped (bounded memory); per-user and global connection caps.
 *   - Sessions are re-validated every 30 s: revoke/deactivate closes sockets (4401) within that window.
 *   - Any LISTEN gap (DB restart, reconnect) broadcasts `resync` ⇒ clients refetch ⇒ no silent staleness.
 */
interface Client {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  tenantId: string;
  role: Role;
  alive: boolean;
}

interface NotifyPayload {
  id: number;
  t: string; // tenant id
  ty: string; // event type
  a: string; // aggregate type
  i: string; // aggregate id
}

/** @deprecated Legacy pages read topic/action/entityId. Derived from the event so both shapes ship until those pages are rebuilt. */
const LEGACY_TOPIC: Record<string, string> = { lead: 'leads', viewing: 'viewings', task: 'tasks', property: 'properties', activity: 'activities', project: 'projects' };
function legacyFields(eventType: string, aggregateType: string, aggregateId: string) {
  const verb = eventType.split('.').slice(1).join('.');
  const action = verb === 'created' ? 'INSERT' : verb === 'deleted' ? 'DELETE' : verb === 'stage_changed' ? 'TRANSITION' : 'UPDATE';
  return { topic: LEGACY_TOPIC[aggregateType] ?? aggregateType, action, entityId: aggregateId };
}

const MAX_CONNECTIONS_PER_USER = 6;
const MAX_CONNECTIONS_TOTAL = 5000;
const MAX_BUFFERED_BYTES = 1_000_000;

export class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private listener: pg.Client | null = null;
  private heartbeat?: NodeJS.Timeout;
  private revalidate?: NodeJS.Timeout;
  private stopped = false;
  private reconnectAttempts = 0;

  getActiveClientCount(tenantId?: string): number {
    if (!tenantId) return this.clients.size;
    let n = 0;
    for (const c of this.clients) if (c.tenantId === tenantId) n++;
    return n;
  }

  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/api/realtime', maxPayload: 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
    this.heartbeat = setInterval(() => this.sweepDead(), 30_000);
    this.revalidate = setInterval(() => void this.revalidateSessions().catch((e) => logger.warn('WS session revalidation failed', { error: e.message })), 30_000);
    this.heartbeat.unref?.();
    this.revalidate.unref?.();
    void this.connectListener();
  }

  // ── connection lifecycle ──────────────────────────────────────────────────────────────────────────────
  private async onConnection(ws: WebSocket, req: IncomingMessage) {
    try {
      const origin = req.headers.origin;
      if (origin && !config.allowedOriginsArray.includes(origin)) return ws.close(4403, 'origin not allowed');
      if (this.clients.size >= MAX_CONNECTIONS_TOTAL) return ws.close(1013, 'server busy');

      const cookies = parseCookie(req.headers.cookie ?? '');
      const session = await sessions.validate(cookies[sessionCookieName()]);
      if (!session || !session.user.emailVerified) return ws.close(4401, 'unauthenticated');

      const url = new URL(req.url ?? '', 'http://localhost');
      const requested = url.searchParams.get('tenant');
      const tenant = requested
        ? session.tenants.find((t) => t.id === requested)
        : (session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0]);
      if (!tenant) return ws.close(4403, 'not a member of this workspace');

      let perUser = 0;
      for (const c of this.clients) if (c.userId === session.user.id) perUser++;
      if (perUser >= MAX_CONNECTIONS_PER_USER) return ws.close(1013, 'too many connections');

      const client: Client = { ws, userId: session.user.id, sessionId: session.sessionId, tenantId: tenant.id, role: tenant.role, alive: true };
      this.clients.add(client);
      wsConnections.set(this.clients.size);

      ws.on('pong', () => (client.alive = true));
      ws.on('message', (raw) => {
        // The protocol is deliberately tiny: clients may only ping. Everything else is ignored.
        if (raw.toString() === 'ping') ws.send('{"type":"pong"}');
      });
      const drop = () => {
        this.clients.delete(client);
        wsConnections.set(this.clients.size);
      };
      ws.on('close', drop);
      ws.on('error', drop);

      // `hello` tells the client to (re)load its data now: covers the fetch/subscribe race on every (re)connect.
      ws.send(JSON.stringify({ type: 'hello', tenantId: tenant.id, at: new Date().toISOString() }));
    } catch (err: any) {
      logger.error('WebSocket handshake failed', { error: err.message });
      ws.close(1011, 'internal error');
    }
  }

  private sweepDead() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* closed concurrently */
      }
    }
    wsConnections.set(this.clients.size);
  }

  /** Close sockets whose session was revoked/expired or whose user/membership was deactivated. */
  /** Exposed for tests and operations; also runs on a 30 s timer. */
  async revalidateNow() {
    await this.revalidateSessions();
  }

  private async revalidateSessions() {
    if (this.clients.size === 0) return;
    const ids = [...new Set([...this.clients].map((c) => c.sessionId))];
    const { rows } = await db.identity.query<{ id: string }>(
      `SELECT s.id FROM sessions s
         JOIN users u ON u.id = s.user_id AND u.is_active
        WHERE s.id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(secs => $2::int)`,
      [ids, Math.floor(config.sessionIdleMs / 1000)]
    );
    const valid = new Set(rows.map((r) => r.id));
    for (const c of this.clients) {
      if (!valid.has(c.sessionId)) {
        c.ws.close(4401, 'session ended');
        this.clients.delete(c);
      }
    }
    wsConnections.set(this.clients.size);
  }

  // ── Postgres LISTEN with reconnect + resync ───────────────────────────────────────────────────────────────
  private async connectListener() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'anibros-api-listen' });
    this.listener = client;
    const reconnect = (why: string) => {
      if (this.listener !== client) return; // already replaced
      this.listener = null;
      client.removeAllListeners();
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts++) + Math.random() * 250;
      logger.warn('Realtime LISTEN connection lost; reconnecting', { why, retryInMs: Math.round(delay) });
      setTimeout(() => void this.connectListener(), delay).unref?.();
    };
    client.on('error', (e) => reconnect(e.message));
    client.on('end', () => reconnect('end'));
    client.on('notification', (m) => this.onNotify(m.payload));
    try {
      await client.connect();
      await client.query('LISTEN crm_events');
      const recovering = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      logger.info('Realtime LISTEN active', { channel: 'crm_events' });
      // Events may have been missed while disconnected: tell every client to refetch.
      if (recovering) this.broadcastAll({ type: 'resync', reason: 'listener_reconnected' });
    } catch (e: any) {
      reconnect(e.message);
    }
  }

  private onNotify(raw: string | undefined) {
    let p: NotifyPayload;
    try {
      p = JSON.parse(raw ?? '');
    } catch {
      return;
    }
    if (!p?.t || !p.ty) return;
    const permission = (EVENT_CATALOG as Record<string, { permission: Permission }>)[p.ty]?.permission;
    if (!permission) return; // unknown event types are never forwarded
    const message = JSON.stringify({ type: 'event', cursor: p.id, event: p.ty, aggregate: { type: p.a, id: p.i }, at: new Date().toISOString(), ...legacyFields(p.ty, p.a, p.i) });
    for (const c of this.clients) {
      if (c.tenantId !== p.t || c.ws.readyState !== WebSocket.OPEN) continue;
      if (!can(c.role, permission)) continue;
      this.send(c, message);
    }
  }

  private broadcastAll(payload: object) {
    const message = JSON.stringify(payload);
    for (const c of this.clients) if (c.ws.readyState === WebSocket.OPEN) this.send(c, message);
  }

  private send(c: Client, message: string) {
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Slow consumer: drop it rather than letting one stalled tab grow server memory without bound.
      c.ws.terminate();
      this.clients.delete(c);
      return;
    }
    c.ws.send(message);
  }

  /**
   * @deprecated Legacy routes push directly after commit. New code emits a domain event inside its transaction instead.
   * Retained (tenant-scoped, best-effort) until the legacy routes are ported.
   */
  broadcastToTenant(tenantId: string, event: { topic: string; action: string; entityId: string; metadata?: Record<string, unknown> }) {
    const message = JSON.stringify({ type: 'event', event: `${event.topic}.${event.action.toLowerCase()}`, aggregate: { type: event.topic, id: event.entityId }, legacy: true, at: new Date().toISOString(), topic: event.topic, action: event.action, entityId: event.entityId, metadata: event.metadata ?? {} });
    for (const c of this.clients) if (c.tenantId === tenantId && c.ws.readyState === WebSocket.OPEN) this.send(c, message);
  }

  shutdown() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.revalidate) clearInterval(this.revalidate);
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
    this.clients.clear();
    this.wss?.close();
    void this.listener?.end().catch(() => undefined);
    this.listener = null;
  }
}

export const realtimeHub = new RealtimeHub();
