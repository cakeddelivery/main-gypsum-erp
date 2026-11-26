-- Entri hasil panen Oven realtime (hanya ADD)
CREATE TABLE "ShiftHarvest" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "oven" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "good" INTEGER NOT NULL,
    "reject" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "replacesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftHarvest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShiftHarvest_reportId_idx" ON "ShiftHarvest"("reportId");
ALTER TABLE "ShiftHarvest" ADD CONSTRAINT "ShiftHarvest_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ShiftReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
