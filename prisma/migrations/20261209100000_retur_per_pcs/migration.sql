-- Retur diperiksa per pcs (aditif)
ALTER TABLE "ReturnLine" ADD COLUMN "pieceMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "goodValue" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "lossValue" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "ReturnPiece" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "perPack" INTEGER NOT NULL,
    "goodQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "ReturnPiece_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReturnPiece_lineId_idx" ON "ReturnPiece"("lineId");
ALTER TABLE "ReturnPiece" ADD CONSTRAINT "ReturnPiece_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "ReturnLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnPiece" ADD CONSTRAINT "ReturnPiece_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
