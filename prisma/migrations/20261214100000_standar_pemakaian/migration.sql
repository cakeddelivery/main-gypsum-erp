-- Standar pemakaian proses (AUTO median / MANUAL Owner), aditif
CREATE TABLE "UsageStandard" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'AUTO',
    "autoValue" DECIMAL(14,4),
    "manualValue" DECIMAL(14,4),
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3),
    "pinnedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsageStandard_pkey" PRIMARY KEY ("key")
);
