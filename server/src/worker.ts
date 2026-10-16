import http from 'http';
import { config, describeConfig } from './platform/config';
import { createWorkerDb } from './platform/db';
import { logger } from './logger';
import { JobRunner, type JobHandler } from './platform/jobs';
import { EventDispatcher, type EventConsumer } from './platform/events';
import { mailSendHandler, mailStatus } from './platform/mail';
import { leadsImportHandler } from './modules/leads/import';
import { inboundProcessHandler } from './modules/inbound/processor';
import { automationJobHandlers } from './modules/automation/jobs';
import { automationConsumer } from './modules/automation/engine';
import { outboundConsumer, outboundJobHandlers } from './modules/outbound/delivery';
import { messageSendHandler } from './modules/messaging/service';
import { refreshQueueGauges, runMaintenance } from './platform/maintenance';
import { metricsHandler, registerDbGauges } from './platform/observability/metrics';
import { bindEventLog, flushEvents } from './platform/observability/event-log';

/**
 * Worker process: background jobs, event dispatching, scheduled maintenance.
 * Runs as the restricted `crm_worker` role (cross-tenant ONLY on queue tables; business data still needs tenant context).
 * Scale horizontally: job claims use SKIP LOCKED, event consumers use cursor row locks.
 */
export const jobHandlers: Record<string, JobHandler> = {
  'mail.send': mailSendHandler,
  'leads.import': leadsImportHandler,
  'inbound.process': inboundProcessHandler,
  ...automationJobHandlers,
  ...outboundJobHandlers,
  'message.send': messageSendHandler,
  // Later: 'webhook.deliver', 'sla.check', …
};

export const eventConsumers: EventConsumer[] = [
  automationConsumer,
  outboundConsumer,
  // Later: outbound webhooks, conversions.
];

export interface WorkerHandle {
  stop(): Promise<void>;
}

export async function startWorker(opts: { healthPort?: number | null } = {}): Promise<WorkerHandle> {
  const db = createWorkerDb();
  const role = await db.assertRuntimeRoleSafe('worker');
  logger.info('Worker starting', { ...describeConfig(), dbRole: role.role, mail: mailStatus() });
  registerDbGauges(db, 'worker');
  bindEventLog(() => db);

  const runner = new JobRunner(db, jobHandlers, { concurrency: 8, listenConnectionString: config.workerDatabaseUrl });
  await runner.start();

  const dispatcher = new EventDispatcher(db, eventConsumers);
  let stopping = false;
  const dispatchLoop = (async () => {
    while (!stopping) {
      try {
        const handled = await dispatcher.runOnce();
        const busy = Object.values(handled).some((n) => n > 0);
        await new Promise((r) => setTimeout(r, busy ? 50 : 1000));
      } catch (e: any) {
        logger.error('Event dispatch loop error', { error: e.message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  const tick = async () => {
    try {
      await runner.reap();
      // Task reminders / overdue alerts: one narrow cross-tenant SQL function, safe with any number of workers.
      const sent = (await db.query<{ n: number }>('SELECT app.dispatch_task_notifications(200) AS n')).rows[0]?.n ?? 0;
      if (sent) logger.info('Task notifications dispatched', { count: sent });
      await refreshQueueGauges(db);
      // Heartbeat the Monitor panel reads (via app.platform_health): proves the worker is alive and its loop is turning.
      await db.query(`INSERT INTO system_health (component, status, latency_ms, last_checked_at, details) VALUES ('worker', 'healthy', 0, now(), '{}'::jsonb)
                      ON CONFLICT (component, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET status = 'healthy', last_checked_at = now()`);
    } catch (e: any) {
      logger.warn('Worker housekeeping tick failed', { error: e.message });
    }
  };
  const tickTimer = setInterval(() => void tick(), 15_000);
  const maintTimer = setInterval(() => void runMaintenance(db).then((r) => logger.info('Maintenance complete', r)), 6 * 3_600_000);
  tickTimer.unref?.();
  maintTimer.unref?.();
  void tick();

  let healthServer: http.Server | undefined;
  const port = opts.healthPort === undefined ? Number(process.env.WORKER_HEALTH_PORT ?? 4001) : opts.healthPort;
  if (port) {
    healthServer = http
      .createServer(async (req, res) => {
        if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        if (req.url === '/readyz') {
          try {
            await db.query('SELECT 1');
            return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ready', counters: runner.counters }));
          } catch {
            return void res.writeHead(503).end('{"status":"unavailable"}');
          }
        }
        if (req.url === '/metrics') return metricsHandler(req as any, res as any);
        res.writeHead(404).end();
      })
      .listen(port, config.HOST);
  }

  return {
    async stop() {
      stopping = true;
      clearInterval(tickTimer);
      clearInterval(maintTimer);
      await runner.stop();
      await dispatchLoop;
      await flushEvents();
      healthServer?.close();
      await db.end();
      logger.info('Worker stopped');
    },
  };
}

// Run directly: `tsx server/src/worker.ts`
if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  startWorker()
    .then((w) => {
      const shutdown = (sig: string) => {
        logger.info(`${sig} received: draining worker`);
        const force = setTimeout(() => process.exit(1), 30_000);
        void w.stop().then(() => {
          clearTimeout(force);
          process.exit(0);
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((e) => {
      logger.error('Worker failed to start', { error: e.message });
      process.exit(1);
    });
}
