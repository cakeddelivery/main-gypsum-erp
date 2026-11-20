import { prisma } from "../db";
import { n } from "../money";
import { dateOnly, todayStr } from "../time";
import { dayEnd, dayStart, reconcile } from "./report";
import { marketplaceBanks, recordedWithdraws, ref } from "./bank";

/** Saldo marketplace & pencocokan withdraw (hanya baca; pencatatan withdraw tetap di Keuangan). */
/** Panel "Saldo marketplace": cair − withdraw tercatat − potongan iklan dari saldo = estimasi saldo belum ditarik */
export async function saldoPanel(opts: { from: string; to: string; storeId?: string }) {
  const rec = await reconcile({ storeId: opts.storeId, from: opts.from, to: opts.to });
  const today = todayStr();
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const banks = await marketplaceBanks();
  const out = [];
  for (const r of rec) {
    const s = stores.find((x) => x.id === r.storeId)!;
    const todayWd = await recordedWithdraws(s, r.channel, banks, stores.length, dayStart(today), dayEnd(today));
    out.push({ ...r, estimate: r.cair + r.ads + r.adjust - r.recorded, todayCount: todayWd.rows.length, todayAmount: todayWd.rows.reduce((a, x) => a + x.amount, 0) });
  }
  return out;
}

export type WdMatch = { status: "COCOK" | "BELUM_DI_ERP" | "TIDAK_DI_FILE"; refId: string; fileAmount: number | null; erpAmount: number | null; date: Date | null; txId?: string };

/** Cocokkan "Riwayat penarikan" TikTok (Withdrawal + ID referensi) dengan withdrawRef transaksi Keuangan */
export async function matchTiktokWithdrawals(opts: { storeId: string; from: string; to: string }): Promise<WdMatch[]> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true, code: true } });
  const s = stores.find((x) => x.id === opts.storeId);
  if (!s) return [];
  const file = await prisma.marketplaceWithdrawal.findMany({ where: { storeId: s.id, channel: "TTS", txType: { contains: "withdraw", mode: "insensitive" }, requestedAt: { gte: dayStart(opts.from), lt: dayEnd(opts.to) } } });
  const banks = await marketplaceBanks();
  const erp = (await recordedWithdraws(s, "TTS", banks, stores.length, dayStart(opts.from), dayEnd(opts.to))).rows;
  const erpByRef = new Map(erp.filter((e) => e.withdrawRef).map((e) => [ref(e.withdrawRef), e]));
  const seen = new Set<string>();
  const out: WdMatch[] = [];
  for (const w of file) {
    const e = erpByRef.get(ref(w.refId));
    if (e) seen.add(ref(w.refId));
    out.push({ status: e ? "COCOK" : "BELUM_DI_ERP", refId: w.refId, fileAmount: Math.abs(n(w.amount)), erpAmount: e?.amount ?? null, date: w.requestedAt, txId: e?.id });
  }
  for (const e of erp) if (e.withdrawRef && !seen.has(ref(e.withdrawRef))) out.push({ status: "TIDAK_DI_FILE", refId: e.withdrawRef, fileAmount: null, erpAmount: e.amount, date: e.date, txId: e.id });
  return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

export const WD_REMINDER_KEY = "marketplace_wd_reminder_hour";
export const wdReminderHour = async () => {
  const v = Number((await prisma.setting.findUnique({ where: { key: WD_REMINDER_KEY } }))?.value);
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : 15;
};

/** Toko+kanal yang punya saldo belum ditarik tetapi belum dicatat withdraw-nya hari ini (untuk pengingat Finance) */
export async function missingWithdrawToday(now = new Date()) {
  const today = todayStr(now);
  const d = dateOnly(today);
  void d;
  const rows = await saldoPanel({ from: `${today.slice(0, 7)}-01`, to: today });
  return rows.filter((r) => r.estimate > 0 && r.todayCount === 0);
}

/** Pengingat harian ke Finance & Owner (jam bisa diatur di halaman Saldo; bawaan 15.00 WIB) */
export async function sendMarketplaceWdReminder(now: Date) {
  const missing = await missingWithdrawToday(now);
  if (!missing.length) return { notifikasi: 0 };
  const users = await prisma.user.findMany({ where: { active: true, role: { in: ["FINANCE", "OWNER"] } }, select: { id: true } });
  const { sendPush } = await import("../push");
  const label = (c: string) => (c === "SHP" ? "Shopee" : "TikTok");
  const r = await sendPush(users.map((u) => u.id), {
    title: "Withdraw marketplace hari ini belum dicatat",
    body: `${missing.map((m) => `${m.store} ${label(m.channel)}`).join(", ")}. Catat withdraw di Keuangan bila sudah ditarik.`,
    url: "/penjualan/marketplace/saldo",
    tag: "mp-withdraw",
  });
  return { notifikasi: 1, perangkat: r.sent };
}
