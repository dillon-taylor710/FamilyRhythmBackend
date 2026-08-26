import { Platform, Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { verifyPassword } from '../../utils/password';
import { signAdminToken } from '../../utils/jwt';
import { unauthorized } from '../../utils/httpError';
import { invalidatePlanCache } from '../subscriptions/planCatalog';
import {
  endOfDay,
  resolveDateRange,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from './adminDateRange';
import type {
  AdminLoginInput,
  OverviewQuery,
  PurchasesQuery,
  SubscriptionsQuery,
  UserLoginHistoryQuery,
  UsersQuery,
} from './admin.schemas';

/**
 * Resolves a validated `sort`/`dir` pair into a Prisma `orderBy` object.
 * `columns` is an allow-list mapping the public sort key (used in the URL
 * and matched against the `<th>` in the view) to the actual Prisma orderBy
 * path — `sort` is never used to build a raw column/identifier itself, so
 * an unrecognized value just falls back to `fallback` instead of erroring.
 */
function resolveOrderBy<T extends Record<string, unknown>>(
  sort: string | undefined,
  dir: 'asc' | 'desc' | undefined,
  columns: Record<string, T>,
  fallback: T,
): T {
  if (sort && sort in columns) {
    const direction = dir ?? 'asc';
    return applyDir(columns[sort]!, direction);
  }
  return fallback;
}

// Swaps in the requested direction wherever the allow-listed orderBy shape
// has an 'asc'/'desc' leaf (works for both a flat `{ field: dir }` and a
// nested one-to-one-relation `{ subscription: { field: dir } }`).
function applyDir<T>(shape: T, dir: 'asc' | 'desc'): T {
  if (shape && typeof shape === 'object') {
    const entries = Object.entries(shape as Record<string, unknown>).map(([k, v]) => [
      k,
      v === 'asc' || v === 'desc' ? dir : applyDirUnknown(v, dir),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return shape;
}

function applyDirUnknown(shape: unknown, dir: 'asc' | 'desc'): unknown {
  return applyDir(shape, dir);
}

export async function adminLogin(input: AdminLoginInput) {
  const admin = await prisma.adminUser.findUnique({ where: { email: input.email } });
  if (!admin) throw unauthorized('Invalid email or password');

  const valid = await verifyPassword(input.password, admin.passwordHash);
  if (!valid) throw unauthorized('Invalid email or password');

  return signAdminToken(admin.id, admin.isSuperAdmin);
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function paginate<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// Allow-list of public sort keys -> Prisma orderBy shape for the Users
// table — `subscription` fields use nested orderBy (supported for a
// one-to-one relation), matching how `subscription.status`/etc. are already
// read via `include` above.
const USERS_SORT_COLUMNS: Record<string, Prisma.UserOrderByWithRelationInput> = {
  email: { email: 'asc' },
  name: { displayName: 'asc' },
  createdAt: { createdAt: 'asc' },
  status: { subscription: { status: 'asc' } },
  plan: { subscription: { planId: 'asc' } },
  expiresAt: { subscription: { currentPeriodEnd: 'asc' } },
};

export async function listUsers(query: UsersQuery): Promise<Page<{
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
  subscriptionStatus: string | null;
  planId: string | null;
  expiresAt: Date | null;
  loginCount: number;
}>> {
  const { page, pageSize, email, name, dateField, sort, dir, ...rangeInput } = query;
  const range = resolveDateRange(rangeInput);

  const where: Prisma.UserWhereInput = {};
  if (email) where.email = { contains: email, mode: 'insensitive' };
  if (name) where.displayName = { contains: name, mode: 'insensitive' };
  if (range.from || range.to) {
    const bounds = { gte: range.from, lte: range.to };
    if (dateField === 'expires') {
      where.subscription = { currentPeriodEnd: bounds };
    } else {
      where.createdAt = bounds;
    }
  }

  const orderBy = resolveOrderBy(sort, dir, USERS_SORT_COLUMNS, { createdAt: 'desc' });

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy,
      include: { subscription: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // "Login count" is distinct calendar days with at least one login, not
  // raw row count (logging in five times in one day still counts as one) —
  // computed here for just this page's users, the same "aggregate only
  // what's on the page" pattern `listSubscriptions` already uses below for
  // `transactionCount`.
  const userIds = users.map((u) => u.id);
  const loginDayCounts = userIds.length
    ? await prisma.$queryRaw<{ user_id: string; days: bigint }[]>`
        SELECT user_id, COUNT(DISTINCT date_trunc('day', created_at)) AS days
        FROM login_events
        WHERE user_id IN (${Prisma.join(userIds)})
        GROUP BY user_id
      `
    : [];
  const loginCountByUser = new Map(loginDayCounts.map((r) => [r.user_id, Number(r.days)]));

  return paginate(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      createdAt: u.createdAt,
      subscriptionStatus: u.subscription?.status ?? null,
      planId: u.subscription?.planId ?? null,
      expiresAt: u.subscription?.currentPeriodEnd ?? null,
      loginCount: loginCountByUser.get(u.id) ?? 0,
    })),
    total,
    page,
    pageSize,
  );
}

export interface UserLoginHistoryEntry {
  id: string;
  createdAt: Date;
}

/** Admin per-user drill-down (click a Users row) — raw login events, most
 * recent first. `loginDays` is the same distinct-day count shown in the
 * Users table, recomputed here from the full (unpaginated) event list. */
export async function getUserLoginHistory(
  userId: string,
  query: UserLoginHistoryQuery,
): Promise<{
  user: { id: string; email: string; displayName: string } | null;
  loginDays: number;
  history: Page<UserLoginHistoryEntry>;
}> {
  const { page, pageSize } = query;

  const [user, total, events, allEvents] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true } }),
    prisma.loginEvent.count({ where: { userId } }),
    prisma.loginEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.loginEvent.findMany({ where: { userId }, select: { createdAt: true } }),
  ]);

  const loginDays = new Set(allEvents.map((e) => e.createdAt.toDateString())).size;

  return {
    user,
    loginDays,
    history: paginate(
      events.map((e) => ({ id: e.id, createdAt: e.createdAt })),
      total,
      page,
      pageSize,
    ),
  };
}

const SUBSCRIPTIONS_SORT_COLUMNS: Record<string, Prisma.SubscriptionOrderByWithRelationInput> = {
  email: { user: { email: 'asc' } },
  name: { user: { displayName: 'asc' } },
  status: { status: 'asc' },
  plan: { planId: 'asc' },
  platform: { platform: 'asc' },
  autoRenewing: { autoRenewing: 'asc' },
  currentPeriodEnd: { currentPeriodEnd: 'asc' },
};

export async function listSubscriptions(query: SubscriptionsQuery): Promise<Page<{
  userId: string;
  email: string;
  displayName: string;
  status: string;
  planId: string | null;
  platform: string | null;
  currentPeriodEnd: Date | null;
  autoRenewing: boolean;
  transactionCount: number;
}>> {
  const { page, pageSize, email, status, plan, platform, sort, dir, ...rangeInput } = query;
  const range = resolveDateRange(rangeInput);

  const where: Prisma.SubscriptionWhereInput = {};
  if (email) where.user = { email: { contains: email, mode: 'insensitive' } };
  if (status && status in SubscriptionStatus) where.status = status as SubscriptionStatus;
  if (plan) where.planId = { contains: plan, mode: 'insensitive' };
  if (platform && platform in Platform) where.platform = platform as Platform;
  if (range.from || range.to) where.updatedAt = { gte: range.from, lte: range.to };

  const orderBy = resolveOrderBy(sort, dir, SUBSCRIPTIONS_SORT_COLUMNS, { updatedAt: 'desc' });

  const [total, subscriptions] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy,
      include: { user: { select: { email: true, displayName: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const userIds = subscriptions.map((s) => s.userId);
  const transactionCounts = userIds.length
    ? await prisma.purchaseTransaction.groupBy({ where: { userId: { in: userIds } }, by: ['userId'], _count: { _all: true } })
    : [];
  const countByUser = new Map(transactionCounts.map((t) => [t.userId, t._count._all]));

  return paginate(
    subscriptions.map((s) => ({
      userId: s.userId,
      email: s.user.email,
      displayName: s.user.displayName,
      status: s.status,
      planId: s.planId,
      platform: s.platform,
      currentPeriodEnd: s.currentPeriodEnd,
      autoRenewing: s.autoRenewing,
      transactionCount: countByUser.get(s.userId) ?? 0,
    })),
    total,
    page,
    pageSize,
  );
}

const PURCHASES_SORT_COLUMNS: Record<string, Prisma.PurchaseTransactionOrderByWithRelationInput> = {
  email: { user: { email: 'asc' } },
  name: { user: { displayName: 'asc' } },
  plan: { productId: 'asc' },
  platform: { platform: 'asc' },
  verifiedAt: { verifiedAt: 'asc' },
  verificationResult: { verificationResult: 'asc' },
  amount: { amountUsd: 'asc' },
};

export async function listPurchases(query: PurchasesQuery): Promise<
  Page<{
    id: string;
    userId: string;
    email: string;
    displayName: string;
    productId: string;
    platform: string;
    verifiedAt: Date;
    verificationResult: string;
    amount: number;
  }> & { totalAmount: number }
> {
  const { page, pageSize, email, plan, platform, sort, dir, ...rangeInput } = query;
  const range = resolveDateRange(rangeInput);

  const where: Prisma.PurchaseTransactionWhereInput = {};
  if (email) where.user = { email: { contains: email, mode: 'insensitive' } };
  if (plan) where.productId = { contains: plan, mode: 'insensitive' };
  if (platform && platform in Platform) where.platform = platform as Platform;
  if (range.from || range.to) where.verifiedAt = { gte: range.from, lte: range.to };

  const orderBy = resolveOrderBy(sort, dir, PURCHASES_SORT_COLUMNS, { verifiedAt: 'desc' });

  const [total, transactions, amountAgg] = await Promise.all([
    prisma.purchaseTransaction.count({ where }),
    prisma.purchaseTransaction.findMany({
      where,
      orderBy,
      include: { user: { select: { email: true, displayName: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    // Sums the *entire filtered set* (not just this page) directly in the
    // DB — `amountUsd` is a real stored column (the price actually
    // recorded at purchase time, see `subscriptions.service.ts`), not
    // re-derived from `productId` here.
    prisma.purchaseTransaction.aggregate({
      where: { ...where, verificationResult: 'valid' },
      _sum: { amountUsd: true },
    }),
  ]);

  const totalAmount = amountAgg._sum.amountUsd?.toNumber() ?? 0;

  const page_ = paginate(
    transactions.map((t) => ({
      id: t.id,
      userId: t.userId,
      email: t.user.email,
      displayName: t.user.displayName,
      productId: t.productId,
      platform: t.platform,
      verifiedAt: t.verifiedAt,
      verificationResult: t.verificationResult,
      amount: t.amountUsd.toNumber(),
    })),
    total,
    page,
    pageSize,
  );

  return { ...page_, totalAmount };
}

export interface OverviewStats {
  users: {
    total: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    series: { bucket: string; count: number }[];
  };
  purchases: {
    total: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    series: { bucket: string; amount: number }[];
  };
  granularity: string;
  range: { from: string; to: string };
}

function bucketKeyFor(granularity: 'day' | 'week' | 'month') {
  return (d: Date): string => {
    if (granularity === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const anchor = granularity === 'week' ? startOfWeek(d) : startOfDay(d);
    return `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`;
  };
}

/**
 * Home/Overview dashboard — signup and purchase-revenue stats "at a
 * glance" plus a chart series over the requested range/granularity. The
 * headline totals (today/week/month/year/all-time) are real DB `_sum`
 * aggregates over `amountUsd`; only the chart series still buckets in JS
 * (per-day/week/month grouping needs the rows' `verifiedAt` values, and
 * there's no `date_trunc` aggregate wired up for that yet) — worth
 * revisiting with a raw aggregate query if the chart's range grows to
 * cover a very large number of transactions.
 */
export async function getOverviewStats(query: OverviewQuery): Promise<OverviewStats> {
  const now = new Date();
  const { granularity, ...rangeInput } = query;

  const sumAmountSince = (since: Date) =>
    prisma.purchaseTransaction
      .aggregate({ where: { verificationResult: 'valid', verifiedAt: { gte: since } }, _sum: { amountUsd: true } })
      .then((r) => r._sum.amountUsd?.toNumber() ?? 0);

  const [totalUsers, todayUsers, weekUsers, monthUsers, yearUsers, totalAmount, todayAmount, weekAmount, monthAmount, yearAmount] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: startOfDay(now) } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfWeek(now) } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfMonth(now) } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfYear(now) } } }),
      sumAmountSince(new Date(0)),
      sumAmountSince(startOfDay(now)),
      sumAmountSince(startOfWeek(now)),
      sumAmountSince(startOfMonth(now)),
      sumAmountSince(startOfYear(now)),
    ]);

  const range = resolveDateRange(rangeInput);
  const from = range.from ?? startOfMonth(now);
  const to = range.to ?? endOfDay(now);
  const bucketKey = bucketKeyFor(granularity);

  const buckets: string[] = [];
  const cursor = new Date(from);
  // Safety cap — a malformed/huge explicit `from`/`to` range shouldn't spin
  // this loop forever; 1000 buckets covers ~3 years daily, ~19 years
  // weekly, or ~83 years monthly, comfortably past any real use of this
  // dashboard.
  for (let i = 0; i < 1000 && cursor <= to; i++) {
    buckets.push(bucketKey(cursor));
    if (granularity === 'day') cursor.setDate(cursor.getDate() + 1);
    else if (granularity === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  const orderedBuckets = Array.from(new Set(buckets));

  // The chart series still buckets per-row in JS (day/week/month grouping
  // needs each row's `verifiedAt`, and there's no `date_trunc` aggregate
  // wired up for that) — only fetches rows within the requested range, not
  // the whole table, unlike the headline totals above which cover all time.
  const [usersInRange, transactionsInRange] = await Promise.all([
    prisma.user.findMany({ where: { createdAt: { gte: from, lte: to } }, select: { createdAt: true } }),
    prisma.purchaseTransaction.findMany({
      where: { verificationResult: 'valid', verifiedAt: { gte: from, lte: to } },
      select: { amountUsd: true, verifiedAt: true },
    }),
  ]);

  const userCounts = new Map<string, number>();
  for (const u of usersInRange) {
    const key = bucketKey(u.createdAt);
    userCounts.set(key, (userCounts.get(key) ?? 0) + 1);
  }

  const amountByBucket = new Map<string, number>();
  for (const t of transactionsInRange) {
    const key = bucketKey(t.verifiedAt);
    amountByBucket.set(key, (amountByBucket.get(key) ?? 0) + t.amountUsd.toNumber());
  }

  return {
    users: {
      total: totalUsers,
      today: todayUsers,
      thisWeek: weekUsers,
      thisMonth: monthUsers,
      thisYear: yearUsers,
      series: orderedBuckets.map((bucket) => ({ bucket, count: userCounts.get(bucket) ?? 0 })),
    },
    purchases: {
      total: totalAmount,
      today: todayAmount,
      thisWeek: weekAmount,
      thisMonth: monthAmount,
      thisYear: yearAmount,
      series: orderedBuckets.map((bucket) => ({ bucket, amount: amountByBucket.get(bucket) ?? 0 })),
    },
    granularity,
    range: { from: from.toISOString(), to: to.toISOString() },
  };
}

export interface MonthlySumupRow {
  year: number;
  month: number;
  profit: number;
  status: 'none' | 'confirmed';
}

/** Sumup page (super admin only) — one row per of the last [monthsBack]
 * calendar months, `profit` recomputed live from `PurchaseTransaction` so
 * it can never drift from reality the way a stored/cached total could. */
export async function listMonthlySumups(monthsBack = 24): Promise<MonthlySumupRow[]> {
  const now = new Date();
  const months: { year: number; month: number }[] = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const [validTransactions, existingSumups] = await Promise.all([
    prisma.purchaseTransaction.findMany({
      where: { verificationResult: 'valid' },
      select: { amountUsd: true, verifiedAt: true },
    }),
    prisma.monthlySumup.findMany(),
  ]);

  const statusByMonth = new Map(existingSumups.map((s) => [`${s.year}-${s.month}`, s.status]));

  return months.map(({ year, month }) => {
    const profit = validTransactions
      .filter((t) => t.verifiedAt.getFullYear() === year && t.verifiedAt.getMonth() + 1 === month)
      .reduce((sum, t) => sum + t.amountUsd.toNumber(), 0);
    return { year, month, profit, status: statusByMonth.get(`${year}-${month}`) ?? 'none' };
  });
}

export async function setSumupStatus(year: number, month: number, status: 'none' | 'confirmed', adminId: string) {
  await prisma.monthlySumup.upsert({
    where: { year_month: { year, month } },
    create: { year, month, status, updatedBy: adminId },
    update: { status, updatedBy: adminId },
  });
}

export interface PlanRow {
  productId: string;
  label: string;
  priceUsd: number;
  isActive: boolean;
}

/** Plans page — the editable list-price catalog (see `SubscriptionPlan`'s
 * schema doc comment). Ordered by price so the tiers read low-to-high,
 * same order they're offered in on `PurchaseScreen`. */
export async function listPlans(): Promise<PlanRow[]> {
  const plans = await prisma.subscriptionPlan.findMany({ orderBy: { priceUsd: 'asc' } });
  return plans.map((p) => ({ productId: p.productId, label: p.label, priceUsd: p.priceUsd.toNumber(), isActive: p.isActive }));
}

export async function updatePlan(productId: string, label: string, priceUsd: number, isActive: boolean) {
  await prisma.subscriptionPlan.update({ where: { productId }, data: { label, priceUsd, isActive } });
  // So the very next purchase (not up to 60s later, see planCatalog.ts's
  // cache TTL) is recorded at the price just set here.
  invalidatePlanCache();
}
