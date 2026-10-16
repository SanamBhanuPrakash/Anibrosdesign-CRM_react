import type { NextFunction, Request, Response } from 'express';
import { Errors, fromUnknown, toProblem, isAppError } from '../errors';

export function notFoundHandler(req: Request, res: Response) {
  const problem = toProblem(Errors.notFound('Route'), req.id);
  problem.detail = `No route for ${req.method} ${req.path}`;
  res.status(404).type('application/problem+json').json(problem);
}

/**
 * Terminal error handler.
 *  - AppError / mapped DB errors → their status + problem document
 *  - anything else → logged WITH stack (defect), client receives an opaque 500 + requestId
 * Security-relevant denials (401/403/RLS) are logged at warn so they are visible without being noisy.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  const mapped = fromUnknown(err);
  const appError = mapped ?? Errors.internal();

  if (!mapped) {
    req.logger?.error('Unhandled exception', {
      error: (err as Error)?.message,
      name: (err as Error)?.name,
      stack: (err as Error)?.stack,
      route: `${req.method} ${req.originalUrl.split('?')[0]}`,
    });
  } else if (appError.status === 401 || appError.status === 403) {
    req.logger?.warn('Access denied', {
      code: appError.code,
      route: `${req.method} ${req.originalUrl.split('?')[0]}`,
      tenantId: req.actor?.tenantId,
      userId: req.actor?.userId,
      cause: !isAppError(err) ? (err as { code?: string })?.code : undefined,
    });
  } else if (appError.status >= 500) {
    req.logger?.error('Request failed', {
      code: appError.code,
      route: `${req.method} ${req.originalUrl.split('?')[0]}`,
      cause: (err as Error)?.message,
    });
  }

  if (appError.headers) for (const [k, v] of Object.entries(appError.headers)) res.setHeader(k, v);
  res.status(appError.status).type('application/problem+json').json(toProblem(appError, req.id));
}
