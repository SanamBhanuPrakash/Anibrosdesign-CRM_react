import client from 'prom-client';
import type { NextFunction, Request, Response } from 'express';
import type { Database } from '../db';
import { safeEqual } from '../crypto/field-encryption';
import { config } from '../config';

/**
 * Prometheus metrics. RED for HTTP (rate, errors, duration) + saturation for the DB pool.
 * Cardinality rule: labels are route TEMPLATES (`/leads/:id`), never raw URLs, tenant ids or user ids.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'anibros_' });

export const httpDuration = new client.Histogram({
  name: 'anibros_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 6],
  registers: [registry],
});
export const httpInflight = new client.Gauge({ name: 'anibros_http_inflight_requests', help: 'In-flight HTTP requests', registers: [registry] });
export const authDenied = new client.Counter({ name: 'anibros_auth_denied_total', help: 'Denied auth attempts by reason', labelNames: ['reason'] as const, registers: [registry] });
export const jobsProcessed = new client.Counter({ name: 'anibros_jobs_total', help: 'Jobs by outcome', labelNames: ['type', 'outcome'] as const, registers: [registry] });
export const automationRuns = new client.Counter({ name: 'anibros_automation_executions_total', help: 'Automation executions by template and outcome', labelNames: ['template', 'outcome'] as const, registers: [registry] });
export const jobsQueueDepth = new client.Gauge({ name: 'anibros_jobs_queue_depth', help: 'Jobs by status', labelNames: ['status'] as const, registers: [registry] });
export const jobsOldestAge = new client.Gauge({ name: 'anibros_jobs_oldest_queued_age_seconds', help: 'Age of the oldest runnable job', registers: [registry] });
export const eventConsumerLag = new client.Gauge({ name: 'anibros_event_consumer_lag', help: 'Undelivered events per consumer', labelNames: ['consumer'] as const, registers: [registry] });
export const wsConnections = new client.Gauge({ name: 'anibros_ws_connections', help: 'Open realtime sockets', registers: [registry] });

export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  httpInflight.inc();
  res.on('finish', () => {
    httpInflight.dec();
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export function registerDbGauges(db: Database, name = 'api') {
  if (registry.getSingleMetric('anibros_db_pool_connections')) return; // idempotent (createApp may run more than once in tests/tools)
  new client.Gauge({
    name: 'anibros_db_pool_connections',
    help: 'DB pool connections by state',
    labelNames: ['pool', 'state'] as const,
    registers: [registry],
    collect() {
      const s = db.stats();
      this.set({ pool: name, state: 'total' }, s.total);
      this.set({ pool: name, state: 'idle' }, s.idle);
      this.set({ pool: name, state: 'waiting' }, s.waiting);
    },
  });
}

/** `/metrics` handler: requires `Authorization: Bearer $METRICS_TOKEN` when configured; loopback-only otherwise. */
export function metricsHandler(req: Request, res: Response) {
  const token = config.METRICS_TOKEN;
  if (token) {
    const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(given, token)) return void res.status(401).end();
  } else if (config.isProduction) {
    return void res.status(404).end(); // never expose metrics in production without a token
  }
  registry
    .metrics()
    .then((m) => res.type(registry.contentType).send(m))
    .catch(() => res.status(500).end());
}
