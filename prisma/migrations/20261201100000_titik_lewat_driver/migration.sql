-- Titik borongan yang dikirimi bahan tanpa driver (aditif; bawaan lewat driver). Beringin diantar langsung.
ALTER TABLE "BoronganPoint" ADD COLUMN "viaDriver" BOOLEAN NOT NULL DEFAULT true;
UPDATE "BoronganPoint" SET "viaDriver" = false WHERE "code" = 'BRN' OR "name" ILIKE 'beringin%';
