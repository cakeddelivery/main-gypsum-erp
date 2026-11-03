-- Kode otomatis supplier (SUP-001) & pelanggan (PLG-001)
ALTER TABLE "Supplier" ADD COLUMN "code" TEXT;
ALTER TABLE "Customer" ADD COLUMN "code" TEXT;
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- Isi kode untuk data yang sudah ada (urut nama / tanggal dibuat)
UPDATE "Supplier" s SET "code" = 'SUP-' || LPAD(x.n::text, 3, '0')
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) AS n FROM "Supplier") x WHERE x.id = s.id;
UPDATE "Customer" c SET "code" = 'PLG-' || LPAD(x.n::text, 3, '0')
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS n FROM "Customer") x WHERE x.id = c.id;

INSERT INTO "Counter"("key","value") SELECT 'KODE-SUP', COUNT(*) FROM "Supplier" HAVING COUNT(*) > 0
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("Counter"."value", EXCLUDED."value");
INSERT INTO "Counter"("key","value") SELECT 'KODE-PLG', COUNT(*) FROM "Customer" HAVING COUNT(*) > 0
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("Counter"."value", EXCLUDED."value");
