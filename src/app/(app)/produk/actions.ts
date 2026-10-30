"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { createsCycle, productCosting } from "@/lib/hpp";
import { OVERHEAD_CATEGORIES, monthlyDepreciation, parseFees, type FeeConfig } from "@/lib/pricing";
import type { ProductType, ProductVariant } from "@prisma/client";

/** Persen 0–95 */
const pct = (fd: FormData, k: string, def: number) => {
  const v = dec(fd, k, def);
  if (v < 0 || v >= 95) throw new Error("Persen harus 0 sampai di bawah 95");
  return v;
};

const PACK: Record<string, number> = { SATUAN: 1, PAKET_12: 12, PAKET_24: 24, PAKET_48: 48, GIFTBOX: 1, CUSTOM: 1 };

export const saveProduct = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const type = str(fd, "type") as ProductType;
    const data = {
      sku: z.string().min(2, "SKU wajib").parse(str(fd, "sku").toUpperCase()),
      name: z.string().min(2, "Nama wajib").parse(str(fd, "name")),
      type,
      variant: str(fd, "variant") as ProductVariant,
      storeId: str(fd, "storeId"),
      packQty: int(fd, "packQty", PACK[type] ?? 1) || 1,
      laborCost: BigInt(int(fd, "laborCost")),
      overheadCost: BigInt(int(fd, "overheadCost")),
      targetMargin: pct(fd, "targetMargin", 30),
      affiliatePct: pct(fd, "affiliatePct", 0),
      adsPct: pct(fd, "adsPct", 0),
      itemsPerOrder: Math.max(1, dec(fd, "itemsPerOrder", 1)),
      finishedItemId: optStr(fd, "finishedItemId"),
      active: id ? bool(fd, "active") : true,
    };
    const p = id ? await prisma.product.update({ where: { id }, data }) : await prisma.product.create({ data });
    await audit(user, id ? "PRODUK_DIUBAH" : "PRODUK_DIBUAT", "Product", p.id, data);
    return "Produk tersimpan";
  },
  ["/produk"],
);

export const saveBom = action(
  "product.manage",
  async (fd, user) => {
    const productId = str(fd, "productId");
    const itemId = str(fd, "itemId");
    const qty = dec(fd, "qty");
    if (qty <= 0) {
      await prisma.bomLine.deleteMany({ where: { productId, itemId } });
    } else {
      await prisma.bomLine.upsert({ where: { productId_itemId: { productId, itemId } }, create: { productId, itemId, qty }, update: { qty } });
    }
    await audit(user, "BOM_DIUBAH", "Product", productId, { itemId, qty });
    return qty <= 0 ? "Bahan dihapus dari BOM" : "BOM tersimpan";
  },
  ["/produk"],
);

/** Catat harga jual baru per kanal; HPP saat itu disimpan untuk histori margin */
export const savePrice = action(
  "product.manage",
  async (fd, user) => {
    const productId = str(fd, "productId");
    const price = int(fd, "price");
    if (price <= 0) throw new Error("Harga harus > 0");
    const { hpp } = await productCosting(productId);
    await prisma.priceHistory.create({ data: { productId, channel: str(fd, "channel"), price: BigInt(price), hpp: BigInt(hpp), createdBy: user.name } });
    await audit(user, "HARGA_DIUBAH", "Product", productId, { channel: str(fd, "channel"), price, hpp });
    return "Harga tersimpan";
  },
  ["/produk"],
);

/** Resep barang setengah jadi: komponen (bahan / setengah jadi lain) per 1 unit + upah & overhead per unit */
export const saveRecipe = action(
  "product.manage",
  async (fd, user) => {
    const itemId = str(fd, "itemId");
    const qty = fd.getAll("qty").map((v) => Number(String(v).replace(",", ".")) || 0);
    const lines = fd.getAll("componentId").map((v, i) => ({ componentId: String(v), qty: qty[i] ?? 0 })).filter((l) => l.componentId && l.qty > 0);
    for (const l of lines) if (await createsCycle(prisma, itemId, l.componentId)) throw new Error("Komponen tidak boleh memakai barang ini sendiri (resep melingkar)");
    if (new Set(lines.map((l) => l.componentId)).size !== lines.length) throw new Error("Komponen yang sama dipilih dua kali");
    await prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id: itemId }, data: { laborCost: BigInt(int(fd, "laborCost")), overheadCost: BigInt(int(fd, "overheadCost")) } });
      await tx.itemRecipeLine.deleteMany({ where: { itemId } });
      if (lines.length) await tx.itemRecipeLine.createMany({ data: lines.map((l) => ({ itemId, componentId: l.componentId, qty: l.qty })) });
    });
    await audit(user, "RESEP_DIUBAH", "Item", itemId, { lines: lines.length });
    return "Resep tersimpan";
  },
  ["/produk"],
);

export const saveOverhead = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const category = str(fd, "category");
    if (!OVERHEAD_CATEGORIES.includes(category as (typeof OVERHEAD_CATEGORIES)[number])) throw new Error("Pilih kategori overhead");
    const assetCost = int(fd, "assetCost");
    const lifeMonths = int(fd, "lifeMonths");
    // Penyusutan dihitung dari harga aset / umur bila diisi
    const monthly = assetCost > 0 && lifeMonths > 0 ? monthlyDepreciation(assetCost, lifeMonths) : int(fd, "monthlyAmount");
    if (monthly <= 0) throw new Error("Isi biaya per bulan, atau harga aset dan umurnya");
    const data = { category, name: str(fd, "name") || category, monthlyAmount: BigInt(monthly), assetCost: assetCost > 0 ? BigInt(assetCost) : null, lifeMonths: lifeMonths > 0 ? lifeMonths : null, active: fd.get("active") !== "off" };
    const o = id ? await prisma.overhead.update({ where: { id }, data }) : await prisma.overhead.create({ data });
    await audit(user, "OVERHEAD", "Overhead", o.id, { ...data, monthlyAmount: monthly, assetCost, lifeMonths });
    return `${o.name} tersimpan (Rp${monthly.toLocaleString("id-ID")}/bulan)`;
  },
  ["/produk"],
);

export const deleteOverhead = action(
  "product.manage",
  async (fd, user) => {
    await prisma.overhead.delete({ where: { id: str(fd, "id") } });
    await audit(user, "OVERHEAD_DIHAPUS", "Overhead", str(fd, "id"));
    return "Overhead dihapus";
  },
  ["/produk"],
);

export const saveCapacity = action(
  "product.manage",
  async (fd, user) => {
    const value = String(Math.max(0, int(fd, "capacity")));
    await prisma.setting.upsert({ where: { key: "overhead_capacity_pcs" }, create: { key: "overhead_capacity_pcs", value }, update: { value } });
    await audit(user, "KAPASITAS_PRODUKSI", "Setting", "overhead_capacity_pcs", { value });
    return "Kapasitas produksi tersimpan";
  },
  ["/produk"],
);

/** Potongan marketplace: fee_<kanal>_name[], fee_<kanal>_pct[], perOrder_<kanal> */
export const saveFees = action(
  "product.manage",
  async (fd, user) => {
    const cur = parseFees((await prisma.setting.findUnique({ where: { key: "marketplace_fees" } }))?.value);
    const next: FeeConfig = {};
    for (const ch of Object.keys(cur)) {
      const names = fd.getAll(`fee_${ch}_name`).map((v) => String(v).trim());
      const pcts = fd.getAll(`fee_${ch}_pct`).map((v) => Number(String(v).replace(",", ".")) || 0);
      const fees = names.map((name, i) => ({ name, pct: pcts[i] ?? 0 })).filter((f) => f.name && f.pct > 0);
      if (fees.some((f) => f.pct >= 50)) throw new Error("Persen potongan terlalu besar");
      next[ch] = { fees, perOrder: Math.max(0, int(fd, `perOrder_${ch}`)) };
    }
    const value = JSON.stringify(next);
    await prisma.setting.upsert({ where: { key: "marketplace_fees" }, create: { key: "marketplace_fees", value }, update: { value } });
    await audit(user, "BIAYA_MARKETPLACE", "Setting", "marketplace_fees", next);
    return "Biaya marketplace tersimpan";
  },
  ["/produk"],
);
