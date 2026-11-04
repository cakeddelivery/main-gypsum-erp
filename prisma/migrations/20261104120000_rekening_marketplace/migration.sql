ALTER TABLE "BankAccount" ADD COLUMN "marketplace" BOOLEAN NOT NULL DEFAULT false;
-- Saldo penjual Shopee & TikTok yang sudah ada
UPDATE "BankAccount" SET "marketplace" = true
WHERE "code" IN ('SALDO_SHOPEE', 'SALDO_TIKTOK') OR "name" ILIKE '%saldo penjual%' OR "code" LIKE 'SALDO_PENJUAL%';
