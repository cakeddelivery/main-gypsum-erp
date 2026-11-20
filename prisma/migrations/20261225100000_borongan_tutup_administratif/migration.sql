-- Kiriman borongan ditutup administratif (tanpa mutasi stok / upah / jurnal). Hanya menambah kolom.
ALTER TABLE "BoronganShipment" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "BoronganShipment" ADD COLUMN "closedBy" TEXT;
ALTER TABLE "BoronganShipment" ADD COLUMN "closeNote" TEXT;
