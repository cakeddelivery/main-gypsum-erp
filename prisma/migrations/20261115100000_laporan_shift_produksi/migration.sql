-- Target hasil per shift per divisi (laporan shift: capaian %)
ALTER TABLE "Division" ADD COLUMN "targetPerShift" INTEGER;
-- Versi posting hasil kerja laporan shift ke stok (0 = belum pernah diposting)
ALTER TABLE "ShiftReport" ADD COLUMN "workPostedVersion" INTEGER NOT NULL DEFAULT 0;
