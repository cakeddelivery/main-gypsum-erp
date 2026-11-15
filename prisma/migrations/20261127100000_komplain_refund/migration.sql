-- Komplain pembeli & refund (kirim ganti / refund disetujui & dibayar Finance).
-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('DIAJUKAN', 'DISETUJUI', 'DIBAYAR', 'DIKIRIM', 'SELESAI', 'DITOLAK');


-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "marketplace" TEXT,
    "courier" TEXT,
    "trackingNo" TEXT,
    "orderNo" TEXT,
    "city" TEXT,
    "province" TEXT,
    "issueType" TEXT NOT NULL,
    "description" TEXT,
    "solution" TEXT NOT NULL,
    "bundleNext" BOOLEAN NOT NULL DEFAULT false,
    "refundAmount" BIGINT NOT NULL DEFAULT 0,
    "payeeBank" TEXT,
    "payeeAccount" TEXT,
    "payeeName" TEXT,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'DIAJUKAN',
    "labelRead" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "payBankAccountId" TEXT,
    "payJournalId" TEXT,
    "proofPath" TEXT,
    "proofMime" TEXT,
    "proofSentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "sendJournalId" TEXT,
    "sendRef" TEXT,
    "replacementValue" BIGINT NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintLine" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "labelSku" TEXT,
    "labelName" TEXT,
    "itemId" TEXT,
    "qty" INTEGER NOT NULL,
    "sendQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ComplaintLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintMedia" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_number_key" ON "Complaint"("number");

-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- CreateIndex
CREATE INDEX "Complaint_date_idx" ON "Complaint"("date");

-- CreateIndex
CREATE INDEX "Complaint_trackingNo_idx" ON "Complaint"("trackingNo");

-- CreateIndex
CREATE INDEX "ComplaintMedia_complaintId_idx" ON "ComplaintMedia"("complaintId");

-- AddForeignKey
ALTER TABLE "ComplaintLine" ADD CONSTRAINT "ComplaintLine_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintLine" ADD CONSTRAINT "ComplaintLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintMedia" ADD CONSTRAINT "ComplaintMedia_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 6-1820 Beban Garansi & Penggantian Barang: barang pengganti komplain yang keluar dari stok (aman dijalankan ulang)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1820', 'Beban Garansi & Penggantian Barang', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1820');

