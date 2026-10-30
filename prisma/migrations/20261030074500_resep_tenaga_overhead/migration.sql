-- AlterTable
ALTER TABLE "BomLine" ADD COLUMN     "useUnit" TEXT;


-- AlterTable
ALTER TABLE "ItemRecipeLine" ADD COLUMN     "useUnit" TEXT;

-- AlterTable
ALTER TABLE "Overhead" ADD COLUMN     "outputPerMonth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT;
ALTER TABLE "Product" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "category" TEXT,
ADD COLUMN     "extraPackaging" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RecipeLabor" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "productId" TEXT,
    "taskId" TEXT,
    "name" TEXT NOT NULL,
    "rate" BIGINT NOT NULL,

    CONSTRAINT "RecipeLabor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeOverhead" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "productId" TEXT,
    "overheadId" TEXT NOT NULL,
    "factor" DECIMAL(10,4) NOT NULL DEFAULT 1,

    CONSTRAINT "RecipeOverhead_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RecipeLabor" ADD CONSTRAINT "RecipeLabor_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLabor" ADD CONSTRAINT "RecipeLabor_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLabor" ADD CONSTRAINT "RecipeLabor_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOverhead" ADD CONSTRAINT "RecipeOverhead_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOverhead" ADD CONSTRAINT "RecipeOverhead_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOverhead" ADD CONSTRAINT "RecipeOverhead_overheadId_fkey" FOREIGN KEY ("overheadId") REFERENCES "Overhead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Upah per unit yang sudah diisi pindah ke baris tenaga kerja resep
INSERT INTO "RecipeLabor" ("id", "itemId", "name", "rate")
SELECT 'rl_i_' || "id", "id", 'Tenaga Kerja', "laborCost" FROM "Item" WHERE "laborCost" > 0;
INSERT INTO "RecipeLabor" ("id", "productId", "name", "rate")
SELECT 'rl_p_' || "id", "id", 'Tenaga Kerja', "laborCost" FROM "Product" WHERE "laborCost" > 0;
UPDATE "Product" SET "laborCost" = 0 WHERE "laborCost" > 0;

-- AlterTable
ALTER TABLE "Item" DROP COLUMN "laborCost",
DROP COLUMN "overheadCost";
