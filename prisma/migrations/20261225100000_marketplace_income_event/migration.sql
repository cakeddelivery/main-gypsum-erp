-- CreateTable
CREATE TABLE "MarketplaceIncomeEvent" (
    "id" TEXT NOT NULL,
    "incomeId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "released" BIGINT NOT NULL DEFAULT 0,
    "productAmt" BIGINT NOT NULL DEFAULT 0,
    "refundAmt" BIGINT NOT NULL DEFAULT 0,
    "fees" BIGINT NOT NULL DEFAULT 0,
    "feeDetail" JSONB,
    "importId" TEXT NOT NULL,

    CONSTRAINT "MarketplaceIncomeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceIncomeEvent_importId_idx" ON "MarketplaceIncomeEvent"("importId");

-- CreateIndex
CREATE INDEX "MarketplaceIncomeEvent_releasedAt_idx" ON "MarketplaceIncomeEvent"("releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceIncomeEvent_incomeId_eventKey_key" ON "MarketplaceIncomeEvent"("incomeId", "eventKey");

-- AddForeignKey
ALTER TABLE "MarketplaceIncomeEvent" ADD CONSTRAINT "MarketplaceIncomeEvent_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "MarketplaceIncome"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data impor lama: satu event per penghasilan yang sudah ada (hanya menambah ke tabel baru; tidak mengubah/menghapus apa pun)
INSERT INTO "MarketplaceIncomeEvent" ("id", "incomeId", "eventKey", "releasedAt", "released", "productAmt", "refundAmt", "fees", "feeDetail", "importId")
SELECT 'ev_' || "id", "id", 'legacy', "releasedAt", "released", "productAmt", "refundAmt", "fees", "feeDetail", "importId" FROM "MarketplaceIncome";
