import { prisma } from "./db";
import { addDays, dateOnly, dayRange, jakartaParts, monthRange, todayStr } from "./time";
import { cashMovements, profitLoss } from "./accounting";

export async function financeMonth(storeId?: string | null) {
  const p = jakartaParts();
  const { start, end } = monthRange(p.year, p.month);
  const pl = await profitLoss({ start, end, storeId });
  // Uang masuk/keluar dari jurnal kas (bukan hanya menu Transaksi) agar pembelian, gaji, kasbon, dll. ikut terhitung
  const moves = await cashMovements(start, end, storeId);
  const sales = await prisma.financeTransaction.aggregate({ where: { status: "DIBUKUKAN", direction: "MASUK", origin: null, date: { gte: start, lt: end }, ...(storeId ? { storeId } : {}) }, _sum: { amount: true } });
  const income = moves.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
  const expense = moves.filter((m) => m.amount < 0).reduce((s, m) => s - m.amount, 0);
  return { pl, income, expense, sales: Number(sales._sum.amount ?? 0), month: p.month, year: p.year };
}

export async function financeTrend(days: number, storeId?: string | null) {
  const end = todayStr();
  const start = addDays(end, -(days - 1));
  const moves = await cashMovements(dayRange(start).start, dayRange(end).end, storeId);
  const map = new Map<string, { masuk: number; keluar: number }>();
  for (const t of moves) {
    const d = todayStr(t.date);
    const cur = map.get(d) ?? { masuk: 0, keluar: 0 };
    if (t.amount > 0) cur.masuk += t.amount;
    else cur.keluar -= t.amount;
    map.set(d, cur);
  }
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(start, i);
    return { label: d.slice(8, 10) + "/" + d.slice(5, 7), ...(map.get(d) ?? { masuk: 0, keluar: 0 }) };
  });
}

/** Rekening saldo penjual marketplace (sumber withdraw), dikenali dari nama/alias rekening */
const MARKETPLACE = /penjual|seller|saldo shopee|tiktok|tokopedia|lazada|marketplace/i;

/** Withdraw saldo penjual marketplace per toko bulan ini (transfer internal yang sudah dibukukan).
 *  Toko hanya membedakan withdraw; pemasukan lain, beban, dan bahan baku dipakai bersama. */
export async function salesByStore() {
  const p = jakartaParts();
  const { start, end } = monthRange(p.year, p.month);
  const banks = await prisma.bankAccount.findMany();
  const mp = banks.filter((b) => MARKETPLACE.test(`${b.name} ${b.aliases}`)).map((b) => b.id);
  const rows = await prisma.financeTransaction.groupBy({ by: ["storeId"], where: { status: "DIBUKUKAN", direction: "TRANSFER", origin: null, accountId: { in: mp }, date: { gte: start, lt: end } }, _sum: { amount: true }, _count: true });
  const stores = await prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  return stores.map((s) => {
    const r = rows.find((x) => x.storeId === s.id);
    return { store: s.name, amount: Number(r?._sum.amount ?? 0), count: r?._count ?? 0 };
  });
}
