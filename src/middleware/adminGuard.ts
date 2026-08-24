import { NextFunction, Request, Response } from 'express';
import { signAdminToken, verifyAdminToken } from '../utils/jwt';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../utils/httpError';

// Shared with `admin.routes.ts` (the login route sets this same cookie) so
// the initial login and every subsequent sliding-expiry refresh below agree
// on lifetime/flags.
export const ADMIN_SESSION_MS = 10 * 60 * 1000;
export const adminCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  maxAge: ADMIN_SESSION_MS,
};

// Admin pages are plain server-rendered HTML (see src/views/admin), so the
// admin token lives in an httpOnly cookie rather than a header the browser
// has no way to attach itself. A Bearer header is also accepted so the
// same guard covers a future admin API client without duplicating logic.
export function adminGuard(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const cookieToken = req.cookies?.[env.ADMIN_COOKIE_NAME] as string | undefined;
  const token = bearerToken ?? cookieToken;

  if (!token) {
    if (req.accepts('html')) return res.redirect('/admin/login');
    return next(unauthorized('Missing admin token'));
  }

  try {
    const { adminId, isSuperAdmin } = verifyAdminToken(token);
    req.adminId = adminId;
    req.isSuperAdmin = isSuperAdmin;
    // Sliding expiry, cookie-borne sessions only (a Bearer-token API client
    // manages its own token lifecycle) — every request re-issues both the
    // JWT and its cookie with a fresh 30-minute window, so an idle admin
    // tab actually expires 30 minutes after the *last* click, not 30
    // minutes after login regardless of activity.
    if (!bearerToken) {
      const freshToken = signAdminToken(adminId, isSuperAdmin);
      res.cookie(env.ADMIN_COOKIE_NAME, freshToken, adminCookieOptions);
    }
    next();
  } catch {
    res.clearCookie(env.ADMIN_COOKIE_NAME);
    if (req.accepts('html')) return res.redirect('/admin/login');
    next(unauthorized('Invalid or expired admin token'));
  }
}

// Chain after `adminGuard` — restricts a route to the Sumup page (monthly
// profit confirmation), everything else stays open to any AdminUser.
export function superAdminGuard(req: Request, res: Response, next: NextFunction) {
  if (!req.isSuperAdmin) {
    if (req.accepts('html')) return res.status(403).render('admin/forbidden');
    return next(forbidden('Super admin access required'));
  }
  next();
}
