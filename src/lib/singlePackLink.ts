import type { Prisma, PrismaClient, ProductVariant } from "@prisma/client";
import { SATUAN_FAMILY } from "./productFamily";
import { itemQty } from "./stock";

type Db = PrismaClient | Prisma.TransactionClient;

/** Varian Single Pack (urutan tampilan laporan) */
export const SINGLE_PACK_VARIANTS = ["Hewan", "Cowok", "Cewek", "Transportasi"] as const;

/** Nama barang "Single Pack <varian>" (Transportasi juga "Transport"); bukan paket / satuan katalog */
export function isSinglePackName(variant: string, name: string) {
  const v = variant.toLowerCase() === "transportasi" ? "transport(asi)?" : variant.toLowerCase();
  return new RegExp(`^\\s*single\\s*pack\\s+${v}\\s*$`, "i").test(name);
}

export type SinglePackLink = {
  variant: string;
  /** ok = sudah tertaut; tautkan = finishedItemId produk katalog diarahkan ke barang Single Pack; lainnya hanya dilaporkan */
  status: "ok" | "tautkan" | "ganda" | "tidak-ada" | "bentrok" | "tanpa-produk";
  text: string;
  productId?: string;
  itemId?: string;
};

/**
 * Rencana tautan produk katalog "Satuan Single Pack" (per varian) → barang "Single Pack <varian>".
 * Tahap "Stok jadi" laporan shift mengelompokkan barang lewat Product.finishedItemId; bila produk katalog
 * menunjuk barang lain, barang Single Pack jatuh ke "Produk jadi lainnya". Tidak mengubah apa pun.
 */
export async function planSinglePackLinks(db: Db): Promise<SinglePackLink[]> {
  const fam = await db.productFamily.findFirst({ where: { name: SATUAN_FAMILY }, select: { id: true } });
  const out: SinglePackLink[] = [];
  const pool = await db.item.findMany({ where: { name: { contains: "single", mode: "insensitive" } }, select: { id: true, sku: true, name: true, active: true } });
  for (const v of SINGLE_PACK_VARIANTS) {
    const products = fam ? await db.product.findMany({ where: { familyId: fam.id, variant: v.toUpperCase() as ProductVariant }, orderBy: { sku: "asc" }, select: { id: true, sku: true, name: true, finishedItemId: true } }) : [];
    const items = pool.filter((i) => isSinglePackName(v, i.name)).sort((a, b) => Number(b.active) - Number(a.active) || a.sku.localeCompare(b.sku));
    const list = (xs: typeof items) => xs.map((i) => `${i.sku} "${i.name}"${i.active ? "" : " nonaktif"}`).join(", ");
    if (products.length !== 1) {
      out.push({ variant: v, status: "tanpa-produk", text: `Single Pack ${v}: ${products.length ? `${products.length} produk katalog (${products.map((p) => p.sku).join(", ")}) — produk ganda, pilih satu` : `produk katalog ${SATUAN_FAMILY} · ${v} belum ada`} — dilewati` });
      continue;
    }
    const p = products[0];
    const active = items.filter((i) => i.active);
    if (p.finishedItemId && items.some((i) => i.id === p.finishedItemId)) {
      const dup = items.filter((i) => i.id !== p.finishedItemId);
      out.push({ variant: v, status: "ok", productId: p.id, itemId: p.finishedItemId, text: `Single Pack ${v}: ${p.sku} sudah tertaut ke barang Single Pack${dup.length ? ` — PERHATIAN barang Single Pack ganda: ${list(dup)}` : ""}` });
      continue;
    }
    if (active.length > 1) {
      out.push({ variant: v, status: "ganda", productId: p.id, text: `Single Pack ${v}: barang Single Pack GANDA (${list(active)}) — pilih satu & nonaktifkan yang lain; ${p.sku} TIDAK ditautkan` });
      continue;
    }
    if (!active.length) {
      out.push({ variant: v, status: "tidak-ada", productId: p.id, text: `Single Pack ${v}: barang "Single Pack ${v}" aktif tidak ditemukan${items.length ? ` (nonaktif: ${list(items)})` : ""} — dilewati` });
      continue;
    }
    const s = active[0];
    const other = await db.product.findUnique({ where: { finishedItemId: s.id }, select: { sku: true, name: true } });
    if (other) {
      out.push({ variant: v, status: "bentrok", productId: p.id, itemId: s.id, text: `Single Pack ${v}: barang ${s.sku} sudah dipakai produk lain ${other.sku} "${other.name}" — konfirmasi Owner; ${p.sku} TIDAK ditautkan` });
      continue;
    }
    const old = p.finishedItemId ? await db.item.findUnique({ where: { id: p.finishedItemId }, select: { sku: true, name: true } }) : null;
    const oldQty = p.finishedItemId ? await itemQty(db, p.finishedItemId) : 0;
    const was = old ? `dulu ${old.sku} "${old.name}"${oldQty ? ` — stok ${oldQty.toLocaleString("id-ID")} tetap di barang lama (tidak dipindah)` : ""}` : "dulu belum tertaut";
    out.push({ variant: v, status: "tautkan", productId: p.id, itemId: s.id, text: `Single Pack ${v}: ${p.sku} "${p.name}" → barang ${s.sku} "${s.name}" (${was})` });
  }
  return out;
}

/** Jalankan rencana: hanya mengubah Product.finishedItemId (tidak menghapus barang / stok) */
export async function applySinglePackLinks(db: Db, links: SinglePackLink[]) {
  let n = 0;
  for (const l of links) {
    if (l.status !== "tautkan" || !l.productId || !l.itemId) continue;
    await db.product.update({ where: { id: l.productId }, data: { finishedItemId: l.itemId } });
    n++;
  }
  return n;
}
