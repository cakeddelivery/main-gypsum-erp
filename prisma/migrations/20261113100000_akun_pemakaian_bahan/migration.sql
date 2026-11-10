-- Akun HPP "Pemakaian Bahan Baku": pemakaian bahan dari stock opname laporan shift (sebelumnya ke 6-1800
-- Beban Reject & Selisih Persediaan). Kode otomatis = kode 5-1200..5-1990 (kelipatan 10) pertama yang masih kosong;
-- kodenya disimpan di Setting coa_pemakaian_bahan. Data lama tidak diubah. Aman dijalankan ulang.
DO $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Setting" WHERE "key" = 'coa_pemakaian_bahan') THEN
    SELECT "code" INTO c FROM "CoaAccount" WHERE "name" = 'Pemakaian Bahan Baku' LIMIT 1;
    IF c IS NULL THEN
      SELECT '5-' || n::text INTO c FROM generate_series(1200, 1990, 10) n
       WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '5-' || n::text) ORDER BY n LIMIT 1;
      INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
      VALUES (gen_random_uuid()::text, c, 'Pemakaian Bahan Baku', 'HPP', false, true);
    END IF;
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('coa_pemakaian_bahan', c, CURRENT_TIMESTAMP);
  END IF;
END $$;
