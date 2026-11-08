-- Nama lain supplier (gabung supplier dobel), bukti nota hutang, dan sinkron transfer Transaksi ↔ Dana sisihan
ALTER TABLE "Supplier" ADD COLUMN "aliases" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payable" ADD COLUMN "proofPath" TEXT, ADD COLUMN "proofMime" TEXT;
ALTER TABLE "FinanceTransaction" ADD COLUMN "reserveLink" JSONB;
ALTER TABLE "ReserveEntry" ADD COLUMN "transactionId" TEXT;
ALTER TABLE "ReserveEntry" ADD CONSTRAINT "ReserveEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FinanceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ReserveEntry_transactionId_idx" ON "ReserveEntry"("transactionId");
