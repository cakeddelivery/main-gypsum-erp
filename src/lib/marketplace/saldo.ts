import { prisma } from "../db";
import { n } from "../money";
import { todayStr } from "../time";
import { dayEnd, dayStart, reconcile } from "./report";
import { marketplaceBanks, recordedWithdraws, ref } from "./bank";

/** Saldo marketplace & pencocokan withdraw (hanya baca; pencatatan withdraw tetap di Keuangan). */
/** Saldo berjalan: cair masuk per hari, withdraw menutup cair TERTUA lebih dulu (FIFO). Murni, mudah dites. */
export type Lot = { date: string; amount: number };
export type Coverage = { date: string; amount: number; covers: { from: string; to: string } | null };
export function allocateFifo(cair: Lot[], withdraws: Lot[]) {
  const lots = cair.filter((c) => c.amount > 0).map((c) => ({ ...c })).sort((a, b) => a.date.localeCompare(b.date));
  // potongan iklan/penyesuaian negatif mengurangi saldo seperti withdraw, tetapi tidak ditampilkan sebagai withdraw
  const neg = cair.filter((c) => c.amount < 0).map((c) => ({ date: c.date, amount: -c.amount, silent: true }));
  const outs = [...withdraws.map((w) => ({ ...w, silent: false })), ...neg].sort((a, b) => a.date.localeCompare(b.date));
  const coverage: Coverage[] = [];
  let i = 0;
  let over = 0;
  for (const w of outs) {
    let need = w.amount;
    let from: string | null = null;
    let to: string | null = null;
    while (need > 0 && i < lots.length) {
      const take = Math.min(need, lots[i].amount);
      lots[i].amount -= take;
      need -= take;
      from ??= lots[i].date;
      to = lots[i].date;
      if (lots[i].amount === 0) i++;
    }
    over += need;
    if (!w.silent) coverage.push({ date: w.date, amount: w.amount, covers: from && to ? { from, to } : null });
  }
  const remaining = lots.filter((l) => l.amount > 0);
  return { remaining, coverage, balance: remaining.reduce((a, l) => a + l.amount, 0) - over, oldest: remaining[0]?.date ?? null };
}

export type SaldoStatus = "KOSONG" | "NORMAL" | "PERINGATAN" | "MERAH";
/** Normal: saldo hanya dari hari ini · Peringatan: ada cair 1–3 hari belum ditarik · Merah: lebih dari 3 hari */
export function saldoStatus(balance: number, oldest: string | null, today: string): { status: SaldoStatus; ageDays: number } {
  if (balance <= 0 || !oldest) return { status: "KOSONG", ageDays: 0 };
  const age = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86400000));
  return { status: age === 0 ? "NORMAL" : age > 3 ? "MERAH" : "PERINGATAN", ageDays: age };
}

const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);

/** Panel "Saldo marketplace" (kumulatif sejak data pertama): cair − withdraw tercatat − iklan = estimasi saldo belum ditarik */
export async function saldoPanel(opts: { storeId?: string } = {}) {
  const today = todayStr();
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] }, ...(opts.storeId ? { id: opts.storeId } : {}) }, select: { id: true, name: true, code: true }, orderBy: { code: "asc" } });
  const all = opts.storeId ? await prisma.store.count({ where: { active: true, code: { in: ["MG", "DL"] } } }) : stores.length;
  const banks = await marketplaceBanks();
  const out = [];
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      const incomes = await prisma.marketplaceIncome.findMany({ where: { storeId: s.id, channel: ch, releasedAt: { not: null } }, select: { releasedAt: true, released: true } });
      const wd = await recordedWithdraws(s, ch, banks, all, new Date(0), new Date("2100-01-01"));
      if (!incomes.length && !wd.rows.length) continue;
      const perDay = new Map<string, number>();
      for (const i of incomes) perDay.set(wib(i.releasedAt!), (perDay.get(wib(i.releasedAt!)) ?? 0) + n(i.released));
      const fifo = allocateFifo([...perDay].map(([date, amount]) => ({ date, amount })), wd.rows.map((w) => ({ date: wib(w.date), amount: w.amount })));
      const st = saldoStatus(fifo.balance, fifo.oldest, today);
      const todayRows = wd.rows.filter((w) => wib(w.date) === today);
      out.push({
        storeId: s.id, store: s.name, channel: ch, cair: incomes.reduce((a, i) => a + n(i.released), 0), recorded: wd.rows.reduce((a, w) => a + w.amount, 0),
        estimate: fifo.balance, since: fifo.oldest, ...st, noBank: wd.noBank, todayCount: todayRows.length, todayAmount: todayRows.reduce((a, w) => a + w.amount, 0),
        coverage: fifo.coverage.slice(-5).reverse(),
      });
    }
  }
  return out;
}

export type WdMatch = { status: "COCOK" | "BELUM_DI_ERP" | "TIDAK_DI_FILE"; refId: string; fileAmount: number | null; erpAmount: number | null; date: Date | null; txId?: string };

/**
 * Cocokkan penarikan di file (TikTok "Riwayat penarikan" / Shopee "Transaksi Saldo Penjual") dengan withdraw di Keuangan.
 * TikTok: ID referensi = withdrawRef. Shopee: tidak ada ID bersama → nominal sama & tanggal berselisih ≤ 2 hari (satu lawan satu).
 */
export async function matchWithdrawals(opts: { storeId: string; channel: "SHP" | "TTS"; from: string; to: string }): Promise<WdMatch[]> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const s = stores.find((x) => x.id === opts.storeId);
  if (!s) return [];
  const file = await prisma.marketplaceWithdrawal.findMany({ where: { storeId: s.id, channel: opts.channel, txType: { contains: "withdraw", mode: "insensitive" }, requestedAt: { gte: dayStart(opts.from), lt: dayEnd(opts.to) } } });
  const banks = await marketplaceBanks();
  const erp = (await recordedWithdraws(s, opts.channel, banks, stores.length, dayStart(opts.from), dayEnd(opts.to))).rows;
  const used = new Set<string>();
  const out: WdMatch[] = [];
  const DAY = 86400000;
  for (const w of file) {
    const amount = Math.abs(n(w.amount));
    const e = opts.channel === "TTS"
      ? erp.find((x) => x.withdrawRef && ref(x.withdrawRef) === ref(w.refId) && !used.has(x.id))
      : erp.find((x) => !used.has(x.id) && x.amount === amount && w.requestedAt && Math.abs(x.date.getTime() - w.requestedAt.getTime()) <= 2 * DAY);
    if (e) used.add(e.id);
    out.push({ status: e ? "COCOK" : "BELUM_DI_ERP", refId: opts.channel === "TTS" ? w.refId : `Saldo Penjual ${w.requestedAt ? dateStrWib(w.requestedAt) : ""}`, fileAmount: amount, erpAmount: e?.amount ?? null, date: w.requestedAt, txId: e?.id });
  }
  for (const e of erp) if (!used.has(e.id) && (opts.channel === "SHP" || e.withdrawRef)) out.push({ status: "TIDAK_DI_FILE", refId: e.withdrawRef ?? `Keuangan ${dateStrWib(e.date)}`, fileAmount: null, erpAmount: e.amount, date: e.date, txId: e.id });
  return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}
export const matchTiktokWithdrawals = (o: { storeId: string; from: string; to: string }) => matchWithdrawals({ ...o, channel: "TTS" });
const dateStrWib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);

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
