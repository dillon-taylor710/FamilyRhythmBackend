-- Family Rhythm backend — consolidated database setup script.
--
-- This is a hand-consolidated snapshot of every migration under
-- prisma/migrations/ (as of 2026-08-20), for standing up a fresh database
-- in one shot (e.g. restoring onto a new Postgres instance) without
-- replaying migration history step by step. It is NOT itself a Prisma
-- migration — Prisma's own migration history (prisma/migrations/) remains
-- the source of truth for `prisma migrate deploy`/`dev`; regenerate this
-- file by hand (or re-derive it) if the schema changes again, it does not
-- update itself.
--
-- Ownership: every table and enum type is assigned to the `family_rhythm_api`
-- role — the app connects as this role in production, and Postgres
-- requires the connecting role to *own* a table (or have equivalent grants)
-- to run DDL/DML against it without superuser privileges. Run this script
-- as a role that can grant ownership (e.g. the DB's bootstrap superuser),
-- with `family_rhythm_api` already created:
--   CREATE ROLE family_rhythm_api WITH LOGIN PASSWORD '...';

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE "SubscriptionStatus" AS ENUM ('active_trial', 'active_paid', 'expired_trial', 'expired_subscription', 'cancelled', 'unknown_error');
ALTER TYPE "SubscriptionStatus" OWNER TO family_rhythm_api;

CREATE TYPE "Platform" AS ENUM ('android', 'ios');
ALTER TYPE "Platform" OWNER TO family_rhythm_api;

CREATE TYPE "VerificationResult" AS ENUM ('valid', 'invalid', 'expired', 'error');
ALTER TYPE "VerificationResult" OWNER TO family_rhythm_api;

CREATE TYPE "SumupStatus" AS ENUM ('none', 'confirmed');
ALTER TYPE "SumupStatus" OWNER TO family_rhythm_api;

-- ============================================================
-- Tables
-- ============================================================

-- users
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "users" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- password_reset_tokens
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "password_reset_tokens" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- email_verification_codes
CREATE TABLE "email_verification_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "email_verification_codes" OWNER TO family_rhythm_api;

CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes"("user_id");

ALTER TABLE "email_verification_codes"
  ADD CONSTRAINT "email_verification_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- subscription_plans — created before subscriptions/purchase_transactions
-- reference it conceptually (no FK to it, but purchase_transactions.amount_usd
-- is derived from this table's price at insert time — see app code).
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price_usd" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "subscription_plans" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "subscription_plans_product_id_key" ON "subscription_plans"("product_id");

-- subscriptions
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active_trial',
    "plan_id" TEXT,
    "platform" "Platform",
    "trial_start_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "auto_renewing" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "subscriptions" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- purchase_transactions
CREATE TABLE "purchase_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "product_id" TEXT NOT NULL,
    "purchase_token" TEXT NOT NULL,
    "raw_receipt" JSONB,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_result" "VerificationResult" NOT NULL,
    "amount_usd" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_transactions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "purchase_transactions" OWNER TO family_rhythm_api;

CREATE INDEX "purchase_transactions_user_id_idx" ON "purchase_transactions"("user_id");
CREATE UNIQUE INDEX "purchase_transactions_platform_purchase_token_key" ON "purchase_transactions"("platform", "purchase_token");

ALTER TABLE "purchase_transactions"
  ADD CONSTRAINT "purchase_transactions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- admin_users
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "admin_users" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- monthly_sumups
CREATE TABLE "monthly_sumups" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "SumupStatus" NOT NULL DEFAULT 'none',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "monthly_sumups_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "monthly_sumups" OWNER TO family_rhythm_api;

CREATE UNIQUE INDEX "monthly_sumups_year_month_key" ON "monthly_sumups"("year", "month");

-- ============================================================
-- Seed data (DML)
-- ============================================================

-- subscription_plans — today's 3 tiers (see
-- src/modules/subscriptions/planCatalog.ts and the admin Plans page, which
-- is the intended way to change these afterward, not by editing this file).
INSERT INTO "subscription_plans" ("id", "product_id", "label", "price_usd", "is_active", "updated_at") VALUES
  (gen_random_uuid()::text, 'family_rhythm_monthly', 'Monthly', 3.90, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'family_rhythm_six_months', '6 Months', 20.00, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'family_rhythm_yearly', 'Yearly', 35.00, true, CURRENT_TIMESTAMP);
