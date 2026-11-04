CREATE TABLE "FinanceTxSplit" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "categoryId" TEXT,
    "amount" BIGINT NOT NULL,
    "note" TEXT,
    "itemId" TEXT,
    "qty" DECIMAL(14,3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "FinanceTxSplit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FinanceTxSplit_transactionId_idx" ON "FinanceTxSplit"("transactionId");
ALTER TABLE "FinanceTxSplit" ADD CONSTRAINT "FinanceTxSplit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FinanceTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
