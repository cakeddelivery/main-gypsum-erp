-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "checkInAccuracy" DOUBLE PRECISION,
ADD COLUMN     "checkInDistance" INTEGER,
ADD COLUMN     "checkInLat" DOUBLE PRECISION,
ADD COLUMN     "checkInLng" DOUBLE PRECISION,
ADD COLUMN     "checkInSiteId" TEXT,
ADD COLUMN     "checkOutAccuracy" DOUBLE PRECISION,
ADD COLUMN     "checkOutDistance" INTEGER,
ADD COLUMN     "checkOutLat" DOUBLE PRECISION,
ADD COLUMN     "checkOutLng" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "WorkSite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSite_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_checkInSiteId_fkey" FOREIGN KEY ("checkInSiteId") REFERENCES "WorkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
