import { google } from 'googleapis';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { HttpError } from '../../utils/httpError';
import type { IapVerifier, VerifiedPurchase } from './iapVerifier.types';

// Verifies a subscription purchase against the Google Play Developer API
// (purchases.subscriptionsv2.get). Requires a service-account key with
// access granted to this app in Play Console → Users and permissions.
export class GooglePlayVerifier implements IapVerifier {
  async verify(productId: string, purchaseToken: string): Promise<VerifiedPurchase> {
    if (!env.GOOGLE_PLAY_PACKAGE_NAME) {
      throw new HttpError(500, 'GOOGLE_PLAY_PACKAGE_NAME is not configured');
    }

    const auth = await this.buildAuth();
    const androidPublisher = google.androidpublisher({ version: 'v3', auth });

    try {
      const { data } = await androidPublisher.purchases.subscriptionsv2.get({
        packageName: env.GOOGLE_PLAY_PACKAGE_NAME,
        token: purchaseToken,
      });

      const lineItem = data.lineItems?.[0];
      const expiryTimeMillis = lineItem?.expiryTime ? Date.parse(lineItem.expiryTime) : NaN;
      const isActive = data.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
      const isInGrace = data.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';

      return {
        valid: isActive || isInGrace,
        productId: lineItem?.productId ?? productId,
        expiresAt: Number.isFinite(expiryTimeMillis) ? new Date(expiryTimeMillis) : null,
        autoRenewing: lineItem?.autoRenewingPlan?.autoRenewEnabled ?? false,
        raw: data,
      };
    } catch (err) {
      logger.warn({ err, productId }, 'Google Play verification failed');
      // A verification failure (invalid token, network error, etc.) is
      // NOT the same as "the app is broken" — surface it as an invalid
      // purchase to the caller rather than a 500, so the client gets a
      // clean "we couldn't confirm this purchase" instead of a crash.
      return { valid: false, productId, expiresAt: null, autoRenewing: false, raw: { error: String(err) } };
    }
  }

  private async buildAuth() {
    const credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
      : undefined;

    if (!credentials && !env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
      throw new HttpError(
        500,
        'Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_KEY_FILE to verify Android purchases',
      );
    }

    return new google.auth.GoogleAuth({
      credentials,
      keyFile: credentials ? undefined : env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  }
}
