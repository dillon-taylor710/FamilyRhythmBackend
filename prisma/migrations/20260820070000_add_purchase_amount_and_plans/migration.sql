-- CreateTable: SubscriptionPlan — the editable list-price catalog (see
-- schema.prisma's doc comment). Created FIRST in this migration so the
-- amount_usd backfill below can join against it instead of hardcoding
-- prices a second time.
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price_usd" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_product_id_key" ON "subscription_plans"("product_id");

-- Seed today's 3 tiers (see the now-removed hardcoded map in
-- src/modules/subscriptions/planCatalog.ts) — this table is the only
-- source of truth for list price from here on.
INSERT INTO "subscription_plans" ("id", "product_id", "label", "price_usd", "is_active", "updated_at") VALUES
  (gen_random_uuid()::text, 'family_rhythm_monthly', 'Monthly', 3.90, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'family_rhythm_six_months', '6 Months', 20.00, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'family_rhythm_yearly', 'Yearly', 35.00, true, CURRENT_TIMESTAMP);

-- AlterTable: PurchaseTransaction.amount_usd — the price actually charged
-- at purchase time, recorded going forward by
-- subscriptions.service.ts#verifyPurchase, never recomputed later.
ALTER TABLE "purchase_transactions" ADD COLUMN "amount_usd" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Backfill existing valid rows from subscription_plans (not a hardcoded
-- price list) — there's no historical price record before this column
-- existed, so this is a best-effort one-time backfill against *today's*
-- prices, not a guarantee those purchases were charged exactly this
-- amount at the time.
UPDATE "purchase_transactions" AS pt
SET "amount_usd" = sp."price_usd"
FROM "subscription_plans" AS sp
WHERE pt."product_id" = sp."product_id"
  AND pt."verification_result" = 'valid';
