import type { Prisma, ProductVariant } from "@prisma/client";
import { prisma } from "./db";
import { SATUAN_ORDER, SINGLE_PACK_VARIANTS } from "./singlePackFix";

type Db = Prisma.TransactionClient | typeof prisma;

const WORD: Record<string, RegExp> = { HEWAN: /\bhewan\b/i, COWOK: /\bcowok\b/i, CEWEK: /\bcewek\b/i, TRANSPORTASI: /\btransport(asi)?\b/i };

/** Barang kandidat Single Pack untuk series: kode BJ-SAT-/SJ-SP-<series>, nama single pack/satuan/figur + series (bukan paket) */
export function isSinglePackCandidate(variant: string, it: { sku: string; name: string }) {
  const w = WORD[variant];
  if (!w || /\bpaket\b|giftbox/i.test(it.name)) return false;
  const sku = it.sku.toUpperCase();
  if ((sku.startsWith("BJ-SAT-") || sku.startsWith("SJ-SP-")) && w.test(sku.replace(/-/g, " "))) return true;
  return /(single\s*pack|satuan|figur)/i.test(it.name) && w.test(it.name);
}

export type SinglePackItemDiag = {
  id: string; sku: string; name: string; type: string; unit: string; active: boolean; division: string | null;
  stock: { location: string; qty: number }[]; movements: number; lastMove: string | null;
  usedBy: string[];
};
export type SinglePackDiag = { variant: ProductVariant; flowItemId: string | null; flowNote: string; items: SinglePackItemDiag[] };

/** Diagnosa READ-ONLY barang Single Pack per series (tidak membuat / mengubah apa pun) */
export async function diagnoseSinglePack(db: Db = prisma): Promise<SinglePackDiag[]> {
  const all = await db.item.findMany({ select: { id: true, sku: true, name: true, type: true, unit: true, active: true, division: { select: { name: true } } } });
  const locs = new Map((await db.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const out: SinglePackDiag[] = [];
  for (const variant of SINGLE_PACK_VARIANTS) {
    // Sama dengan flowItem(kind "jadi") tanpa membuat barang
    const fp = await db.product.findFirst({ where: { type: "SATUAN", variant, active: true, finishedItemId: { not: null } }, orderBy: SATUAN_ORDER, select: { sku: true, finishedItemId: true } });
    const legacy = all.find((i) => i.sku.toUpperCase() === `BJ-SAT-${variant}`);
    const flowItemId = fp?.finishedItemId ?? legacy?.id ?? null;
    const flowNote = fp ? `barang jadi produk ${fp.sku}` : legacy ? `barang ${legacy.sku} (tanpa produk)` : "belum ada (akan dibuat BJ-SAT-" + variant + " saat laporan diposting)";
    const extra = new Set<string>([
      ...(flowItemId ? [flowItemId] : []),
      ...(await db.product.findMany({ where: { type: "SATUAN", variant, finishedItemId: { not: null } }, select: { finishedItemId: true } })).map((p) => p.finishedItemId!),
    ]);
    const cands = all.filter((i) => extra.has(i.id) || isSinglePackCandidate(variant, i)).sort((a, b) => a.sku.localeCompare(b.sku));
    const items: SinglePackItemDiag[] = [];
    for (const it of cands) {
      const [ins, outs, movements, last, prods, bom, recipeComp, recipeOwn, tasks, reports] = await Promise.all([
        db.stockMovement.groupBy({ by: ["toLocationId"], where: { itemId: it.id, toLocationId: { not: null } }, _sum: { qty: true } }),
        db.stockMovement.groupBy({ by: ["fromLocationId"], where: { itemId: it.id, fromLocationId: { not: null } }, _sum: { qty: true } }),
        db.stockMovement.count({ where: { itemId: it.id } }),
        db.stockMovement.findFirst({ where: { itemId: it.id }, orderBy: { date: "desc" }, select: { date: true, ref: true, type: true } }),
        db.product.findMany({ where: { finishedItemId: it.id }, select: { sku: true, familyId: true, active: true } }),
        db.bomLine.count({ where: { itemId: it.id } }),
        db.itemRecipeLine.count({ where: { componentId: it.id } }),
        db.itemRecipeLine.count({ where: { itemId: it.id } }),
        db.pieceTask.findMany({ where: { outputItemId: it.id }, select: { code: true, name: true } }),
        db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "ShiftReport" WHERE "work"::text LIKE ${"%" + it.id + "%"}`,
      ]);
      const q = new Map<string, number>();
      for (const r of ins) q.set(r.toLocationId!, (q.get(r.toLocationId!) ?? 0) + Number(r._sum.qty ?? 0));
      for (const r of outs) q.set(r.fromLocationId!, (q.get(r.fromLocationId!) ?? 0) - Number(r._sum.qty ?? 0));
      const usedBy = [
        ...prods.map((p) => `produk ${p.sku}${p.familyId ? " (katalog Satuan Single Pack)" : " (produk lain)"}${p.active ? "" : " nonaktif"}`),
        ...(it.id === flowItemId ? ["flowItem laporan shift (Assembling → Packing)"] : []),
        ...(bom ? [`BOM produk ${bom} baris`] : []),
        ...(recipeComp ? [`komponen resep barang ${recipeComp} baris`] : []),
        ...(recipeOwn ? [`punya resep ${recipeOwn} bahan`] : []),
        ...tasks.map((t) => `tugas borongan ${t.code} ${t.name}`),
        ...(Number(reports[0]?.n ?? 0) ? [`hitungan/isi laporan shift ${Number(reports[0].n)} laporan`] : []),
      ];
      items.push({
        id: it.id, sku: it.sku, name: it.name, type: it.type, unit: it.unit, active: it.active, division: it.division?.name ?? null,
        stock: [...q].filter(([, n]) => Math.abs(n) > 0.0005).map(([l, n]) => ({ location: locs.get(l) ?? l, qty: n })),
        movements, lastMove: last ? `${last.date.toISOString().slice(0, 10)} ${last.type}${last.ref ? ` ${last.ref.split(":")[0]}` : ""}` : null,
        usedBy,
      });
    }
    out.push({ variant, flowItemId, flowNote, items });
  }
  return out;
}

/** Baris teks untuk konsol */
export function diagLines(d: SinglePackDiag[]): string[] {
  const L: string[] = [];
  for (const v of d) {
    L.push("", `== ${v.variant} == flowItem: ${v.flowNote} · ${v.items.length} barang kandidat${v.items.length > 1 ? "  ⚠ LEBIH DARI SATU" : ""}`);
    for (const i of v.items) {
      L.push(`  ${i.sku} "${i.name}" · ${i.type} · ${i.unit} · divisi ${i.division ?? "-"} · ${i.active ? "aktif" : "NONAKTIF"}`);
      L.push(`     stok: ${i.stock.length ? i.stock.map((s) => `${s.location} ${s.qty.toLocaleString("id-ID")}`).join(", ") : "0"} · ${i.movements} mutasi${i.lastMove ? ` (terakhir ${i.lastMove})` : ""}`);
      L.push(`     dipakai: ${i.usedBy.length ? i.usedBy.join("; ") : "tidak ada"}`);
    }
  }
  return L;
}
