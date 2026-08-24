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
import type { AdminLoginInput, OverviewQuery, PurchasesQuery, SubscriptionsQuery, UsersQuery } from './admin.schemas';

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

export async function listUsers(query: UsersQuery): Promise<Page<{
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
  subscriptionStatus: string | null;
  planId: string | null;
  expiresAt: Date | null;
}>> {
  const { page, pageSize, email, name, dateField, ...rangeInput } = query;
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

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { subscription: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return paginate(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      createdAt: u.createdAt,
      subscriptionStatus: u.subscription?.status ?? null,
      planId: u.subscription?.planId ?? null,
      expiresAt: u.subscription?.currentPeriodEnd ?? null,
    })),
    total,
    page,
    pageSize,
  );
}

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
  const { page, pageSize, email, status, plan, platform, ...rangeInput } = query;
  const range = resolveDateRange(rangeInput);

  const where: Prisma.SubscriptionWhereInput = {};
  if (email) where.user = { email: { contains: email, mode: 'insensitive' } };
  if (status && status in SubscriptionStatus) where.status = status as SubscriptionStatus;
  if (plan) where.planId = { contains: plan, mode: 'insensitive' };
  if (platform && platform in Platform) where.platform = platform as Platform;
  if (range.from || range.to) where.updatedAt = { gte: range.from, lte: range.to };

  const [total, subscriptions] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
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
  const { page, pageSize, email, plan, platform, ...rangeInput } = query;
  const range = resolveDateRange(rangeInput);

  const where: Prisma.PurchaseTransactionWhereInput = {};
  if (email) where.user = { email: { contains: email, mode: 'insensitive' } };
  if (plan) where.productId = { contains: plan, mode: 'insensitive' };
  if (platform && platform in Platform) where.platform = platform as Platform;
  if (range.from || range.to) where.verifiedAt = { gte: range.from, lte: range.to };

  const [total, transactions, amountAgg] = await Promise.all([
    prisma.purchaseTransaction.count({ where }),
    prisma.purchaseTransaction.findMany({
      where,
      orderBy: { verifiedAt: 'desc' },
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
