import { logger } from '../../utils/logger';
import type { IapVerifier, VerifiedPurchase } from './iapVerifier.types';

const PLAN_DURATIONS_DAYS: Record<string, number> = {
  family_rhythm_monthly: 30,
  family_rhythm_six_months: 30 * 6,
  family_rhythm_yearly: 365,
};

const DEFAULT_DURATION_DAYS = 30;

/**
 * Used in place of `GooglePlayVerifier`/`AppStoreVerifier` whenever their
 * store credentials aren't configured (see `getVerifier`) — real IAP is
 * deliberately not wired up yet (no native `in_app_purchase` plugin, no
 * Play Console/App Store Connect product IDs), so there is no real receipt
 * to verify against Google/Apple. Rather than the client faking an
 * "active_paid" state locally (which `CLAUDE.md` explicitly forbids —
 * never trust `subscriptionActive: true` from the client alone), this
 * always accepts the purchase server-side instead, so `PurchaseScreen`'s
 * "activePaid" status and the recorded `PurchaseTransaction` genuinely
 * come from the backend, same code path a real store verification would
 * take once one exists — swap this out for the moment real credentials are
 * configured, no caller changes needed.
 */
export class MockPreviewVerifier implements IapVerifier {
  async verify(productId: string, purchaseToken: string): Promise<VerifiedPurchase> {
    logger.info({ productId, purchaseToken }, 'Preview purchase accepted (no real store credentials configured)');
    const durationDays = PLAN_DURATIONS_DAYS[productId] ?? DEFAULT_DURATION_DAYS;
    return {
      valid: true,
      productId,
      expiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000),
      autoRenewing: true,
      raw: { preview: true, productId, purchaseToken },
    };
  }
}
