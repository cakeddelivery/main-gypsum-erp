-- Pengakhiran kontrak (aditif)
CREATE TYPE "TerminationReason" AS ENUM ('RESIGN', 'PELANGGARAN_BERAT', 'KONTRAK_HABIS', 'DIPUTUS_PERUSAHAAN');
CREATE TYPE "TerminationStatus" AS ENUM ('DRAFT', 'DITERBITKAN', 'BATAL');
CREATE TABLE "Termination" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "contractId" TEXT,
    "employeeId" TEXT NOT NULL,
    "reason" "TerminationReason" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "note" TEXT,
    "evidencePath" TEXT,
    "calc" JSONB NOT NULL,
    "status" "TerminationStatus" NOT NULL DEFAULT 'DRAFT',
    "contentHash" TEXT,
    "verifyCode" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "issuedById" TEXT,
    CONSTRAINT "Termination_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Termination_number_key" ON "Termination"("number");
CREATE UNIQUE INDEX "Termination_verifyCode_key" ON "Termination"("verifyCode");
CREATE INDEX "Termination_employeeId_status_idx" ON "Termination"("employeeId", "status");
ALTER TABLE "Termination" ADD CONSTRAINT "Termination_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
