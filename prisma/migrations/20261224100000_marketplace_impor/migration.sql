-- CreateTable
CREATE TABLE "MarketplaceImport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "stats" JSONB,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,

    CONSTRAINT "MarketplaceImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceChange" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "before" JSONB NOT NULL,

    CONSTRAINT "MarketplaceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rawStatus" TEXT,
    "rawSubstatus" TEXT,
    "rawReturn" TEXT,
    "cancelReason" TEXT,
    "status" TEXT NOT NULL,
    "complaint" BOOLEAN NOT NULL DEFAULT false,
    "complaintNote" TEXT,
    "trackingNo" TEXT,
    "shipOption" TEXT,
    "courier" TEXT,
    "paymentMethod" TEXT,
    "city" TEXT,
    "province" TEXT,
    "creatorHandle" TEXT,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "shippingPaid" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "refundAmount" BIGINT NOT NULL DEFAULT 0,
    "returnQty" INTEGER NOT NULL DEFAULT 0,
    "sig" TEXT,
    "importId" TEXT NOT NULL,
    "lastImportId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "incomeId" TEXT,
    "invoiceId" TEXT,
    "returnCaseId" TEXT,
    "complaintId" TEXT,

    CONSTRAINT "MarketplaceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT,
    "variation" TEXT,
    "skuKey" TEXT NOT NULL,
    "name" TEXT,
    "qty" INTEGER NOT NULL,
    "unitPrice" BIGINT NOT NULL DEFAULT 0,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "returnQty" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MarketplaceOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceIncome" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ORDER',
    "refNo" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "released" BIGINT NOT NULL DEFAULT 0,
    "productAmt" BIGINT NOT NULL DEFAULT 0,
    "refundAmt" BIGINT NOT NULL DEFAULT 0,
    "fees" BIGINT NOT NULL DEFAULT 0,
    "feeDetail" JSONB,
    "sig" TEXT,
    "importId" TEXT NOT NULL,
    "lastImportId" TEXT NOT NULL,

    CONSTRAINT "MarketplaceIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceWithdrawal" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "txType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT,
    "importId" TEXT NOT NULL,

    CONSTRAINT "MarketplaceWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSkuClass" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "variant" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSkuClass_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "MarketplaceImport_createdAt_idx" ON "MarketplaceImport"("createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceChange_importId_idx" ON "MarketplaceChange"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceOrder_incomeId_key" ON "MarketplaceOrder"("incomeId");

-- CreateIndex
CREATE INDEX "MarketplaceOrder_orderedAt_idx" ON "MarketplaceOrder"("orderedAt");

-- CreateIndex
CREATE INDEX "MarketplaceOrder_trackingNo_idx" ON "MarketplaceOrder"("trackingNo");

-- CreateIndex
CREATE INDEX "MarketplaceOrder_importId_idx" ON "MarketplaceOrder"("importId");

-- CreateIndex
CREATE INDEX "MarketplaceOrder_status_idx" ON "MarketplaceOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceOrder_storeId_channel_orderNo_key" ON "MarketplaceOrder"("storeId", "channel", "orderNo");

-- CreateIndex
CREATE INDEX "MarketplaceOrderLine_orderId_idx" ON "MarketplaceOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "MarketplaceOrderLine_skuKey_idx" ON "MarketplaceOrderLine"("skuKey");

-- CreateIndex
CREATE INDEX "MarketplaceIncome_releasedAt_idx" ON "MarketplaceIncome"("releasedAt");

-- CreateIndex
CREATE INDEX "MarketplaceIncome_importId_idx" ON "MarketplaceIncome"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceIncome_storeId_channel_kind_refNo_key" ON "MarketplaceIncome"("storeId", "channel", "kind", "refNo");

-- CreateIndex
CREATE INDEX "MarketplaceWithdrawal_requestedAt_idx" ON "MarketplaceWithdrawal"("requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceWithdrawal_storeId_channel_txType_refId_key" ON "MarketplaceWithdrawal"("storeId", "channel", "txType", "refId");

-- AddForeignKey
ALTER TABLE "MarketplaceChange" ADD CONSTRAINT "MarketplaceChange_importId_fkey" FOREIGN KEY ("importId") REFERENCES "MarketplaceImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOrder" ADD CONSTRAINT "MarketplaceOrder_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "MarketplaceIncome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOrderLine" ADD CONSTRAINT "MarketplaceOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketplaceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

