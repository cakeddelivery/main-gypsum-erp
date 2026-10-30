-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "laborCost" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "overheadCost" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "adsPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "affiliatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "itemsPerOrder" DECIMAL(6,2) NOT NULL DEFAULT 1,
ADD COLUMN     "targetMargin" DECIMAL(5,2) NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "ItemRecipeLine" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "ItemRecipeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Overhead" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyAmount" BIGINT NOT NULL,
    "assetCost" BIGINT,
    "lifeMonths" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Overhead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemRecipeLine_itemId_componentId_key" ON "ItemRecipeLine"("itemId", "componentId");

-- AddForeignKey
ALTER TABLE "ItemRecipeLine" ADD CONSTRAINT "ItemRecipeLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRecipeLine" ADD CONSTRAINT "ItemRecipeLine_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Biaya marketplace (persen dari harga + biaya pesanan flat per pesanan) dan kapasitas produksi untuk overhead per pcs
INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES
  ('marketplace_fees', '{"SHOPEE":{"fees":[{"name":"Biaya Admin","pct":8.25},{"name":"Biaya Gratis Ongkir Xtra","pct":6}],"perOrder":1250},"TIKTOK_SHOP":{"fees":[{"name":"Komisi Platform","pct":9.5},{"name":"Komisi Dinamis","pct":8}],"perOrder":1250}}', NOW()),
  ('overhead_capacity_pcs', '0', NOW())
ON CONFLICT ("key") DO NOTHING;
