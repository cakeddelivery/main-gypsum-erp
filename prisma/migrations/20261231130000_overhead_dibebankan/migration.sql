-- Akun kontra-beban "Overhead Pabrik Dibebankan" (full costing): overhead resep yang dikapitalisasi ke persediaan
-- dikreditkan di sini; beban aslinya (LPG, penyusutan, sewa, dll.) tetap dicatat di akunnya masing-masing. ADD-only, idempoten.
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1850', 'Overhead Pabrik Dibebankan (kontra beban)', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1850');
