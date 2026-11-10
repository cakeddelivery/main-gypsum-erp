-- Kategori bunga bank (aman dijalankan ulang):
-- 1. "Bunga Bank" (MASUK) -> 4-9100 Pendapatan Bunga Bank, sub-akun dari 4-9000 Pendapatan Lain-lain
--    (bunga tabungan yang dikreditkan bank, mis. resi SeaBank "Bunga Rp 218").
-- 2. "Pajak Bunga Bank" (KELUAR) -> 6-1960 Beban Pajak Bunga Bank (pajak bunga yang dipotong bank).
-- Kata "bunga" dilepas dari kategori "Pendapatan Lain" agar bunga bank tidak lagi masuk ke sana.
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active", "parentId")
SELECT gen_random_uuid()::text, '4-9100', 'Pendapatan Bunga Bank', 'PENDAPATAN', false, true, (SELECT "id" FROM "CoaAccount" WHERE "code" = '4-9000')
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '4-9100');

INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1960', 'Beban Pajak Bunga Bank', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1960');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Bunga Bank', 'MASUK', c."id", 'bunga bank,bunga tabungan,bunga seabank,bunga,interest', true
FROM "CoaAccount" c WHERE c."code" = '4-9100'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Bunga Bank');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Pajak Bunga Bank', 'KELUAR', c."id", 'pajak bunga,pph bunga,pajak bunga bank,pajak tabungan', true
FROM "CoaAccount" c WHERE c."code" = '6-1960'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Pajak Bunga Bank');

UPDATE "TxCategory" SET "keywords" = 'cashback,lain'
WHERE "name" = 'Pendapatan Lain' AND "keywords" = 'bunga,cashback,lain';
