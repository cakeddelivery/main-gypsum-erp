-- Neraca stok per barang per shift (aditif)
CREATE TABLE "ShiftBalance" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "opening" DECIMAL(14,3) NOT NULL,
    "inProduksi" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "inMasuk" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "inBorongan" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "inLain" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "outPakai" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "outBorongan" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "outJual" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "outReject" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "outLain" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "systemClosing" DECIMAL(14,3) NOT NULL,
    "counted" DECIMAL(14,3),
    "diff" DECIMAL(14,3),
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "picName" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftBalance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShiftBalance_reportId_itemId_key" ON "ShiftBalance"("reportId", "itemId");
CREATE INDEX "ShiftBalance_divisionId_computedAt_idx" ON "ShiftBalance"("divisionId", "computedAt");
