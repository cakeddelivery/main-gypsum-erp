-- Penerimaan hasil borongan oleh divisi (total per barang, gabungan titik)
-- CreateTable
CREATE TABLE "BoronganReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelBy" TEXT,

    CONSTRAINT "BoronganReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reject" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "BoronganReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoronganReceipt_number_key" ON "BoronganReceipt"("number");

-- CreateIndex
CREATE INDEX "BoronganReceipt_divisionId_date_idx" ON "BoronganReceipt"("divisionId", "date");

-- CreateIndex
CREATE INDEX "BoronganReceiptLine_itemId_pointId_idx" ON "BoronganReceiptLine"("itemId", "pointId");

-- AddForeignKey
ALTER TABLE "BoronganReceipt" ADD CONSTRAINT "BoronganReceipt_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganReceiptLine" ADD CONSTRAINT "BoronganReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "BoronganReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganReceiptLine" ADD CONSTRAINT "BoronganReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganReceiptLine" ADD CONSTRAINT "BoronganReceiptLine_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

