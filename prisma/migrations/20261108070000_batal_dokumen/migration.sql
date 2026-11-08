-- Pembatalan pembelian, kasbon, dan pembayaran upah borongan (jurnal dibalik, dokumen tetap tersimpan)
ALTER TABLE "Purchase" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "CashAdvance" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "BoronganSettlement" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
