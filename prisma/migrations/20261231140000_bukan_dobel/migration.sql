-- Tabel baru (ADD-only): pasangan kandidat dobel yang dinyatakan bukan dobel
CREATE TABLE "DuplicateDismissal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyA" TEXT NOT NULL,
    "keyB" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DuplicateDismissal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DuplicateDismissal_kind_keyA_keyB_key" ON "DuplicateDismissal"("kind", "keyA", "keyB");

-- Dikonfirmasi owner: TRX-202611-0008 dan TRX-202611-0010 adalah dua transaksi berbeda (hanya bila keduanya ada)
INSERT INTO "DuplicateDismissal" ("id", "kind", "keyA", "keyB", "reason", "createdBy")
SELECT gen_random_uuid()::text, 'FINANCE_TX', 'TRX-202611-0008', 'TRX-202611-0010', 'Dikonfirmasi owner: transaksi berbeda', 'migrasi'
WHERE EXISTS (SELECT 1 FROM "FinanceTransaction" WHERE "number" = 'TRX-202611-0008')
  AND EXISTS (SELECT 1 FROM "FinanceTransaction" WHERE "number" = 'TRX-202611-0010')
ON CONFLICT DO NOTHING;
