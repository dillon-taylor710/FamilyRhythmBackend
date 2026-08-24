export interface VerifiedPurchase {
  valid: boolean;
  /** Store's own product/subscription ID, echoed back so callers can
   * cross-check against what the client claimed to purchase. */
  productId: string;
  /** null when `valid` is false or the store didn't return one. */
  expiresAt: Date | null;
  autoRenewing: boolean;
  /** Raw store response, stored as-is in purchase_transactions.raw_receipt
   * for audits/disputes — never parsed again after this point. */
  raw: unknown;
}

export interface IapVerifier {
  verify(productId: string, purchaseToken: string): Promise<VerifiedPurchase>;
}
