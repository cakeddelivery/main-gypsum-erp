-- AlterEnum
ALTER TYPE "PayrollKind" ADD VALUE 'TUNJANGAN';

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "hppFactor" DECIMAL(14,4) NOT NULL DEFAULT 1,
ADD COLUMN     "hppUnit" TEXT,
ADD COLUMN     "lastCost" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lastCostAt" TIMESTAMP(3),
ADD COLUMN     "prevCost" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "allowance" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "allowanceDetail" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "EmployeeAllowance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeAllowance_employeeId_idx" ON "EmployeeAllowance"("employeeId");

-- AddForeignKey
ALTER TABLE "EmployeeAllowance" ADD CONSTRAINT "EmployeeAllowance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: tanggal tunjangan, tanggal go-live (aplikasi mulai dipakai), harga beli terakhir awal = harga rata-rata
INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES
  ('allowance_payday', '15', now()),
  ('go_live_date', '2026-10-29', now())
ON CONFLICT ("key") DO NOTHING;

UPDATE "Item" SET "lastCost" = "avgCost", "prevCost" = "avgCost" WHERE "lastCost" = 0 AND "avgCost" > 0;
