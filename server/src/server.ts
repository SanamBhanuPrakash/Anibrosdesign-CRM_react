/**
 * Development all-in-one runner: API + worker in one process for convenience (`npm run server:dev`).
 * Production runs `api.ts` and `worker.ts` as separate processes/containers so they scale and fail independently.
 */
import { startApi } from './api';
import { startWorker } from './worker';
import { config } from './platform/config';
import { logger } from './logger';

const runWorker = config.RUN_WORKER_IN_PROCESS ?? !config.isProduction;

const api = await startApi();
const worker = runWorker ? await startWorker({ healthPort: null }) : null;
if (!runWorker) logger.info('Worker not started in this process (run `npm run worker:dev`)');

const shutdown = (sig: string) => {
  logger.info(`${sig} received`);
  const force = setTimeout(() => process.exit(1), 20_000);
  void Promise.all([api.stop(), worker?.stop()]).finally(() => {
    clearTimeout(force);
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
