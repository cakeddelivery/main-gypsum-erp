-- Akun & kategori LPG oven: Biaya Overhead Pabrik (produksi), bukan 6-1300 Beban Listrik, Air & Gas (beban umum). ADD-only, idempoten.
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1310', 'Beban LPG Produksi (Oven) — BOP', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1310');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'LPG Oven (Produksi)', 'KELUAR', c."id", 'lpg,elpiji,tabung gas,gas melon,isi ulang gas', true
FROM "CoaAccount" c WHERE c."code" = '6-1310'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'LPG Oven (Produksi)');
