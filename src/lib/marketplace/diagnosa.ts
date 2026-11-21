import { prisma } from "../db";
import { n } from "../money";

/**
 * DIAGNOSA withdraw (HANYA BACA, tanpa data pribadi): bagaimana withdraw marketplace sebenarnya tercatat di Keuangan,
 * dan seberapa banyak penarikan file yang bisa dipadankan bila aturan dilonggarkan. Tidak mengubah apa pun.
 */
const KEY = /withdraw|tarik|penarikan|shopee|tiktok|tokopedia|tts|shp/i;
const DAY = 86400000;
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);

export type DiagTx = { date: string; dir: string; from: string; to: string; cat: string; source: string; store: string; hasRef: boolean; amount: number; sameAmountAsFile: boolean; keyword: boolean; origin: string };
export type FileWd = { id: string; store: string; ch: string; amount: number; date: Date };
type T = { id: string; amount: number; date: Date };

/** Pasangan 1-1 (nominal sama, selisih tanggal ≤ tol hari), terdekat dulu */
export function pairByAmount(txs: T[], files: { id: string; amount: number; date: Date }[], tolDays: number) {
  const cand: { t: string; f: string; d: number }[] = [];
  for (const t of txs) for (const f of files) if (t.amount === f.amount) { const d = Math.abs(t.date.getTime() - f.date.getTime()); if (d <= tolDays * DAY) cand.push({ t: t.id, f: f.id, d }); }
  cand.sort((a, b) => a.d - b.d);
  const ut = new Set<string>(), uf = new Set<string>();
  for (const c of cand) if (!ut.has(c.t) && !uf.has(c.f)) { ut.add(c.t); uf.add(c.f); }
  return { tx: ut, file: uf };
}

/** Satu transaksi = jumlah beberapa penarikan file (satu kanal, satu hari ± tol; semua toko / lintas toko). Hanya 2–4 penarikan, tanpa memakai file yang sudah terpakai */
export function pairBySum(txs: T[], files: FileWd[], tolDays: number, maxParts = 4) {
  const usedF = new Set<string>(), usedT = new Set<string>();
  const found: { tx: string; parts: number; crossStore: boolean }[] = [];
  const byCh = new Map<string, FileWd[]>();
  for (const f of files) byCh.set(f.ch, [...(byCh.get(f.ch) ?? []), f]);
  for (const t of txs) {
    for (const [, list] of byCh) {
      const near = list.filter((f) => !usedF.has(f.id) && Math.abs(f.date.getTime() - t.date.getTime()) <= tolDays * DAY).slice(0, 14);
      let hit: FileWd[] | null = null;
      const rec = (i: number, cur: FileWd[], sum: number) => {
        if (hit || cur.length > maxParts) return;
        if (cur.length >= 2 && sum === t.amount) { hit = [...cur]; return; }
        if (i >= near.length || sum > t.amount) return;
        rec(i + 1, [...cur, near[i]], sum + near[i].amount);
        rec(i + 1, cur, sum);
      };
      rec(0, [], 0);
      if (hit) { const h = hit as FileWd[]; for (const f of h) usedF.add(f.id); usedT.add(t.id); found.push({ tx: t.id, parts: h.length, crossStore: new Set(h.map((x) => x.store)).size > 1 }); break; }
    }
  }
  return { found, usedT };
}

export async function diagnoseWithdraws(opts: { from: string; to: string }) {
  const from = new Date(`${opts.from}T00:00:00+07:00`), to = new Date(`${opts.to}T23:59:59+07:00`);
  const wide = new Date(from.getTime() - 6 * DAY), wideTo = new Date(to.getTime() + 6 * DAY);
  const stores = new Map((await prisma.store.findMany({ select: { id: true, code: true } })).map((s) => [s.id, s.code]));
  const fileRows = await prisma.marketplaceWithdrawal.findMany({ where: { txType: { contains: "withdraw", mode: "insensitive" }, requestedAt: { gte: from, lte: to } }, select: { id: true, storeId: true, channel: true, amount: true, requestedAt: true } });
  const files: FileWd[] = fileRows.filter((f) => f.requestedAt).map((f) => ({ id: f.id, store: stores.get(f.storeId) ?? "?", ch: f.channel, amount: Math.abs(n(f.amount)), date: f.requestedAt! }));
  const fileAmounts = new Set(files.map((f) => f.amount));
  const banks = new Map((await prisma.bankAccount.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  const cats = new Map((await prisma.txCategory.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const txsRaw = await prisma.financeTransaction.findMany({
    where: { deletedAt: null, status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, date: { gte: wide, lte: wideTo }, direction: { in: ["MASUK", "TRANSFER"] } },
    select: { id: true, direction: true, accountId: true, toAccountId: true, categoryId: true, source: true, storeId: true, withdrawRef: true, amount: true, date: true, origin: true, note: true, counterparty: true },
  });
  const rows = txsRaw.map((t) => {
    const from_ = t.accountId ? banks.get(t.accountId) ?? "?" : "-", to_ = t.toAccountId ? banks.get(t.toAccountId) ?? "?" : "-", cat = t.categoryId ? cats.get(t.categoryId) ?? "?" : "-";
    const keyword = KEY.test(`${t.note ?? ""} ${t.counterparty ?? ""} ${cat} ${from_} ${to_}`); // hanya penanda ya/tidak; teks tidak dicetak
    return { t, view: { date: wib(t.date), dir: t.direction as string, from: from_, to: to_, cat, source: t.source as string, store: t.storeId ? stores.get(t.storeId) ?? "?" : "-", hasRef: !!t.withdrawRef, amount: n(t.amount), sameAmountAsFile: fileAmounts.has(n(t.amount)), keyword, origin: t.origin ?? "-" } satisfies DiagTx };
  });
  const inRange = rows.filter((r) => r.t.date >= from && r.t.date <= to);
  const cand = inRange.filter((r) => r.view.sameAmountAsFile || r.view.keyword);
  // ringkasan kombinasi
  const combo = new Map<string, { count: number; sum: number; sameAmt: number }>();
  for (const r of cand) {
    const k = `${r.view.dir} | dari ${r.view.from} → ${r.view.to} | kategori ${r.view.cat} | sumber ${r.view.source}${r.view.origin !== "-" ? ` (${r.view.origin})` : ""}`;
    const e = combo.get(k) ?? { count: 0, sum: 0, sameAmt: 0 };
    e.count++; e.sum += r.view.amount; e.sameAmt += r.view.sameAmountAsFile ? 1 : 0;
    combo.set(k, e);
  }
  // kecocokan bila toleransi dilebarkan (hanya kandidat); satu per satu per nominal lalu jumlah
  const candT: T[] = rows.map((r) => ({ id: r.t.id, amount: r.view.amount, date: r.t.date })).filter((t) => cand.some((c) => c.t.id === t.id) || fileAmounts.has(t.amount));
  const tol = [0, 1, 2, 3, 4, 5].map((d) => { const p = pairByAmount(candT, files.map((f) => ({ id: f.id, amount: f.amount, date: f.date })), d); return { days: d, files: p.file.size, txs: p.tx.size }; });
  const oneToOne5 = pairByAmount(candT, files.map((f) => ({ id: f.id, amount: f.amount, date: f.date })), 5);
  const leftoverTx = cand.map((c) => ({ id: c.t.id, amount: c.view.amount, date: c.t.date })).filter((t) => !oneToOne5.tx.has(t.id));
  const sums = pairBySum(leftoverTx, files.filter((f) => !oneToOne5.file.has(f.id)), 2);
  const perDayPerCh = new Map<string, number>();
  for (const f of files) perDayPerCh.set(`${f.ch}|${wib(f.date)}`, (perDayPerCh.get(`${f.ch}|${wib(f.date)}`) ?? 0) + 1);
  return {
    range: opts, fileWithdraws: files.length, fileByChannel: ["SHP", "TTS"].map((c) => ({ ch: c, count: files.filter((f) => f.ch === c).length, sum: files.filter((f) => f.ch === c).reduce((a, f) => a + f.amount, 0) })),
    financeTxInRange: inRange.length, candidates: cand.map((c) => c.view).sort((a, b) => a.date.localeCompare(b.date)),
    combos: [...combo.entries()].sort((a, b) => b[1].count - a[1].count), tol,
    sumMatches: { txs: sums.usedT.size, details: sums.found, candidatesLeft: leftoverTx.length },
    daysWithMultipleWithdraws: [...perDayPerCh.values()].filter((v) => v > 1).length,
  };
}
