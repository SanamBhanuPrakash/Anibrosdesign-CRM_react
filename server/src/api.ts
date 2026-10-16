import type { Server } from 'http';
import { app } from './app';
import { config, describeConfig } from './platform/config';
import { db } from './platform/db';
import { logger } from './logger';
import { realtimeHub } from './realtime/ws-server';

/**
 * API process: HTTP + realtime gateway. Stateless; run N replicas behind a load balancer (no sticky sessions needed).
 */
export async function startApi(): Promise<{ server: Server; stop(): Promise<void> }> {
  const role = await db.assertRuntimeRoleSafe('api');
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info('API listening', { ...describeConfig(), dbRole: role.role, rlsEnforced: !role.superuser && !role.bypassRls && !role.ownsTables });
  });
  // Slowloris / hung-client protection and keep-alive tuned for common load balancers (> LB idle timeout of 60 s).
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 65_000;
  realtimeHub.initialize(server);

  return {
    server,
    async stop() {
      logger.info('API draining: closing realtime and refusing new connections');
      realtimeHub.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
      logger.info('API stopped');
    },
  };
}

if (process.argv[1] && /api\.(ts|js)$/.test(process.argv[1])) {
  startApi()
    .then((a) => {
      const shutdown = (sig: string) => {
        logger.info(`${sig} received`);
        const force = setTimeout(() => process.exit(1), 15_000);
        void a.stop().then(() => {
          clearTimeout(force);
          process.exit(0);
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((e) => {
      logger.error('API failed to start', { error: e.message });
      process.exit(1);
    });
}
