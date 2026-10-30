"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { createsCycle, draftRecipeCost, productCosting, type RecipeInput } from "@/lib/hpp";
import { saveItemRecord } from "@/lib/items";
import { toRecipeQty } from "@/lib/itemCatalog";
import { recipeUnit } from "@/lib/unitcost";
import { OVERHEAD_CATEGORIES, monthlyDepreciation, parseFees, type FeeConfig } from "@/lib/pricing";
import type { Prisma, ProductType, ProductVariant } from "@prisma/client";

/** Persen 0–95 */
const pct = (fd: FormData, k: string, def: number) => {
  const v = dec(fd, k, def);
  if (v < 0 || v >= 95) throw new Error("Persen harus 0 sampai di bawah 95");
  return v;
};

const PACK: Record<string, number> = { SATUAN: 1, PAKET_12: 12, PAKET_24: 24, PAKET_48: 48, GIFTBOX: 1, CUSTOM: 1 };

/**
 * Produk jadi. Produk baru otomatis mendapat item stok barang jadi (kode MG-xxx) dengan stok awal
 * bernilai estimasi HPP, batas minimum stok, dan harga jual offline pertama.
 */
export const saveProduct = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const type = str(fd, "type") as ProductType;
    const name = z.string().min(2, "Nama wajib").parse(str(fd, "name"));
    const category = optStr(fd, "category") ?? "Mainan Gypsum";
    const minStock = dec(fd, "minStock", 0);
    const data = {
      name,
      category,
      note: optStr(fd, "note"),
      type,
      variant: str(fd, "variant") as ProductVariant,
      storeId: str(fd, "storeId"),
      packQty: int(fd, "packQty", PACK[type] ?? 1) || 1,
      affiliatePct: pct(fd, "affiliatePct", 0),
      adsPct: pct(fd, "adsPct", 0),
      itemsPerOrder: Math.max(1, dec(fd, "itemsPerOrder", 1)),
    };
    if (minStock < 0) throw new Error("Batas minimum stok tidak boleh minus");
    if (id) {
      const cur = await prisma.product.findUniqueOrThrow({ where: { id } });
      const sku = str(fd, "sku").toUpperCase() || cur.sku;
      const finishedItemId = fd.has("finishedItemId") ? optStr(fd, "finishedItemId") : cur.finishedItemId;
      const p = await prisma.product.update({ where: { id }, data: { ...data, sku, finishedItemId, active: bool(fd, "active") } });
      if (p.finishedItemId) await prisma.item.update({ where: { id: p.finishedItemId }, data: { minStock } });
      await audit(user, "PRODUK_DIUBAH", "Product", p.id, { ...data, sku, minStock });
      return "Produk tersimpan";
    }
    const hpp = int(fd, "estimatedHpp");
    const price = int(fd, "price");
    const openingQty = dec(fd, "openingQty", 0);
    if (hpp < 0 || price < 0) throw new Error("HPP dan harga tidak boleh minus");
    const item = await saveItemRecord({ name, type: "BARANG_JADI", category: "Mainan Gypsum", unit: "pcs", hppFactor: 1, minStock, price: hpp, openingQty, note: data.note }, user);
    let sku = str(fd, "sku").toUpperCase() || item.sku;
    if (await prisma.product.findUnique({ where: { sku } })) sku = `${sku}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
    const p = await prisma.product.create({ data: { ...data, sku, finishedItemId: item.id } });
    if (price > 0) await prisma.priceHistory.create({ data: { productId: p.id, channel: "OFFLINE", price: BigInt(price), hpp: BigInt(hpp), createdBy: user.name } });
    await audit(user, "PRODUK_DIBUAT", "Product", p.id, { ...data, sku, hpp, price, openingQty, minStock });
    return `Produk ${sku} tersimpan. Lanjut atur Resep HPP di halaman detail.`;
  },
  ["/produk", "/stok"],
);

/** Baris resep dari form RecipeEditor: comp_item/comp_qty/comp_unit, labor_task/labor_name/labor_rate, oh_id/oh_factor */
async function parseRecipe(fd: FormData): Promise<RecipeInput> {
  const all = (k: string) => fd.getAll(k).map((v) => String(v).trim());
  const n = (v: string | undefined) => Number((v ?? "").replace(",", ".")) || 0;
  const qty = all("comp_qty");
  const units = all("comp_unit");
  const raw = all("comp_item").map((id, i) => ({ componentId: id, qty: n(qty[i]), useUnit: units[i] || null })).filter((l) => l.componentId && l.qty > 0);
  if (new Set(raw.map((l) => l.componentId)).size !== raw.length) throw new Error("Komponen yang sama dipilih dua kali");
  const items = await prisma.item.findMany({ where: { id: { in: raw.map((l) => l.componentId) } } });
  // Qty diisi dalam satuan pakai, disimpan dalam satuan resep komponen (500 gram → 0,5 bila resep kg)
  const comp = raw.map((l) => {
    const it = items.find((x) => x.id === l.componentId);
    if (!it) throw new Error("Komponen tidak ditemukan");
    return { ...l, qty: toRecipeQty(l.qty, l.useUnit, recipeUnit(it)) };
  });
  const tasks = all("labor_task");
  const names = all("labor_name");
  const rates = all("labor_rate");
  const master = await prisma.pieceTask.findMany({ where: { id: { in: tasks.filter(Boolean) } } });
  const labor = names.map((name, i) => {
    const t = master.find((x) => x.id === tasks[i]);
    const custom = Number((rates[i] ?? "").replace(/\./g, "")) || 0;
    return { taskId: t?.id ?? null, name: t?.name ?? name, rate: custom > 0 ? custom : Number(t?.ratePerPcs ?? 0) };
  }).filter((l) => l.name && l.rate > 0);
  const factors = all("oh_factor");
  const oh = all("oh_id").map((id, i) => ({ overheadId: id, factor: n(factors[i]) })).filter((o) => o.overheadId && o.factor > 0);
  return { comp, labor, oh };
}

async function writeRecipe(tx: Prisma.TransactionClient, owner: { itemId: string } | { productId: string }, r: RecipeInput) {
  await tx.recipeLabor.deleteMany({ where: owner });
  await tx.recipeOverhead.deleteMany({ where: owner });
  if (r.labor.length) await tx.recipeLabor.createMany({ data: r.labor.map((l) => ({ ...owner, ...l, rate: BigInt(l.rate) })) });
  if (r.oh.length) await tx.recipeOverhead.createMany({ data: r.oh.map((o) => ({ ...owner, ...o })) });
  if ("itemId" in owner) {
    await tx.itemRecipeLine.deleteMany({ where: owner });
    if (r.comp.length) await tx.itemRecipeLine.createMany({ data: r.comp.map((c) => ({ ...owner, ...c })) });
  } else {
    await tx.bomLine.deleteMany({ where: owner });
    if (r.comp.length) await tx.bomLine.createMany({ data: r.comp.map((c) => ({ ...owner, itemId: c.componentId, qty: c.qty, useUnit: c.useUnit })) });
  }
}

/** Resep HPP produk jadi: 4 section + tambahan kemasan + target margin */
export const saveProductRecipe = action(
  "product.manage",
  async (fd, user) => {
    const productId = str(fd, "productId");
    const r = await parseRecipe(fd);
    const extraPackaging = Math.max(0, int(fd, "extraPackaging"));
    const targetMargin = pct(fd, "targetMargin", 30);
    await prisma.$transaction(async (tx) => {
      await writeRecipe(tx, { productId }, r);
      // Biaya manual lama digantikan baris resep
      await tx.product.update({ where: { id: productId }, data: { extraPackaging: BigInt(extraPackaging), targetMargin, laborCost: 0, overheadCost: 0 } });
    });
    await audit(user, "RESEP_PRODUK_DIUBAH", "Product", productId, { comp: r.comp.length, labor: r.labor.length, oh: r.oh.length, extraPackaging, targetMargin });
    return "Resep HPP produk tersimpan";
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

/** Barang setengah jadi baru/ubah beserta resepnya (komponen, tenaga kerja, overhead per 1 unit) */
export const saveSemi = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const r = await parseRecipe(fd);
    if (id) for (const l of r.comp) if (await createsCycle(prisma, id, l.componentId)) throw new Error("Komponen tidak boleh memakai barang ini sendiri (resep melingkar)");
    const base = { name: str(fd, "name"), type: "BARANG_DALAM_PROSES" as const, category: "Barang Setengah Jadi", unit: str(fd, "unit") || "pcs", hppFactor: 1, note: optStr(fd, "note") };
    let itemId = id;
    if (id) {
      const cur = await prisma.item.findUniqueOrThrow({ where: { id } });
      await saveItemRecord({ ...base, id, sku: cur.sku, minStock: Number(cur.minStock), hppUnit: null }, user);
    } else {
      // Nilai stok awal = HPP resep saat ini
      const price = await draftRecipeCost(r);
      itemId = (await saveItemRecord({ ...base, minStock: 0, price, openingQty: dec(fd, "openingQty", 0) }, user)).id;
    }
    await prisma.$transaction((tx) => writeRecipe(tx, { itemId: itemId! }, r));
    await audit(user, "RESEP_DIUBAH", "Item", itemId!, { comp: r.comp.length, labor: r.labor.length, oh: r.oh.length });
    return "Barang setengah jadi tersimpan";
  },
  ["/produk", "/stok"],
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
    const outputPerMonth = Math.max(0, int(fd, "outputPerMonth"));
    const data = { category, name: str(fd, "name") || category, monthlyAmount: BigInt(monthly), outputPerMonth, note: optStr(fd, "note"), assetCost: assetCost > 0 ? BigInt(assetCost) : null, lifeMonths: lifeMonths > 0 ? lifeMonths : null, active: fd.get("active") !== "off" };
    const o = id ? await prisma.overhead.update({ where: { id }, data }) : await prisma.overhead.create({ data });
    await audit(user, "OVERHEAD", "Overhead", o.id, { ...data, monthlyAmount: monthly, assetCost, lifeMonths });
    return `${o.name} tersimpan (Rp${monthly.toLocaleString("id-ID")}/bulan)`;
  },
  ["/produk"],
);

export const deleteOverhead = action(
  "product.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    if (await prisma.recipeOverhead.count({ where: { overheadId: id } })) {
      await prisma.overhead.update({ where: { id }, data: { active: false } });
      await audit(user, "OVERHEAD_NONAKTIF", "Overhead", id);
      return "Overhead dipakai di resep, jadi dinonaktifkan";
    }
    await prisma.overhead.delete({ where: { id } });
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
