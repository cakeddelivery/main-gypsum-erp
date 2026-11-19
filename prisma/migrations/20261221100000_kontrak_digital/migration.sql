-- Kontrak kerja digital (aditif)
ALTER TABLE "Employee" ADD COLUMN "nik" TEXT;

CREATE TYPE "ContractKind" AS ENUM ('PKWT', 'ADD');
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'HRD_TTD', 'AKTIF', 'BATAL');

CREATE TABLE "DocCounter" (
    "key" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DocCounter_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" "ContractKind" NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "employeeId" TEXT NOT NULL,
    "parentId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "months" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentHash" TEXT,
    "finalHash" TEXT,
    "verifyCode" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hrdSignedAt" TIMESTAMP(3),
    "hrdSignedBy" TEXT,
    "hrdSignedById" TEXT,
    "employeeSignature" TEXT,
    "employeeSignedAt" TIMESTAMP(3),
    "employeeDevice" TEXT,
    "lockedAt" TIMESTAMP(3),
    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Contract_number_key" ON "Contract"("number");
CREATE UNIQUE INDEX "Contract_verifyCode_key" ON "Contract"("verifyCode");
CREATE INDEX "Contract_employeeId_status_idx" ON "Contract"("employeeId", "status");
CREATE INDEX "Contract_parentId_idx" ON "Contract"("parentId");
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
