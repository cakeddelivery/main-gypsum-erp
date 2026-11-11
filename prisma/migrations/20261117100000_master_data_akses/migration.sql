-- Master data & akses: tipe produk bisa diatur, item OFFLINE/ONLINE + link produk, harga manual Owner,
-- jumlah order biasa, permintaan stok otomatis, jabatan karyawan tidak wajib lagi

-- Tipe produk: enum -> tabel pilihan (nilai lama tetap sama)
CREATE TABLE "ProductTypeOption" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "packQty" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductTypeOption_pkey" PRIMARY KEY ("code")
);
INSERT INTO "ProductTypeOption" ("code", "name", "packQty", "sortOrder") VALUES
  ('SATUAN', 'Satuan', 1, 1), ('PAKET_12', 'Paket 12', 12, 2), ('PAKET_24', 'Paket 24', 24, 3),
  ('PAKET_48', 'Paket 48', 48, 4), ('GIFTBOX', 'Giftbox', 1, 5), ('CUSTOM', 'Custom', 1, 6);
ALTER TABLE "Product" ALTER COLUMN "type" TYPE TEXT USING "type"::text;
DROP TYPE "ProductType";

-- Item
CREATE TYPE "BuyMode" AS ENUM ('OFFLINE', 'ONLINE');
ALTER TABLE "Item" ADD COLUMN "buyPrice" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Item" ADD COLUMN "buyQty" DECIMAL(14,3) NOT NULL DEFAULT 1;
ALTER TABLE "Item" ADD COLUMN "costManualBy" TEXT;
ALTER TABLE "Item" ADD COLUMN "costManualAt" TIMESTAMP(3);
ALTER TABLE "Item" ADD COLUMN "buyMode" "BuyMode" NOT NULL DEFAULT 'OFFLINE';
ALTER TABLE "Item" ADD COLUMN "productUrl" TEXT;
ALTER TABLE "Item" ADD COLUMN "orderQty" DECIMAL(14,3) NOT NULL DEFAULT 0;
UPDATE "Item" SET "buyPrice" = "lastCost" WHERE "lastCost" > 0;

-- Permintaan stok otomatis
ALTER TABLE "StockRequest" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StockRequest" ADD COLUMN "reportId" TEXT;
CREATE INDEX "StockRequest_itemId_status_idx" ON "StockRequest"("itemId", "status");

-- Jabatan tidak wajib lagi (kolom tetap ada, data lama aman)
ALTER TABLE "Employee" ALTER COLUMN "position" SET DEFAULT '';
