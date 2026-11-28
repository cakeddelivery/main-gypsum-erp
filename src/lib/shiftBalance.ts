import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { locationSettings, qtyAt } from "./stock";
import { shiftEndAt, type StockCountRow, type WorkData } from "./shiftReport";
import { storedCounts } from "./shiftResultCount";

/**
 * NERACA stok per barang per shift: awal + masuk − keluar − reject = sistem akhir; dibandingkan hitung fisik akhir.
 * Selisih = fisik − sistem akhir (negatif = kebocoran/hilang). Mutasi penyesuaian hasil hitung laporan ini sendiri (LPS:/LAP:<laporan>)
 * TIDAK ikut dihitung (itulah selisihnya). Jendela = jam selesai shift sebelumnya → jam selesai shift ini.
 */
export type InKind = "produksi" | "masuk" | "borongan" | "lain";
export type OutKind = "pakai" | "borongan" | "jual" | "reject" | "lain";

export type MoveLite = { type: string; ref: string | null; fromLocationId: string | null; toLocationId: string | null };

/** Penggolongan satu mutasi terhadap lokasi gudang `loc` (null = tidak menyentuh / dikecualikan) */
export function classifyMovement(m: MoveLite, loc: string, reportId: string): { dir: "in" | "out"; kind: InKind | OutKind } | null {
  const ref = m.ref ?? "";
  if (ref === `LPS:${reportId}` || ref === `LAP:${reportId}`) return null;
  const into = m.toLocationId === loc, outOf = m.fromLocationId === loc;
  if (into === outOf) return null; // tidak menyentuh, atau pindah di dalam lokasi yang sama
  const p = ref.split(/[:-]/)[0];
  if (into) {
    if (p === "KRM" || p === "BGI" || p === "PND" || p === "AMB" || p === "SRT" || p === "PNR") return { dir: "in", kind: "borongan" };
    if (m.type === "HASIL_PRODUKSI" || p === "LPH" || p === "PRD") return { dir: "in", kind: "produksi" };
    if (m.type === "PENERIMAAN" || p === "RTR" || p === "AMBIL") return { dir: "in", kind: "masuk" };
    return { dir: "in", kind: "lain" };
  }
  if (p === "RJK") return { dir: "out", kind: "reject" };
  if (p === "KRM" || p === "BGI" || p === "SRT" || p === "PND" || p === "AMB") return { dir: "out", kind: "borongan" };
  if (m.type === "KONSUMSI_PRODUKSI" || p === "LPH") return { dir: "out", kind: "pakai" };
  if (m.type === "PENGELUARAN" || p === "JUAL") return { dir: "out", kind: "jual" };
  return { dir: "out", kind: "lain" };
}

export type BalanceRow = {
  itemId: string; name: string; unit: string; type: ItemType; opening: number;
  produksi: number; masuk: number; inBorongan: number; inLain: number;
  pakai: number; outBorongan: number; jual: number; reject: number; outLain: number;
  systemClosing: number; counted: number | null; diff: number | null; unitCost: number;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export async function computeShiftBalance(reportId: string, now: Date = new Date()): Promise<BalanceRow[]> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const locs = await locationSettings(prisma);
  const locOf = (t: ItemType) => (t === "BARANG_DALAM_PROSES" ? locs.wip : t === "BARANG_JADI" ? locs.finished : locs.raw);
  const end = shiftEndAt(r.date, r.shift, now);
  const prev = await prisma.shiftReport.findFirst({
    where: { divisionId: r.divisionId, id: { not: r.id }, OR: [{ date: { lt: r.date } }, { date: r.date, shift: { code: { lt: r.shift.code } } }] },
    include: { shift: true },
    orderBy: [{ date: "desc" }, { shift: { code: "desc" } }],
  });
  let start = prev ? shiftEndAt(prev.date, prev.shift, now) : new Date(end.getTime() - 12 * 3600_000);
  if (start >= end) start = new Date(end.getTime() - 12 * 3600_000);

  // Barang yang dihitung di laporan: stok akhir setengah jadi/jadi dan bahan baku
  const counted = new Map<string, number | null>();
  for (const [id, n] of await prisma.$transaction((tx) => storedCounts(r.work as WorkData, r.division.reportTemplate, tx))) counted.set(id, n);
  for (const row of (r.stockCount as StockCountRow[]) ?? []) if (row.qty != null) counted.set(row.itemId, row.qty);
  if (!counted.size) return [];
  const items = await prisma.item.findMany({ where: { id: { in: [...counted.keys()] } } });
  const out: BalanceRow[] = [];
  for (const it of items) {
    const loc = locOf(it.type);
    if (!loc) continue;
    const moves = await prisma.stockMovement.findMany({ where: { itemId: it.id, date: { gt: start, lte: end }, OR: [{ toLocationId: loc }, { fromLocationId: loc }] }, select: { type: true, ref: true, fromLocationId: true, toLocationId: true, qty: true } });
    const row: BalanceRow = { itemId: it.id, name: it.name, unit: it.unit, type: it.type, opening: r3(await qtyAt(prisma, it.id, loc, start)), produksi: 0, masuk: 0, inBorongan: 0, inLain: 0, pakai: 0, outBorongan: 0, jual: 0, reject: 0, outLain: 0, systemClosing: 0, counted: counted.get(it.id) ?? null, diff: null, unitCost: Number(it.avgCost) };
    for (const m of moves) {
      const c = classifyMovement(m, loc, r.id);
      if (!c) continue;
      const q = Number(m.qty);
      if (c.dir === "in") { if (c.kind === "produksi") row.produksi += q; else if (c.kind === "masuk") row.masuk += q; else if (c.kind === "borongan") row.inBorongan += q; else row.inLain += q; }
      else if (c.kind === "pakai") row.pakai += q; else if (c.kind === "borongan") row.outBorongan += q; else if (c.kind === "jual") row.jual += q; else if (c.kind === "reject") row.reject += q; else row.outLain += q;
    }
    row.systemClosing = r3(row.opening + row.produksi + row.masuk + row.inBorongan + row.inLain - row.pakai - row.outBorongan - row.jual - row.reject - row.outLain);
    row.diff = row.counted == null ? null : r3(row.counted - row.systemClosing);
    for (const k of ["produksi", "masuk", "inBorongan", "inLain", "pakai", "outBorongan", "jual", "reject", "outLain"] as const) row[k] = r3(row[k]);
    out.push(row);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

/** Simpan snapshot neraca (saat laporan dikirim/direvisi): menggantikan snapshot lama laporan itu */
export async function saveShiftBalance(reportId: string, now: Date = new Date()) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, select: { divisionId: true, picName: true } });
  const rows = await computeShiftBalance(reportId, now);
  await prisma.$transaction([
    prisma.shiftBalance.deleteMany({ where: { reportId } }),
    prisma.shiftBalance.createMany({
      data: rows.map((x) => ({
        reportId, divisionId: r.divisionId, itemId: x.itemId, opening: new Prisma.Decimal(x.opening), inProduksi: new Prisma.Decimal(x.produksi), inMasuk: new Prisma.Decimal(x.masuk), inBorongan: new Prisma.Decimal(x.inBorongan), inLain: new Prisma.Decimal(x.inLain),
        outPakai: new Prisma.Decimal(x.pakai), outBorongan: new Prisma.Decimal(x.outBorongan), outJual: new Prisma.Decimal(x.jual), outReject: new Prisma.Decimal(x.reject), outLain: new Prisma.Decimal(x.outLain),
        systemClosing: new Prisma.Decimal(x.systemClosing), counted: x.counted == null ? null : new Prisma.Decimal(x.counted), diff: x.diff == null ? null : new Prisma.Decimal(x.diff), unitCost: BigInt(Math.round(x.unitCost)), picName: r.picName,
      })),
    }),
  ]);
  return rows;
}

/** Baris teks borongan untuk laporan: keluar ke borongan (KRM/BGI) & masuk dari borongan (PND/AMB) per barang */
export function boronganBalanceLines(rows: BalanceRow[]): string[] {
  const f = (n: number) => n.toLocaleString("id-ID");
  const list = rows.filter((x) => x.outBorongan > 0 || x.inBorongan > 0);
  if (!list.length) return [];
  return ["BORONGAN (otomatis dari kiriman & setoran)", ...list.map((x) => `${x.name}: keluar ke borongan ${f(x.outBorongan)} · masuk dari borongan ${f(x.inBorongan)} ${x.unit}`)];
}
