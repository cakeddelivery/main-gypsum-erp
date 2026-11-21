-- CreateTable
CREATE TABLE "MarketplaceWalletCheck" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceWalletCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceWalletCheck_storeId_channel_asOf_idx" ON "MarketplaceWalletCheck"("storeId", "channel", "asOf");

