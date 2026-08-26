import { z } from 'zod';

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

// --- Shared list-query building blocks (pagination + date range) — every
// admin list page (Users/Subscriptions/Purchases) composes these with its
// own search fields via `.extend()` below, so the pagination/date-range UI
// partials can stay generic across all three pages.

export const DATE_RANGE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'previous_week',
  'this_month',
  'previous_month',
  'this_year',
  'previous_year',
] as const;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const dateRangeQuerySchema = z.object({
  preset: z.enum(DATE_RANGE_PRESETS).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

// --- Sortable-column support — every admin list page (Users/Subscriptions/
// Purchases) accepts `sort`/`dir` query params. `sort` is validated per-page
// against an allow-list of actual column keys in `admin.service.ts` (never
// used to build a raw identifier directly), `dir` is just asc/desc.
export const sortQuerySchema = z.object({
  sort: z.string().trim().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export const usersQuerySchema = paginationQuerySchema.merge(dateRangeQuerySchema).merge(sortQuerySchema).extend({
  email: z.string().trim().optional(),
  name: z.string().trim().optional(),
  // Which date field the range/preset above filters on — signup date or
  // subscription expiry — per the req: "In Users, Search by email, name,
  // signup date, expires."
  dateField: z.enum(['signup', 'expires']).default('signup'),
});
export type UsersQuery = z.infer<typeof usersQuerySchema>;

export const subscriptionsQuerySchema = paginationQuerySchema.merge(dateRangeQuerySchema).merge(sortQuerySchema).extend({
  email: z.string().trim().optional(),
  status: z.string().trim().optional(),
  plan: z.string().trim().optional(),
  platform: z.string().trim().optional(),
});
export type SubscriptionsQuery = z.infer<typeof subscriptionsQuerySchema>;

export const purchasesQuerySchema = paginationQuerySchema.merge(dateRangeQuerySchema).merge(sortQuerySchema).extend({
  email: z.string().trim().optional(),
  plan: z.string().trim().optional(),
  platform: z.string().trim().optional(),
});
export type PurchasesQuery = z.infer<typeof purchasesQuerySchema>;

export const userLoginHistoryQuerySchema = paginationQuerySchema;
export type UserLoginHistoryQuery = z.infer<typeof userLoginHistoryQuerySchema>;

export const overviewQuerySchema = dateRangeQuerySchema.extend({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export const sumupUpdateSchema = z.object({
  year: z.coerce.number().int().min(2000).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  status: z.enum(['none', 'confirmed']),
});
export type SumupUpdateInput = z.infer<typeof sumupUpdateSchema>;

export const planUpdateSchema = z.object({
  productId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  priceUsd: z.coerce.number().min(0),
  // Checkbox inputs only appear in `req.body` when checked, so this is
  // `'on'`/absent, not a real boolean — the route handler below coerces.
  isActive: z.union([z.literal('on'), z.undefined()]).optional(),
});
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;
