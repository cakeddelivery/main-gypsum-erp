-- Tunjangan per orang dengan tanggal bayar sendiri (data lama tetap tgl 15) & potongan Alpa di slip. Hanya ADD COLUMN.
ALTER TABLE "EmployeeAllowance" ADD COLUMN "payDay" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Payslip" ADD COLUMN "alpaDeduction" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "alpaDetail" JSONB NOT NULL DEFAULT '[]';
