-- Koordinator borongan memegang lebih dari satu titik (titik tambahan). Hanya menambah tabel; data lama tetap.
CREATE TABLE "BoronganCoordinatorPoint" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BoronganCoordinatorPoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BoronganCoordinatorPoint_personId_pointId_key" ON "BoronganCoordinatorPoint"("personId", "pointId");
CREATE INDEX "BoronganCoordinatorPoint_pointId_idx" ON "BoronganCoordinatorPoint"("pointId");
ALTER TABLE "BoronganCoordinatorPoint" ADD CONSTRAINT "BoronganCoordinatorPoint_personId_fkey" FOREIGN KEY ("personId") REFERENCES "BoronganPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoronganCoordinatorPoint" ADD CONSTRAINT "BoronganCoordinatorPoint_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "BoronganPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
