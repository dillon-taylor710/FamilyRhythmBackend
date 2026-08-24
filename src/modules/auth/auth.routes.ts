import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authGuard } from '../../middleware/authGuard';
import { asyncHandler } from '../../utils/asyncHandler';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, signupSchema, verifyEmailSchema } from './auth.schemas';
import * as authService from './auth.service';

export const authRouter = Router();

// Auth endpoints are the obvious brute-force/credential-stuffing target —
// tighter limit than the general API limiter in app.ts. Scoped to just the
// actual credential-guessing endpoints (signup/login/forgot-password/
// change-password), not the whole router — `GET /me` in particular is
// called after every successful login/signup/switchAccount and on every
// session restore, so sharing this budget with it meant a handful of
// ordinary login/logout cycles could exhaust it long before 20 real
// credential attempts. A plain-text/HTML body on 429 also broke the
// Flutter client's `jsonDecode(response.body)` (see `ApiClient`), turning
// a rate limit into an opaque generic error instead of a real message —
// `handler` below keeps the response JSON so that still works.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  },
});

authRouter.post(
  '/signup',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = signupSchema.parse(req.body);
    const result = await authService.signup(input);
    res.status(201).json(result);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.status(200).json(result);
  }),
);

// Always 200 — never lets a caller learn whether `email` has an account
// (see `authService.requestPasswordReset`'s doc comment). The actual
// password-set step happens on the web page at GET/POST `/reset-password`
// (`auth.pages.routes.ts`), reached via the link this emails out.
authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = forgotPasswordSchema.parse(req.body);
    await authService.requestPasswordReset(input);
    res.status(200).json({ ok: true });
  }),
);

authRouter.post(
  '/verify-email',
  authGuard,
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = verifyEmailSchema.parse(req.body);
    await authService.verifyEmail(req.userId!, input);
    res.status(200).json({ ok: true });
  }),
);

authRouter.post(
  '/resend-verification',
  authGuard,
  authLimiter,
  asyncHandler(async (req, res) => {
    await authService.resendVerificationCode(req.userId!);
    res.status(200).json({ ok: true });
  }),
);

authRouter.post(
  '/change-password',
  authGuard,
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.userId!, input);
    res.status(200).json({ ok: true });
  }),
);

// login/signup only return { userId, token } — the client needs this to
// learn the display name (login doesn't have it at all; signup only has
// whatever the client just typed) and to restore a session after an app
// relaunch from a saved token. Not brute-forceable (it just echoes back
// whichever account the caller's own token already belongs to), so it
// isn't behind `authLimiter` — only the general API limiter in `app.ts`
// applies, same as any other authenticated route.
authRouter.get(
  '/me',
  authGuard,
  asyncHandler(async (req, res) => {
    const user = await authService.getMe(req.userId!);
    res.json(user);
  }),
);
