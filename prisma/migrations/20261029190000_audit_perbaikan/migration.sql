-- Revisi laporan shift hanya menerapkan selisih stock opname
ALTER TABLE "ShiftReport" ADD COLUMN "stockAppliedCount" JSONB;

-- Indeks baris jurnal (laporan keuangan, buku besar & saldo rekening)
CREATE INDEX "JournalLine_journalId_idx" ON "JournalLine"("journalId");
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");
