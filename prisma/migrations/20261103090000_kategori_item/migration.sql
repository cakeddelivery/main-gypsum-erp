-- Kategori item/produk bisa diatur di Pengaturan (dulu tertanam di kode)
CREATE TABLE "ItemCategory" (
    "id" TEXT NOT NULL,
    "type" "ItemType" NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ItemCategory_type_name_key" ON "ItemCategory"("type", "name");
CREATE UNIQUE INDEX "ItemCategory_prefix_key" ON "ItemCategory"("prefix");

INSERT INTO "ItemCategory" ("id", "type", "name", "prefix", "sortOrder") VALUES
  ('icat_bu',  'BAHAN_BAKU', 'Bahan Utama', 'BU', 1),
  ('icat_ct',  'BAHAN_BAKU', 'Cat & Pewarna', 'CT', 2),
  ('icat_bp',  'BAHAN_BAKU', 'Bahan Pendukung', 'BP', 3),
  ('icat_km',  'BAHAN_BAKU', 'Kemasan & Packaging', 'KM', 4),
  ('icat_pp',  'BAHAN_BAKU', 'Perlengkapan Produksi', 'PP', 5),
  ('icat_bsj', 'BARANG_DALAM_PROSES', 'Barang Setengah Jadi', 'BSJ', 1),
  ('icat_mg',  'BARANG_JADI', 'Mainan Gypsum', 'MG', 1);
