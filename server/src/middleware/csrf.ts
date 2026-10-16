import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../platform/config';
import { Errors } from '../platform/errors';
import { sessionCookieName } from '../modules/identity/sessions';

/**
 * CSRF defence for cookie-authenticated requests (defence in depth on top of SameSite=Lax):
 *  1. Origin/Referer, when present on an unsafe method, must be an allowed origin.
 *  2. Double-submit token: the `x-csrf-token` header must equal the (JS-readable) CSRF cookie.
 * Bearer/API-key requests carry no ambient credentials, so they are exempt (no session cookie ⇒ nothing to forge).
 */
export const csrfCookieName = () => (config.isProduction ? '__Host-anibrosdesign_csrf' : 'anibrosdesign_csrf');

export function setCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie(csrfCookieName(), token, { httpOnly: false, secure: config.isProduction, sameSite: 'lax', path: '/' });
  return token;
}

function originOf(req: Request): string | undefined {
  const o = req.headers.origin;
  if (o && o !== 'null') return o;
  if (o === 'null') return 'null';
  try {
    return req.headers.referer ? new URL(req.headers.referer).origin : undefined;
  } catch {
    return 'invalid';
  }
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    if (!req.cookies?.[csrfCookieName()]) setCsrfCookie(res);
    return next();
  }
  const origin = originOf(req);
  if (origin && !config.allowedOriginsArray.includes(origin)) return next(Errors.forbidden('Cross-origin request rejected'));

  if (req.cookies?.[sessionCookieName()]) {
    const cookie = req.cookies?.[csrfCookieName()] as string | undefined;
    const header = req.headers[config.CSRF_HEADER_NAME] as string | undefined;
    if (!cookie || !header || cookie.length !== header.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
      return next(Errors.forbidden('Invalid or missing CSRF token'));
    }
  }
  next();
}
