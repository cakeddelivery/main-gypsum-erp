-- CreateTable
CREATE TABLE "MarketplaceBalanceTx" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "txKey" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "orderNo" TEXT,
    "amount" BIGINT NOT NULL,
    "status" TEXT,
    "balanceAfter" BIGINT,
    "pos" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL,
    "importId" TEXT NOT NULL,

    CONSTRAINT "MarketplaceBalanceTx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceBalanceTx_storeId_channel_date_idx" ON "MarketplaceBalanceTx"("storeId", "channel", "date");

-- CreateIndex
CREATE INDEX "MarketplaceBalanceTx_orderNo_idx" ON "MarketplaceBalanceTx"("orderNo");

-- CreateIndex
CREATE INDEX "MarketplaceBalanceTx_importId_idx" ON "MarketplaceBalanceTx"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceBalanceTx_storeId_channel_txKey_key" ON "MarketplaceBalanceTx"("storeId", "channel", "txKey");

