-- Pembelian dalam pengiriman (bayar dulu / COD) + penerimaan barang, BPJS Ketenagakerjaan (info slip + kategori setoran)

CREATE TYPE "PurchaseDelivery" AS ENUM ('DITERIMA', 'MENUNGGU', 'SEBAGIAN', 'DITUTUP');
ALTER TABLE "Purchase" ADD COLUMN "delivery" "PurchaseDelivery" NOT NULL DEFAULT 'DITERIMA';
ALTER TABLE "Purchase" ADD COLUMN "cod" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Purchase" ADD COLUMN "prepaidUsed" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Purchase" ADD COLUMN "codPaid" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Purchase" ADD COLUMN "dueDate" TIMESTAMP(3);
ALTER TABLE "Purchase" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "PurchaseLine" ADD COLUMN "qtyReceived" DECIMAL(14,3) NOT NULL DEFAULT 0;
-- Pembelian lama: barang sudah diterima semua
UPDATE "PurchaseLine" SET "qtyReceived" = "qty";

CREATE TABLE "PurchaseReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "value" BIGINT NOT NULL,
    "fromPrepaid" BIGINT NOT NULL DEFAULT 0,
    "codPaid" BIGINT NOT NULL DEFAULT 0,
    "toPayable" BIGINT NOT NULL DEFAULT 0,
    "bankAccountId" TEXT,
    "payableId" TEXT,
    "journalId" TEXT,
    "shiftReceiptId" TEXT,
    "photoPath" TEXT,
    "photoMime" TEXT,
    "note" TEXT,
    "receivedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseReceipt_number_key" ON "PurchaseReceipt"("number");
CREATE UNIQUE INDEX "PurchaseReceipt_shiftReceiptId_key" ON "PurchaseReceipt"("shiftReceiptId");
CREATE INDEX "PurchaseReceipt_purchaseId_idx" ON "PurchaseReceipt"("purchaseId");
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BPJS Ketenagakerjaan
ALTER TABLE "Employee" ADD COLUMN "bpjsTk" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Employee" ADD COLUMN "bpjsTkAmount" BIGINT;
ALTER TABLE "Payslip" ADD COLUMN "bpjsCompany" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "FinanceTransaction" ADD COLUMN "bpjsEmployeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('bpjs_tk_amount', '28400', CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING;

-- Akun & kategori baru
INSERT INTO "CoaAccount" ("id", "code", "name", "type") VALUES
  (gen_random_uuid()::text, '1-1510', 'Uang Muka Pembelian (Barang Dalam Pengiriman)', 'ASET'),
  (gen_random_uuid()::text, '6-1120', 'Beban BPJS Ketenagakerjaan', 'BEBAN')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "TxCategory" ("id", "name", "direction", "coaAccountId", "keywords")
SELECT gen_random_uuid()::text, 'BPJS Ketenagakerjaan', 'KELUAR', a."id", 'bpjs,bpjs ketenagakerjaan,bpjstk,jamsostek,iuran bpjs'
FROM "CoaAccount" a WHERE a."code" = '6-1120' AND NOT EXISTS (SELECT 1 FROM "TxCategory" c WHERE c."name" = 'BPJS Ketenagakerjaan');
