import type { Prisma, ProductionStage, WageType } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA } from "./accounting";
import { audit } from "./audit";

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

/** Hitung (ulang) slip gaji seluruh karyawan aktif untuk periode DRAFT */
export async function computePeriod(periodId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const period = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (period.status !== "DRAFT") throw new PayrollError("Periode sudah disetujui; tidak bisa dihitung ulang");
    const range = { gte: period.startDate, lte: period.endDate };
    const [employees, rates, setting, onlyValidated] = await Promise.all([
      tx.employee.findMany({ where: { status: { not: "NONAKTIF" } } }),
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
          total: BigInt(calc.total),
        },
      });
    }
    await audit(actor, "GAJI_DIHITUNG", "PayrollPeriod", periodId, null, tx);
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
    const wages = p.payslips.reduce((s, x) => s + Number(x.dailyWage + x.pieceWage + x.bonus - x.deduction), 0);
    const transport = p.payslips.reduce((s, x) => s + Number(x.transport), 0);
    const lines = [
      ...(wages > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, debit: wages, memo: "Upah harian & borongan" }] : []),
      ...(transport > 0 ? [{ accountCode: COA.BEBAN_TRANSPORT, debit: transport, memo: "Transport assembling" }] : []),
      { accountId: bank.coaAccountId, credit: wages + transport },
    ];
    const j = await postJournal(tx, { date: paidAt, storeId, description: `Pembayaran gaji ${p.code}`, source: "PAYROLL", sourceId: p.id, actor, lines });
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "DIBAYAR", paidAt, paidFromAccountId: bankAccountId, journalId: j.id } });
    await audit(actor, "GAJI_DIBAYAR", "PayrollPeriod", periodId, { journal: j.number, total: wages + transport }, tx);
    return j;
  });
}
