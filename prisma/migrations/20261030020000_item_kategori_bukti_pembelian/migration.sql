-- Kategori & catatan item (kode otomatis per kategori), foto bukti transfer pembelian
ALTER TABLE "Item" ADD COLUMN "category" TEXT;
ALTER TABLE "Item" ADD COLUMN "note" TEXT;
ALTER TABLE "Purchase" ADD COLUMN "proofPath" TEXT;
ALTER TABLE "Purchase" ADD COLUMN "proofMime" TEXT;
