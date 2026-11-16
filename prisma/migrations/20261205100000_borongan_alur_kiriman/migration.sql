-- Alur borongan baru (kiriman KRM → pembagian → laporan hasil → pengambilan AMB → penerimaan divisi).
-- Aditif saja: tabel, kolom, dan nilai enum baru. Data alur lama (serah terima, setoran) tidak diubah.

-- CreateEnum
CREATE TYPE "ShipmentMode" AS ENUM ('DRIVER', 'LANGSUNG');

-- CreateEnum
CREATE TYPE "PickupStatus" AS ENUM ('DIBAWA', 'DITERIMA', 'KURANG', 'DIBATALKAN');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'DRIVER';

-- AlterTable
ALTER TABLE "BoronganResult" ADD COLUMN     "held" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pickupId" TEXT;

-- CreateTable
CREATE TABLE "BoronganShipment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "mode" "ShipmentMode" NOT NULL,
    "pointIds" TEXT[],
    "driverId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,

    CONSTRAINT "BoronganShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganShipmentTask" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "BoronganShipmentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganShipmentLine" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "support" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BoronganShipmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganAllot" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoronganAllot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganWorkReport" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoronganWorkReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganWorkReportLine" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "good" INTEGER NOT NULL,
    "reject" INTEGER NOT NULL,

    CONSTRAINT "BoronganWorkReportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganPickup" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "PickupStatus" NOT NULL DEFAULT 'DIBAWA',
    "driverId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "receivedById" TEXT,
    "holdNote" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,

    CONSTRAINT "BoronganPickup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganPickupLine" (
    "id" TEXT NOT NULL,
    "pickupId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reject" INTEGER NOT NULL DEFAULT 0,
    "done" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BoronganPickupLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoronganPickupCount" (
    "id" TEXT NOT NULL,
    "pickupId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "BoronganPickupCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoronganShipment_number_key" ON "BoronganShipment"("number");

-- CreateIndex
CREATE INDEX "BoronganShipment_date_idx" ON "BoronganShipment"("date");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganAllot_shipmentId_workerId_taskId_key" ON "BoronganAllot"("shipmentId", "workerId", "taskId");

-- CreateIndex
CREATE INDEX "BoronganWorkReport_shipmentId_pointId_createdAt_idx" ON "BoronganWorkReport"("shipmentId", "pointId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BoronganPickup_number_key" ON "BoronganPickup"("number");

-- CreateIndex
CREATE INDEX "BoronganPickup_shipmentId_idx" ON "BoronganPickup"("shipmentId");

-- CreateIndex
CREATE INDEX "BoronganPickup_status_idx" ON "BoronganPickup"("status");

-- CreateIndex
CREATE INDEX "BoronganResult_pickupId_idx" ON "BoronganResult"("pickupId");

-- AddForeignKey
ALTER TABLE "BoronganResult" ADD CONSTRAINT "BoronganResult_pickupId_fkey" FOREIGN KEY ("pickupId") REFERENCES "BoronganPickup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganShipment" ADD CONSTRAINT "BoronganShipment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganShipmentTask" ADD CONSTRAINT "BoronganShipmentTask_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "BoronganShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganShipmentTask" ADD CONSTRAINT "BoronganShipmentTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganShipmentLine" ADD CONSTRAINT "BoronganShipmentLine_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "BoronganShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganAllot" ADD CONSTRAINT "BoronganAllot_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "BoronganShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganAllot" ADD CONSTRAINT "BoronganAllot_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganAllot" ADD CONSTRAINT "BoronganAllot_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BoronganPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganAllot" ADD CONSTRAINT "BoronganAllot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganWorkReport" ADD CONSTRAINT "BoronganWorkReport_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "BoronganShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganWorkReport" ADD CONSTRAINT "BoronganWorkReport_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganWorkReportLine" ADD CONSTRAINT "BoronganWorkReportLine_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "BoronganWorkReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganWorkReportLine" ADD CONSTRAINT "BoronganWorkReportLine_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BoronganPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganWorkReportLine" ADD CONSTRAINT "BoronganWorkReportLine_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickup" ADD CONSTRAINT "BoronganPickup_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "BoronganShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickup" ADD CONSTRAINT "BoronganPickup_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupLine" ADD CONSTRAINT "BoronganPickupLine_pickupId_fkey" FOREIGN KEY ("pickupId") REFERENCES "BoronganPickup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupLine" ADD CONSTRAINT "BoronganPickupLine_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupLine" ADD CONSTRAINT "BoronganPickupLine_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "BoronganPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupLine" ADD CONSTRAINT "BoronganPickupLine_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupCount" ADD CONSTRAINT "BoronganPickupCount_pickupId_fkey" FOREIGN KEY ("pickupId") REFERENCES "BoronganPickup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoronganPickupCount" ADD CONSTRAINT "BoronganPickupCount_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PieceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

