-- Anomali stok/produksi (alert) — aditif
CREATE TABLE "StockAnomaly" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "value" BIGINT NOT NULL DEFAULT 0,
    "divisionId" TEXT,
    "itemId" TEXT,
    "reportId" TEXT,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BARU',
    "note" TEXT,
    "noteBy" TEXT,
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockAnomaly_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockAnomaly_key_key" ON "StockAnomaly"("key");
CREATE INDEX "StockAnomaly_status_date_idx" ON "StockAnomaly"("status", "date");
CREATE INDEX "StockAnomaly_type_date_idx" ON "StockAnomaly"("type", "date");
