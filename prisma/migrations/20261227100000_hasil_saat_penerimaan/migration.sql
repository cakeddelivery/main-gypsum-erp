-- Tugas borongan yang hasil per jenisnya diisi saat penerimaan (mis. Cat Plastik). Hanya menambah kolom; data lama tetap false.
ALTER TABLE "PieceTask" ADD COLUMN "resultAtReceipt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BoronganShipment" ADD COLUMN "resultAtReceipt" BOOLEAN NOT NULL DEFAULT false;
