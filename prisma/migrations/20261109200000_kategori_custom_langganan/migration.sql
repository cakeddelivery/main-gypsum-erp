-- Kategori baru (aman dijalankan ulang):
-- 1. "Bahan Pesanan Custom" -> 5-1100 HPP Pesanan Custom: label/stiker/print custom yang dipesan ke percetakan per
--    pesanan dan langsung dikirim (tanpa stok), jadi langsung menjadi harga pokok, bukan persediaan.
-- 2. "Langganan Software & AI" -> 6-1550 Beban Langganan Software & AI (ChatGPT, Claude, Canva, CapCut, Google One, dll.).
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '5-1100', 'HPP Pesanan Custom (tanpa stok)', 'HPP', false, true),
  (gen_random_uuid()::text, '6-1550', 'Beban Langganan Software & AI', 'BEBAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Bahan Pesanan Custom', 'KELUAR', c."id", 'custom label,label custom,stiker custom,sticker custom,print custom,cetak custom,custom print,custom cetak,percetakan,warna print', true
FROM "CoaAccount" c WHERE c."code" = '5-1100'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Bahan Pesanan Custom');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Langganan Software & AI', 'KELUAR', c."id", 'subscription,chatgpt,chat gpt,claude,canva,capcut,google one,langganan ai,software,aplikasi premium', true
FROM "CoaAccount" c WHERE c."code" = '6-1550'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Langganan Software & AI');
