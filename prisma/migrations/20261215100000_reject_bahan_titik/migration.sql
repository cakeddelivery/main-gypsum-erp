-- Reject bahan pendukung di titik borongan (aditif)
CREATE TABLE "BoronganMaterialReject" (
    "id" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BoronganMaterialReject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BoronganMaterialReject_pointId_createdAt_idx" ON "BoronganMaterialReject"("pointId", "createdAt");
CREATE INDEX "BoronganMaterialReject_itemId_idx" ON "BoronganMaterialReject"("itemId");
