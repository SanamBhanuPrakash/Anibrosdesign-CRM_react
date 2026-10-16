/**
 * Isolated end-to-end stack: disposable database + API + in-process worker (+ mail inspection on a side port).
 *
 *   tsx scripts/e2e/stack.ts            # prints READY once listening; Ctrl-C / SIGTERM drops the database
 *
 * Environment (all optional):
 *   E2E_API_PORT=4300  E2E_MAIL_PORT=4301  E2E_WEB_ORIGIN=http://127.0.0.1:5299  E2E_RESTRICTED=1
 *
 * E2E_RESTRICTED=1 runs the API as the production-style restricted DB role (RLS enforced). Until every legacy route is
 * ported the default is the privileged role so legacy pages still work; new modules are always covered by the restricted
 * suites in server/src/tests.
 *
 * The mail endpoint exists ONLY in this process (never in the application): GET http://127.0.0.1:4301/mail?to=<email>
 */
import http from 'node:http';

const apiPort = Number(process.env.E2E_API_PORT ?? 4300);
const mailPort = Number(process.env.E2E_MAIL_PORT ?? 4301);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5299';

process.env.NODE_ENV = 'test';
process.env.PORT = String(apiPort);
process.env.HOST = '127.0.0.1';
process.env.ALLOWED_ORIGINS = webOrigin;
process.env.PUBLIC_APP_URL = webOrigin;

const { createTestDatabase } = await import('../../server/src/tests/support/test-db');
const tdb = await createTestDatabase();
process.env.DATABASE_URL = process.env.E2E_RESTRICTED === '1' ? tdb.apiUrl : tdb.adminUrl;
process.env.WORKER_DATABASE_URL = tdb.workerUrl;
process.env.MIGRATOR_DATABASE_URL = tdb.adminUrl;

const { startApi } = await import('../../server/src/api');
const { startWorker } = await import('../../server/src/worker');
const { memoryTransport } = await import('../../server/src/platform/mail');

const api = await startApi();
const worker = await startWorker({ healthPort: null });

const mailServer = http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/mail') {
      const to = url.searchParams.get('to')?.toLowerCase();
      const items = memoryTransport.sent.filter((m) => !to || m.to.toLowerCase() === to);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
    } else if (url.pathname === '/db') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: tdb.name }));
    } else res.writeHead(404).end();
  })
  .listen(mailPort, '127.0.0.1');

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  mailServer.close();
  await worker.stop().catch(() => undefined);
  await api.stop().catch(() => undefined);
  await tdb.drop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`READY api=http://127.0.0.1:${apiPort} mail=http://127.0.0.1:${mailPort} db=${tdb.name} restricted=${process.env.E2E_RESTRICTED === '1'}`);
