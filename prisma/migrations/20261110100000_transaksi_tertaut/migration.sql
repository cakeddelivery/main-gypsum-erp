-- Baris Transaksi tertaut dari menu lain (tanpa jurnal kedua) + daftar "bukan duplikat" + usulan kategori bot
ALTER TABLE "FinanceTransaction" ADD COLUMN "origin" TEXT;
ALTER TABLE "FinanceTransaction" ADD COLUMN "originRef" TEXT;
ALTER TABLE "FinanceTransaction" ADD COLUMN "dupAckIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "FinanceTransaction_origin_idx" ON "FinanceTransaction"("origin");

CREATE TABLE "CategoryProposal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "TxDirection" NOT NULL,
    "coaType" "AccountType" NOT NULL,
    "parentCoaId" TEXT,
    "keywords" TEXT NOT NULL DEFAULT '',
    "transactionId" TEXT,
    "chatId" TEXT,
    "proposedById" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'MENUNGGU',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategoryProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CategoryProposal_status_idx" ON "CategoryProposal"("status");
