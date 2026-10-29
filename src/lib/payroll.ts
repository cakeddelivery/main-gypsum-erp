import type { Prisma, ProductionStage, WageType } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA } from "./accounting";
import { nextNumber } from "./numbering";
import { audit } from "./audit";
import { addDays, dateOnly, dateStr, jakartaDateTime, todayStr } from "./time";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

export class PayrollError extends Error {}

export type PayslipCalcInput = {
  wageType: WageType;
  dailyRate: number;
  daysPresent: number;
  lateMinutes: number;
  pieces: Partial<Record<ProductionStage, number>>;
  rates: Partial<Record<ProductionStage, number>>;
  transport: number;
  lateDeductionPerMinute: number;
  bonus?: number;
};

/** Perhitungan murni slip gaji: upah harian + borongan (Filling Cat, Assembling, ...) + transport assembling. */
export function calcPayslip(i: PayslipCalcInput) {
  const dailyWage = i.wageType === "BORONGAN" ? 0 : i.daysPresent * i.dailyRate;
  const pieceDetail: { stage: string; qty: number; rate: number; amount: number }[] = [];
  let pieceWage = 0;
  if (i.wageType !== "HARIAN") {
    for (const [stage, qty] of Object.entries(i.pieces)) {
      const rate = i.rates[stage as ProductionStage] ?? 0;
      if (!qty || !rate) continue;
      pieceDetail.push({ stage, qty, rate, amount: qty * rate });
      pieceWage += qty * rate;
    }
  }
  const deduction = Math.min(dailyWage + pieceWage, i.lateMinutes * i.lateDeductionPerMinute);
  const bonus = i.bonus ?? 0;
  return { dailyWage, pieceWage, pieceDetail, transport: i.transport, bonus, deduction, total: dailyWage + pieceWage + i.transport + bonus - deduction };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Tanggal "ulang bulan" dari tanggal masuk pada bulan tertentu (tgl 31 → akhir bulan bila bulan lebih pendek) */
export function anniversary(joinDate: string, year: number, month: number) {
  const day = Math.min(Number(joinDate.slice(8, 10)), daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftMonth(year: number, month: number, by: number) {
  const m = year * 12 + (month - 1) + by;
  return { year: Math.floor(m / 12), month: (m % 12) + 1 };
}

export type MonthlyCycle = { start: string; end: string; anniversary: string; payDate: string };

/**
 * Siklus gaji bulanan terakhir yang sudah selesai per `today`.
 * Contoh masuk tgl 10: siklus 10 Okt – 9 Nov, slip dibuat 10 Nov, gajian H+7 = 17 Nov.
 */
export function lastCompletedCycle(joinDate: string, today: string, payOffsetDays = 7): MonthlyCycle | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  let ann = anniversary(joinDate, y, m);
  let prev = shiftMonth(y, m, -1);
  if (ann > today) {
    ann = anniversary(joinDate, prev.year, prev.month);
    prev = shiftMonth(prev.year, prev.month, -1);
  }
  const start = anniversary(joinDate, prev.year, prev.month);
  if (start < joinDate) return null; // belum genap sebulan bekerja
  return { start, end: addDays(ann, -1), anniversary: ann, payDate: addDays(ann, payOffsetDays) };
}

/**
 * Jatah libur: siklus dipotong per 7 hari dari awal siklus; tiap blok boleh `quota` hari tidak masuk
 * (blok sisa di akhir siklus mendapat jatah proporsional). Tidak masuk melebihi jatah = bolos.
 */
export function countAbsence(start: string, end: string, present: Set<string>, quota = 1) {
  let offDays = 0;
  let absentDays = 0;
  let workDays = 0;
  for (let blockStart = start; blockStart <= end; blockStart = addDays(blockStart, 7)) {
    let len = 0;
    let missing = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(blockStart, i);
      if (day > end) break;
      len++;
      if (!present.has(day)) missing++;
    }
    const allowed = Math.round((quota * len) / 7);
    const off = Math.min(missing, allowed);
    offDays += off;
    absentDays += missing - off;
    workDays += len - missing;
  }
  return { offDays, absentDays, workDays };
}

/**
 * Awal hitungan absen: hari sebelum tanggal go-live (aplikasi mulai dipakai) tidak punya data absen,
 * jadi dianggap masuk. Mengembalikan null bila seluruh siklus sebelum go-live (gaji dibayar penuh).
 */
export function attendanceStart(start: string, end: string, goLive: string | null) {
  if (!goLive || goLive <= start) return start;
  return goLive > end ? null : goLive;
}

export type AllowanceLine = { name: string; amount: number };

/** Total tunjangan aktif satu karyawan */
export function sumAllowances(rows: { name: string; amount: number | bigint; active: boolean }[]): { total: number; detail: AllowanceLine[] } {
  const detail = rows.filter((r) => r.active && Number(r.amount) > 0).map((r) => ({ name: r.name, amount: Number(r.amount) }));
  return { total: detail.reduce((s, d) => s + d.amount, 0), detail };
}

/** Periode tunjangan bulan berjalan: dibuat mulai tanggal `payday` (default 15), dibayar pada tanggal itu */
export function allowancePeriodFor(today: string, payday = 15) {
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = String(Math.min(Math.max(1, payday), last)).padStart(2, "0");
  const ym = `${y}-${String(m).padStart(2, "0")}`;
  const payDate = `${ym}-${day}`;
  return { code: `TNJ-${ym.replace("-", "")}`, start: `${ym}-01`, payDate, due: today >= payDate };
}

export type MonthlyCalcInput = {
  monthlySalary: number;
  absentDays: number;
  workdaysPerMonth: number;
  lateMinutes: number;
  lateDeductionPerMinute: number;
  transport: number;
  resignedBeforePayday: boolean;
};

/** Gaji bulanan: gaji pokok − (bolos × gaji/hari) − potongan terlambat; resign sebelum gajian = Rp0 */
export function calcMonthly(i: MonthlyCalcInput) {
  if (i.resignedBeforePayday) return { baseSalary: i.monthlySalary, deduction: 0, transport: 0, total: 0, note: "Resign sebelum tanggal gajian: tidak menerima gaji" };
  const perDay = Math.round(i.monthlySalary / Math.max(1, i.workdaysPerMonth));
  const deduction = Math.min(i.monthlySalary, i.absentDays * perDay + i.lateMinutes * i.lateDeductionPerMinute);
  return { baseSalary: i.monthlySalary, deduction, transport: i.transport, total: i.monthlySalary - deduction + i.transport, note: i.absentDays ? `Bolos ${i.absentDays} hari × Rp ${perDay.toLocaleString("id-ID")}` : null };
}

async function settingStr(tx: Tx, key: string) {
  const s = await tx.setting.findUnique({ where: { key } });
  return s?.value?.trim() || null;
}

async function settingNum(tx: Tx, key: string, def: number) {
  const s = await tx.setting.findUnique({ where: { key } });
  const v = Number(s?.value);
  return Number.isFinite(v) && s?.value !== "" ? v : def;
}

type AdvanceAlloc = { id: string; number: string; amount: number };

/**
 * Potongan kasbon untuk satu slip (maksimal sebesar `available`), cicilan per slip sesuai kasbon.
 * Kasbon yang sudah dialokasikan di slip lain yang belum dibayar tidak dipotong dua kali.
 */
async function allocateAdvances(tx: Tx, employeeId: string, periodId: string, available: number) {
  const none = { deduction: 0, detail: [] as AdvanceAlloc[] };
  if (available <= 0) return none;
  const advances = (await tx.cashAdvance.findMany({ where: { employeeId }, orderBy: { date: "asc" } })).filter((a) => a.repaid < a.amount);
  if (!advances.length) return none;
  const pending = await tx.payslip.findMany({ where: { employeeId, periodId: { not: periodId }, advanceDeduction: { gt: 0 }, period: { status: { not: "DIBAYAR" } } } });
  const reserved = new Map<string, number>();
  for (const p of pending) for (const d of p.advanceDetail as AdvanceAlloc[]) reserved.set(d.id, (reserved.get(d.id) ?? 0) + d.amount);
  let left = available;
  const detail: AdvanceAlloc[] = [];
  for (const a of advances) {
    const remaining = Number(a.amount - a.repaid) - (reserved.get(a.id) ?? 0);
    const take = Math.min(remaining, Number(a.installment) > 0 ? Number(a.installment) : remaining, left);
    if (take <= 0) continue;
    detail.push({ id: a.id, number: a.number, amount: take });
    left -= take;
    if (left <= 0) break;
  }
  return { deduction: available - left, detail };
}

/** Beri kasbon: Dr Piutang Karyawan / Cr rekening; dipotong otomatis dari slip gaji berikutnya */
export async function giveAdvance(input: { employeeId: string; amount: number; installment: number; bankAccountId: string; storeId: string; date: string; note?: string | null }, actor: Actor) {
  if (!(input.amount > 0)) throw new PayrollError("Nominal kasbon harus > 0");
  if (input.installment < 0 || input.installment > input.amount) throw new PayrollError("Cicilan per gajian harus 0 – nominal kasbon");
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: input.employeeId } });
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } });
    const number = await nextNumber(tx, "KSB");
    const j = await postJournal(tx, { date: jakartaDateTime(input.date, "12:00"), storeId: input.storeId, description: `Kasbon ${number} ${emp.name}`, source: "KASBON", sourceId: number, actor, lines: [{ accountCode: COA.PIUTANG_KARYAWAN, debit: input.amount }, { accountId: bank.coaAccountId, credit: input.amount }] });
    const a = await tx.cashAdvance.create({ data: { number, employeeId: emp.id, date: dateOnly(input.date), amount: BigInt(input.amount), installment: BigInt(input.installment), paidFromAccountId: bank.id, note: input.note ?? null, journalId: j.id, createdBy: actor.name } });
    await audit(actor, "KASBON_DIBERIKAN", "CashAdvance", a.id, { number, amount: input.amount }, tx);
    return a;
  });
}

/** Pelunasan kasbon di luar gaji (tunai/transfer): Dr rekening / Cr Piutang Karyawan */
export async function repayAdvance(advanceId: string, amount: number, bankAccountId: string, date: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CashAdvance" WHERE id = ${advanceId} FOR UPDATE`;
    const a = await tx.cashAdvance.findUniqueOrThrow({ where: { id: advanceId }, include: { employee: true } });
    const remaining = Number(a.amount - a.repaid);
    if (!(amount > 0) || amount > remaining) throw new PayrollError(`Nominal pelunasan harus 1 – ${remaining}`);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
    const storeId = (await tx.setting.findUnique({ where: { key: "default_store_id" } }))?.value ?? (await tx.store.findFirstOrThrow()).id;
    await postJournal(tx, { date: jakartaDateTime(date, "12:00"), storeId, description: `Pelunasan kasbon ${a.number} ${a.employee.name}`, source: "KASBON", sourceId: a.number, actor, lines: [{ accountId: bank.coaAccountId, debit: amount }, { accountCode: COA.PIUTANG_KARYAWAN, credit: amount }] });
    await tx.cashAdvance.update({ where: { id: a.id }, data: { repaid: { increment: BigInt(amount) } } });
    await audit(actor, "KASBON_DILUNASI", "CashAdvance", a.id, { amount }, tx);
  });
}

/** Hitung (ulang) slip gaji seluruh karyawan aktif untuk periode DRAFT */
export async function computePeriod(periodId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (period.status !== "DRAFT") throw new PayrollError("Periode sudah disetujui; tidak bisa dihitung ulang");
    if (period.kind === "BULANAN") return computeMonthly(tx, period, actor);
    if (period.kind === "BORONGAN") return computeClaim(tx, period, actor);
    if (period.kind === "TUNJANGAN") return computeAllowance(tx, period, actor);
    const range = { gte: period.startDate, lte: period.endDate };
    const [employees, rates, setting, onlyValidated] = await Promise.all([
      // Gaji bulanan & pekerja borongan punya alur sendiri (siklus H+7 dan klaim)
      tx.employee.findMany({ where: { status: { not: "NONAKTIF" }, wageType: { in: ["HARIAN", "CAMPURAN"] } } }),
      tx.pieceRate.findMany(),
      tx.setting.findUnique({ where: { key: "late_deduction_per_minute" } }),
      tx.setting.findUnique({ where: { key: "payroll_require_validated" } }),
    ]);
    const rateMap = Object.fromEntries(rates.map((r) => [r.stage, Number(r.ratePerPcs)]));
    const lateDed = Number(setting?.value ?? 0);
    const requireValidated = (onlyValidated?.value ?? "true") === "true";
    await tx.payslip.deleteMany({ where: { periodId } });
    for (const e of employees) {
      const att = await tx.attendance.findMany({ where: { employeeId: e.id, date: range, status: { in: ["HADIR", "TERLAMBAT"] }, ...(requireValidated ? { validated: true } : {}) } });
      const prod = await tx.productionEntry.groupBy({ by: ["stage"], where: { employeeId: e.id, date: range }, _sum: { qtyGood: true } });
      const trips = await tx.transportTrip.aggregate({ where: { employeeId: e.id, date: range }, _sum: { amount: true } });
      const calc = calcPayslip({
        wageType: e.wageType,
        dailyRate: Number(e.dailyRate),
        daysPresent: att.length,
        lateMinutes: att.reduce((s, a) => s + a.lateMinutes, 0),
        pieces: Object.fromEntries(prod.map((p) => [p.stage, p._sum.qtyGood ?? 0])),
        rates: rateMap,
        transport: Number(trips._sum.amount ?? 0),
        lateDeductionPerMinute: lateDed,
      });
      if (calc.total === 0 && att.length === 0) continue;
      const adv = await allocateAdvances(tx, e.id, periodId, calc.total);
      await tx.payslip.create({
        data: {
          periodId,
          employeeId: e.id,
          daysPresent: att.length,
          dailyWage: BigInt(calc.dailyWage),
          pieceWage: BigInt(calc.pieceWage),
          pieceDetail: calc.pieceDetail,
          transport: BigInt(calc.transport),
          bonus: BigInt(calc.bonus),
          deduction: BigInt(calc.deduction),
          advanceDeduction: BigInt(adv.deduction),
          advanceDetail: adv.detail,
          total: BigInt(calc.total - adv.deduction),
        },
      });
    }
    await audit(actor, "GAJI_DIHITUNG", "PayrollPeriod", periodId, null, tx);
  });
}

type Period = Awaited<ReturnType<Tx["payrollPeriod"]["findUniqueOrThrow"]>>;

/** Karyawan bulanan yang siklusnya sama dengan periode ini */
async function monthlyEmployeesFor(tx: Tx, period: Period, offset: number) {
  const ann = addDays(dateStr(period.endDate), 1);
  const emps = await tx.employee.findMany({ where: { wageType: "BULANAN", joinDate: { not: null } } });
  return emps.filter((e) => {
    const c = lastCompletedCycle(dateStr(e.joinDate!), ann, offset);
    if (!c || c.anniversary !== ann || c.start !== dateStr(period.startDate)) return false;
    if (e.resignDate && dateStr(e.resignDate) < c.start) return false; // sudah keluar sebelum siklus
    return e.status !== "NONAKTIF" || !!e.resignDate;
  });
}

async function computeMonthly(tx: Tx, period: Period, actor: Actor) {
  const [offset, quota, workdays, lateDed, requireValidated, goLive] = await Promise.all([
    settingNum(tx, "payday_offset_days", 7),
    settingNum(tx, "weekly_off_quota", 1),
    settingNum(tx, "monthly_workdays", 26),
    settingNum(tx, "late_deduction_per_minute", 0),
    tx.setting.findUnique({ where: { key: "payroll_require_validated" } }).then((s) => (s?.value ?? "true") === "true"),
    settingStr(tx, "go_live_date"),
  ]);
  const start = dateStr(period.startDate);
  const end = dateStr(period.endDate);
  const countFrom = attendanceStart(start, end, goLive);
  const payDate = period.payDate ? dateStr(period.payDate) : addDays(end, 1 + offset);
  const employees = await monthlyEmployeesFor(tx, period, offset);
  await tx.payslip.deleteMany({ where: { periodId: period.id } });
  for (const e of employees) {
    const att = await tx.attendance.findMany({ where: { employeeId: e.id, date: { gte: period.startDate, lte: period.endDate }, status: { in: ["HADIR", "TERLAMBAT"] }, ...(requireValidated ? { validated: true } : {}) } });
    const present = new Set(att.map((a) => dateStr(a.date)));
    const { offDays, absentDays } = countFrom ? countAbsence(countFrom, end, present, quota) : { offDays: 0, absentDays: 0 };
    const trips = await tx.transportTrip.aggregate({ where: { employeeId: e.id, date: { gte: period.startDate, lte: period.endDate } }, _sum: { amount: true } });
    const calc = calcMonthly({
      monthlySalary: Number(e.monthlySalary),
      absentDays,
      workdaysPerMonth: workdays,
      lateMinutes: att.reduce((s, a) => s + a.lateMinutes, 0),
      lateDeductionPerMinute: lateDed,
      transport: Number(trips._sum.amount ?? 0),
      resignedBeforePayday: !!e.resignDate && dateStr(e.resignDate) < payDate,
    });
    const adv = await allocateAdvances(tx, e.id, period.id, calc.total);
    const preLive = countFrom !== start ? (countFrom ? `Absen dihitung mulai go-live ${countFrom}` : "Siklus sebelum go-live aplikasi: gaji penuh") : null;
    await tx.payslip.create({
      data: {
        periodId: period.id,
        employeeId: e.id,
        daysPresent: present.size,
        baseSalary: BigInt(calc.baseSalary),
        offDays,
        absentDays,
        note: [calc.note, preLive].filter(Boolean).join(" · ") || null,
        dailyWage: BigInt(0),
        pieceWage: BigInt(0),
        pieceDetail: [],
        transport: BigInt(calc.transport),
        deduction: BigInt(calc.deduction),
        advanceDeduction: BigInt(adv.deduction),
        advanceDetail: adv.detail,
        total: BigInt(calc.total - adv.deduction),
      },
    });
  }
  await audit(actor, "GAJI_BULANAN_DIHITUNG", "PayrollPeriod", period.id, { employees: employees.length }, tx);
}

async function computeClaim(tx: Tx, period: Period, actor: Actor) {
  if (!period.employeeId) throw new PayrollError("Klaim borongan tanpa pekerja");
  const works = await tx.pieceWork.findMany({ where: { periodId: period.id }, include: { task: true } });
  const byTask = new Map<string, { stage: string; qty: number; rate: number; amount: number }>();
  for (const w of works) {
    const key = `${w.task.name}@${w.rate}`;
    const cur = byTask.get(key) ?? { stage: w.task.name, qty: 0, rate: Number(w.rate), amount: 0 };
    cur.qty += w.qty;
    cur.amount += Number(w.amount);
    byTask.set(key, cur);
  }
  const pieceDetail = [...byTask.values()];
  const pieceWage = pieceDetail.reduce((s, d) => s + d.amount, 0);
  await tx.payslip.deleteMany({ where: { periodId: period.id } });
  const adv = await allocateAdvances(tx, period.employeeId, period.id, pieceWage);
  await tx.payslip.create({ data: { periodId: period.id, employeeId: period.employeeId, daysPresent: new Set(works.map((w) => dateStr(w.date))).size, dailyWage: BigInt(0), pieceWage: BigInt(pieceWage), pieceDetail, transport: BigInt(0), advanceDeduction: BigInt(adv.deduction), advanceDetail: adv.detail, total: BigInt(pieceWage - adv.deduction) } });
  await audit(actor, "KLAIM_BORONGAN_DIHITUNG", "PayrollPeriod", period.id, { pieceWage }, tx);
}

/** Slip tunjangan: semua karyawan aktif yang punya tunjangan; resign sebelum tanggal bayar tidak menerima */
async function computeAllowance(tx: Tx, period: Period, actor: Actor) {
  const payDate = period.payDate ? dateStr(period.payDate) : dateStr(period.endDate);
  const emps = await tx.employee.findMany({ where: { allowances: { some: { active: true } } }, include: { allowances: true } });
  await tx.payslip.deleteMany({ where: { periodId: period.id } });
  let count = 0;
  for (const e of emps) {
    if (e.status === "NONAKTIF" && !e.resignDate) continue;
    if (e.resignDate && dateStr(e.resignDate) < payDate) continue;
    const a = sumAllowances(e.allowances);
    if (!a.total) continue;
    await tx.payslip.create({ data: { periodId: period.id, employeeId: e.id, daysPresent: 0, dailyWage: BigInt(0), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), allowance: BigInt(a.total), allowanceDetail: a.detail, total: BigInt(a.total), note: "Tunjangan bulanan" } });
    count++;
  }
  await audit(actor, "TUNJANGAN_DIHITUNG", "PayrollPeriod", period.id, { employees: count }, tx);
}

/** Buat periode tunjangan bulan berjalan bila sudah tanggal bayar (default 15). Idempoten. */
export async function generateAllowancePayroll(actor: Actor, now: Date = new Date(), force = false) {
  const today = todayStr(now);
  const db = prisma as unknown as Tx;
  const payday = await settingNum(db, "allowance_payday", 15);
  const goLive = await settingStr(db, "go_live_date");
  const p = allowancePeriodFor(today, payday);
  if (!p.due && !force) return { created: null };
  if (goLive && p.payDate < goLive && !force) return { created: null };
  if (await prisma.payrollPeriod.findUnique({ where: { code: p.code } })) return { created: null };
  const has = await prisma.employeeAllowance.count({ where: { active: true } });
  if (!has) return { created: null };
  const period = await prisma.payrollPeriod.create({ data: { code: p.code, kind: "TUNJANGAN", startDate: dateOnly(p.start), endDate: dateOnly(p.payDate), payDate: dateOnly(p.payDate) } });
  await computePeriod(period.id, actor);
  return { created: period.code };
}

/**
 * Buat slip gaji bulanan otomatis untuk siklus yang sudah selesai (dipanggil harian oleh scheduler).
 * Idempoten: periode per siklus hanya dibuat sekali; siklus yang terlewat ≤ 31 hari ikut dibuat.
 */
export async function generateMonthlyPayroll(actor: Actor, now: Date = new Date()) {
  const today = todayStr(now);
  const offset = await settingNum(prisma as unknown as Tx, "payday_offset_days", 7);
  const emps = await prisma.employee.findMany({ where: { wageType: "BULANAN", joinDate: { not: null } } });
  const cycles = new Map<string, { start: string; end: string; payDate: string }>();
  for (const e of emps) {
    if (e.status === "NONAKTIF" && !e.resignDate) continue;
    const c = lastCompletedCycle(dateStr(e.joinDate!), today, offset);
    if (!c || addDays(c.anniversary, 31) < today) continue;
    if (e.resignDate && dateStr(e.resignDate) < c.start) continue;
    cycles.set(`${c.start}|${c.end}`, c);
  }
  const created: string[] = [];
  for (const c of cycles.values()) {
    const exists = await prisma.payrollPeriod.findFirst({ where: { kind: "BULANAN", startDate: dateOnly(c.start), endDate: dateOnly(c.end) } });
    if (exists) continue;
    const p = await prisma.payrollPeriod.create({ data: { code: `GJB-${c.end.replace(/-/g, "")}`, kind: "BULANAN", startDate: dateOnly(c.start), endDate: dateOnly(c.end), payDate: dateOnly(c.payDate) } });
    await computePeriod(p.id, actor);
    created.push(p.code);
  }
  return { created };
}

/** Klaim borongan: semua hasil kerja yang belum dibayar s/d tanggal klaim menjadi satu slip */
export async function createPieceClaim(employeeId: string, upTo: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const where = { employeeId, periodId: null, date: { lte: dateOnly(upTo) } };
    const first = await tx.pieceWork.findFirst({ where, orderBy: { date: "asc" } });
    if (!first) throw new PayrollError(`Tidak ada hasil borongan ${emp.name} yang belum diklaim`);
    const p = await tx.payrollPeriod.create({ data: { code: `KLM-${emp.code}-${upTo.replace(/-/g, "")}-${Date.now().toString(36).slice(-4)}`, kind: "BORONGAN", employeeId, startDate: first.date, endDate: dateOnly(upTo), payDate: dateOnly(upTo) } });
    await tx.pieceWork.updateMany({ where, data: { periodId: p.id } });
    await computeClaim(tx, p, actor);
    await audit(actor, "KLAIM_BORONGAN_DIBUAT", "PayrollPeriod", p.id, { employee: emp.code }, tx);
    return p;
  });
}

/** Batalkan klaim yang masih draft: hasil kerja kembali menjadi belum diklaim */
export async function cancelPieceClaim(periodId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (p.kind !== "BORONGAN" || p.status !== "DRAFT") throw new PayrollError("Hanya klaim borongan berstatus draft yang bisa dibatalkan");
    await tx.pieceWork.updateMany({ where: { periodId }, data: { periodId: null } });
    await tx.payrollPeriod.delete({ where: { id: periodId } });
    await audit(actor, "KLAIM_BORONGAN_DIBATALKAN", "PayrollPeriod", periodId, { code: p.code }, tx);
  });
}

export async function approvePeriod(periodId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { payslips: true } });
    if (p.status !== "DRAFT") throw new PayrollError("Periode bukan draft");
    if (!p.payslips.length) throw new PayrollError("Belum ada slip gaji; hitung dahulu");
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "DISETUJUI", approvedBy: actor.name } });
    await audit(actor, "GAJI_DISETUJUI", "PayrollPeriod", periodId, null, tx);
  });
}

/** Bayar gaji: integrasi biaya tenaga kerja ke keuangan (jurnal beban gaji & transport). */
export async function payPeriod(periodId: string, bankAccountId: string, storeId: string, actor: Actor, paidAt: Date = new Date()) {
  return prisma.$transaction(async (tx: Tx) => {
    await tx.$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${periodId} FOR UPDATE`;
    const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { payslips: true } });
    if (p.status !== "DISETUJUI") throw new PayrollError("Periode harus disetujui sebelum dibayar");
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
    if (p.kind === "BULANAN") {
      // Resign setelah slip dihitung tetapi sebelum tanggal gajian: slip menjadi Rp0
      const payDay = p.payDate ? dateStr(p.payDate) : todayStr(paidAt);
      const resigned = await tx.employee.findMany({ where: { id: { in: p.payslips.map((x) => x.employeeId) }, resignDate: { lt: dateOnly(payDay) } } });
      for (const e of resigned) {
        const slip = p.payslips.find((x) => x.employeeId === e.id)!;
        if (slip.total === BigInt(0)) continue;
        await tx.payslip.update({ where: { id: slip.id }, data: { total: BigInt(0), transport: BigInt(0), advanceDeduction: BigInt(0), advanceDetail: [], note: "Resign sebelum tanggal gajian: tidak menerima gaji" } });
        slip.total = BigInt(0);
        slip.transport = BigInt(0);
        slip.advanceDeduction = BigInt(0);
        slip.advanceDetail = [];
      }
    }
    // Beban = gaji kotor; kasbon yang dipotong melunasi piutang karyawan, sisanya keluar dari rekening
    const advances = p.payslips.reduce((s, x) => s + Number(x.advanceDeduction), 0);
    const wages = p.payslips.reduce((s, x) => s + Number(x.total + x.advanceDeduction - x.transport), 0);
    const transport = p.payslips.reduce((s, x) => s + Number(x.transport), 0);
    const net = wages + transport - advances;
    const lines = [
      ...(wages > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, debit: wages, memo: p.kind === "TUNJANGAN" ? "Tunjangan karyawan" : "Gaji bulanan, upah harian & borongan" }] : []),
      ...(transport > 0 ? [{ accountCode: COA.BEBAN_TRANSPORT, debit: transport, memo: "Transport assembling" }] : []),
      ...(advances > 0 ? [{ accountCode: COA.PIUTANG_KARYAWAN, credit: advances, memo: "Potongan kasbon" }] : []),
      ...(net > 0 ? [{ accountId: bank.coaAccountId, credit: net }] : []),
    ];
    for (const x of p.payslips) for (const d of x.advanceDetail as AdvanceAlloc[]) await tx.cashAdvance.update({ where: { id: d.id }, data: { repaid: { increment: BigInt(d.amount) } } });
    if (wages + transport === 0) {
      await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "DIBAYAR", paidAt, paidFromAccountId: bankAccountId } });
      await audit(actor, "GAJI_DIBAYAR", "PayrollPeriod", periodId, { total: 0 }, tx);
      return { number: "tanpa jurnal (Rp0)" } as { number: string };
    }
    const j = await postJournal(tx, { date: paidAt, storeId, description: `Pembayaran gaji ${p.code}`, source: "PAYROLL", sourceId: p.id, actor, lines });
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "DIBAYAR", paidAt, paidFromAccountId: bankAccountId, journalId: j.id } });
    await audit(actor, "GAJI_DIBAYAR", "PayrollPeriod", periodId, { journal: j.number, total: net, advances }, tx);
    return j;
  });
}
