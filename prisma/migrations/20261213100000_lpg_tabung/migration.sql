-- Tabung LPG 5 kg: status per shift Oven + isi ulang menunggu transaksi Finance (aditif)
CREATE TABLE "LpgState" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "penuh" INTEGER NOT NULL,
    "aktif" INTEGER NOT NULL,
    "kosong" INTEGER NOT NULL,
    "isiUlang" INTEGER NOT NULL DEFAULT 0,
    "dipasang" INTEGER NOT NULL DEFAULT 0,
    "habis" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "picName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LpgState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LpgState_reportId_key" ON "LpgState"("reportId");
CREATE INDEX "LpgState_date_idx" ON "LpgState"("date");

CREATE TABLE "LpgRefill" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "physicalDate" DATE NOT NULL,
    "tabung" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'MENUNGGU',
    "transactionId" TEXT,
    "amount" BIGINT,
    "pricePerTabung" BIGINT,
    "pairedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LpgRefill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LpgRefill_reportId_key" ON "LpgRefill"("reportId");
CREATE UNIQUE INDEX "LpgRefill_transactionId_key" ON "LpgRefill"("transactionId");
CREATE INDEX "LpgRefill_status_physicalDate_idx" ON "LpgRefill"("status", "physicalDate");
