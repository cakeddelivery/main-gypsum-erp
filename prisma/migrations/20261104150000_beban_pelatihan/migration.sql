-- Akun & kategori untuk biaya kelas/kursus/pelatihan (pengembangan bisnis & SDM)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '6-1650', 'Beban Pelatihan & Pengembangan SDM', 'BEBAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Pelatihan & Pengembangan', 'KELUAR', c."id", 'kelas,kursus,pelatihan,training,workshop,seminar,bootcamp,webinar', true
FROM "CoaAccount" c WHERE c."code" = '6-1650'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Pelatihan & Pengembangan');
