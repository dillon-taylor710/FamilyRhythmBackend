import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../utils/asyncHandler';
import { resetPasswordSchema } from './auth.schemas';
import * as authService from './auth.service';

// Reset links are opened outside the app (from the user's email client),
// so this is a plain server-rendered page — same reasoning as the admin
// login form in `admin.routes.ts` — not a JSON endpoint like the rest of
// `auth.routes.ts`.
export const authPagesRouter = Router();

const submitLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

authPagesRouter.get(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const valid = token.length > 0 && (await authService.isResetTokenValid(token));
    res.render('auth/reset-password', { valid, success: false, error: null, token });
  }),
);

authPagesRouter.post(
  '/reset-password',
  submitLimiter,
  asyncHandler(async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token : '';

    if (req.body.password !== req.body.confirmPassword) {
      const valid = token.length > 0 && (await authService.isResetTokenValid(token));
      return res.status(400).render('auth/reset-password', { valid, success: false, error: 'Passwords do not match.', token });
    }

    const parsed = resetPasswordSchema.safeParse({ token, password: req.body.password });
    if (!parsed.success) {
      const valid = token.length > 0 && (await authService.isResetTokenValid(token));
      return res
        .status(400)
        .render('auth/reset-password', { valid, success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.', token });
    }

    try {
      await authService.resetPassword(parsed.data);
      res.render('auth/reset-password', { valid: true, success: true, error: null, token });
    } catch {
      res.status(400).render('auth/reset-password', { valid: false, success: false, error: null, token });
    }
  }),
);
