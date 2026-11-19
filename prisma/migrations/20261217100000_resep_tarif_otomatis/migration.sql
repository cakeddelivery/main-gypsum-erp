-- Upah borongan di resep: otomatis dari Tugas & Tarif (override hanya Owner). Baris lama yang tarifnya berbeda dari tarif tugas atau tanpa tugas ditandai override.
ALTER TABLE "RecipeLabor" ADD COLUMN "override" BOOLEAN NOT NULL DEFAULT false;
UPDATE "RecipeLabor" l SET "override" = true
WHERE l."taskId" IS NULL OR l."rate" <> (SELECT t."ratePerPcs" FROM "PieceTask" t WHERE t."id" = l."taskId");
