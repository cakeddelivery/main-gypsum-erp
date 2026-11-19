-- Sample affiliator per platform + toko di laporan Packing/Giftbox (aditif) + akun Beban Promosi & Sample
CREATE TABLE "AffiliateSample" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "platform" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "ref" TEXT,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AffiliateSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AffiliateSample_reportId_idx" ON "AffiliateSample"("reportId");
CREATE INDEX "AffiliateSample_platform_storeId_date_idx" ON "AffiliateSample"("platform", "storeId", "date");

INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
SELECT gen_random_uuid()::text, '6-1840', 'Beban Promosi & Sample Affiliator', 'BEBAN', false, true
WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '6-1840');
