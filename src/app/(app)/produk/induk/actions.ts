"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { itemCosts, productCosting } from "@/lib/hpp";
import { PRICE_CHANNELS, copyRecipe, generateMissingSkus, saveBulkPrices } from "@/lib/productFamily";
import type { ProductVariant } from "@prisma/client";

const PATHS = ["/produk", "/produk/induk"];
const VARIANTS = ["COWOK", "CEWEK", "HEWAN", "TRANSPORTASI", "MIX"];

/** Tambah / ubah pilihan dalam kategori varian (mis. Series baru). Pilihan tidak dihapus, hanya dinonaktifkan. */
export const saveVariantOption = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const name = z.string().trim().min(1, "Nama pilihan wajib").max(40).parse(str(fd, "name"));
    const patung = int(fd, "patungQty", 0);
    if (patung < 0) throw new Error("Jumlah patung tidak boleh minus");
    const variantRaw = optStr(fd, "variant");
    const variant = variantRaw && VARIANTS.includes(variantRaw) ? (variantRaw as ProductVariant) : null;
    const productType = optStr(fd, "productType");
    if (productType && !(await prisma.productTypeOption.findUnique({ where: { code: productType } }))) throw new Error("Tipe produk tidak dikenal");
    const data = { name, patungQty: patung || null, variant, productType };
    if (id) {
      const o = await prisma.variantOption.update({ where: { id }, data: { ...data, active: bool(fd, "active") }, include: { values: true } });
      // Jumlah patung / varian / tipe ikut ke SKU yang memakai pilihan ini
      const ids = o.values.map((v) => v.productId);
      if (ids.length) {
        await prisma.product.updateMany({ where: { id: { in: ids } }, data: { ...(patung ? { packQty: patung } : {}), ...(variant ? { variant } : {}), ...(productType ? { type: productType } : {}) } });
      }
      await audit(user, "VARIAN_DIUBAH", "VariantOption", id, { ...data, sku: ids.length });
      return "Pilihan varian tersimpan";
    }
    const axisId = str(fd, "axisId");
    const last = await prisma.variantOption.findFirst({ where: { axisId }, orderBy: { sortOrder: "desc" } });
    const o = await prisma.variantOption.create({ data: { ...data, axisId, sortOrder: (last?.sortOrder ?? 0) + 1 } });
    await audit(user, "VARIAN_DITAMBAH", "VariantOption", o.id, data);
    return "Pilihan varian ditambahkan. Tekan \"Buat SKU yang belum ada\" untuk membuat kombinasinya.";
  },
  PATHS,
);

export const createMissingSkus = action(
  "product.manage",
  async (fd, user) => {
    const familyId = str(fd, "familyId");
    const r = await generateMissingSkus(familyId);
    await audit(user, "SKU_DIBUAT", "ProductFamily", familyId, r);
    return r.created + r.linked ? `${r.created} SKU baru dibuat${r.linked ? `, ${r.linked} produk lama dimasukkan` : ""}` : "Semua kombinasi sudah punya SKU";
  },
  [...PATHS, "/stok"],
);

/** Isi harga massal: input price.<productId>.<channel> */
export const saveFamilyPrices = action(
  "product.manage",
  async (fd, user) => {
    const familyId = str(fd, "familyId");
    const products = await prisma.product.findMany({ where: { familyId }, select: { id: true } });
    const costs = await itemCosts();
    const rows: { productId: string; channel: string; price: number; hpp: number }[] = [];
    for (const p of products) {
      let hpp: number | null = null;
      for (const ch of PRICE_CHANNELS) {
        const raw = String(fd.get(`price.${p.id}.${ch}`) ?? "").replace(/\./g, "").trim();
        if (!raw) continue;
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) throw new Error("Harga tidak valid");
        if (!price) continue;
        hpp ??= (await productCosting(p.id, costs)).hpp;
        rows.push({ productId: p.id, channel: ch, price, hpp });
      }
    }
    const saved = await prisma.$transaction((tx) => saveBulkPrices(tx, rows, user.name));
    await audit(user, "HARGA_MASSAL", "ProductFamily", familyId, { saved });
    return saved ? `${saved} harga baru tersimpan` : "Tidak ada harga yang berubah";
  },
  PATHS,
);

/** Salin resep satu SKU ke SKU lain (target[] = id produk) */
export const copyFamilyRecipe = action(
  "product.manage",
  async (fd, user) => {
    const fromId = str(fd, "fromId");
    const targets = fd.getAll("target").map(String).filter(Boolean);
    if (!targets.length) throw new Error("Centang minimal satu SKU tujuan");
    const n = await prisma.$transaction((tx) => copyRecipe(tx, fromId, targets));
    await audit(user, "RESEP_DISALIN", "Product", fromId, { targets });
    return `Resep disalin ke ${n} SKU. Ubah resep per SKU bila ada bahan yang berbeda (mis. palet / magnet).`;
  },
  PATHS,
);
