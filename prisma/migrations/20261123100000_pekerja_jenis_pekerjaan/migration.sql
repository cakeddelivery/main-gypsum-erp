-- Jenis pekerjaan per pekerja borongan (aditif; kosong = boleh semua tugas di titiknya seperti sebelumnya)
ALTER TABLE "BoronganPerson" ADD COLUMN "taskIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
