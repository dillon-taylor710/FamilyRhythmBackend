import { prisma } from '../../db/prisma';

/**
 * `SubscriptionPlan` (see schema.prisma) is the one source of truth for a
 * plan's current list price — editable from the admin Plans page without a
 * deploy. This module is just a thin, short-lived cache in front of it so
 * `verifyPurchase` (on the hot path of every purchase) doesn't hit the DB
 * for a value that changes rarely; every write path (the admin Plans page)
 * calls `invalidatePlanCache()` so a price edit takes effect immediately
 * rather than waiting out the TTL.
 */
const CACHE_TTL_MS = 60_000;
let cache: { plans: Map<string, { label: string; priceUsd: number }>; expiresAt: number } | null = null;

async function loadPlans(): Promise<Map<string, { label: string; priceUsd: number }>> {
  if (cache && cache.expiresAt > Date.now()) return cache.plans;

  const rows = await prisma.subscriptionPlan.findMany();
  const plans = new Map(rows.map((r) => [r.productId, { label: r.label, priceUsd: r.priceUsd.toNumber() }]));
  cache = { plans, expiresAt: Date.now() + CACHE_TTL_MS };
  return plans;
}

export function invalidatePlanCache(): void {
  cache = null;
}

/** Unrecognized/legacy or not-yet-seeded product IDs count as $0 rather
 * than throwing — purchase recording should degrade gracefully, not 500,
 * on an unmapped plan ID. */
export async function priceForPlan(productId: string | null | undefined): Promise<number> {
  if (!productId) return 0;
  const plans = await loadPlans();
  return plans.get(productId)?.priceUsd ?? 0;
}
