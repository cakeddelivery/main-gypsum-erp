-- Invoice bernomor resmi (aditif)
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "storeCode" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "yymm" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "storeId" TEXT NOT NULL,
    "saleId" TEXT,
    "customerName" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "shipping" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_saleId_key" ON "Invoice"("saleId");
CREATE INDEX "Invoice_date_idx" ON "Invoice"("date");
CREATE INDEX "Invoice_storeCode_channel_yymm_idx" ON "Invoice"("storeCode", "channel", "yymm");
