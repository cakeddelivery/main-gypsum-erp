-- Alur lapangan: rekap telat di slip, tanda absen pulang sebelum laporan shift terkirim,
-- barang masuk di laporan shift, stok akhir hasil (patung kering / produk jadi per karakter)
ALTER TABLE "Attendance" ADD COLUMN "reportMissing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payslip" ADD COLUMN "lateCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "lateMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShiftReport" ADD COLUMN "resultApplied" JSONB;

CREATE TABLE "ShiftReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "supplierName" TEXT,
    "photoPath" TEXT,
    "photoMime" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "purchaseId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShiftReceipt_number_key" ON "ShiftReceipt"("number");
CREATE INDEX "ShiftReceipt_itemId_purchaseId_idx" ON "ShiftReceipt"("itemId", "purchaseId");
ALTER TABLE "ShiftReceipt" ADD CONSTRAINT "ShiftReceipt_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ShiftReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftReceipt" ADD CONSTRAINT "ShiftReceipt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftReceipt" ADD CONSTRAINT "ShiftReceipt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
