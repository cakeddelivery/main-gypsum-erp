import { prisma } from "./db";
import { accountBalances, cashBalance, classifyCashJournals, normalSign, COA } from "./accounting";
import { inventoryValuation } from "./stock";
import { reserveSummary } from "./reserve";
import { addDays, dateOnly, jakartaParts, monthRange, todayStr, MONTHS } from "./time";

export type MonthRow = { key: string; label: string; revenue: number; cogs: number; expenses: number; ownerComp: number; net: number; cashIn: number; cashOut: number; cashEnd: number };

/**
 * Ringkasan per bulan (laba rugi + arus kas) untuk `months` bulan terakhir, termasuk bulan berjalan.
 * Semua jurnal dalam rentang diambil sekali lalu dihitung per bulan di memori (dulu 12 bulan × beberapa query
 * berurutan, membuat halaman Analitik lambat).
 */
export async function monthlySeries(months = 12, now: Date = new Date()): Promise<MonthRow[]> {
  const p = jakartaParts(now);
  const ranges = Array.from({ length: months }, (_, k) => {
    const idx = p.year * 12 + (p.month - 1) - (months - 1 - k);
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    return { year, month, ...monthRange(year, month) };
  });
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  const [accounts, journals, opening] = await Promise.all([
    prisma.coaAccount.findMany(),
    prisma.journal.findMany({ where: { date: { gte: first, lt: last } }, include: { lines: true }, orderBy: { date: "asc" } }),
    cashBalance(first),
  ]);
  const accById = new Map(accounts.map((a) => [a.id, a]));
  let cashEnd = opening;
  return ranges.map(({ year, month, start, end }) => {
    const js = journals
      .filter((j) => j.date >= start && j.date < end)
      .map((j) => ({ ...j, lines: j.lines.map((l) => ({ ...l, account: accById.get(l.accountId)! })) }));
    const byType = { PENDAPATAN: 0, HPP: 0, BEBAN: 0 } as Record<string, number>;
    let ownerComp = 0;
    for (const j of js)
      for (const l of j.lines) {
        const amt = (Number(l.debit) - Number(l.credit)) * normalSign(l.account.type, l.account.code);
        if (l.account.type in byType) byType[l.account.type] += amt;
        if (l.account.code === COA.BEBAN_GAJI_OWNER) ownerComp += amt;
        if (l.account.isCash) cashEnd += Number(l.debit) - Number(l.credit);
      }
    const cf = classifyCashJournals(js);
    const all = [...cf.OPERASI, ...cf.INVESTASI, ...cf.PENDANAAN];
    return {
      key: `${year}-${String(month).padStart(2, "0")}`,
      label: `${MONTHS[month - 1].slice(0, 3)} ${String(year).slice(2)}`,
      revenue: byType.PENDAPATAN,
      cogs: byType.HPP,
      expenses: byType.BEBAN,
      ownerComp,
      net: byType.PENDAPATAN - byType.HPP - byType.BEBAN,
      cashIn: all.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0),
      cashOut: -all.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0),
      cashEnd,
    };
  });
}

/** Pertumbuhan dalam persen; null bila pembanding nol */
export function growth(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

export type Insight = { tone: "red" | "amber" | "green" | "blue"; title: string; detail: string };

export type Snapshot = Awaited<ReturnType<typeof businessSnapshot>>;

/** Posisi keuangan sekarang + kewajiban 30 hari ke depan */
export async function businessSnapshot(now: Date = new Date()) {
  const today = todayStr(now);
  const in30 = dateOnly(addDays(today, 30));
  const [series, balances, payables, receivables, periods, monthlyEmps, unclaimed, advances, reserves, inv] = await Promise.all([
    monthlySeries(12, now),
    accountBalances({}),
    prisma.payable.findMany(),
    prisma.receivable.findMany(),
    prisma.payrollPeriod.findMany({ where: { status: { not: "DIBAYAR" } }, include: { payslips: { select: { total: true } } } }),
    prisma.employee.findMany({ where: { wageType: "BULANAN", status: { not: "NONAKTIF" }, resignDate: null } }),
    prisma.pieceWork.aggregate({ where: { periodId: null }, _sum: { amount: true } }),
    prisma.cashAdvance.findMany(),
    reserveSummary(now),
    inventoryValuation(),
  ]);
  const bal = (code: string) => balances.find((b) => b.code === code)?.balance ?? 0;
  const cash = balances.filter((b) => b.isCash).reduce((s, b) => s + b.balance, 0);
  const ownerHeld = bal(COA.UTANG_GAJI_OWNER);
  const loanSaving = reserves.filter((r) => r.kind === "LOAN_SAVING").reduce((s, r) => s + r.balance, 0);
  const freeCash = cash - ownerHeld - loanSaving;
  const open = <T extends { amount: bigint; paid: bigint }>(rows: T[]) => rows.filter((r) => r.paid < r.amount);
  const rem = (r: { amount: bigint; paid: bigint }) => Number(r.amount - r.paid);
  const supplierDebt = open(payables.filter((p) => p.kind === "USAHA")).reduce((s, p) => s + rem(p), 0);
  const loanDebt = open(payables.filter((p) => p.kind === "PINJAMAN")).reduce((s, p) => s + rem(p), 0);
  const dueSoon = open(payables).filter((p) => p.dueDate && p.dueDate <= in30);
  const overdue = dueSoon.filter((p) => p.dueDate! < now);
  const pendingPayroll = periods.reduce((s, p) => s + p.payslips.reduce((a, x) => a + Number(x.total), 0), 0);
  const monthlyPayroll = monthlyEmps.reduce((s, e) => s + Number(e.monthlySalary), 0);
  const dailyReserve = reserves.filter((r) => r.active).reduce((s, r) => s + Number(r.dailyAmount), 0);
  const obligations = [
    { label: "Utang jatuh tempo ≤ 30 hari", amount: dueSoon.reduce((s, p) => s + rem(p), 0) },
    { label: "Gaji/klaim belum dibayar", amount: pendingPayroll },
    { label: "Perkiraan gaji bulanan 30 hari ke depan", amount: Math.max(0, monthlyPayroll - periods.filter((p) => p.kind === "BULANAN").reduce((s, p) => s + p.payslips.reduce((a, x) => a + Number(x.total), 0), 0)) },
    { label: "Borongan belum diklaim", amount: Number(unclaimed._sum.amount ?? 0) },
    { label: "Sisihan harian 30 hari (owner & cicilan)", amount: dailyReserve * 30 },
  ];
  const obligations30 = obligations.reduce((s, o) => s + o.amount, 0);
  const full = series.slice(-4, -1); // 3 bulan penuh terakhir
  const avg = (k: keyof MonthRow) => (full.length ? Math.round(full.reduce((s, m) => s + (m[k] as number), 0) / full.length) : 0);
  const avgCashIn = avg("cashIn");
  const avgCashOut = avg("cashOut");
  const runwayMonths = avgCashOut > avgCashIn && avgCashOut > 0 ? Math.round((freeCash / (avgCashOut - avgCashIn)) * 10) / 10 : null;
  const cur = series[series.length - 1];
  const prev = series[series.length - 2];
  return {
    today,
    series,
    cur,
    prev,
    cash,
    ownerHeld,
    loanSaving,
    freeCash,
    supplierDebt,
    loanDebt,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((s, p) => s + rem(p), 0),
    receivables: open(receivables).reduce((s, r) => s + rem(r), 0),
    advances: advances.reduce((s, a) => s + Number(a.amount - a.repaid), 0),
    inventory: inv.total,
    obligations,
    obligations30,
    avgCashIn,
    avgCashOut,
    projected30: freeCash + avgCashIn - obligations30,
    runwayMonths,
    reservesMissingToday: reserves.filter((r) => r.active && !r.doneToday).length,
  };
}

const pct = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toLocaleString("id-ID")}%`);
const rp = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;

/** Saran strategis berbasis aturan (tanpa AI, selalu tersedia) */
export function ruleInsights(s: Snapshot): Insight[] {
  const out: Insight[] = [];
  const full = s.series.slice(0, -1).filter((m) => m.revenue || m.expenses);
  const last = full[full.length - 1];
  const before = full[full.length - 2];
  if (last && before) {
    const g = growth(last.revenue, before.revenue);
    if (g !== null) out.push(g >= 0 ? { tone: "green", title: `Pendapatan ${last.label} tumbuh ${pct(g)}`, detail: `Dibanding ${before.label} (${rp(before.revenue)} → ${rp(last.revenue)}). Pertahankan channel & produk yang mendorong kenaikan.` } : { tone: "amber", title: `Pendapatan ${last.label} turun ${pct(g)}`, detail: `Dibanding ${before.label}. Cek produk/toko mana yang turun dan aktifkan promosi atau paket bundling.` });
  }
  const last3 = full.slice(-3);
  if (last3.length === 3 && last3.every((m, i) => i === 0 || m.revenue < last3[i - 1].revenue)) out.push({ tone: "red", title: "Pendapatan turun 3 bulan berturut-turut", detail: "Tren menurun. Prioritaskan evaluasi harga, kanal penjualan, dan stok produk terlaris." });
  if (last && last.revenue > 0) {
    const margin = Math.round((last.net / last.revenue) * 1000) / 10;
    const gross = Math.round(((last.revenue - last.cogs) / last.revenue) * 1000) / 10;
    if (margin < 0) out.push({ tone: "red", title: `${last.label} rugi ${rp(-last.net)}`, detail: `Margin bersih ${margin}% setelah kompensasi owner. Tekan beban terbesar atau naikkan harga jual.` });
    else if (margin < 10) out.push({ tone: "amber", title: `Margin bersih ${last.label} tipis (${margin}%)`, detail: "Di bawah 10%. Tinjau HPP per produk dan biaya operasional." });
    else out.push({ tone: "green", title: `Margin bersih ${last.label} ${margin}%`, detail: "Sehat. Pertimbangkan menambah kapasitas produksi produk dengan margin tertinggi." });
    if (gross < 30) out.push({ tone: "amber", title: `Margin kotor ${gross}%`, detail: "HPP memakan lebih dari 70% penjualan. Cek harga bahan baku, reject produksi, dan harga jual." });
  }
  if (s.overdueCount) out.push({ tone: "red", title: `${s.overdueCount} utang lewat jatuh tempo (${rp(s.overdueAmount)})`, detail: "Bayar atau negosiasi ulang dengan supplier agar pasokan bahan baku tidak terganggu." });
  if (s.projected30 < 0) out.push({ tone: "red", title: `Proyeksi kas 30 hari minus ${rp(-s.projected30)}`, detail: "Kewajiban 30 hari melebihi kas bebas + rata-rata pemasukan. Tunda pembelian non-penting, percepat penagihan piutang." });
  else if (s.obligations30 > 0 && s.freeCash < s.obligations30) out.push({ tone: "amber", title: "Kas bebas belum menutup kewajiban 30 hari", detail: `Kas bebas ${rp(s.freeCash)} vs kewajiban ${rp(s.obligations30)}. Bergantung pada penjualan bulan ini.` });
  if (s.runwayMonths !== null && s.runwayMonths < 3) out.push({ tone: s.runwayMonths < 1 ? "red" : "amber", title: `Runway kas ±${s.runwayMonths} bulan`, detail: "Pengeluaran rata-rata lebih besar dari pemasukan. Targetkan cadangan kas minimal 3 bulan biaya operasional." });
  if (s.loanDebt > 0 && s.cur.revenue > 0) out.push({ tone: "blue", title: `Sisa pinjaman modal ${rp(s.loanDebt)}`, detail: "Jaga sisihan harian cicilan tetap jalan. Prioritaskan pelunasan sebelum menambah utang baru." });
  if (s.reservesMissingToday) out.push({ tone: "amber", title: `${s.reservesMissingToday} dana sisihan hari ini belum dicatat`, detail: "Catat di Finance › Dana sisihan agar kompensasi owner & cicilan tidak tertinggal." });
  if (s.advances > 0) out.push({ tone: "blue", title: `Kasbon karyawan berjalan ${rp(s.advances)}`, detail: "Akan dipotong dari gaji berikutnya. Batasi kasbon baru bila kas sedang ketat." });
  if (last && last.expenses > 0 && last.revenue > 0 && last.ownerComp / last.revenue > 0.3) out.push({ tone: "amber", title: "Kompensasi owner > 30% pendapatan", detail: "Wajar di awal usaha, tapi pantau agar tidak menghambat modal kerja." });
  if (!out.length) out.push({ tone: "blue", title: "Data belum cukup", detail: "Bukukan transaksi minimal 2 bulan agar tren dan saran bisa dihitung." });
  return out;
}
