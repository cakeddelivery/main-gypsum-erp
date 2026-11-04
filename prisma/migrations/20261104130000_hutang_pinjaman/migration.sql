-- Hutang: akun COA per hutang, jadwal cicilan pinjaman, pembayaran hutang tercatat di Transaksi
ALTER TABLE "Payable" ADD COLUMN "coaAccountId" TEXT;
ALTER TABLE "Payable" ADD COLUMN "installments" INTEGER;
ALTER TABLE "Payable" ADD COLUMN "interestTotal" BIGINT;
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_coaAccountId_fkey" FOREIGN KEY ("coaAccountId") REFERENCES "CoaAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinanceTransaction" ADD COLUMN "payableId" TEXT;
ALTER TABLE "FinanceTransaction" ADD COLUMN "payInterest" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "Payable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "FinanceTransaction_payableId_idx" ON "FinanceTransaction"("payableId");

-- Akun baru: bunga/biaya pinjaman dan iuran lingkungan (bukan lagi Beban Lain-lain)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '6-1950', 'Beban Bunga & Biaya Pinjaman', 'BEBAN', false, true),
  (gen_random_uuid()::text, '6-1350', 'Beban Kebersihan & Iuran Lingkungan', 'BEBAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Iuran Lingkungan & Kebersihan', 'KELUAR', c."id", 'iuran,sampah,kebersihan,keamanan,ronda,retribusi', true
FROM "CoaAccount" c WHERE c."code" = '6-1350'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Iuran Lingkungan & Kebersihan');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Bunga & Biaya Pinjaman', 'KELUAR', c."id", 'bunga pinjaman,biaya pinjaman,denda keterlambatan', true
FROM "CoaAccount" c WHERE c."code" = '6-1950'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Bunga & Biaya Pinjaman');

-- Penamaan: "Utang" → "Hutang"
UPDATE "CoaAccount" SET "name" = regexp_replace("name", '^Utang', 'Hutang') WHERE "type" = 'KEWAJIBAN' AND "name" LIKE 'Utang%';
