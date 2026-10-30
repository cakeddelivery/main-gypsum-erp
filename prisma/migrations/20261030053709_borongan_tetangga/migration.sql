-- CreateEnum
CREATE TYPE "BoronganRole" AS ENUM ('PEKERJA', 'KOORDINATOR', 'DRIVER');

-- CreateEnum
CREATE TYPE "HandoverKind" AS ENUM ('KIRIM', 'KEMBALI');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('DIKIRIM', 'DITERIMA', 'DIBATALKAN');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'KOORDINATOR';

-- AlterTable
ALTER TABLE "PieceTask" ADD COLUMN     "coordinatorRate" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "driverRate" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "outputItemId" TEXT,
ADD COLUMN     "workerRate" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PieceTaskInput" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "PieceTaskInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganPoint" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganPerson" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "BoronganRole" NOT NULL,
    "pointId" TEXT,
    "userId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganHandover" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "HandoverKind" NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'DIKIRIM',
    "pointId" TEXT NOT NULL,
    "driverId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganHandoverLine" (
    "id" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "BoronganHandoverLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganResult" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "coordinatorId" TEXT,
    "driverId" TEXT,
    "taskId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "qty" INTEGER NOT NULL,
    "workerRate" BIGINT NOT NULL,
    "coordinatorRate" BIGINT NOT NULL,
    "driverRate" BIGINT NOT NULL,
    "note" TEXT,
    "settlementId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganSettlement" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "upTo" DATE NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "total" BIGINT NOT NULL,
    "journalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoronganPoint_code_key" ON "BoronganPoint"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganPoint_locationId_key" ON "BoronganPoint"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganPerson_userId_key" ON "BoronganPerson"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganHandover_number_key" ON "BoronganHandover"("number");

-- CreateIndex
CREATE INDEX "BoronganHandover_pointId_status_idx" ON "BoronganHandover"("pointId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganResult_number_key" ON "BoronganResult"("number");

-- CreateIndex
CREATE INDEX "BoronganResult_pointId_settlementId_idx" ON "BoronganResult"("pointId", "settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganSettlement_number_key" ON "BoronganSettlement"("number");

-- AddForeignKey
ALTER TABLE "PieceTask" ADD CONSTRAINT "PieceTask_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceTaskInput" ADD CONSTRAINT "PieceTaskInput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PieceTaskInput" ADD CONSTRAINT "PieceTaskInput_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPoint" ADD CONSTRAINT "BoronganPoint_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPerson" ADD CONSTRAINT "BoronganPerson_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPerson" ADD CONSTRAINT "BoronganPerson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganHandover" ADD CONSTRAINT "BoronganHandover_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganHandover" ADD CONSTRAINT "BoronganHandover_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganHandoverLine" ADD CONSTRAINT "BoronganHandoverLine_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "BoronganHandover"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganHandoverLine" ADD CONSTRAINT "BoronganHandoverLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BoronganPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_coordinatorId_fkey" FOREIGN KEY ("coordinatorId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "BoronganSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganSettlement" ADD CONSTRAINT "BoronganSettlement_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data awal: lokasi driver & dua titik borongan (BMR, Mastrip)
INSERT INTO "Location" ("id", "code", "name") VALUES
  ('loc_borongan_drv', 'DRV', 'Driver Borongan (Dalam Perjalanan)'),
  ('loc_borongan_bmr', 'BMR', 'Titik Borongan BMR'),
  ('loc_borongan_mst', 'MST', 'Titik Borongan Mastrip')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "BoronganPoint" ("id", "code", "name", "locationId")
SELECT 'bpt_' || l."code", l."code", CASE l."code" WHEN 'BMR' THEN 'BMR' ELSE 'Mastrip' END, l."id"
FROM "Location" l WHERE l."code" IN ('BMR', 'MST')
ON CONFLICT DO NOTHING;

INSERT INTO "Setting" ("key", "value", "updatedAt")
SELECT 'loc_borongan_driver', "id", NOW() FROM "Location" WHERE "code" = 'DRV'
ON CONFLICT ("key") DO NOTHING;

-- Pembagian budget per pcs (pekerja / koordinator / driver)
UPDATE "PieceTask" SET "workerRate" = 80, "coordinatorRate" = 20, "driverRate" = 0, "ratePerPcs" = 100 WHERE "code" = 'CAT_GIFTBOX';
UPDATE "PieceTask" SET "workerRate" = 30, "coordinatorRate" = 15, "driverRate" = 15, "ratePerPcs" = 60 WHERE "code" = 'ASSEMBLING';
UPDATE "PieceTask" SET "workerRate" = 13, "coordinatorRate" = 2, "driverRate" = 0, "ratePerPcs" = 15 WHERE "code" = 'CAT_PLASTIK';
-- Tugas lain: seluruh budget untuk pekerja
UPDATE "PieceTask" SET "workerRate" = "ratePerPcs" WHERE "workerRate" + "coordinatorRate" + "driverRate" = 0;
