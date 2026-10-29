-- CreateEnum
CREATE TYPE "PayrollKind" AS ENUM ('PERIODE', 'BULANAN', 'BORONGAN');

-- CreateEnum
CREATE TYPE "PayableKind" AS ENUM ('USAHA', 'PINJAMAN');

-- CreateEnum
CREATE TYPE "PaymentTerm" AS ENUM ('LUNAS', 'BERTAHAP', 'TEMPO');

-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'LIBUR';

-- AlterEnum
ALTER TYPE "WageType" ADD VALUE 'BULANAN';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "monthlySalary" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "resignDate" DATE;

-- AlterTable
ALTER TABLE "Payable" ADD COLUMN     "kind" "PayableKind" NOT NULL DEFAULT 'USAHA';

-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "kind" "PayrollKind" NOT NULL DEFAULT 'PERIODE',
ADD COLUMN     "payDate" DATE;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "absentDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "baseSalary" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "offDays" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PieceTask" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratePerPcs" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PieceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PieceWork" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "qty" INTEGER NOT NULL,
    "rate" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "note" TEXT,
    "periodId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PieceWork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT,
    "vendor" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "term" "PaymentTerm" NOT NULL,
    "total" BIGINT NOT NULL,
    "paidNow" BIGINT NOT NULL DEFAULT 0,
    "bankAccountId" TEXT,
    "payableId" TEXT,
    "journalId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseLine" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "PurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PieceTask_code_key" ON "PieceTask"("code");

-- CreateIndex
CREATE INDEX "PieceWork_employeeId_periodId_idx" ON "PieceWork"("employeeId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_number_key" ON "Purchase"("number");

-- AddForeignKey
ALTER TABLE "PieceWork" ADD CONSTRAINT "PieceWork_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceWork" ADD CONSTRAINT "PieceWork_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceWork" ADD CONSTRAINT "PieceWork_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "advanceDeduction" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "advanceDetail" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "CashAdvance" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "installment" BIGINT NOT NULL DEFAULT 0,
    "repaid" BIGINT NOT NULL DEFAULT 0,
    "paidFromAccountId" TEXT NOT NULL,
    "note" TEXT,
    "journalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashAdvance_number_key" ON "CashAdvance"("number");

-- CreateIndex
CREATE INDEX "CashAdvance_employeeId_idx" ON "CashAdvance"("employeeId");

-- AddForeignKey
ALTER TABLE "CashAdvance" ADD CONSTRAINT "CashAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ReserveKind" AS ENUM ('OWNER', 'LOAN_SAVING', 'LOAN_PAYMENT');

-- CreateTable
CREATE TABLE "ReserveFund" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ReserveKind" NOT NULL,
    "dailyAmount" BIGINT NOT NULL,
    "fromBankId" TEXT NOT NULL,
    "toBankId" TEXT,
    "payableId" TEXT,
    "storeId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveEntry" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "journalId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReserveEntry_fundId_date_idx" ON "ReserveEntry"("fundId", "date");

-- AddForeignKey
ALTER TABLE "ReserveEntry" ADD CONSTRAINT "ReserveEntry_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "ReserveFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data awal aturan bisnis (aman untuk database yang sudah berjalan)
INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active") VALUES
  (gen_random_uuid()::text, '1-1310', 'Piutang Karyawan (Kasbon)', 'ASET', false, true),
  (gen_random_uuid()::text, '2-1210', 'Utang Kompensasi Pengelola (Owner)', 'KEWAJIBAN', false, true),
  (gen_random_uuid()::text, '2-1400', 'Utang Pinjaman Modal', 'KEWAJIBAN', false, true),
  (gen_random_uuid()::text, '6-1150', 'Beban Kompensasi Pengelola (Owner)', 'BEBAN', false, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "PieceTask" ("id", "code", "name", "ratePerPcs", "active") VALUES
  (gen_random_uuid()::text, 'CAT_GIFTBOX', 'Cat giftbox', 100, true),
  (gen_random_uuid()::text, 'CAT_PLASTIK', 'Cat plastik', 15, true),
  (gen_random_uuid()::text, 'ASSEMBLING', 'Assembling', 60, true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES
  ('payday_offset_days', '7', now()),
  ('weekly_off_quota', '1', now()),
  ('monthly_workdays', '26', now())
ON CONFLICT ("key") DO NOTHING;

-- Sisihan harian kompensasi owner: Rp100 rb/hari per owner (Rp3 jt/bulan), Seabank -> ShopeePay
INSERT INTO "ReserveFund" ("id", "name", "kind", "dailyAmount", "fromBankId", "toBankId", "storeId", "active")
SELECT gen_random_uuid()::text, o.name, 'OWNER', 100000, sb.id, sp.id, st.value, true
FROM (VALUES ('Kompensasi Pengelola - Cak Ed'), ('Kompensasi Pengelola - Jojo')) AS o(name)
JOIN "BankAccount" sb ON sb.code = 'SEABANK'
JOIN "BankAccount" sp ON sp.code = 'SHOPEEPAY'
JOIN "Setting" st ON st.key = 'default_store_id'
WHERE NOT EXISTS (SELECT 1 FROM "ReserveFund" WHERE "kind" = 'OWNER');
