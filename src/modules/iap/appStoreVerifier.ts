import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { HttpError } from '../../utils/httpError';
import type { IapVerifier, VerifiedPurchase } from './iapVerifier.types';

const PRODUCTION_BASE_URL = 'https://api.storekit.itunes.apple.com';
const SANDBOX_BASE_URL = 'https://api.storekit-sandbox.itunes.apple.com';

/** Decoded payload of Apple's `JWSTransactionDecodedPayload`, fields we use. */
interface AppleTransactionInfo {
  productId: string;
  expiresDate?: number; // epoch millis
  autoRenewStatus?: number; // 1 = will auto-renew
  revocationDate?: number; // present if refunded/revoked
}

// Verifies a subscription purchase against Apple's App Store Server API.
// `purchaseToken` here is the original/latest *transaction id* the client
// hands back from StoreKit — Apple's naming, unlike Google's opaque
// "purchase token", but it plays the identical role in our schema.
export class AppStoreVerifier implements IapVerifier {
  async verify(productId: string, purchaseToken: string): Promise<VerifiedPurchase> {
    if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY || !env.APPLE_BUNDLE_ID) {
      throw new HttpError(500, 'APPLE_ISSUER_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY/APPLE_BUNDLE_ID are not configured');
    }

    const baseUrl = env.APPLE_USE_SANDBOX ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
    const authToken = this.buildAuthToken();

    try {
      const response = await fetch(`${baseUrl}/inApps/v1/transactions/${encodeURIComponent(purchaseToken)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (!response.ok) {
        logger.warn({ status: response.status, productId }, 'Apple transaction lookup failed');
        return { valid: false, productId, expiresAt: null, autoRenewing: false, raw: { status: response.status } };
      }

      const body = (await response.json()) as { signedTransactionInfo: string };
      // The JWS payload's signature is Apple's own chain (x5c header) —
      // decoding without verifying the chain is enough to read the fields
      // we need, but production hardening should verify the certificate
      // chain up to Apple's root CA before trusting `payload` below.
      const payload = jwt.decode(body.signedTransactionInfo) as AppleTransactionInfo | null;
      if (!payload) {
        return { valid: false, productId, expiresAt: null, autoRenewing: false, raw: body };
      }

      const isRevoked = typeof payload.revocationDate === 'number';
      const expiresAt = payload.expiresDate ? new Date(payload.expiresDate) : null;
      const isExpired = expiresAt !== null && expiresAt.getTime() < Date.now();

      return {
        valid: !isRevoked && !isExpired,
        productId: payload.productId ?? productId,
        expiresAt,
        autoRenewing: payload.autoRenewStatus === 1,
        raw: payload,
      };
    } catch (err) {
      logger.warn({ err, productId }, 'Apple verification failed');
      return { valid: false, productId, expiresAt: null, autoRenewing: false, raw: { error: String(err) } };
    }
  }

  private buildAuthToken(): string {
    // Apple requires a short-lived (<= 1hr) ES256 JWT signed with the
    // App Store Connect API private key, re-minted per request rather
    // than cached, to keep this stateless and avoid an expiry-tracking
    // bug class entirely.
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 60 * 20, aud: 'appstoreconnect-v1', bid: env.APPLE_BUNDLE_ID },
      (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      { algorithm: 'ES256', header: { alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' } },
    );
  }
}
