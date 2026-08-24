-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "SumupStatus" AS ENUM ('none', 'confirmed');

-- CreateTable
CREATE TABLE "monthly_sumups" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "SumupStatus" NOT NULL DEFAULT 'none',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "monthly_sumups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monthly_sumups_year_month_key" ON "monthly_sumups"("year", "month");
