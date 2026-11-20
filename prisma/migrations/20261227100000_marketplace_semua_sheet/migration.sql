-- AlterTable
ALTER TABLE "MarketplaceOrder" ADD COLUMN     "extra" JSONB;

-- CreateTable
CREATE TABLE "MarketplaceShipDiscrepancy" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "estimate" BIGINT NOT NULL DEFAULT 0,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "diff" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT,
    "date" TIMESTAMP(3),
    "importId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceShipDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSellerFee" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "platformFee" BIGINT NOT NULL DEFAULT 0,
    "xtra" BIGINT NOT NULL DEFAULT 0,
    "service" BIGINT NOT NULL DEFAULT 0,
    "promo" BIGINT NOT NULL DEFAULT 0,
    "other" BIGINT NOT NULL DEFAULT 0,
    "importId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceSellerFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceImportJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "message" TEXT,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MarketplaceImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceShipDiscrepancy_storeId_channel_date_idx" ON "MarketplaceShipDiscrepancy"("storeId", "channel", "date");

-- CreateIndex
CREATE INDEX "MarketplaceShipDiscrepancy_importId_idx" ON "MarketplaceShipDiscrepancy"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceShipDiscrepancy_storeId_channel_orderNo_key" ON "MarketplaceShipDiscrepancy"("storeId", "channel", "orderNo");

-- CreateIndex
CREATE INDEX "MarketplaceSellerFee_importId_idx" ON "MarketplaceSellerFee"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceSellerFee_storeId_channel_orderNo_key" ON "MarketplaceSellerFee"("storeId", "channel", "orderNo");

-- CreateIndex
CREATE INDEX "MarketplaceImportJob_status_updatedAt_idx" ON "MarketplaceImportJob"("status", "updatedAt");

