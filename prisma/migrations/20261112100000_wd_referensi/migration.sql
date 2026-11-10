-- No. Referensi withdraw TikTok (Detail penarikan dana Seller Center): cek duplikat pasti. Aman diulang.
ALTER TABLE "FinanceTransaction" ADD COLUMN IF NOT EXISTS "withdrawRef" TEXT;
CREATE INDEX IF NOT EXISTS "FinanceTransaction_withdrawRef_idx" ON "FinanceTransaction"("withdrawRef");
