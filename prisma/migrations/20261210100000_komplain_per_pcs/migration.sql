-- Komplain: rincian pcs rusak per karakter (aditif)
CREATE TABLE "ComplaintPiece" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "perPack" INTEGER NOT NULL,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "ComplaintPiece_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplaintPiece_lineId_idx" ON "ComplaintPiece"("lineId");
ALTER TABLE "ComplaintPiece" ADD CONSTRAINT "ComplaintPiece_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "ComplaintLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplaintPiece" ADD CONSTRAINT "ComplaintPiece_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
