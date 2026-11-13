-- Output per bulan overhead: manual (bawaan) atau otomatis dari laporan shift
ALTER TABLE "Overhead" ADD COLUMN "outputAuto" BOOLEAN NOT NULL DEFAULT false;
