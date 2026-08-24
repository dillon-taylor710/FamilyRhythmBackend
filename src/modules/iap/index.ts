import { env } from '../../config/env';
import { GooglePlayVerifier } from './googlePlayVerifier';
import { AppStoreVerifier } from './appStoreVerifier';
import { MockPreviewVerifier } from './mockPreviewVerifier';
import type { IapVerifier } from './iapVerifier.types';
import { badRequest } from '../../utils/httpError';

const googlePlayVerifier = new GooglePlayVerifier();
const appStoreVerifier = new AppStoreVerifier();
const mockPreviewVerifier = new MockPreviewVerifier();

const googleConfigured = Boolean(
  env.GOOGLE_PLAY_PACKAGE_NAME && (env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE),
);
const appleConfigured = Boolean(
  env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY && env.APPLE_BUNDLE_ID,
);

export type Platform = 'android' | 'ios';

/**
 * Falls back to `MockPreviewVerifier` per-platform until that platform's
 * real store credentials are configured (see `env.ts`) — real native IAP
 * isn't wired up yet, so there's no real receipt to verify against
 * Google/Apple regardless; this keeps `POST /subscriptions/verify` the one
 * true source of "did this purchase happen" either way, real or preview.
 */
export function getVerifier(platform: Platform): IapVerifier {
  switch (platform) {
    case 'android':
      return googleConfigured ? googlePlayVerifier : mockPreviewVerifier;
    case 'ios':
      return appleConfigured ? appStoreVerifier : mockPreviewVerifier;
    default:
      throw badRequest('iap.unsupportedPlatform', { platform });
  }
}

export type { VerifiedPurchase } from './iapVerifier.types';
