-- AlterTable
ALTER TABLE "MarketplaceChange" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "undone" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MarketplaceOrder" ADD COLUMN     "affiliate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "needsCheck" TEXT;

-- CreateTable
CREATE TABLE "MarketplaceFeeMap" (
    "platform" TEXT NOT NULL,
    "column" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceFeeMap_pkey" PRIMARY KEY ("platform","column")
);

-- CreateIndex
CREATE INDEX "MarketplaceChange_rowId_idx" ON "MarketplaceChange"("rowId");

