-- Kiriman Assembling bertahap: Cetak/Oven isi patung kering, Assembling/Supervisor melengkapi (aditif).

-- AlterTable
ALTER TABLE "BoronganShipment" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedBy" TEXT,
ADD COLUMN     "waitingSupport" BOOLEAN NOT NULL DEFAULT false;


-- Titik tanpa koordinator (bagian koordinator ke pekerja)
ALTER TABLE "BoronganPoint" ADD COLUMN     "noCoordinator" BOOLEAN NOT NULL DEFAULT false;
