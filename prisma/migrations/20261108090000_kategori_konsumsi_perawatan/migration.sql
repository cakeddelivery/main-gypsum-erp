-- Kategori Konsumsi dan Perawatan Tempat & Alat Produksi (+ akun bebannya)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '6-1250', 'Beban Konsumsi', 'BEBAN', false, true),
  (gen_random_uuid()::text, '6-1450', 'Beban Pemeliharaan & Perbaikan', 'BEBAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Konsumsi', 'KELUAR', c."id", 'konsumsi,makan,minum,snack,jajan,kopi,nasi,galon,air minum,aqua,katering,catering,gorengan,roti', true
FROM "CoaAccount" c WHERE c."code" = '6-1250'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Konsumsi');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Perawatan Tempat & Alat Produksi', 'KELUAR', c."id", 'perawatan,pemeliharaan,perbaikan,reparasi,renovasi,servis,service,sparepart,suku cadang,pelumas,oli mesin,obeng,palu,gergaji,gerinda,sapu,alat pel,kain pel,pembersih,alat kebersihan,sabun,ember,lampu,tukang,bengkel,benerin,betulin,perlengkapan', true
FROM "CoaAccount" c WHERE c."code" = '6-1450'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Perawatan Tempat & Alat Produksi');
