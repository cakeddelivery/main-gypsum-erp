-- Katalog produk induk + kategori varian + kombinasi (SKU)

CREATE TABLE "ProductFamily" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "patungQty" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductFamily_code_key" ON "ProductFamily"("code");

CREATE TABLE "VariantAxis" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VariantAxis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VariantAxis_familyId_name_key" ON "VariantAxis"("familyId", "name");
ALTER TABLE "VariantAxis" ADD CONSTRAINT "VariantAxis_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VariantOption" (
    "id" TEXT NOT NULL,
    "axisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "patungQty" INTEGER,
    "variant" "ProductVariant",
    "productType" TEXT,
    CONSTRAINT "VariantOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VariantOption_axisId_name_key" ON "VariantOption"("axisId", "name");
ALTER TABLE "VariantOption" ADD CONSTRAINT "VariantOption_axisId_fkey" FOREIGN KEY ("axisId") REFERENCES "VariantAxis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductVariantValue" (
    "productId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    CONSTRAINT "ProductVariantValue_pkey" PRIMARY KEY ("productId", "optionId")
);
CREATE INDEX "ProductVariantValue_optionId_idx" ON "ProductVariantValue"("optionId");
ALTER TABLE "ProductVariantValue" ADD CONSTRAINT "ProductVariantValue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariantValue" ADD CONSTRAINT "ProductVariantValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "VariantOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Product" ADD COLUMN "familyId" TEXT;
CREATE INDEX "Product_familyId_idx" ON "Product"("familyId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tipe produk Paket 96 (Paket Single Pack)
INSERT INTO "ProductTypeOption" ("code", "name", "packQty", "sortOrder") VALUES ('PAKET_96', 'Paket 96', 96, 5)
ON CONFLICT ("code") DO NOTHING;
