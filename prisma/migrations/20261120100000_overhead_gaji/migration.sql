-- Overhead "Gaji Produksi" otomatis dari gaji karyawan (gaji pokok + tunjangan + BPJS TK)
ALTER TABLE "Overhead" ADD COLUMN "autoSalary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Overhead" ADD COLUMN "salaryDivisionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Overhead" ADD COLUMN "autoUpdatedAt" TIMESTAMP(3);
