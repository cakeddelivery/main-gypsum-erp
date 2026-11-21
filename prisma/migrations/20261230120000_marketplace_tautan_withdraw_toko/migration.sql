-- CreateTable
CREATE TABLE "MarketplaceWithdrawLink" (
    "id" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "withdrawalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceWithdrawLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceWithdrawLink_txId_key" ON "MarketplaceWithdrawLink"("txId");

-- CreateIndex
CREATE INDEX "MarketplaceWithdrawLink_storeId_channel_idx" ON "MarketplaceWithdrawLink"("storeId", "channel");

