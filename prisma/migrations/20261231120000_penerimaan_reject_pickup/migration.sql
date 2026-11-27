-- Reject saat diterima divisi penerima per jenis (hanya ADD)
ALTER TABLE "BoronganPickupCount" ADD COLUMN "reject" INTEGER NOT NULL DEFAULT 0;
