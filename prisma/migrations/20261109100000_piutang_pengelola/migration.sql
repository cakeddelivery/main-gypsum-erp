-- Piutang Pengelola (1-1320): uang usaha yang dipinjam pengelola dan nanti dikembalikan.
-- Kategori KELUAR "Pinjaman Pengelola" dan MASUK "Pengembalian Pinjaman Pengelola". Aman dijalankan ulang.
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
VALUES (gen_random_uuid()::text, '1-1320', 'Piutang Pengelola', 'ASET', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Pinjaman Pengelola', 'KELUAR', c."id", 'pinjaman pengelola,dipinjam pengelola,pinjam pengelola', true
FROM "CoaAccount" c WHERE c."code" = '1-1320'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Pinjaman Pengelola');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Pengembalian Pinjaman Pengelola', 'MASUK', c."id", 'pengembalian pinjaman pengelola,kembalikan pinjaman pengelola', true
FROM "CoaAccount" c WHERE c."code" = '1-1320'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Pengembalian Pinjaman Pengelola');
