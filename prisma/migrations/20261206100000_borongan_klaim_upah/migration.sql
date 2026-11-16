-- Klaim upah borongan per titik (aditif: tabel, kolom, dan enum baru).


-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('MENUNGGU', 'DIBAYAR', 'DITOLAK');

-- AlterTable
ALTER TABLE "BoronganResult" ADD COLUMN     "claimId" TEXT;

-- CreateTable
CREATE TABLE "BoronganClaim" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'MENUNGGU',
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "total" BIGINT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "settlementId" TEXT,

    CONSTRAINT "BoronganClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoronganClaim_number_key" ON "BoronganClaim"("number");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganClaim_settlementId_key" ON "BoronganClaim"("settlementId");

-- CreateIndex
CREATE INDEX "BoronganClaim_pointId_status_idx" ON "BoronganClaim"("pointId", "status");

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "BoronganClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganClaim" ADD CONSTRAINT "BoronganClaim_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganClaim" ADD CONSTRAINT "BoronganClaim_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "BoronganSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

