-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPERVISOR';

-- AlterTable
ALTER TABLE "Division" ADD COLUMN     "checklist" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "reportTemplate" TEXT,
ADD COLUMN     "shiftCount" INTEGER NOT NULL DEFAULT 1;

-- Saat ini hanya divisi cetak & oven (Produksi) yang punya 2 shift
UPDATE "Division" SET "shiftCount" = 2 WHERE "code" IN ('CTK', 'OVN', 'PRD') OR "name" ILIKE '%cetak%' OR "name" ILIKE '%oven%' OR "name" ILIKE '%produksi%';

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "divisionId" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShiftReport" ADD COLUMN     "picName" TEXT,
ADD COLUMN     "stockApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stockCount" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "work" JSONB NOT NULL DEFAULT '{}';

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;
