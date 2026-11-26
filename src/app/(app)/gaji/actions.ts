"use server";
import { z } from "zod";
import { syncSalaryOverheadsSafe } from "@/lib/salaryOverhead";
import { prisma } from "@/lib/db";
import { autoCode } from "@/lib/codes";
import { action, str, int, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { approvePeriod, cancelAdvance, cancelPayment, unapprovePeriod, giveAdvance, repayAdvance, cancelPieceClaim, computePeriod, createPieceClaim, generateAllowancePayroll, generateMonthlyPayroll, payPeriod } from "@/lib/payroll";
import { dateOnly, jakartaDateTime, todayStr } from "@/lib/time";
import type { ProductionStage } from "@prisma/client";
import { zField } from "@/lib/fieldError";

export const createPeriod = action(
  "payroll.manage",
  async (fd, user) => {
    const start = str(fd, "startDate");
    const end = str(fd, "endDate");
    if (!start || !end || end < start) throw new Error("Rentang tanggal tidak valid");
    const p = await prisma.payrollPeriod.create({ data: { code: await autoCode.payrollPeriod(prisma, dateOnly(start)), startDate: dateOnly(start), endDate: dateOnly(end) } });
    await audit(user, "PERIODE_GAJI_DIBUAT", "PayrollPeriod", p.id);
    return "Periode dibuat";
  },
  ["/gaji"],
);

export const compute = action("payroll.manage", async (fd, user) => { await computePeriod(str(fd, "id"), user); return "Slip gaji dihitung"; }, ["/gaji"]);
export const approve = action("payroll.approve", async (fd, user) => { await approvePeriod(str(fd, "id"), user); return "Penggajian disetujui"; }, ["/gaji", "/"]);
export const unapprove = action("payroll.approve", async (fd, user) => { await unapprovePeriod(str(fd, "id"), str(fd, "reason"), user); return "Persetujuan dibatalkan, periode kembali draft"; }, ["/gaji", "/"]);
export const cancelPay = action("payroll.approve", async (fd, user) => { await cancelPayment(str(fd, "id"), str(fd, "reason"), user); return "Pembayaran dibatalkan, jurnal dibalik"; }, ["/gaji", "/", "/akuntansi"]);
export const pay = action(
  "payroll.approve",
  async (fd, user) => {
    const j = await payPeriod(str(fd, "id"), str(fd, "bankAccountId"), optStr(fd, "storeId"), user, jakartaDateTime(str(fd, "date"), "12:00"));
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
    // Potongan Alpa (gaji pokok ÷ 30 × hari Alpa) tetap; "Potongan" di sini = potongan lain/terlambat yang diubah manual
    const total = Math.max(0, Number(s.baseSalary + s.dailyWage + s.pieceWage + s.allowance + s.transport - s.advanceDeduction - s.alpaDeduction) + bonus - deduction);
    // Ubah hanya bila periodenya masih draft pada saat ditulis (Setujui bersamaan tidak boleh membuat slip beda dari jurnal hutang gaji)
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${s.periodId} FOR UPDATE`;
      if ((await tx.payrollPeriod.findUniqueOrThrow({ where: { id: s.periodId } })).status !== "DRAFT") throw new Error("Periode sudah disetujui");
      await tx.payslip.update({ where: { id }, data: { bonus: BigInt(bonus), deduction: BigInt(deduction), total: BigInt(total) } });
    });
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
    const name = zField(fd, "name", z.string().min(2, "Nama tugas wajib"));
    const t = id
      ? await prisma.pieceTask.update({ where: { id }, data: { name, ratePerPcs: BigInt(rate), active: fd.get("active") !== "off" } })
      : await prisma.pieceTask.create({ data: { name, ratePerPcs: BigInt(rate), code: await autoCode.pieceTask(prisma) } });
    await audit(user, "TUGAS_BORONGAN", "PieceTask", t.id, { name, rate });
    return "Tugas borongan tersimpan";
  },
  ["/gaji/borongan"],
);

/** Alur klaim borongan per karyawan (PieceWork) ditutup: hasil & klaim baru lewat Borongan › Klaim Upah */
const OLD_PIECE_FLOW = "Alur lama ini sudah ditutup (arsip read-only). Catat hasil dan klaim upah borongan lewat menu Borongan › Klaim Upah.";

export const addPieceWork = action(
  "payroll.manage",
  async () => {
    throw new Error(OLD_PIECE_FLOW);
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
  async () => {
    throw new Error(OLD_PIECE_FLOW);
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
    const a = await giveAdvance({ employeeId: str(fd, "employeeId"), amount: int(fd, "amount"), installment: int(fd, "installment"), bankAccountId: str(fd, "bankAccountId"), storeId: optStr(fd, "storeId"), date: str(fd, "date") || todayStr(), note: optStr(fd, "note") }, user);
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

export const saveAllowance = action(
  "payroll.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const name = zField(fd, "name", z.string().trim().min(2, "Nama tunjangan minimal 2 huruf"));
    const amount = int(fd, "amount");
    if (amount <= 0) throw new Error("Nominal tunjangan harus lebih dari 0");
    const payDay = int(fd, "payDay", 15);
    if (payDay < 1 || payDay > 31) throw new Error("Tanggal bayar tunjangan harus 1–31");
    const data = { name, amount: BigInt(amount), payDay, active: id ? fd.get("active") === "on" : true };
    const row = id ? await prisma.employeeAllowance.update({ where: { id }, data }) : await prisma.employeeAllowance.create({ data: { ...data, employeeId: str(fd, "employeeId") } });
    await audit(user, id ? "TUNJANGAN_DIUBAH" : "TUNJANGAN_DITAMBAH", "EmployeeAllowance", row.id, { name, amount, payDay });
    await syncSalaryOverheadsSafe();
    return "Tunjangan disimpan";
  },
  ["/gaji/tunjangan"],
);

export const deleteAllowance = action(
  "payroll.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    await prisma.employeeAllowance.delete({ where: { id } });
    await audit(user, "TUNJANGAN_DIHAPUS", "EmployeeAllowance", id, null);
    await syncSalaryOverheadsSafe();
    return "Tunjangan dihapus";
  },
  ["/gaji/tunjangan"],
);

export const generateAllowance = action(
  "payroll.manage",
  async (_fd, user) => {
    const r = await generateAllowancePayroll(user, new Date(), true);
    return r.created ? `Slip tunjangan ${r.created} dibuat` : "Slip tunjangan yang jatuh tempo bulan ini sudah ada, atau belum ada tunjangan aktif";
  },
  ["/gaji", "/gaji/tunjangan"],
);

export const cancelAdvanceAction = action("payroll.approve", async (fd, user) => { await cancelAdvance(str(fd, "id"), str(fd, "reason"), user); return "Kasbon dibatalkan, jurnal dibalik"; }, ["/gaji/kasbon", "/gaji", "/akuntansi"]);
