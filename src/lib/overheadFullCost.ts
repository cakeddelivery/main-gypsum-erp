import type { Prisma, PrismaClient } from "@prisma/client";
import { COA } from "./accounting";
import { overheadUnitCost } from "./hpp";
import { biayaLpgPerPeriode } from "./biayaOven";

/**
 * FULL COSTING: overhead resep milik barang itu sendiri (RecipeOverhead pada Item; bukan yang tersemat di komponen — itu sudah ada di
 * harga komponen) ikut nilai persediaan saat HASIL_PRODUKSI. Jurnal: Dr Persediaan / Cr "Overhead Pabrik Dibebankan" (6-1850, kontra beban).
 * Beban aslinya (LPG, penyusutan, sewa, …) tetap dicatat di akunnya → laba bersih benar: beban − dibebankan = selisih (under/over-applied)
 * yang tetap menjadi beban periode; saat barang terjual HPP memakai avgCost yang sudah memuat overhead.
 * Batas: per overhead per bulan, yang dikapitalisasi tidak boleh melebihi beban aktual bulan itu.
 */
type Db = PrismaClient | Prisma.TransactionClient;
export const ohMemo = (overheadId: string) => `OH:${overheadId}`;
const memoToId = (m: string | null) => (m && m.startsWith("OH:") ? m.slice(3) : null);

const monthRange = (d: Date) => {
  const w = new Date(d.getTime() + 7 * 3600_000);
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: new Date(`${y}-${pad(m + 1)}-01T00:00:00+07:00`), to: new Date(`${m === 11 ? y + 1 : y}-${pad(((m + 1) % 12) + 1)}-01T00:00:00+07:00`) };
};

export type OwnOverhead = { overheadId: string; name: string; category: string; monthlyAmount: number; perPcs: number };

/** Overhead resep barang itu sendiri, tarif per pcs (kapasitas normal dari master / kapasitas global) */
export async function ownOverhead(db: Db, itemId: string): Promise<OwnOverhead[]> {
  const rows = await db.recipeOverhead.findMany({ where: { itemId }, include: { overhead: true } });
  if (!rows.length) return [];
  const cap = Number((await db.setting.findUnique({ where: { key: "overhead_capacity_pcs" } }))?.value ?? 0) || 0;
  return rows.map((r) => ({ overheadId: r.overheadId, name: r.overhead.name, category: r.overhead.category, monthlyAmount: Number(r.overhead.monthlyAmount), perPcs: overheadUnitCost(r.overhead, cap) * Number(r.factor) }));
}

/** Beban aktual satu overhead pada bulan `date`: LPG = isi ulang dibayar + estimasi (bila tak ada data: nilai master); lainnya = nilai master bulanan */
export async function overheadActual(db: Db, o: Pick<OwnOverhead, "category" | "monthlyAmount">, date: Date): Promise<number> {
  if (o.category === "LPG") {
    const p = (await biayaLpgPerPeriode(db, date))[5];
    return p.lpg.dipakai > 0 ? p.lpg.dipakai : o.monthlyAmount;
  }
  return o.monthlyAmount;
}

/** Yang sudah dibebankan ke persediaan untuk satu overhead pada bulan `date` (kredit − debit 6-1850 bermemo OH:<id>; pembalik dihitung ke bulan jurnal aslinya) */
export async function overheadApplied(db: Db, overheadId: string, date: Date): Promise<number> {
  const { from, to } = monthRange(date);
  const where = { memo: ohMemo(overheadId), account: { code: COA.OVERHEAD_DIBEBANKAN } };
  // Jurnal asli bulan itu + pembaliknya (pembalik bisa bertanggal bulan lain, mis. setoran bulan lalu dibatalkan hari ini)
  const orig = await db.journalLine.findMany({ where: { ...where, journal: { date: { gte: from, lt: to }, reversalOfId: null } }, select: { debit: true, credit: true, journalId: true } });
  const ids = [...new Set(orig.map((l) => l.journalId))];
  const rev = ids.length ? await db.journalLine.findMany({ where: { ...where, journal: { reversalOfId: { in: ids } } }, select: { debit: true, credit: true } }) : [];
  return [...orig, ...rev].reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0);
}

export function capAmount(wanted: number, actual: number, applied: number) {
  return Math.max(0, Math.min(wanted, actual - applied));
}

export type OhApplied = { lines: { overheadId: string; name: string; amount: number }[]; total: number; wanted: number };

/** Overhead resep sendiri × qty, dibatasi beban aktual bulan itu (yang sudah dibebankan dihitung). Dipanggil di dalam transaksi posting. */
export async function applyOwnOverhead(db: Db, itemId: string, qty: number, date: Date): Promise<OhApplied> {
  const own = await ownOverhead(db, itemId);
  const lines: OhApplied["lines"] = [];
  let wanted = 0;
  for (const o of own) {
    const w = Math.round(o.perPcs * qty);
    wanted += w;
    if (w <= 0) continue;
    const amount = capAmount(w, await overheadActual(db, o, date), await overheadApplied(db, o.overheadId, date));
    if (amount > 0) lines.push({ overheadId: o.overheadId, name: o.name, amount });
  }
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0), wanted };
}

/** Baris jurnal kredit 6-1850 per overhead (memo OH:<id> dipakai untuk batas bulanan & laporan) */
export const overheadCreditLines = (a: OhApplied) => a.lines.map((l) => ({ accountCode: COA.OVERHEAD_DIBEBANKAN, credit: l.amount, memo: ohMemo(l.overheadId) }));

// ---------------- Laporan read-only: cek:overhead-bulanan ----------------

export type OverheadBulan = { bulan: string; rows: { overheadId: string; nama: string; category: string; aktual: number; dibebankan: number; selisih: number }[]; aktual: number; dibebankan: number; selisih: number };

/** Overhead aktual vs yang dibebankan ke persediaan per bulan (6 bulan). selisih > 0 = under-applied, < 0 = over-applied; keduanya tetap beban periode. */
export async function overheadBulanan(db: Db, now: Date = new Date()): Promise<OverheadBulan[]> {
  const used = await db.recipeOverhead.findMany({ where: { itemId: { not: null }, overhead: { active: true } }, include: { overhead: true } });
  const masters = [...new Map(used.map((r) => [r.overheadId, r.overhead])).values()];
  const out: OverheadBulan[] = [];
  const w = new Date(now.getTime() + 7 * 3600_000);
  for (let k = 5; k >= 0; k--) {
    const d = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() - k, 15, 5));
    const rows: OverheadBulan["rows"] = [];
    for (const o of masters) {
      const aktual = await overheadActual(db, { category: o.category, monthlyAmount: Number(o.monthlyAmount) }, d);
      const dibebankan = await overheadApplied(db, o.id, d);
      rows.push({ overheadId: o.id, nama: o.name, category: o.category, aktual, dibebankan, selisih: aktual - dibebankan });
    }
    const { from, to } = monthRange(d);
    const lainnya = (await db.journalLine.findMany({ where: { account: { code: COA.OVERHEAD_DIBEBANKAN }, journal: { date: { gte: from, lt: to } } }, select: { debit: true, credit: true, memo: true } })).filter((l) => !masters.some((m) => memoToId(l.memo) === m.id)).reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    const aktual = rows.reduce((s, r) => s + r.aktual, 0);
    const dibebankan = rows.reduce((s, r) => s + r.dibebankan, 0) + lainnya;
    out.push({ bulan: d.toISOString().slice(0, 7), rows, aktual, dibebankan, selisih: aktual - dibebankan });
  }
  return out;
}
