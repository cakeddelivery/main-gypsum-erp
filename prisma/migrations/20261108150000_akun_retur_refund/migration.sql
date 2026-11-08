-- Akun kontra pendapatan "Retur & Refund Penjualan" (4-1200) + kategori transaksi keluarnya.
-- Aman dijalankan ulang: tidak membuat dobel, hanya merapikan nama bila sudah ada dari seed lama ("Return & Refund Penjualan").
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
VALUES (gen_random_uuid()::text, '4-1200', 'Retur & Refund Penjualan', 'PENDAPATAN', false, true)
ON CONFLICT ("code") DO NOTHING;

UPDATE "CoaAccount" SET "name" = 'Retur & Refund Penjualan', "active" = true
WHERE "code" = '4-1200' AND "type" = 'PENDAPATAN';

UPDATE "TxCategory" SET "name" = 'Retur & Refund Penjualan'
WHERE "name" = 'Return & Refund Penjualan'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Retur & Refund Penjualan');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Retur & Refund Penjualan', 'KELUAR', c."id", 'refund,retur,return,pengembalian dana pembeli,uang kembali pembeli,komplain pembeli', true
FROM "CoaAccount" c WHERE c."code" = '4-1200' AND c."type" = 'PENDAPATAN'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Retur & Refund Penjualan');
