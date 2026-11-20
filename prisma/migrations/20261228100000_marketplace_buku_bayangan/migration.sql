-- CreateTable
CREATE TABLE "MarketplaceGlJournal" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceGlJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceGlLine" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "debit" BIGINT NOT NULL DEFAULT 0,
    "credit" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "MarketplaceGlLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceGlOpening" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceGlOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceGlJournal_key_key" ON "MarketplaceGlJournal"("key");

-- CreateIndex
CREATE INDEX "MarketplaceGlJournal_date_idx" ON "MarketplaceGlJournal"("date");

-- CreateIndex
CREATE INDEX "MarketplaceGlJournal_storeId_channel_date_idx" ON "MarketplaceGlJournal"("storeId", "channel", "date");

-- CreateIndex
CREATE INDEX "MarketplaceGlLine_journalId_idx" ON "MarketplaceGlLine"("journalId");

-- CreateIndex
CREATE INDEX "MarketplaceGlLine_account_idx" ON "MarketplaceGlLine"("account");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceGlOpening_storeId_channel_wallet_key" ON "MarketplaceGlOpening"("storeId", "channel", "wallet");

-- AddForeignKey
ALTER TABLE "MarketplaceGlLine" ADD CONSTRAINT "MarketplaceGlLine_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "MarketplaceGlJournal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

