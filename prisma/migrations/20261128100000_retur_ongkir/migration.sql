-- Ongkir yang ditanggung toko pada retur & komplain (untuk Analitik Retur & Komplain).

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "shippingCost" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReturnCase" ADD COLUMN     "shippingCost" BIGINT NOT NULL DEFAULT 0;

