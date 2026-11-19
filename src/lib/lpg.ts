import { prisma } from "./db";
import { addDays, dateOnly, dateStr, todayStr } from "./time";

/**
 * LPG tabung 5 kg di laporan Oven: tiap shift melaporkan jumlah tabung per status (penuh / aktif terpasang / kosong) + isi ulang yang diterima.
 * Total tabung = aset (bawaan 3, bisa diubah di Pengaturan bila membeli tabung baru). Pemakaian dihitung saat tabung pindah AKTIF → KOSONG.
 * Isi ulang fisik dipasangkan otomatis ke transaksi pembelian Finance (yang sering dicatat malam/esok hari) — menunggu, bukan error.
 */
export const LPG_KEY = "_lpg";
export const LPG_TOTAL_SETTING = "lpg_total_aset";
export const LPG_KG_PER_TABUNG = 5;
export const LPG_PAIR_WINDOW_BEFORE_DAYS = 1;
export const LPG_PAIR_WINDOW_AFTER_DAYS = 5;
/** Isi ulang fisik yang belum dicatat Finance lebih dari ini (hari) = peringatan */
export const LPG_REFILL_ALERT_DAYS = 2;

export { lpgFlow, type LpgInput } from "./lpgShared";
import { lpgFlow, type LpgInput } from "./lpgShared";

const int = (s: string | null) => {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error("Jumlah tabung LPG harus bilangan bulat 0–99");
  return n;
};

/** Isian form: lpg.penuh / lpg.aktif / lpg.kosong / lpg.isiUlang. Semua kosong = tidak dilaporkan (null) */
export function parseLpg(get: (k: string) => string | null): LpgInput | null {
  const v = { penuh: int(get("lpg.penuh")), aktif: int(get("lpg.aktif")), kosong: int(get("lpg.kosong")), isiUlang: int(get("lpg.isiUlang")) };
  if (v.penuh == null && v.aktif == null && v.kosong == null && v.isiUlang == null) return null;
  if (v.penuh == null || v.aktif == null || v.kosong == null) throw new Error("Isi jumlah tabung LPG penuh, aktif, dan kosong (0 bila tidak ada)");
  return { penuh: v.penuh, aktif: v.aktif, kosong: v.kosong, isiUlang: v.isiUlang ?? 0 };
}

export function storedLpg(work: unknown): LpgInput | null {
  const raw = work && typeof work === "object" ? (work as Record<string, unknown>)[LPG_KEY] : null;
  const x = raw as Partial<LpgInput> | null;
  return x && Number.isInteger(x.penuh) && Number.isInteger(x.aktif) && Number.isInteger(x.kosong) ? { penuh: x.penuh!, aktif: x.aktif!, kosong: x.kosong!, isiUlang: x.isiUlang ?? 0 } : null;
}

export async function lpgTotalAset(): Promise<number> {
  const v = Number((await prisma.setting.findUnique({ where: { key: LPG_TOTAL_SETTING } }))?.value);
  return Number.isInteger(v) && v > 0 ? v : 3;
}

/** Status tabung laporan sebelumnya (terbaru sebelum/sampai tanggal laporan ini) untuk prefill & turunan */
export async function previousLpg(reportId: string, date: Date) {
  return prisma.lpgState.findFirst({ where: { reportId: { not: reportId }, date: { lte: date } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }] });
}

/** Simpan status tabung + isi ulang laporan (dipanggil saat laporan Oven dikirim/direvisi) lalu pasangkan ke transaksi Finance */
export async function applyLpg(reportId: string, picName: string | null) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, select: { date: true, work: true } });
  const cur = storedLpg(r.work);
  if (!cur) return null;
  const prev = await previousLpg(reportId, r.date);
  const flow = lpgFlow(prev, cur);
  const total = cur.penuh + cur.aktif + cur.kosong;
  const data = { date: r.date, penuh: cur.penuh, aktif: cur.aktif, kosong: cur.kosong, isiUlang: cur.isiUlang, dipasang: flow.dipasang, habis: flow.habis, total, picName };
  await prisma.lpgState.upsert({ where: { reportId }, create: { reportId, ...data }, update: data });
  const refill = await prisma.lpgRefill.findUnique({ where: { reportId } });
  if (cur.isiUlang > 0) {
    if (!refill) await prisma.lpgRefill.create({ data: { reportId, physicalDate: r.date, tabung: cur.isiUlang } });
    else if (refill.tabung !== cur.isiUlang || refill.physicalDate.getTime() !== r.date.getTime()) await prisma.lpgRefill.update({ where: { reportId }, data: { tabung: cur.isiUlang, physicalDate: r.date, status: "MENUNGGU", transactionId: null, amount: null, pricePerTabung: null, pairedAt: null } });
  } else if (refill) await prisma.lpgRefill.delete({ where: { reportId } });
  await pairLpgRefills();
  return { ...flow, total, totalAset: await lpgTotalAset() };
}

const LPG_WORDS = /\b(lpg|gas|elpiji|tabung)\b/i;

/**
 * Pasangkan isi ulang fisik yang menunggu ke transaksi pengeluaran Finance (dibukukan) yang menyebut LPG/gas/tabung
 * (di catatan, penerima, teks asli, atau nama kategori), tanggalnya dekat tanggal fisik (−1 s/d +5 hari), belum terpasang.
 * Harga per tabung = nominal ÷ jumlah tabung laporan. Aman dipanggil berulang.
 */
export async function pairLpgRefills(): Promise<number> {
  const waiting = await prisma.lpgRefill.findMany({ where: { status: "MENUNGGU" }, orderBy: { physicalDate: "asc" } });
  if (!waiting.length) return 0;
  const from = addDays(dateStr(waiting[0].physicalDate), -LPG_PAIR_WINDOW_BEFORE_DAYS);
  const to = addDays(dateStr(waiting[waiting.length - 1].physicalDate), LPG_PAIR_WINDOW_AFTER_DAYS + 1);
  const [txs, used, cats] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { direction: "KELUAR", status: "DIBUKUKAN", deletedAt: null, date: { gte: dateOnly(from), lt: dateOnly(to) } }, select: { id: true, date: true, amount: true, note: true, counterparty: true, rawText: true, categoryId: true } }),
    prisma.lpgRefill.findMany({ where: { transactionId: { not: null } }, select: { transactionId: true } }),
    prisma.txCategory.findMany({ select: { id: true, name: true } }),
  ]);
  const taken = new Set(used.map((u) => u.transactionId));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  let n = 0;
  for (const w of waiting) {
    const lo = addDays(dateStr(w.physicalDate), -LPG_PAIR_WINDOW_BEFORE_DAYS), hi = addDays(dateStr(w.physicalDate), LPG_PAIR_WINDOW_AFTER_DAYS);
    const cands = txs
      .filter((t) => !taken.has(t.id) && dateStr(t.date) >= lo && dateStr(t.date) <= hi && LPG_WORDS.test(`${t.note ?? ""} ${t.counterparty ?? ""} ${t.rawText ?? ""} ${catName.get(t.categoryId ?? "") ?? ""}`))
      .sort((a, b) => Math.abs(a.date.getTime() - w.physicalDate.getTime()) - Math.abs(b.date.getTime() - w.physicalDate.getTime()));
    const t = cands[0];
    if (!t) continue;
    taken.add(t.id);
    await prisma.lpgRefill.update({ where: { id: w.id }, data: { status: "DIPASANGKAN", transactionId: t.id, amount: t.amount, pricePerTabung: BigInt(Math.round(Number(t.amount) / w.tabung)), pairedAt: new Date() } });
    n++;
  }
  return n;
}

/** Ringkasan rentang hari (bawaan 7): tabung habis vs isi ulang, Rp per tabung, isi ulang belum dicatat, status total aset */
export async function lpgSummary(days = 7, now: Date = new Date()) {
  const since = dateOnly(addDays(todayStr(now), -days));
  const [states, refills, aset, latest] = await Promise.all([
    prisma.lpgState.findMany({ where: { date: { gte: since } } }),
    prisma.lpgRefill.findMany({ where: { physicalDate: { gte: since } } }),
    lpgTotalAset(),
    prisma.lpgState.findFirst({ orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
  ]);
  const habis = states.reduce((a, x) => a + x.habis, 0);
  const isiUlang = refills.reduce((a, x) => a + x.tabung, 0);
  const paired = refills.filter((x) => x.status === "DIPASANGKAN");
  const amount = paired.reduce((a, x) => a + Number(x.amount ?? 0), 0);
  const tabungPaired = paired.reduce((a, x) => a + x.tabung, 0);
  const lateBefore = dateOnly(addDays(todayStr(now), -LPG_REFILL_ALERT_DAYS));
  const lateWaiting = refills.filter((x) => x.status === "MENUNGGU" && x.physicalDate < lateBefore).length;
  return { days, habis, isiUlang, selisih: isiUlang - habis, amount, pricePerTabung: tabungPaired ? Math.round(amount / tabungPaired) : null, lateWaiting, aset, latestTotal: latest?.total ?? null, totalMismatch: latest ? latest.total !== aset : false };
}
