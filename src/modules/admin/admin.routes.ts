import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { adminCookieOptions, adminGuard, superAdminGuard } from '../../middleware/adminGuard';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  adminLoginSchema,
  overviewQuerySchema,
  planUpdateSchema,
  purchasesQuerySchema,
  subscriptionsQuerySchema,
  sumupUpdateSchema,
  usersQuerySchema,
} from './admin.schemas';
import * as adminService from './admin.service';
import { resolveDateRangeForInputs } from './adminDateRange';
import { buildQueryString } from './adminViewHelpers';

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const cookieOptions = adminCookieOptions;

// --- JSON API — GET /api/admin/users|subscriptions|purchases|overview,
// per the API surface CLAUDE.md/backend/README.md suggested. Bearer-token
// only in practice (nothing sets the admin cookie except the HTML login
// form below), but adminGuard accepts either.
export const adminApiRouter = Router();
adminApiRouter.use(adminGuard);

adminApiRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listUsers(usersQuerySchema.parse(req.query)));
  }),
);

adminApiRouter.get(
  '/subscriptions',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listSubscriptions(subscriptionsQuerySchema.parse(req.query)));
  }),
);

adminApiRouter.get(
  '/purchases',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listPurchases(purchasesQuerySchema.parse(req.query)));
  }),
);

adminApiRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getOverviewStats(overviewQuerySchema.parse(req.query)));
  }),
);

adminApiRouter.get(
  '/plans',
  superAdminGuard,
  asyncHandler(async (_req, res) => {
    res.json(await adminService.listPlans());
  }),
);

adminApiRouter.post(
  '/plans',
  superAdminGuard,
  asyncHandler(async (req, res) => {
    const input = planUpdateSchema.parse(req.body);
    await adminService.updatePlan(input.productId, input.label, input.priceUsd, input.isActive === 'on');
    res.json({ ok: true });
  }),
);

adminApiRouter.get(
  '/sumup',
  superAdminGuard,
  asyncHandler(async (_req, res) => {
    res.json(await adminService.listMonthlySumups());
  }),
);

adminApiRouter.post(
  '/sumup',
  superAdminGuard,
  asyncHandler(async (req, res) => {
    const input = sumupUpdateSchema.parse(req.body);
    await adminService.setSumupStatus(input.year, input.month, input.status, req.adminId!);
    res.json({ ok: true });
  }),
);

// --- Server-rendered admin website — login form + read-only tables.
export const adminPagesRouter = Router();

adminPagesRouter.get('/login', (req, res) => {
  if (req.cookies?.[env.ADMIN_COOKIE_NAME]) return res.redirect('/admin/overview');
  res.render('admin/login', { error: null });
});

adminPagesRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/login', { error: 'Enter a valid email and password.' });
    }

    try {
      const token = await adminService.adminLogin(parsed.data);
      res.cookie(env.ADMIN_COOKIE_NAME, token, cookieOptions);
      res.redirect('/admin/overview');
    } catch (err) {
      // Logged, not shown — this catch previously swallowed every failure
      // mode identically (wrong credentials, DB errors, a bad
      // JWT_ADMIN_SECRET, ...) behind the same generic message, which made
      // an infra-level failure indistinguishable from a typo'd password.
      req.log.error({ err }, 'admin login failed');
      res.status(401).render('admin/login', { error: 'Invalid email or password.' });
    }
  }),
);

adminPagesRouter.post('/logout', (req, res) => {
  res.clearCookie(env.ADMIN_COOKIE_NAME);
  res.redirect('/admin/login');
});

adminPagesRouter.get(
  '/overview',
  adminGuard,
  asyncHandler(async (req, res) => {
    const query = overviewQuerySchema.parse(req.query);
    const stats = await adminService.getOverviewStats(query);
    res.render('admin/overview', {
      stats,
      query,
      range: resolveDateRangeForInputs(query),
      isSuperAdmin: req.isSuperAdmin ?? false,
      qs: (overrides: Record<string, unknown>) => buildQueryString(query, overrides),
    });
  }),
);

adminPagesRouter.get(
  '/users',
  adminGuard,
  asyncHandler(async (req, res) => {
    const query = usersQuerySchema.parse(req.query);
    const result = await adminService.listUsers(query);
    res.render('admin/users', {
      result,
      query,
      range: resolveDateRangeForInputs(query),
      isSuperAdmin: req.isSuperAdmin ?? false,
      qs: (overrides: Record<string, unknown>) => buildQueryString(query, overrides),
    });
  }),
);

adminPagesRouter.get(
  '/subscriptions',
  adminGuard,
  asyncHandler(async (req, res) => {
    const query = subscriptionsQuerySchema.parse(req.query);
    const result = await adminService.listSubscriptions(query);
    res.render('admin/subscriptions', {
      result,
      query,
      range: resolveDateRangeForInputs(query),
      isSuperAdmin: req.isSuperAdmin ?? false,
      qs: (overrides: Record<string, unknown>) => buildQueryString(query, overrides),
    });
  }),
);

adminPagesRouter.get(
  '/purchases',
  adminGuard,
  asyncHandler(async (req, res) => {
    const query = purchasesQuerySchema.parse(req.query);
    const result = await adminService.listPurchases(query);
    res.render('admin/purchases', {
      result,
      query,
      range: resolveDateRangeForInputs(query),
      isSuperAdmin: req.isSuperAdmin ?? false,
      qs: (overrides: Record<string, unknown>) => buildQueryString(query, overrides),
    });
  }),
);

adminPagesRouter.get(
  '/plans',
  adminGuard,
  superAdminGuard,
  asyncHandler(async (_req, res) => {
    const plans = await adminService.listPlans();
    res.render('admin/plans', { plans, isSuperAdmin: true });
  }),
);

adminPagesRouter.post(
  '/plans',
  adminGuard,
  superAdminGuard,
  asyncHandler(async (req, res) => {
    const input = planUpdateSchema.parse(req.body);
    await adminService.updatePlan(input.productId, input.label, input.priceUsd, input.isActive === 'on');
    res.redirect('/admin/plans');
  }),
);

adminPagesRouter.get(
  '/sumup',
  adminGuard,
  superAdminGuard,
  asyncHandler(async (_req, res) => {
    const rows = await adminService.listMonthlySumups();
    res.render('admin/sumup', { rows, isSuperAdmin: true });
  }),
);

adminPagesRouter.post(
  '/sumup',
  adminGuard,
  superAdminGuard,
  asyncHandler(async (req, res) => {
    const input = sumupUpdateSchema.parse(req.body);
    await adminService.setSumupStatus(input.year, input.month, input.status, req.adminId!);
    res.redirect('/admin/sumup');
  }),
);

adminPagesRouter.get('/', (_req, res) => res.redirect('/admin/overview'));
