"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, int, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { approvePeriod, computePeriod, payPeriod } from "@/lib/payroll";
import { dateOnly, jakartaDateTime } from "@/lib/time";
import type { ProductionStage } from "@prisma/client";

export const createPeriod = action(
  "payroll.manage",
  async (fd, user) => {
    const start = str(fd, "startDate");
    const end = str(fd, "endDate");
    if (!start || !end || end < start) throw new Error("Rentang tanggal tidak valid");
    const p = await prisma.payrollPeriod.create({ data: { code: z.string().min(3, "Kode wajib").parse(str(fd, "code")), startDate: dateOnly(start), endDate: dateOnly(end) } });
    await audit(user, "PERIODE_GAJI_DIBUAT", "PayrollPeriod", p.id);
    return "Periode dibuat";
  },
  ["/gaji"],
);

export const compute = action("payroll.manage", async (fd, user) => { await computePeriod(str(fd, "id"), user); return "Slip gaji dihitung"; }, ["/gaji"]);
export const approve = action("payroll.approve", async (fd, user) => { await approvePeriod(str(fd, "id"), user); return "Penggajian disetujui"; }, ["/gaji", "/"]);
export const pay = action(
  "payroll.approve",
  async (fd, user) => {
    const j = await payPeriod(str(fd, "id"), str(fd, "bankAccountId"), str(fd, "storeId"), user, jakartaDateTime(str(fd, "date"), "12:00"));
    return `Gaji dibayar, jurnal ${j.number}`;
  },
  ["/gaji", "/"],
);

export const adjustSlip = action(
  "payroll.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const s = await prisma.payslip.findUniqueOrThrow({ where: { id }, include: { period: true } });
    if (s.period.status !== "DRAFT") throw new Error("Periode sudah disetujui");
    const bonus = int(fd, "bonus");
    const deduction = int(fd, "deduction");
    if (bonus < 0 || deduction < 0) throw new Error("Nilai tidak boleh negatif");
    const total = Number(s.dailyWage + s.pieceWage + s.transport) + bonus - deduction;
    await prisma.payslip.update({ where: { id }, data: { bonus: BigInt(bonus), deduction: BigInt(deduction), total: BigInt(total) } });
    await audit(user, "SLIP_DISESUAIKAN", "Payslip", id, { bonus, deduction });
    return "Slip diperbarui";
  },
  ["/gaji"],
);

export const saveRate = action(
  "payroll.manage",
  async (fd, user) => {
    const stage = str(fd, "stage") as ProductionStage;
    const rate = int(fd, "ratePerPcs");
    await prisma.pieceRate.upsert({ where: { stage }, create: { stage, ratePerPcs: BigInt(rate) }, update: { ratePerPcs: BigInt(rate) } });
    await audit(user, "TARIF_BORONGAN", "PieceRate", stage, { rate });
    return "Tarif borongan tersimpan";
  },
  ["/gaji/tarif"],
);

export const addTrip = action(
  "payroll.manage",
  async (fd, user) => {
    const amount = int(fd, "amount");
    if (amount <= 0) throw new Error("Nominal harus > 0");
    const t = await prisma.transportTrip.create({ data: { employeeId: str(fd, "employeeId"), date: dateOnly(str(fd, "date")), amount: BigInt(amount), note: optStr(fd, "note") } });
    await audit(user, "TRANSPORT_ASSEMBLING", "TransportTrip", t.id, { amount });
    return "Transport assembling tercatat";
  },
  ["/gaji/tarif"],
);
