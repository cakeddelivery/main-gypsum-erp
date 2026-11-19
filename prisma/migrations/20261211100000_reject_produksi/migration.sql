-- Reject produksi per tahap di laporan shift (aditif) + akun Beban Reject Produksi
CREATE TABLE "ProductionReject" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "ref" TEXT,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductionReject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductionReject_reportId_idx" ON "ProductionReject"("reportId");
CREATE INDEX "ProductionReject_divisionId_stage_idx" ON "ProductionReject"("divisionId", "stage");

INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1830', 'Beban Reject Produksi', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1830');
