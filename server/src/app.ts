import express, { Router, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './platform/config';
import { db, getDb } from './platform/db';
import { bindEventLog } from './platform/observability/event-log';
import { requestContextMiddleware } from './middleware/request-context';
import { csrfProtection } from './middleware/csrf';
import { errorHandler, notFoundHandler } from './platform/http/error-middleware';
import { mountRoutes } from './platform/http/route';
import { httpMetrics, metricsHandler, registerDbGauges } from './platform/observability/metrics';
import { authService, sessions, authenticate, idempotency, membersService, apiKeyService, contactsService, leadsService, pipelinesService, savedViewsService, importService, tasksService, notificationsService, propertiesService, projectsService, filesService, inboundService, outboundService, messagingService, monitorService, viewingsService, workspaceService, dashboardService, matchingService, automationService, homeService, searchService, dealsService, shortlistService, dashboardOverviewService, attributionService, spendService, reportsService, agencyService, agencyLeadsService, agencyReportService, customFieldsService } from './container';
import { createMemberRoutes } from './modules/members/routes';
import { createApiKeyRoutes } from './modules/api-keys';
import { createContactRoutes } from './modules/contacts/routes';
import { createLeadRoutes, createPipelineRoutes, createSavedViewRoutes } from './modules/leads/routes';
import { createTaskRoutes, createNotificationRoutes } from './modules/tasks/routes';
import { createPropertyRoutes, createProjectRoutes, createFileRoutes } from './modules/inventory/routes';
import { createIdentityRoutes } from './modules/identity/routes';
import { createLeadSourceRoutes } from './modules/inbound/routes';
import { createWebhookRoutes } from './modules/outbound/routes';
import { createMessagingRoutes } from './modules/messaging/routes';
import { createMonitorRoutes } from './modules/monitor/routes';
import { createViewingRoutes } from './modules/viewings/routes';
import { createReservationRoutes, createShortlistRoutes } from './modules/deals/routes';
import { createAttributionRoutes, createReportRoutes, createSpendRoutes } from './modules/analytics/routes';
import { createWorkspaceRoutes } from './modules/workspace/routes';
import { createDashboardRoutes } from './modules/dashboard/routes';
import { createMatchingRoutes } from './modules/inventory/matching';
import { createAutomationRoutes } from './modules/automation/routes';
import { createHomeRoutes } from './modules/home/routes';
import { createSearchRoutes } from './modules/search/routes';
import { createAgencyRoutes } from './modules/agency/routes';
import { createCustomFieldRoutes } from './modules/custom-fields/routes';
import { createHookRouter } from './modules/inbound/receiver';
import { Errors } from './platform/errors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildOpenApi } from './platform/openapi';
import { docsHtml } from './platform/openapi/viewer';

// Legacy routers — removed module by module as they are rebuilt on the declarative layer (see Claude_plan.md).
import { healthRouter } from './routes/health';
import { webhooksRouter } from './routes/webhooks';

bindEventLog(() => getDb());

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Exactly N reverse-proxy hops are trusted so `req.ip` (rate limits, audit) cannot be spoofed via X-Forwarded-For.
  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  // This process serves JSON only → the strictest possible CSP. (The SPA is served by its own static host.)
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    })
  );

  // Public lead intake (Meta / Google / website / generic). Mounted BEFORE cors, cookies and the JSON parser on purpose: it needs the
  // exact raw bytes for signature checks and answers its own CORS (per-source allowed websites), and it never uses cookies or CSRF.
  app.use('/hooks', requestContextMiddleware, httpMetrics, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, createHookRouter(db));

  app.use(
    cors({
      origin: (origin, cb) => {
        // Requests without Origin are non-browser clients or same-origin navigations; browsers always send Origin cross-site.
        if (!origin || config.allowedOriginsArray.includes(origin)) return cb(null, true);
        return cb(null, false); // no CORS headers ⇒ the browser blocks the response (no 500 noise)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Request-Id', 'X-Tenant-Id', 'X-CSRF-Token'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After', 'Idempotent-Replay', 'ETag'],
      maxAge: 600,
    })
  );

  app.use(cookieParser(config.COOKIE_SECRET));
  const jsonParser = express.json({
      limit: '1mb',
      // Keep the exact bytes for HMAC verification of provider webhooks (signature is computed over the raw body).
      verify: (req, _res, buf) => {
        const url = (req as Request).originalUrl ?? '';
        if (url.startsWith('/hooks') || url.startsWith('/api/webhooks')) (req as Request).rawBody = Buffer.from(buf);
      },
    });
  // Routes that declare a larger `bodyLimit` (CSV import) parse their own body after authentication.
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/api/v1/leads/imports' ? next() : jsonParser(req, res, next)));
  // Everything under /api is per-user, per-workspace data: never let a browser or proxy keep a copy (the OpenAPI document opts back in).
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(requestContextMiddleware);
  app.use(httpMetrics);

  // ── operational endpoints (no auth, no CSRF) ───────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/readyz', async (req: Request, res: Response) => {
    try {
      const { rows } = await db.query<{ v: string }>('SELECT app.schema_version() AS v');
      res.json({ status: 'ready', database: 'connected', schemaVersion: rows[0]?.v ?? null, pool: db.stats() });
    } catch (e: any) {
      req.logger.error('Readiness probe failed', { error: e.message });
      res.status(503).json({ status: 'unavailable', database: 'disconnected' });
    }
  });
  app.get('/metrics', metricsHandler);
  registerDbGauges(db, 'api');

  // Inbound third-party webhooks authenticate by signature, not cookies → before CSRF.
  app.use('/api/webhooks', webhooksRouter); // retired stub: answers 410 and points senders to the per-tenant signed /hooks/:endpointId

  app.use(csrfProtection);

  // ── v1: declarative routes ──────────────────────────────────────────────────────────────────────
  const { authRoutes, meRoutes } = createIdentityRoutes(authService, sessions, db);
  const v1 = Router();
  const mountOpts = { authenticate, idempotency };
  const authRouter = Router();
  mountRoutes(authRouter, '/api/v1/auth', authRoutes, mountOpts);
  const meRouter = Router();
  mountRoutes(meRouter, '/api/v1/me', meRoutes, mountOpts);
  const { members, invitations } = createMemberRoutes(membersService);
  const membersRouter = Router();
  mountRoutes(membersRouter, '/api/v1/members', members, mountOpts);
  const invitationsRouter = Router();
  mountRoutes(invitationsRouter, '/api/v1/invitations', invitations, mountOpts);
  const apiKeysRouter = Router();
  mountRoutes(apiKeysRouter, '/api/v1/api-keys', createApiKeyRoutes(apiKeyService), mountOpts);
  const contactsV1Router = Router();
  mountRoutes(contactsV1Router, '/api/v1/contacts', createContactRoutes(contactsService), mountOpts);
  const leadsV1Router = Router();
  mountRoutes(leadsV1Router, '/api/v1/leads', createLeadRoutes(leadsService, importService), mountOpts);
  const pipelinesV1Router = Router();
  mountRoutes(pipelinesV1Router, '/api/v1/pipelines', createPipelineRoutes(pipelinesService, leadsService), mountOpts);
  const savedViewsV1Router = Router();
  mountRoutes(savedViewsV1Router, '/api/v1/saved-views', createSavedViewRoutes(savedViewsService), mountOpts);
  const tasksV1Router = Router();
  mountRoutes(tasksV1Router, '/api/v1/tasks', createTaskRoutes(tasksService), mountOpts);
  const notificationsV1Router = Router();
  mountRoutes(notificationsV1Router, '/api/v1/notifications', createNotificationRoutes(notificationsService), mountOpts);
  const propertiesV1Router = Router();
  mountRoutes(propertiesV1Router, '/api/v1/properties', createPropertyRoutes(propertiesService, filesService), mountOpts);
  const projectsV1Router = Router();
  mountRoutes(projectsV1Router, '/api/v1/projects', createProjectRoutes(projectsService, filesService), mountOpts);
  const leadSourcesV1Router = Router();
  mountRoutes(leadSourcesV1Router, '/api/v1/lead-sources', createLeadSourceRoutes(inboundService), mountOpts);
  const webhooksV1Router = Router();
  mountRoutes(webhooksV1Router, '/api/v1/webhooks', createWebhookRoutes(outboundService), mountOpts);
  const messagingV1Router = Router();
  mountRoutes(messagingV1Router, '/api/v1/messaging', createMessagingRoutes(messagingService), mountOpts);
  const viewingsV1Router = Router();
  mountRoutes(viewingsV1Router, '/api/v1/viewings', createViewingRoutes(viewingsService), mountOpts);
  const reservationsV1Router = Router();
  mountRoutes(reservationsV1Router, '/api/v1/reservations', createReservationRoutes(dealsService), mountOpts);
  const shortlistV1Router = Router();
  mountRoutes(shortlistV1Router, '/api/v1/shortlist', createShortlistRoutes(shortlistService), mountOpts);
  const attributionV1Router = Router();
  mountRoutes(attributionV1Router, '/api/v1/attribution', createAttributionRoutes(attributionService), mountOpts);
  const spendV1Router = Router();
  mountRoutes(spendV1Router, '/api/v1/spend', createSpendRoutes(spendService), mountOpts);
  const reportsV1Router = Router();
  mountRoutes(reportsV1Router, '/api/v1/reports', createReportRoutes(reportsService), mountOpts);
  const workspaceV1Router = Router();
  mountRoutes(workspaceV1Router, '/api/v1/workspace', createWorkspaceRoutes(workspaceService), mountOpts);
  const dashboardV1Router = Router();
  mountRoutes(dashboardV1Router, '/api/v1/dashboard', createDashboardRoutes(dashboardService, dashboardOverviewService), mountOpts);
  const matchingV1Router = Router();
  mountRoutes(matchingV1Router, '/api/v1/matching', createMatchingRoutes(matchingService), mountOpts);
  const homeV1Router = Router();
  mountRoutes(homeV1Router, '/api/v1/home', createHomeRoutes(homeService), mountOpts);
  const searchV1Router = Router();
  mountRoutes(searchV1Router, '/api/v1/search', createSearchRoutes(searchService), mountOpts);
  const automationV1Router = Router();
  mountRoutes(automationV1Router, '/api/v1/automations', createAutomationRoutes(automationService), mountOpts);
  const monitorV1Router = Router();
  mountRoutes(monitorV1Router, '/api/v1/monitor', createMonitorRoutes(monitorService), mountOpts);
  const filesV1Router = Router();
  mountRoutes(filesV1Router, '/api/v1/files', createFileRoutes(filesService), mountOpts);
  const customFieldsV1Router = Router();
  mountRoutes(customFieldsV1Router, '/api/v1/custom-fields', createCustomFieldRoutes(customFieldsService), mountOpts);
  const agencyV1Router = Router();
  mountRoutes(agencyV1Router, '/api/v1/agency', createAgencyRoutes(agencyService, agencyLeadsService, agencyReportService), mountOpts);
  v1.use('/auth', authRouter);
  v1.use('/me', meRouter);
  v1.use('/members', membersRouter);
  v1.use('/invitations', invitationsRouter);
  v1.use('/api-keys', apiKeysRouter);
  v1.use('/contacts', contactsV1Router);
  v1.use('/leads', leadsV1Router);
  v1.use('/pipelines', pipelinesV1Router);
  v1.use('/saved-views', savedViewsV1Router);
  v1.use('/tasks', tasksV1Router);
  v1.use('/notifications', notificationsV1Router);
  v1.use('/properties', propertiesV1Router);
  v1.use('/projects', projectsV1Router);
  v1.use('/files', filesV1Router);
  v1.use('/lead-sources', leadSourcesV1Router);
  v1.use('/webhooks', webhooksV1Router);
  v1.use('/messaging', messagingV1Router);
  v1.use('/monitor', monitorV1Router);
  v1.use('/viewings', viewingsV1Router);
  v1.use('/reservations', reservationsV1Router);
  v1.use('/shortlist', shortlistV1Router);
  v1.use('/attribution', attributionV1Router);
  v1.use('/spend', spendV1Router);
  v1.use('/reports', reportsV1Router);
  v1.use('/workspace', workspaceV1Router);
  v1.use('/dashboard', dashboardV1Router);
  v1.use('/matching', matchingV1Router);
  v1.use('/automations', automationV1Router);
  v1.use('/home', homeV1Router);
  v1.use('/search', searchV1Router);
  v1.use('/agency', agencyV1Router);
  v1.use('/custom-fields', customFieldsV1Router);
  app.use('/api/v1', v1);

  // ── public API description + reference (generated from the route registry) ────────────────────────
  let openapiCache: unknown;
  const pkgVersion = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version as string; } catch { return '0.0.0'; } })();
  app.get('/api/v1/openapi.json', (_req, res) => {
    openapiCache ??= buildOpenApi({ version: pkgVersion, serverUrl: config.publicApiUrl });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(openapiCache);
  });
  app.get('/api/docs', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.type('html').send(docsHtml(nonce));
  });
  app.use('/api/v1', (_req, _res, next) => next(Errors.notFound('Route')));

  // ── legacy API: only the health probes remain. Everything else moved to /api/v1 (Slice 0 of the 2026-10-14 remediation) ──────────────────────────────────────────────────────────────────
  app.use('/api/health', healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
