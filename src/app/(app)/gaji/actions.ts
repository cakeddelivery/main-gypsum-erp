"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, int, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { approvePeriod, giveAdvance, repayAdvance, cancelPieceClaim, computePeriod, createPieceClaim, generateMonthlyPayroll, payPeriod } from "@/lib/payroll";
import { dateOnly, jakartaDateTime, todayStr } from "@/lib/time";
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
    // Potongan bolos/terlambat hasil hitungan tetap dipakai bila potongan tidak diubah
    const total = Math.max(0, Number(s.baseSalary + s.dailyWage + s.pieceWage + s.transport - s.advanceDeduction) + bonus - deduction);
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

export const generateMonthly = action(
  "payroll.manage",
  async (_fd, user) => {
    const r = await generateMonthlyPayroll(user);
    return r.created.length ? `Slip gaji bulanan dibuat: ${r.created.join(", ")}` : "Tidak ada siklus gaji bulanan baru yang selesai";
  },
  ["/gaji"],
);

export const savePieceTask = action(
  "payroll.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const rate = int(fd, "ratePerPcs");
    if (rate <= 0) throw new Error("Tarif harus > 0");
    const name = z.string().min(2, "Nama tugas wajib").parse(str(fd, "name"));
    const t = id
      ? await prisma.pieceTask.update({ where: { id }, data: { name, ratePerPcs: BigInt(rate), active: fd.get("active") !== "off" } })
      : await prisma.pieceTask.create({ data: { name, ratePerPcs: BigInt(rate), code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30) } });
    await audit(user, "TUGAS_BORONGAN", "PieceTask", t.id, { name, rate });
    return "Tugas borongan tersimpan";
  },
  ["/gaji/borongan"],
);

export const addPieceWork = action(
  "payroll.manage",
  async (fd, user) => {
    const qty = int(fd, "qty");
    if (qty <= 0) throw new Error("Jumlah harus > 0");
    const task = await prisma.pieceTask.findUniqueOrThrow({ where: { id: str(fd, "taskId") } });
    const w = await prisma.pieceWork.create({ data: { employeeId: str(fd, "employeeId"), taskId: task.id, date: dateOnly(str(fd, "date") || todayStr()), qty, rate: task.ratePerPcs, amount: task.ratePerPcs * BigInt(qty), note: optStr(fd, "note"), createdBy: user.name } });
    await audit(user, "HASIL_BORONGAN", "PieceWork", w.id, { task: task.code, qty });
    return `Tercatat ${qty} pcs ${task.name}`;
  },
  ["/gaji/borongan"],
);

export const deletePieceWork = action(
  "payroll.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const w = await prisma.pieceWork.findUniqueOrThrow({ where: { id } });
    if (w.periodId) throw new Error("Sudah diklaim; batalkan klaimnya dulu");
    await prisma.pieceWork.delete({ where: { id } });
    await audit(user, "HASIL_BORONGAN_DIHAPUS", "PieceWork", id, { qty: w.qty });
    return "Dihapus";
  },
  ["/gaji/borongan"],
);

export const claimPieces = action(
  "payroll.manage",
  async (fd, user) => {
    const p = await createPieceClaim(str(fd, "employeeId"), str(fd, "upTo") || todayStr(), user);
    return `Klaim ${p.code} dibuat, lanjutkan setujui & bayar`;
  },
  ["/gaji", "/gaji/borongan"],
);

export const cancelClaim = action(
  "payroll.manage",
  async (fd, user) => {
    await cancelPieceClaim(str(fd, "id"), user);
    return "Klaim dibatalkan";
  },
  ["/gaji", "/gaji/borongan"],
);

export const createAdvance = action(
  "payroll.approve",
  async (fd, user) => {
    const a = await giveAdvance({ employeeId: str(fd, "employeeId"), amount: int(fd, "amount"), installment: int(fd, "installment"), bankAccountId: str(fd, "bankAccountId"), storeId: str(fd, "storeId"), date: str(fd, "date") || todayStr(), note: optStr(fd, "note") }, user);
    return `Kasbon ${a.number} dicatat, dipotong otomatis dari gaji berikutnya`;
  },
  ["/gaji/kasbon"],
);

export const repayAdvanceAction = action(
  "payroll.approve",
  async (fd, user) => {
    await repayAdvance(str(fd, "id"), int(fd, "amount"), str(fd, "bankAccountId"), str(fd, "date") || todayStr(), user);
    return "Pelunasan kasbon dibukukan";
  },
  ["/gaji/kasbon"],
);
