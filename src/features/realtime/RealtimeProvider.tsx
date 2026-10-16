import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthProvider';
import { realtimeBus } from './bus';

/**
 * One WebSocket per tab. A push is only a hint: it invalidates query caches and the normal, authorized API is
 * re-queried. Consequences: duplicates are harmless, missed pushes self-heal on reconnect (`hello`/`resync` refetch
 * everything), and authorization stays in exactly one place (the API).
 */
export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
const Ctx = createContext<{ status: RealtimeStatus }>({ status: 'offline' });
export const useRealtimeStatus = () => useContext(Ctx).status;

/** Event type prefix → query-key roots to invalidate. Keep in sync with server EVENT_CATALOG. */
export const INVALIDATIONS: Record<string, string[]> = {
  lead: ['leads', 'dashboard', 'reports', 'pipeline', 'home'],
  contact: ['contacts'],
  pipeline: ['pipelines', 'leads', 'pipeline'],
  import: ['imports', 'leads'],
  activity: ['activities', 'leads'],
  task: ['tasks', 'dashboard', 'home'],
  viewing: ['viewings', 'calendar', 'tasks', 'leads', 'home', 'dashboard'],
  automation: ['automations', 'automation-runs'],
  property: ['properties', 'matching', 'projects', 'deals', 'dashboard'],
  reservation: ['deals', 'properties', 'leads', 'home', 'dashboard', 'pipelines', 'shortlist'],
  shortlist: ['shortlist', 'leads'],
  project: ['projects', 'properties'],
  notification: ['notifications'],
  integration: ['integrations'],
  lead_source: ['lead-sources'],
  inbound: ['lead-sources', 'leads'],
  webhook: ['operations'],
  member: ['members', 'me'],
};

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { status: auth, me } = useAuth();
  const [status, setStatus] = useState<RealtimeStatus>('offline');
  const tenantId = me?.activeTenantId;
  const attempts = useRef(0);

  useEffect(() => {
    if (auth !== 'authenticated' || !tenantId) {
      setStatus('offline');
      return;
    }
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closedByUs = false;
    let pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    // Coalesce bursts (e.g. an import creating 500 leads) into one invalidation per key per 150 ms.
    const queueInvalidate = (roots: string[]) => {
      roots.forEach((r) => pending.add(r));
      flushTimer ??= setTimeout(() => {
        const keys = [...pending];
        pending = new Set();
        flushTimer = undefined;
        keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
      }, 150);
    };

    const refetchAll = () => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });

    const connect = () => {
      setStatus(attempts.current === 0 ? 'connecting' : 'reconnecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/api/realtime?tenant=${encodeURIComponent(tenantId)}`);
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === 'hello') {
          attempts.current = 0;
          setStatus('live');
          refetchAll(); // resync after every (re)connect: closes the fetch/subscribe race and any gap
        } else if (m.type === 'resync') {
          refetchAll();
        } else if (m.type === 'event') {
          realtimeBus.emit(m);
          const root = String(m.event ?? '').split('.')[0];
          queueInvalidate(INVALIDATIONS[root] ?? []);
        }
      };
      ws.onclose = (e) => {
        if (closedByUs) return;
        // 4401 = session ended, 4403 = not allowed: do not hammer the server; API 401s drive the auth layer.
        if (e.code === 4401 || e.code === 4403) return setStatus('offline');
        setStatus('reconnecting');
        const delay = Math.min(30_000, 1000 * 2 ** attempts.current++) * (0.7 + Math.random() * 0.6);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    // Deferred a tick so React StrictMode's mount→unmount→mount in dev doesn't open (and abort) a throw-away socket.
    timer = setTimeout(connect, 40);
    const heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    const online = () => {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        connect();
      }
    };
    window.addEventListener('online', online);
    return () => {
      closedByUs = true;
      clearTimeout(timer);
      clearTimeout(flushTimer);
      clearInterval(heartbeat);
      window.removeEventListener('online', online);
      ws?.close();
    };
  }, [auth, tenantId, qc]);

  return <Ctx.Provider value={{ status }}>{children}</Ctx.Provider>;
}
