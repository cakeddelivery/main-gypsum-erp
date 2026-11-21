import { prisma } from "../db";
import { n } from "../money";
import { todayStr } from "../time";
import { dayEnd, dayStart, reconcile } from "./report";
import { marketplaceBanks, recordedWithdraws, ref } from "./bank";

/** Saldo marketplace & pencocokan withdraw (hanya baca; pencatatan withdraw tetap di Keuangan). */
/**
 * Saldo berjalan: cair masuk, withdraw menutup cair TERTUA lebih dulu (FIFO). Murni, mudah dites.
 * `id` pada cair (mis. id penghasilan per pesanan) membuat hasil juga memuat withdraw mana yang menutup tiap cair (bisa sebagian).
 */
export type Lot = { date: string; amount: number; id?: string; ref?: string };
export type Coverage = { date: string; amount: number; covers: { from: string; to: string } | null };
export type LotCover = { withdrawn: number; by: { date: string; ref?: string; amount: number }[] };
export function allocateFifo(cair: Lot[], withdraws: Lot[]) {
  const lots = cair.filter((c) => c.amount > 0).map((c) => ({ ...c, left: c.amount })).sort((a, b) => a.date.localeCompare(b.date));
  // potongan iklan/penyesuaian negatif mengurangi saldo seperti withdraw, tetapi tidak ditampilkan sebagai withdraw
  const neg = cair.filter((c) => c.amount < 0).map((c) => ({ date: c.date, amount: -c.amount, silent: true, ref: undefined as string | undefined }));
  const outs = [...withdraws.map((w) => ({ ...w, silent: false })), ...neg].sort((a, b) => a.date.localeCompare(b.date));
  const coverage: Coverage[] = [];
  const perLot = new Map<string, LotCover>();
  let i = 0;
  let over = 0;
  for (const w of outs) {
    let need = w.amount;
    let from: string | null = null;
    let to: string | null = null;
    // withdraw hanya bisa menutup cair yang SUDAH ada pada tanggalnya (cair yang lebih baru tidak ikut)
    while (need > 0 && i < lots.length && lots[i].date <= w.date) {
      const take = Math.min(need, lots[i].left);
      lots[i].left -= take;
      need -= take;
      from ??= lots[i].date;
      to = lots[i].date;
      const id = lots[i].id;
      if (id && !w.silent) {
        const c = perLot.get(id) ?? { withdrawn: 0, by: [] };
        c.withdrawn += take;
        c.by.push({ date: w.date, ref: w.ref, amount: take });
        perLot.set(id, c);
      } else if (id) {
        const c = perLot.get(id) ?? { withdrawn: 0, by: [] };
        c.withdrawn += take; // dipotong iklan/penyesuaian: tidak lagi ada di saldo
        perLot.set(id, c);
      }
      if (lots[i].left === 0) i++;
    }
    over += need;
    if (!w.silent) coverage.push({ date: w.date, amount: w.amount, covers: from && to ? { from, to } : null });
  }
  const remaining = lots.filter((l) => l.left > 0).map((l) => ({ date: l.date, amount: l.left }));
  return { remaining, coverage, perLot, over, balance: remaining.reduce((a, l) => a + l.amount, 0) - over, oldest: remaining[0]?.date ?? null };
}

export type SaldoStatus = "KOSONG" | "NORMAL" | "PERINGATAN" | "MERAH";
/** Normal: saldo hanya dari hari ini · Peringatan: ada cair 1–3 hari belum ditarik · Merah: lebih dari 3 hari */
export function saldoStatus(balance: number, oldest: string | null, today: string): { status: SaldoStatus; ageDays: number } {
  if (balance <= 0 || !oldest) return { status: "KOSONG", ageDays: 0 };
  const age = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86400000));
  return { status: age === 0 ? "NORMAL" : age > 3 ? "MERAH" : "PERINGATAN", ageDays: age };
}

const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const dateStrWib = wib;

export type WdMatch = { status: "COCOK" | "BELUM_DI_ERP" | "TIDAK_DI_FILE"; refId: string; fileAmount: number | null; erpAmount: number | null; date: Date | null; txId?: string };
type FileWd = { refId: string; amount: number; date: Date | null };
type ErpWd = { id: string; amount: number; date: Date; withdrawRef: string | null; number?: string };

/**
 * Pasangkan penarikan di file (TikTok "Riwayat penarikan" / Shopee "Transaksi Saldo Penjual") dengan withdraw di Keuangan.
 * TikTok: ID referensi = withdrawRef. Shopee: tidak ada ID bersama → nominal sama & tanggal berselisih ≤ 2 hari (satu lawan satu). Murni.
 */
export function pairWithdraws(channel: string, file: FileWd[], erp: ErpWd[]): WdMatch[] {
  const used = new Set<string>();
  const out: WdMatch[] = [];
  const DAY = 86400000;
  for (const w of file) {
    const e = channel === "TTS"
      ? erp.find((x) => x.withdrawRef && ref(x.withdrawRef) === ref(w.refId) && !used.has(x.id))
      : erp.find((x) => !used.has(x.id) && x.amount === w.amount && w.date && Math.abs(x.date.getTime() - w.date.getTime()) <= 2 * DAY);
    if (e) used.add(e.id);
    out.push({ status: e ? "COCOK" : "BELUM_DI_ERP", refId: channel === "TTS" ? w.refId : `Saldo Penjual ${w.date ? dateStrWib(w.date) : ""}`, fileAmount: w.amount, erpAmount: e?.amount ?? null, date: w.date, txId: e?.id });
  }
  for (const e of erp) if (!used.has(e.id) && (channel === "SHP" || e.withdrawRef)) out.push({ status: "TIDAK_DI_FILE", refId: e.withdrawRef ?? e.number ?? `Keuangan ${dateStrWib(e.date)}`, fileAmount: null, erpAmount: e.amount, date: e.date, txId: e.id });
  return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

type StoreLite = { id: string; name: string; code: string };
const FAR = new Date("2100-01-01");

/** Rentang tanggal (WIB) yang SUDAH tercakup file penarikan: periode impor yang memuat penarikan + tanggal tiap penarikan di file */
export type Span = [string, string];
const inSpans = (spans: Span[], d: string) => spans.some(([a, b]) => d >= a && d <= b);

/**
 * Alokasi FIFO per toko & kanal: tiap penghasilan pesanan mendapat withdraw yang menutupnya.
 *
 * SATU SUMBER withdraw per tanggal (tidak pernah dikurangkan dua kali):
 *  - tanggal yang tercakup FILE penarikan (TikTok "Riwayat penarikan" / Shopee Saldo Penjual): file = sumber utama; withdraw di
 *    Keuangan hanya DICOCOKKAN. Yang tidak cocok tidak dikurangkan lagi, hanya menjadi peringatan (`ignoredErp`).
 *  - tanggal di luar cakupan file: withdraw tercatat di Keuangan dipakai.
 */
export async function loadAllocation(s: StoreLite, ch: string, storeCount: number, banks?: Awaited<ReturnType<typeof marketplaceBanks>>) {
  const bks = banks ?? (await marketplaceBanks());
  const [incomes, rec, fileWd, imps] = await Promise.all([
    // Setiap baris penyelesaian (event) = satu lot: cair positif, refund/iklan/penyesuaian negatif
    prisma.marketplaceIncomeEvent.findMany({ where: { income: { storeId: s.id, channel: ch, kind: { not: "ADSUSE" } }, releasedAt: { not: null } }, select: { id: true, incomeId: true, released: true, releasedAt: true, income: { select: { kind: true } } }, orderBy: [{ releasedAt: "asc" }, { id: "asc" }] }),
    recordedWithdraws(s, ch, bks, storeCount, new Date(0), FAR),
    prisma.marketplaceWithdrawal.findMany({ where: { storeId: s.id, channel: ch, txType: { contains: "withdraw", mode: "insensitive" } } }),
    prisma.marketplaceImport.findMany({ where: { storeId: s.id, channel: ch, undoneAt: null, kind: ch === "TTS" ? "INCOME" : "BALANCE", periodFrom: { not: null } }, select: { periodFrom: true, periodTo: true, stats: true } }),
  ]);
  const pairs = pairWithdraws(ch, fileWd.map((w) => ({ refId: w.refId, amount: Math.abs(n(w.amount)), date: w.requestedAt })), rec.rows);
  const spans: Span[] = [];
  for (const i of imps) {
    const hadWd = ((i.stats ?? {}) as { withdrawals?: number }).withdrawals ?? 0;
    if (ch === "TTS" && !hadWd) continue; // file TikTok tanpa sheet penarikan tidak mengklaim cakupan
    spans.push([i.periodFrom!.toISOString().slice(0, 10), (i.periodTo ?? i.periodFrom)!.toISOString().slice(0, 10)]);
  }
  for (const p of pairs) if (p.status !== "TIDAK_DI_FILE" && p.date) spans.push([wib(p.date), wib(p.date)]);
  const matchedIds = new Set(pairs.filter((p) => p.status === "COCOK" && p.txId).map((p) => p.txId!));
  const withdraws = [
    // sumber utama: file
    ...pairs.filter((p) => p.status !== "TIDAK_DI_FILE" && p.date).map((p) => ({ date: wib(p.date!), amount: p.fileAmount ?? 0, ref: p.refId, inErp: p.status === "COCOK" })),
    // Keuangan hanya untuk tanggal di luar cakupan file
    ...rec.rows.filter((r) => !matchedIds.has(r.id) && !inSpans(spans, wib(r.date))).map((r) => ({ date: wib(r.date), amount: r.amount, ref: r.withdrawRef ?? r.number ?? undefined, inErp: true })),
  ];
  // Tercatat di Keuangan, di tanggal yang file-nya ada, tetapi tidak ada padanan di file → tidak dikurangkan (peringatan)
  const ignoredErp = rec.rows.filter((r) => !matchedIds.has(r.id) && inSpans(spans, wib(r.date)));
  const fifo = allocateFifo(incomes.map((i) => ({ date: wib(i.releasedAt!), amount: n(i.released), id: i.id })), withdraws.map((w) => ({ date: w.date, amount: w.amount, ref: w.ref })));
  return { incomes, withdraws, pairs, fifo, noBank: rec.noBank, recordedRows: rec.rows, notInErp: pairs.filter((p) => p.status === "BELUM_DI_ERP"), ignoredErp, spans };
}

export type WalletDetail = {
  /** Saldo awal & asalnya: file Saldo Penjual (Shopee: Saldo Akhir − Jumlah baris tertua) atau tidak diketahui (0) */
  opening: { amount: number; source: "FILE" | "TIDAK_DIKETAHUI"; from: string | null };
  cair: number; adjust: number; topup: number; gmv: number; withdraw: number;
  /** saldo awal + cair + penyesuaian − top-up iklan − GMV Pay − withdraw, sejak awal data */
  estimate: number;
  /** Saldo resmi menurut marketplace pada tanggal tertentu: Shopee = Saldo Akhir baris terbaru Saldo Penjual; atau titik acuan yang diisi Finance */
  official: { amount: number; asOf: string; source: "FILE" | "ISIAN"; note?: string | null } | null;
  /** official − estimasi pada tanggal yang sama (null bila tak ada acuan) */
  diff: number | null;
  /** Angka untuk kartu: acuan + mutasi sesudahnya (bila ada acuan), selain itu estimasi */
  balance: number;
  basis: "ACUAN" | "ESTIMASI";
  causes: string[];
  ignoredErp: { count: number; amount: number };
  notInErp: { count: number; amount: number };
};

/**
 * Rincian saldo dompet marketplace per toko × kanal. Saldo resmi (Saldo Akhir Shopee / isian Finance) dipakai sebagai acuan;
 * estimasi dari data impor ditampilkan sebagai pembanding berikut kandidat penyebab selisih.
 */
export async function walletDetail(s: StoreLite, ch: string, storeCount: number, banks?: Awaited<ReturnType<typeof marketplaceBanks>>, alloc?: Awaited<ReturnType<typeof loadAllocation>>): Promise<WalletDetail> {
  const a = alloc ?? (await loadAllocation(s, ch, storeCount, banks));
  const [first, last, check] = await Promise.all([
    ch === "SHP" ? prisma.marketplaceBalanceTx.findFirst({ where: { storeId: s.id, channel: ch, balanceAfter: { not: null } }, orderBy: [{ date: "asc" }, { pos: "desc" }] }) : null,
    ch === "SHP" ? prisma.marketplaceBalanceTx.findFirst({ where: { storeId: s.id, channel: ch, balanceAfter: { not: null } }, orderBy: [{ date: "desc" }, { pos: "asc" }] }) : null,
    prisma.marketplaceWalletCheck.findFirst({ where: { storeId: s.id, channel: ch }, orderBy: [{ asOf: "desc" }, { createdAt: "desc" }] }),
  ]);
  const opening = first ? { amount: n(first.balanceAfter) - n(first.amount), source: "FILE" as const, from: wib(first.date) } : { amount: 0, source: "TIDAK_DIKETAHUI" as const, from: null };
  const winFrom = opening.from; // data sebelum file Saldo Penjual dimulai sudah termasuk di saldo awal
  const inWin = (d: string) => !winFrom || d >= winFrom;
  const ev = a.incomes.map((e) => ({ day: wib(e.releasedAt!), kind: e.income.kind, v: n(e.released) })).filter((e) => inWin(e.day));
  const sum = (k: string) => ev.filter((e) => e.kind === k).reduce((x, e) => x + e.v, 0);
  const wds = a.withdraws.filter((w) => inWin(w.date));
  const withdraw = wds.reduce((x, w) => x + w.amount, 0);
  const cair = sum("ORDER"), adjust = sum("ADJUST"), topup = sum("TOPUP"), gmv = sum("ADS");
  const estimate = opening.amount + ev.reduce((x, e) => x + e.v, 0) - withdraw;
  // acuan: yang tanggalnya paling baru (isian Finance menang bila sama)
  const fileAnchor = last ? { amount: n(last.balanceAfter), asOf: wib(last.date), source: "FILE" as const, note: null as string | null } : null;
  const checkAnchor = check ? { amount: n(check.amount), asOf: check.asOf.toISOString().slice(0, 10), source: "ISIAN" as const, note: check.note } : null;
  const official = fileAnchor && checkAnchor ? (checkAnchor.asOf >= fileAnchor.asOf ? checkAnchor : fileAnchor) : (checkAnchor ?? fileAnchor);
  let diff: number | null = null, balance = estimate, basis: WalletDetail["basis"] = "ESTIMASI";
  if (official) {
    const upto = (d: string) => d <= official.asOf;
    const estAt = opening.amount + ev.filter((e) => upto(e.day)).reduce((x, e) => x + e.v, 0) - wds.filter((w) => upto(w.date)).reduce((x, w) => x + w.amount, 0);
    diff = official.amount - estAt;
    balance = official.amount + ev.filter((e) => !upto(e.day)).reduce((x, e) => x + e.v, 0) - wds.filter((w) => !upto(w.date)).reduce((x, w) => x + w.amount, 0);
    basis = "ACUAN";
  }
  const ignored = { count: a.ignoredErp.length, amount: a.ignoredErp.reduce((x, r) => x + r.amount, 0) };
  const notIn = { count: a.notInErp.length, amount: a.notInErp.reduce((x, p) => x + (p.fileAmount ?? 0), 0) };
  const causes: string[] = [];
  if (opening.source === "TIDAK_DIKETAHUI" && !official) causes.push(ch === "TTS" ? "Saldo awal TikTok tidak diketahui (file tidak punya saldo berjalan). Isi “Saldo Seller Center” agar estimasi memakai acuan." : "Saldo awal tidak diketahui: unggah file Saldo Penjual (my_balance) mulai awal periode data.");
  if (opening.source === "TIDAK_DIKETAHUI" && official && diff !== null && diff !== 0) causes.push("Saldo awal sebelum data pertama tidak diketahui (dianggap 0)");
  if (ignored.count) causes.push(`${ignored.count} withdraw di Keuangan (Rp ${ignored.amount.toLocaleString("id-ID")}) tidak ada padanan di file penarikan pada tanggalnya — TIDAK dikurangkan (cek nominal/tanggal/ID referensi)`);
  if (notIn.count) causes.push(`${notIn.count} penarikan di file (Rp ${notIn.amount.toLocaleString("id-ID")}) belum tercatat di Keuangan — tetap dikurangkan`);
  if (diff !== null && Math.abs(diff) > 1) causes.push(`File penghasilan / saldo penjual / iklan / penarikan yang belum diunggah sampai ${official!.asOf} membuat selisih ${diff > 0 ? "positif (saldo asli lebih besar)" : "negatif (ERP lebih besar)"}`);
  return { opening, cair, adjust, topup, gmv, withdraw, estimate, official, diff, balance, basis, causes, ignoredErp: ignored, notInErp: notIn };
}

/** Tahap tiap pesanan cair: DITARIK bila withdraw sudah menutup seluruh nilai cairnya */
export function stageOf(released: number, cover: LotCover | undefined): "CAIR" | "SEBAGIAN" | "DITARIK" {
  const w = cover?.withdrawn ?? 0;
  if (released > 0 && w >= released) return "DITARIK";
  return w > 0 ? "SEBAGIAN" : "CAIR";
}

/** Peta id penghasilan → penutup withdraw, untuk semua toko/kanal (atau yang difilter) */
export async function allocationMap(opts: { storeId?: string; channel?: string } = {}) {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true }, orderBy: { code: "asc" } });
  const banks = await marketplaceBanks();
  const covers = new Map<string, LotCover>();
  const released = new Map<string, number>();
  for (const s of stores.filter((x) => !opts.storeId || x.id === opts.storeId)) {
    for (const ch of ["SHP", "TTS"].filter((c) => !opts.channel || c === opts.channel)) {
      const a = await loadAllocation(s, ch, stores.length, banks);
      // lot = event; digabung per pesanan (penghasilan)
      const owner = new Map(a.incomes.map((e) => [e.id, e.incomeId]));
      for (const [evId, c] of a.fifo.perLot) {
        const inc = owner.get(evId)!;
        const cur = covers.get(inc) ?? { withdrawn: 0, by: [] };
        cur.withdrawn += c.withdrawn;
        cur.by.push(...c.by);
        covers.set(inc, cur);
      }
      for (const e of a.incomes) released.set(e.incomeId, (released.get(e.incomeId) ?? 0) + n(e.released));
    }
  }
  return { covers, released };
}

/** Panel "Saldo marketplace" (kumulatif sejak data pertama): cair − iklan − withdraw = saldo belum ditarik */
export async function saldoPanel(opts: { storeId?: string } = {}) {
  const today = todayStr();
  const all = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true }, orderBy: { code: "asc" } });
  const stores = opts.storeId ? all.filter((s) => s.id === opts.storeId) : all;
  const banks = await marketplaceBanks();
  const out = [];
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      const a = await loadAllocation(s, ch, all.length, banks);
      if (!a.incomes.length && !a.withdraws.length) continue;
      const st = saldoStatus(a.fifo.balance, a.fifo.oldest, today);
      const wallet = await walletDetail(s, ch, all.length, banks, a);
      const todayRows = a.recordedRows.filter((w) => wib(w.date) === today);
      out.push({
        storeId: s.id, store: s.name, channel: ch, cair: a.incomes.reduce((x, i) => x + n(i.released), 0), recorded: a.withdraws.reduce((x, w) => x + w.amount, 0),
        estimate: a.fifo.balance, since: a.fifo.oldest, ...st, noBank: a.noBank, todayCount: todayRows.length, todayAmount: todayRows.reduce((x, w) => x + w.amount, 0),
        coverage: a.fifo.coverage.slice(-5).reverse(), wallet,
        /** withdraw melebihi cair yang diketahui (file penghasilan mungkin belum diunggah) */
        over: a.fifo.over, notInErp: a.notInErp.length, notInErpAmount: a.notInErp.reduce((x, p) => x + (p.fileAmount ?? 0), 0),
      });
    }
  }
  return out;
}

/**
 * Cocokkan penarikan di file dengan withdraw di Keuangan pada rentang tanggal (untuk tabel pencocokan).
 */
export async function matchWithdrawals(opts: { storeId: string; channel: "SHP" | "TTS"; from: string; to: string }): Promise<WdMatch[]> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const s = stores.find((x) => x.id === opts.storeId);
  if (!s) return [];
  const file = await prisma.marketplaceWithdrawal.findMany({ where: { storeId: s.id, channel: opts.channel, txType: { contains: "withdraw", mode: "insensitive" }, requestedAt: { gte: dayStart(opts.from), lt: dayEnd(opts.to) } } });
  const banks = await marketplaceBanks();
  const erp = (await recordedWithdraws(s, opts.channel, banks, stores.length, dayStart(opts.from), dayEnd(opts.to))).rows;
  return pairWithdraws(opts.channel, file.map((w) => ({ refId: w.refId, amount: Math.abs(n(w.amount)), date: w.requestedAt })), erp);
}
export const matchTiktokWithdrawals = (o: { storeId: string; from: string; to: string }) => matchWithdrawals({ ...o, channel: "TTS" });

export const WD_REMINDER_KEY = "marketplace_wd_reminder_hour";
export const wdReminderHour = async () => {
  const v = Number((await prisma.setting.findUnique({ where: { key: WD_REMINDER_KEY } }))?.value);
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : 15;
};

/** Saldo belum ditarik per toko/kanal (untuk pengingat Finance): bukan "belum withdraw hari ini = salah", tapi umur saldo */
export async function saldoNeedsAttention() {
  return (await saldoPanel()).filter((r) => r.estimate > 0);
}

/** Pengingat harian ke Finance & Owner (jam bisa diatur di halaman Saldo; bawaan 15.00 WIB) */
export async function sendMarketplaceWdReminder(now: Date) {
  const rows = await saldoNeedsAttention();
  if (!rows.length) return { notifikasi: 0 };
  void now;
  const users = await prisma.user.findMany({ where: { active: true, role: { in: ["FINANCE", "OWNER"] } }, select: { id: true } });
  const { sendPush } = await import("../push");
  const label = (c: string) => (c === "SHP" ? "Shopee" : "TikTok");
  const fmt = (v: number) => `Rp ${v.toLocaleString("id-ID")}`;
  const worst = rows.some((r) => r.status === "MERAH") ? "MERAH" : rows.some((r) => r.status === "PERINGATAN") ? "PERINGATAN" : "NORMAL";
  const r = await sendPush(users.map((u) => u.id), {
    title: worst === "MERAH" ? "Saldo marketplace tertahan > 3 hari" : worst === "PERINGATAN" ? "Ada saldo marketplace belum ditarik" : "Saldo marketplace hari ini",
    body: rows.map((m) => `${m.store} ${label(m.channel)}: ${fmt(m.estimate)} sejak ${m.since}`).join(" · "),
    url: "/penjualan/marketplace/saldo",
    tag: "mp-withdraw",
  });
  return { notifikasi: 1, perangkat: r.sent, status: worst };
}

/**
 * Saldo menurut Shopee (Buku Saldo Penjual: "Saldo Akhir" baris terbaru) dibanding estimasi ERP.
 * Estimasi ERP = saldo awal (saldo akhir baris tertua − jumlahnya) + Σ cair/penyesuaian/isi saldo iklan − Σ withdraw pada rentang yang sama.
 */
export async function bookBalance(storeId: string, channel = "SHP") {
  const where = { storeId, channel, balanceAfter: { not: null } };
  const [last, first] = await Promise.all([
    prisma.marketplaceBalanceTx.findFirst({ where, orderBy: [{ date: "desc" }, { pos: "asc" }] }),
    prisma.marketplaceBalanceTx.findFirst({ where, orderBy: [{ date: "asc" }, { pos: "desc" }] }),
  ]);
  if (!last || !first) return null;
  const opening = n(first.balanceAfter) - n(first.amount);
  const from = dayStart(wib(first.date)), to = dayEnd(wib(last.date));
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const s = stores.find((x) => x.id === storeId);
  if (!s) return null;
  const [ev, alloc] = await Promise.all([
    prisma.marketplaceIncomeEvent.aggregate({ where: { income: { storeId, channel, kind: { in: ["ORDER", "ADJUST", "TOPUP"] } }, releasedAt: { gte: from, lt: to } }, _sum: { released: true } }),
    loadAllocation(s, channel, stores.length),
  ]);
  const wd = alloc.withdraws.filter((w) => new Date(`${w.date}T00:00:00+07:00`) >= from && new Date(`${w.date}T00:00:00+07:00`) < to).reduce((a, w) => a + w.amount, 0);
  const shopee = n(last.balanceAfter);
  const erp = opening + n(ev._sum.released) - wd;
  return { asOf: wib(last.date), from: wib(first.date), opening, shopee, erp, diff: shopee - erp, events: n(ev._sum.released), withdraws: wd };
}
