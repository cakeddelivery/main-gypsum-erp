-- Akun pengurang pendapatan untuk retur & refund ke pembeli (tampil sebagai minus di bagian Pendapatan laba rugi)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '4-1900', 'Retur & Refund Penjualan', 'PENDAPATAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Retur & Refund Penjualan', 'KELUAR', c."id", 'refund,retur,return,pengembalian dana pembeli,uang kembali pembeli,komplain pembeli', true
FROM "CoaAccount" c WHERE c."code" = '4-1900'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Retur & Refund Penjualan');
