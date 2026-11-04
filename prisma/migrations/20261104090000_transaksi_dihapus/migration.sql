-- Transaksi Dibatalkan/Ditolak bisa dihapus dari daftar; datanya & jurnal pembalik tetap tersimpan untuk audit
ALTER TABLE "FinanceTransaction" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedBy" TEXT;
CREATE INDEX "FinanceTransaction_deletedAt_idx" ON "FinanceTransaction"("deletedAt");
