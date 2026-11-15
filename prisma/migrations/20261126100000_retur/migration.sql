-- Retur paket marketplace (video unboxing). Data pribadi pembeli tidak disimpan: hanya kota/kab + provinsi.
-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('DITERIMA', 'DIPERIKSA', 'KLAIM_DIAJUKAN', 'KLAIM_CAIR', 'KLAIM_DITOLAK', 'SELESAI');

-- CreateEnum
CREATE TYPE "ReturnMediaKind" AS ENUM ('VIDEO', 'THUMB', 'FRAME', 'DAMAGE');

-- CreateEnum
CREATE TYPE "ReturnMediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateTable
CREATE TABLE "ReturnCase" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "marketplace" TEXT,
    "courier" TEXT,
    "trackingNo" TEXT NOT NULL,
    "orderNo" TEXT,
    "city" TEXT,
    "province" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "storeId" TEXT,
    "status" "ReturnStatus" NOT NULL DEFAULT 'DITERIMA',
    "labelRead" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inspectedAt" TIMESTAMP(3),
    "inspectedBy" TEXT,
    "inspectJournalId" TEXT,
    "inspectRef" TEXT,
    "goodValue" BIGINT NOT NULL DEFAULT 0,
    "lossValue" BIGINT NOT NULL DEFAULT 0,
    "claimAmount" BIGINT NOT NULL DEFAULT 0,
    "claimAt" TIMESTAMP(3),
    "claimNote" TEXT,
    "claimPaidAmount" BIGINT NOT NULL DEFAULT 0,
    "claimPaidAt" TIMESTAMP(3),
    "claimBankAccountId" TEXT,
    "claimJournalId" TEXT,
    "claimRejectedAt" TIMESTAMP(3),
    "claimRejectReason" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "ReturnCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "labelSku" TEXT,
    "labelVariation" TEXT,
    "labelName" TEXT,
    "qty" INTEGER NOT NULL,
    "itemId" TEXT,
    "goodQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnMedia" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "lineId" TEXT,
    "kind" "ReturnMediaKind" NOT NULL,
    "status" "ReturnMediaStatus" NOT NULL DEFAULT 'READY',
    "storageKey" TEXT,
    "mime" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER,
    "recordedAt" TIMESTAMP(3),
    "meta" JSONB,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ReturnMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSkuMap" (
    "key" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSkuMap_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnCase_number_key" ON "ReturnCase"("number");

-- CreateIndex
CREATE INDEX "ReturnCase_trackingNo_idx" ON "ReturnCase"("trackingNo");

-- CreateIndex
CREATE INDEX "ReturnCase_status_idx" ON "ReturnCase"("status");

-- CreateIndex
CREATE INDEX "ReturnCase_receivedAt_idx" ON "ReturnCase"("receivedAt");

-- CreateIndex
CREATE INDEX "ReturnMedia_returnId_idx" ON "ReturnMedia"("returnId");

-- CreateIndex
CREATE INDEX "ReturnMedia_status_idx" ON "ReturnMedia"("status");

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMedia" ADD CONSTRAINT "ReturnMedia_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceSkuMap" ADD CONSTRAINT "MarketplaceSkuMap_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Akun & kategori (aman dijalankan ulang):
-- 6-1810 Kerugian Barang Retur Rusak: nilai barang retur rusak dipindah dari HPP (jurnal hasil periksa retur)
-- 4-9200 Pendapatan Klaim Marketplace (sub 4-9000) + kategori pemasukan "Klaim Retur Marketplace"
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1810', 'Kerugian Barang Retur Rusak', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1810');

INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active", "parentId")
SELECT gen_random_uuid()::text, '4-9200', 'Pendapatan Klaim Marketplace', 'PENDAPATAN', false, true, (SELECT "id" FROM "CoaAccount" WHERE "code" = '4-9000')
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '4-9200');

INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords", "active")
SELECT gen_random_uuid()::text, 'Klaim Retur Marketplace', 'MASUK', c."id", 'klaim retur,klaim shopee,klaim tiktok,kompensasi retur,klaim paket', true
FROM "CoaAccount" c WHERE c."code" = '4-9200'
  AND NOT EXISTS (SELECT 1 FROM "TxCategory" t WHERE t."name" = 'Klaim Retur Marketplace');
