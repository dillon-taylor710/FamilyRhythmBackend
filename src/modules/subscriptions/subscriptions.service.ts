import { Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { getVerifier } from '../iap';
import { forbidden } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { priceForPlan } from './planCatalog';
import type { VerifyPurchaseInput } from './subscriptions.schemas';

export interface SubscriptionStatusResponse {
  status: SubscriptionStatus;
  active: boolean;
  planId: string | null;
  platform: string | null;
  expiresAt: string | null;
  trialDaysRemaining: number;
  autoRenewing: boolean;
}

const ACTIVE_STATUSES: SubscriptionStatus[] = ['active_trial', 'active_paid'];

export interface PlanResponse {
  productId: string;
  label: string;
  priceUsd: number;
}

/** Active plans, cheapest first — same source the admin Plans page edits
 * and `priceForPlan` reads for purchase recording, so what the app shows
 * on `PurchaseScreen` and what actually gets charged/recorded can never
 * drift apart. */
export async function listActivePlans(): Promise<PlanResponse[]> {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { priceUsd: 'asc' },
  });
  return plans.map((p) => ({ productId: p.productId, label: p.label, priceUsd: p.priceUsd.toNumber() }));
}

/**
 * Recomputes status against wall-clock time on every read — no background
 * job exists yet to flip a lapsed trial/subscription over on its own
 * (that's a real gap: without Google/Apple renewal webhooks, a paid
 * subscription that fails to auto-renew stays "active_paid" in the DB
 * until the next time this user's status happens to be read). Good enough
 * for phase 1; see backend/README.md's "Known gaps" section.
 */
async function resolveCurrentState(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  if (!subscription) return null;

  const now = new Date();
  let status = subscription.status;

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() < now.getTime()) {
    if (status === 'active_trial') status = 'expired_trial';
    else if (status === 'active_paid') status = 'expired_subscription';
  }

  if (status !== subscription.status) {
    await prisma.subscription.update({ where: { userId }, data: { status } });
  }

  return { ...subscription, status };
}

export async function getStatus(userId: string): Promise<SubscriptionStatusResponse> {
  const subscription = await resolveCurrentState(userId);

  if (!subscription) {
    return {
      status: 'unknown_error',
      active: false,
      planId: null,
      platform: null,
      expiresAt: null,
      trialDaysRemaining: 0,
      autoRenewing: false,
    };
  }

  const trialDaysRemaining =
    ACTIVE_STATUSES.includes(subscription.status) && subscription.currentPeriodEnd
      ? Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0;

  return {
    status: subscription.status,
    active: ACTIVE_STATUSES.includes(subscription.status),
    planId: subscription.planId,
    platform: subscription.platform,
    expiresAt: subscription.currentPeriodEnd?.toISOString() ?? null,
    trialDaysRemaining,
    autoRenewing: subscription.autoRenewing,
  };
}

export async function verifyPurchase(
  userId: string,
  input: VerifyPurchaseInput,
): Promise<SubscriptionStatusResponse & { valid: boolean }> {
  // Replay check FIRST, before ever calling the store — a token already
  // claimed by a different user must be rejected outright regardless of
  // what the store itself would say about it.
  const existingTransaction = await prisma.purchaseTransaction.findUnique({
    where: { platform_purchaseToken: { platform: input.platform, purchaseToken: input.purchaseToken } },
  });
  if (existingTransaction && existingTransaction.userId !== userId) {
    logger.warn(
      { userId, existingOwner: existingTransaction.userId, platform: input.platform },
      'Rejected purchase token already claimed by a different user',
    );
    throw forbidden('subscriptions.purchaseAlreadyClaimed');
  }

  const verifier = getVerifier(input.platform);
  const result = await verifier.verify(input.productId, input.purchaseToken);
  // Looked up once, right now — recorded on the row itself (not
  // recomputed from `productId` later) so a future price change can never
  // rewrite what this purchase is reported as having cost. A rejected
  // purchase is worth $0, same as a real store would charge nothing for
  // a declined transaction.
  const amountUsd = result.valid ? await priceForPlan(result.productId) : 0;

  await prisma.purchaseTransaction.upsert({
    where: { platform_purchaseToken: { platform: input.platform, purchaseToken: input.purchaseToken } },
    create: {
      userId,
      platform: input.platform,
      productId: result.productId,
      purchaseToken: input.purchaseToken,
      rawReceipt: result.raw as Prisma.InputJsonValue,
      verificationResult: result.valid ? 'valid' : 'invalid',
      amountUsd,
    },
    update: {
      rawReceipt: result.raw as Prisma.InputJsonValue,
      verificationResult: result.valid ? 'valid' : 'invalid',
      verifiedAt: new Date(),
      amountUsd,
    },
  });

  // A failed verification does NOT downgrade an existing subscription —
  // it could be a transient store-API hiccup, not proof the purchase is
  // fake. Only a *successful* verification writes to `subscriptions`.
  if (!result.valid) {
    const current = await getStatus(userId);
    return { ...current, valid: false };
  }

  // The verifier prices `expiresAt` as if the new period starts now — true
  // for a fresh or lapsed subscription, but a repurchase while an existing
  // paid period is still running should extend from that period's end, not
  // reset the clock. Re-derive the plan's duration from the verifier's own
  // math (`expiresAt - now`) and re-apply it on top of the later of "now"
  // or the existing `currentPeriodEnd`.
  const existingSubscription = await prisma.subscription.findUnique({ where: { userId } });
  const now = new Date();
  const periodStart =
    existingSubscription?.currentPeriodEnd && existingSubscription.currentPeriodEnd.getTime() > now.getTime()
      ? existingSubscription.currentPeriodEnd
      : now;
  const periodEnd = result.expiresAt
    ? new Date(periodStart.getTime() + (result.expiresAt.getTime() - now.getTime()))
    : null;

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      status: 'active_paid',
      planId: result.productId,
      platform: input.platform,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      autoRenewing: result.autoRenewing,
    },
    update: {
      status: 'active_paid',
      planId: result.productId,
      platform: input.platform,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      autoRenewing: result.autoRenewing,
    },
  });

  const current = await getStatus(userId);
  return { ...current, valid: true };
}
