import { Router, type Request, type Response } from 'express';

/**
 * LEGACY inbound webhooks — DISABLED (fail closed).
 * The previous handlers accepted unauthenticated payloads (hard-coded verify token, no HMAC, random event ids,
 * HTTP 200 on persistence failure) and the processor guessed a tenant. They are replaced by per-tenant signed endpoints
 * (POST /hooks/:endpointId, Wave 4). Until then nothing is ingested rather than ingesting unverified data.
 */
export const webhooksRouter = Router();
webhooksRouter.use((_req: Request, res: Response) => {
  res.status(410).json({
    type: 'https://docs.anibros.app/errors/gone',
    title: 'Gone',
    status: 410,
    detail: 'This inbound webhook endpoint was retired. Per-tenant signed endpoints are provided under /hooks/{endpointId}.',
    code: 'GONE',
  });
});
