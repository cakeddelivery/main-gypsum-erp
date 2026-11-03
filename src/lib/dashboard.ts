import { prisma } from "./db";
import { addDays, dateOnly, dayRange, jakartaParts, monthRange, todayStr } from "./time";
import { cashMovements, profitLoss } from "./accounting";

export async function productionSummary(date: string, filter: { divisionId?: string | null; employeeId?: string | null } = {}) {
  const where = { date: dateOnly(date), ...(filter.divisionId ? { divisionId: filter.divisionId } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : {}) };
  const [agg, finished, byStage, targets] = await Promise.all([
    prisma.productionEntry.aggregate({ where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.productionEntry.aggregate({ where: { ...where, stage: "BARANG_JADI" }, _sum: { qtyGood: true } }),
    prisma.productionEntry.groupBy({ by: ["stage"], where, _sum: { qtyGood: true, qtyReject: true } }),
    prisma.productionTarget.findMany({ where: { active: true, ...(filter.divisionId ? { divisionId: filter.divisionId } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : { employeeId: null }) } }),
  ]);
  const good = agg._sum.qtyGood ?? 0;
  const reject = agg._sum.qtyReject ?? 0;
  const target = targets.reduce((s, t) => s + t.dailyQty, 0);
  const targetStages = new Set(targets.map((t) => t.stage));
  const achieved = byStage.filter((s) => targetStages.has(s.stage)).reduce((s, x) => s + (x._sum.qtyGood ?? 0), 0);
  return { good, reject, finished: finished._sum.qtyGood ?? 0, target, achieved, rejectRate: good + reject ? Math.round((reject / (good + reject)) * 1000) / 10 : 0, byStage };
}

export async function productionTrend(days: number, filter: { divisionId?: string | null; employeeId?: string | null } = {}) {
  const end = todayStr();
  const start = addDays(end, -(days - 1));
  const rows = await prisma.productionEntry.groupBy({
    by: ["date"],
    where: { date: { gte: dateOnly(start), lte: dateOnly(end) }, ...(filter.divisionId ? { divisionId: filter.divisionId } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : {}) },
    _sum: { qtyGood: true, qtyReject: true },
  });
  const m = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(start, i);
    const r = m.get(d);
    return { label: d.slice(8, 10) + "/" + d.slice(5, 7), hasil: r?._sum.qtyGood ?? 0, reject: r?._sum.qtyReject ?? 0 };
  });
}

export async function productivity(date: string, divisionId?: string | null) {
  const rows = await prisma.productionEntry.groupBy({ by: ["employeeId"], where: { date: dateOnly(date), ...(divisionId ? { divisionId } : {}) }, _sum: { qtyGood: true, qtyReject: true } });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, include: { division: true } });
  const targets = await prisma.productionTarget.findMany({ where: { employeeId: { in: rows.map((r) => r.employeeId) }, active: true } });
  return rows
    .map((r) => {
      const e = emps.find((x) => x.id === r.employeeId)!;
      const t = targets.filter((x) => x.employeeId === r.employeeId).reduce((s, x) => s + x.dailyQty, 0);
      return { name: e.name, division: e.division.name, good: r._sum.qtyGood ?? 0, reject: r._sum.qtyReject ?? 0, target: t };
    })
    .sort((a, b) => b.good - a.good);
}

export async function financeMonth(storeId?: string | null) {
  const p = jakartaParts();
  const { start, end } = monthRange(p.year, p.month);
  const pl = await profitLoss({ start, end, storeId });
  // Uang masuk/keluar dari jurnal kas (bukan hanya menu Transaksi) agar pembelian, gaji, kasbon, dll. ikut terhitung
  const moves = await cashMovements(start, end, storeId);
  const sales = await prisma.financeTransaction.aggregate({ where: { status: "DIBUKUKAN", direction: "MASUK", date: { gte: start, lt: end }, ...(storeId ? { storeId } : {}) }, _sum: { amount: true } });
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
  const rows = await prisma.financeTransaction.groupBy({ by: ["storeId"], where: { status: "DIBUKUKAN", direction: "TRANSFER", accountId: { in: mp }, date: { gte: start, lt: end } }, _sum: { amount: true }, _count: true });
  const stores = await prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  return stores.map((s) => {
    const r = rows.find((x) => x.storeId === s.id);
    return { store: s.name, amount: Number(r?._sum.amount ?? 0), count: r?._count ?? 0 };
  });
}
