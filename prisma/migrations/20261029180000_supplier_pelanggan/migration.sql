-- Menu Supplier & Pelanggan: catatan + status aktif supplier, tabel pelanggan offline
ALTER TABLE "Supplier" ADD COLUMN "note" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
