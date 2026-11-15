-- Pembayaran gaji per slip (bot Telegram & web): status bayar per karyawan, satu pesan bukti hanya satu pembayaran
ALTER TABLE "Payslip" ADD COLUMN "paidAt" TIMESTAMP(3),
ADD COLUMN "paidJournalId" TEXT,
ADD COLUMN "paidFromAccountId" TEXT,
ADD COLUMN "paidMessageId" TEXT,
ADD COLUMN "paidProofPath" TEXT;

CREATE UNIQUE INDEX "Payslip_paidMessageId_key" ON "Payslip"("paidMessageId");
