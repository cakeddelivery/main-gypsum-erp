-- Setoran borongan per divisi: tugas punya divisi pencatat, setoran menyimpan akun pencatat
ALTER TABLE "PieceTask" ADD COLUMN "divisionId" TEXT;
ALTER TABLE "PieceTask" ADD CONSTRAINT "PieceTask_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BoronganResult" ADD COLUMN "createdById" TEXT;

-- Bawaan: Assembling & Cat Plastik → divisi Assembling; Cat Giftbox → divisi Giftbox
UPDATE "PieceTask" t SET "divisionId" = d."id"
FROM "Division" d
WHERE d."reportTemplate" = 'ASSEMBLING' AND t."divisionId" IS NULL AND (t."name" ILIKE '%assembl%' OR t."name" ILIKE '%cat plastik%');
UPDATE "PieceTask" t SET "divisionId" = d."id"
FROM "Division" d
WHERE d."reportTemplate" = 'GIFTBOX' AND t."divisionId" IS NULL AND t."name" ILIKE '%cat giftbox%';
