import type { Prisma, PrismaClient, ProductVariant } from "@prisma/client";
import { prisma } from "./db";
import { nextSequence } from "./codes";
import { nextItemSku } from "./items";
import { categoryPrefixOf, itemCategories } from "./itemCategories";
import { TEMPLATES, isTemplate, type ReportCatalogs } from "./shiftReport";

/**
 * Katalog produk induk + varian.
 * Produk induk (ProductFamily) punya 1–3 kategori varian (VariantAxis), tiap kategori punya pilihan (VariantOption).
 * Setiap kombinasi pilihan = satu Product (SKU) dengan item stok barang jadi sendiri, harga per kanal sendiri,
 * resep (BomLine) sendiri, dan jumlah patung (Product.packQty).
 * Produk lama tidak pernah dihapus: bila cocok, produk lama dimasukkan ke induk (riwayat penjualan & HPP tetap).
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; name: string };

// ---------------- Spesifikasi katalog (dipakai skrip data & tes) ----------------

export type OptionSpec = { name: string; patungQty?: number; variant?: ProductVariant; productType?: string; /** Kode giftbox lama di laporan shift (MIX, CEW-PLT, …) */ legacy?: string };
export type AxisSpec = { name: string; options: OptionSpec[] };
export type FamilySpec = { name: string; type: string; patungQty: number; unit: string; axes: AxisSpec[]; note?: string };

const SERIES: Record<string, OptionSpec> = {
  Mix: { name: "Mix", variant: "MIX", legacy: "MIX" },
  Cewek: { name: "Cewek", variant: "CEWEK", legacy: "CEW" },
  Cowok: { name: "Cowok", variant: "COWOK", legacy: "CWO" },
  Hewan: { name: "Hewan", variant: "HEWAN", legacy: "HWN" },
  Transportasi: { name: "Transportasi", variant: "TRANSPORTASI", legacy: "TRN" },
};
const series = (...names: string[]) => names.map((n) => SERIES[n]);

export const GIFTBOX_FAMILY = "Giftbox";
export const SATUAN_FAMILY = "Satuan Single Pack";
export const PAKET_FAMILY = "Paket Single Pack";

export const CATALOG: FamilySpec[] = [
  {
    name: GIFTBOX_FAMILY,
    type: "GIFTBOX",
    patungQty: 5,
    unit: "box",
    note: "1 giftbox = 5 patung",
    axes: [
      { name: "Tipe", options: [{ name: "Reguler" }, { name: "Custom" }] },
      { name: "Paket", options: [{ name: "Standard" }, { name: "Bonus Palet", legacy: "PLT" }, { name: "Bonus Magnet" }, { name: "Bonus Magnet + Palet" }] },
      { name: "Series", options: series("Mix", "Cewek", "Cowok", "Hewan", "Transportasi") },
    ],
  },
  {
    name: SATUAN_FAMILY,
    type: "SATUAN",
    patungQty: 1,
    unit: "pcs",
    axes: [{ name: "Series", options: series("Cowok", "Cewek", "Hewan", "Transportasi") }],
  },
  {
    name: PAKET_FAMILY,
    type: "PAKET_12",
    patungQty: 12,
    unit: "pcs",
    note: "Jumlah patung = jumlah pcs",
    axes: [
      { name: "Jumlah", options: [12, 24, 48, 96].map((n) => ({ name: `${n} pcs`, patungQty: n, productType: `PAKET_${n}` })) },
      { name: "Series", options: series("Mix", "Hewan", "Transportasi", "Cowok", "Cewek") },
    ],
  },
];

// ---------------- Kombinasi ----------------

/** Semua kombinasi pilihan (perkalian kategori varian), urut sesuai urutan kategori & pilihan */
export function combos<T>(axes: T[][]): T[][] {
  return axes.reduce<T[][]>((acc, opts) => acc.flatMap((c) => opts.map((o) => [...c, o])), [[]]);
}

type OptLike = { name: string; patungQty?: number | null; variant?: ProductVariant | null; productType?: string | null };

/** Nama SKU: "Giftbox Reguler · Standard · Cowok" */
export function skuName(familyName: string, opts: { name: string }[]) {
  return `${familyName} ${opts.map((o) => o.name).join(" · ")}`.trim();
}

/** Atribut SKU dari pilihannya: jumlah patung, tipe produk, varian karakter (bawaan MIX) */
export function skuAttrs(family: { type: string; patungQty: number }, opts: OptLike[]) {
  const patung = opts.find((o) => o.patungQty)?.patungQty ?? family.patungQty;
  const type = opts.find((o) => o.productType)?.productType ?? family.type;
  const variant: ProductVariant = opts.find((o) => o.variant)?.variant ?? "MIX";
  return { packQty: Math.max(1, patung), type, variant };
}

// ---------------- Baca katalog ----------------

export const familyInclude = {
  axes: { orderBy: { sortOrder: "asc" }, include: { options: { orderBy: { sortOrder: "asc" } } } },
  products: { include: { variantValues: true }, orderBy: { sku: "asc" } },
} satisfies Prisma.ProductFamilyInclude;
export type FamilyFull = Prisma.ProductFamilyGetPayload<{ include: typeof familyInclude }>;

/** Kunci kombinasi = id pilihan diurutkan, untuk mencari SKU suatu kombinasi */
export const comboKey = (optionIds: string[]) => [...optionIds].sort().join("|");

/** Peta kombinasi → produk (SKU) di satu induk */
export function productsByCombo(f: FamilyFull) {
  return new Map(f.products.map((p) => [comboKey(p.variantValues.map((v) => v.optionId)), p]));
}

/** Kombinasi aktif induk beserta SKU-nya (null = belum dibuat) */
export function familyMatrix(f: FamilyFull) {
  const byCombo = productsByCombo(f);
  return combos(f.axes.map((a) => a.options.filter((o) => o.active))).map((opts) => ({ opts, product: byCombo.get(comboKey(opts.map((o) => o.id))) ?? null }));
}

// ---------------- Tulis katalog ----------------

async function familyCode(db: Db) {
  return nextSequence(db, "IND", async (code) => !!(await db.productFamily.findUnique({ where: { code } })));
}

/** Buat/lengkapi induk + kategori + pilihan sesuai spesifikasi (tidak menghapus yang sudah ada) */
export async function ensureFamily(db: Db, spec: FamilySpec, sortOrder = 0) {
  let f = await db.productFamily.findFirst({ where: { name: spec.name } });
  if (!f) f = await db.productFamily.create({ data: { code: await familyCode(db), name: spec.name, type: spec.type, patungQty: spec.patungQty, note: spec.note ?? null, sortOrder } });
  for (const [ai, a] of spec.axes.entries()) {
    const axis = (await db.variantAxis.findUnique({ where: { familyId_name: { familyId: f.id, name: a.name } } })) ?? (await db.variantAxis.create({ data: { familyId: f.id, name: a.name, sortOrder: ai } }));
    for (const [oi, o] of a.options.entries()) {
      const ex = await db.variantOption.findUnique({ where: { axisId_name: { axisId: axis.id, name: o.name } } });
      if (!ex) await db.variantOption.create({ data: { axisId: axis.id, name: o.name, sortOrder: oi, patungQty: o.patungQty ?? null, variant: o.variant ?? null, productType: o.productType ?? null } });
    }
  }
  return db.productFamily.findUniqueOrThrow({ where: { id: f.id }, include: familyInclude });
}

export type SkuPlan = {
  name: string;
  optionIds: string[];
  attrs: ReturnType<typeof skuAttrs>;
  /** "baru" = produk & item barang jadi baru; "item-lama" = produk baru memakai item stok lama; "produk-lama" = produk lama dimasukkan ke induk; "ada" = sudah di induk */
  action: "baru" | "item-lama" | "produk-lama" | "ada";
  existingProduct?: { id: string; sku: string; name: string };
  existingItem?: { id: string; sku: string; name: string };
};

/**
 * Rencana SKU untuk setiap kombinasi induk yang belum punya produk.
 * Produk lama dicocokkan (hanya bila tepat satu kandidat): tipe + varian sama dan belum masuk induk;
 * untuk Giftbox hanya kombinasi Reguler·Standard. Item stok lama dari laporan shift (BJ-GB-<kode>, BJ-SAT-<varian>)
 * dipakai sebagai item barang jadi SKU baru agar stok & riwayatnya bersambung.
 */
export async function planFamilySkus(db: Db, f: FamilyFull, spec?: FamilySpec, storeId?: string): Promise<SkuPlan[]> {
  const out: SkuPlan[] = [];
  const claimed = new Set<string>();
  const linkedItemIds = new Set((await db.product.findMany({ where: { finishedItemId: { not: null } }, select: { finishedItemId: true } })).map((p) => p.finishedItemId!));
  for (const { opts, product } of familyMatrix(f)) {
    const attrs = skuAttrs(f, opts);
    const name = skuName(f.name, opts);
    const optionIds = opts.map((o) => o.id);
    if (product) {
      out.push({ name, optionIds, attrs, action: "ada", existingProduct: product });
      continue;
    }
    const legacyOf = (axisName: string) => spec?.axes.find((a) => a.name === axisName);
    // Kandidat produk lama
    const giftbox = attrs.type === "GIFTBOX";
    const regulerStandard = giftbox && opts.some((o) => o.name === "Reguler") && opts.some((o) => o.name === "Standard");
    if (!giftbox || regulerStandard) {
      const all = (await db.product.findMany({ where: { familyId: null, type: attrs.type, variant: attrs.variant }, orderBy: [{ active: "desc" }, { sku: "asc" }], select: { id: true, sku: true, name: true, storeId: true } })).filter((c) => !claimed.has(c.id));
      // Ada produk sama di beberapa toko: utamakan toko default
      const inStore = storeId ? all.filter((c) => c.storeId === storeId) : [];
      const cands = inStore.length ? inStore : all;
      if (cands.length === 1 || (cands.length > 1 && attrs.type === "SATUAN")) {
        // Satuan: laporan shift memakai produk satuan pertama (urut kode) per varian, jadi itu yang dimasukkan
        const c = cands[0];
        claimed.add(c.id);
        out.push({ name, optionIds, attrs, action: "produk-lama", existingProduct: { id: c.id, sku: c.sku, name: c.name } });
        continue;
      }
    }
    // Item stok lama dari alur laporan shift
    let legacySku: string | null = null;
    if (giftbox && opts.some((o) => o.name === "Reguler")) {
      const ser = opts.map((o) => legacyOf("Series")?.options.find((x) => x.name === o.name)?.legacy).find(Boolean);
      const pk = opts.find((o) => legacyOf("Paket")?.options.some((x) => x.name === o.name));
      const pkLegacy = pk ? legacyOf("Paket")?.options.find((x) => x.name === pk.name)?.legacy : undefined;
      if (ser && pk && (pk.name === "Standard" || pkLegacy)) legacySku = `BJ-GB-${ser}${pkLegacy ? `-${pkLegacy}` : ""}`;
    } else if (attrs.type === "SATUAN" && attrs.variant !== "MIX") legacySku = `BJ-SAT-${attrs.variant}`;
    const legacyItem = legacySku ? await db.item.findUnique({ where: { sku: legacySku }, select: { id: true, sku: true, name: true } }) : null;
    if (legacyItem && !linkedItemIds.has(legacyItem.id)) {
      linkedItemIds.add(legacyItem.id);
      out.push({ name, optionIds, attrs, action: "item-lama", existingItem: legacyItem });
      continue;
    }
    out.push({ name, optionIds, attrs, action: "baru" });
  }
  return out;
}

/** Jalankan rencana SKU: buat produk + item barang jadi (tanpa stok awal, tanpa harga), atau masukkan produk lama ke induk */
export async function applySkuPlan(db: Db, f: { id: string; name: string }, plans: SkuPlan[], opts: { storeId: string; unit: string }) {
  const cats = await itemCategories(db);
  const category = cats.BARANG_JADI[0]?.name ?? null;
  const prefix = await categoryPrefixOf(db, "BARANG_JADI", category);
  let created = 0;
  let linked = 0;
  for (const p of plans) {
    if (p.action === "ada") continue;
    const values = { create: p.optionIds.map((optionId) => ({ optionId })) };
    if (p.action === "produk-lama" && p.existingProduct) {
      await db.product.update({ where: { id: p.existingProduct.id }, data: { familyId: f.id, packQty: p.attrs.packQty, variantValues: values } });
      linked++;
      continue;
    }
    let itemId = p.existingItem?.id;
    if (itemId) await db.item.update({ where: { id: itemId }, data: { name: p.name, category: category ?? undefined } });
    else itemId = (await db.item.create({ data: { sku: await nextItemSku(db as Prisma.TransactionClient, prefix), name: p.name, type: "BARANG_JADI", unit: opts.unit, category } })).id;
    const item = await db.item.findUniqueOrThrow({ where: { id: itemId } });
    let sku = item.sku;
    if (await db.product.findUnique({ where: { sku } })) sku = `${sku}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
    await db.product.create({ data: { sku, name: p.name, type: p.attrs.type, variant: p.attrs.variant, packQty: p.attrs.packQty, storeId: opts.storeId, category, finishedItemId: itemId, familyId: f.id, variantValues: values } });
    created++;
  }
  return { created, linked };
}

/** Buat SKU untuk kombinasi yang belum ada (tombol di halaman induk) */
export async function generateMissingSkus(familyId: string) {
  const storeId = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value ?? (await prisma.store.findFirst({ orderBy: { code: "asc" } }))?.id;
  if (!storeId) throw new Error("Toko default belum diatur di Pengaturan");
  return prisma.$transaction(async (tx) => {
    const f = await tx.productFamily.findUniqueOrThrow({ where: { id: familyId }, include: familyInclude });
    const spec = CATALOG.find((c) => c.name === f.name);
    const plans = await planFamilySkus(tx, f, spec, storeId);
    const unit = spec?.unit ?? (f.type === "GIFTBOX" ? "box" : "pcs");
    return applySkuPlan(tx, f, plans, { storeId, unit });
  }, { timeout: 60000 });
}

// ---------------- Salin resep ----------------

/**
 * Salin resep produk `fromId` (bahan & kemasan, tenaga kerja, overhead, tambahan kemasan, target margin) ke produk tujuan.
 * Resep tujuan yang lama diganti. Setelah disalin, resep tiap SKU tetap bisa diubah sendiri.
 */
export async function copyRecipe(db: Db, fromId: string, toIds: string[]) {
  const src = await db.product.findUniqueOrThrow({ where: { id: fromId }, include: { bom: true, recipeLabor: true, recipeOverhead: true } });
  const targets = [...new Set(toIds)].filter((id) => id !== fromId);
  if (!src.bom.length && !src.recipeLabor.length && !src.recipeOverhead.length) throw new Error("Produk sumber belum punya resep");
  for (const productId of targets) {
    await db.bomLine.deleteMany({ where: { productId } });
    await db.recipeLabor.deleteMany({ where: { productId } });
    await db.recipeOverhead.deleteMany({ where: { productId } });
    if (src.bom.length) await db.bomLine.createMany({ data: src.bom.map((b) => ({ productId, itemId: b.itemId, qty: b.qty, useUnit: b.useUnit })) });
    if (src.recipeLabor.length) await db.recipeLabor.createMany({ data: src.recipeLabor.map((l) => ({ productId, taskId: l.taskId, name: l.name, rate: l.rate })) });
    if (src.recipeOverhead.length) await db.recipeOverhead.createMany({ data: src.recipeOverhead.map((o) => ({ productId, overheadId: o.overheadId, factor: o.factor })) });
    await db.product.update({ where: { id: productId }, data: { extraPackaging: src.extraPackaging, targetMargin: src.targetMargin, laborCost: 0, overheadCost: 0 } });
  }
  return targets.length;
}

// ---------------- Harga massal ----------------

export const PRICE_CHANNELS = ["OFFLINE", "SHOPEE", "TIKTOK_SHOP"] as const;

/**
 * Simpan harga banyak SKU sekaligus. Hanya harga yang berubah dari harga terakhir yang dicatat (riwayat harga tetap).
 * Harga kosong/0 dilewati.
 */
export async function saveBulkPrices(db: Db, rows: { productId: string; channel: string; price: number; hpp: number }[], createdBy: string) {
  let saved = 0;
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    const last = await db.priceHistory.findFirst({ where: { productId: r.productId, channel: r.channel }, orderBy: { effectiveAt: "desc" } });
    if (last && Number(last.price) === r.price) continue;
    await db.priceHistory.create({ data: { productId: r.productId, channel: r.channel, price: BigInt(Math.round(r.price)), hpp: BigInt(Math.round(r.hpp)), createdBy } });
    saved++;
  }
  return saved;
}

// ---------------- Katalog untuk laporan shift ----------------

/** SKU induk untuk isian laporan shift: tabel baris × kolom (kolom = kategori terakhir, mis. Series) */
export type CatalogCell = { productId: string; sku: string; name: string; patung: number; variant: ProductVariant };
export type CatalogGrid = { family: string; cols: string[]; rows: { label: string; cells: (CatalogCell | null)[] }[] };

export function catalogGrid(f: FamilyFull): CatalogGrid {
  const byCombo = productsByCombo(f);
  const axes = f.axes.map((a) => a.options.filter((o) => o.active));
  const colAxis = axes[axes.length - 1] ?? [];
  const rowCombos = combos(axes.slice(0, -1));
  const rows = rowCombos.map((ro) => ({
    label: ro.map((o) => o.name).join(" · "),
    cells: colAxis.map((co) => {
      const p = byCombo.get(comboKey([...ro, co].map((o) => o.id)));
      return p && p.active ? { productId: p.id, sku: p.sku, name: p.name, patung: p.packQty, variant: p.variant } : null;
    }),
  })).filter((r) => r.cells.some(Boolean));
  return { family: f.name, cols: colAxis.map((o) => o.name), rows };
}

export async function catalogGridByName(name: string, db: Db = prisma): Promise<CatalogGrid | null> {
  const f = await db.productFamily.findFirst({ where: { name, active: true }, include: familyInclude });
  return f ? catalogGrid(f) : null;
}

/** Katalog SKU untuk semua bagian katalog format laporan shift (null = induk belum ada / nonaktif) */
export async function reportCatalogs(template: string | null | undefined, db: Db = prisma): Promise<ReportCatalogs> {
  if (!isTemplate(template)) return {};
  const out: ReportCatalogs = {};
  for (const s of TEMPLATES[template].sections) if (s.kind === "catalog") out[s.key] = await catalogGridByName(s.family, db);
  return out;
}
