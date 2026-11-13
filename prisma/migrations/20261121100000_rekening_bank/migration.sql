-- Rekening gaji tidak lagi khusus Seabank: kolom diganti nama (data tetap) + kolom Nama Bank
ALTER TABLE "Employee" RENAME COLUMN "seabankNo" TO "bankAccountNo";
ALTER TABLE "Employee" RENAME COLUMN "seabankName" TO "bankAccountName";
ALTER TABLE "Employee" ADD COLUMN "bankName" TEXT;
UPDATE "Employee" SET "bankName" = 'SeaBank' WHERE "bankAccountNo" IS NOT NULL;

ALTER TABLE "EmployeeRegistration" RENAME COLUMN "seabankNo" TO "bankAccountNo";
ALTER TABLE "EmployeeRegistration" RENAME COLUMN "seabankName" TO "bankAccountName";
ALTER TABLE "EmployeeRegistration" ADD COLUMN "bankName" TEXT NOT NULL DEFAULT 'SeaBank';
