-- Koordinator pilihan per pekerja borongan (aditif).

-- AlterTable
ALTER TABLE "BoronganPerson" ADD COLUMN     "coordinatorId" TEXT,
ADD COLUMN     "noCoordinator" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "BoronganPerson" ADD CONSTRAINT "BoronganPerson_coordinatorId_fkey" FOREIGN KEY ("coordinatorId") REFERENCES "BoronganPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

