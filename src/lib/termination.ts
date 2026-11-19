import { randomBytes } from "node:crypto";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { ContractError, nextSequence, type ContractSnapshot } from "./contract";
import { canonical, contractNumber, newVerifyCode, sha256 } from "./contractTemplate";
import { finalPay, TERMINATION_REASONS, type TerminationReason } from "./terminationCalc";
import { dateOnly, dateStr, todayStr } from "./time";

type Actor = { id: string; name: string; role: Role; employeeId: string | null };

export type TerminationInput = { employeeId: string; reason: string; effective: string; damage?: number; note?: string | null; evidencePath?: string | null };

/** Buat draf pengakhiran kontrak + slip akhir otomatis (hitungan dibekukan di draf; ubah = buat ulang) */
export async function createTermination(actor: Actor, input: TerminationInput, now = new Date()) {
  if (!(input.reason in TERMINATION_REASONS)) throw new ContractError("Pilih alasan pengakhiran");
  const reason = input.reason as TerminationReason;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effective)) throw new ContractError("Tanggal efektif tidak valid");
  if (reason === "PELANGGARAN_BERAT" && !input.evidencePath && (input.note ?? "").trim().length < 10) throw new ContractError("Pelanggaran berat wajib disertai bukti (lampiran) atau uraian yang jelas");
  const emp = await prisma.employee.findUnique({ where: { id: input.employeeId }, include: { allowances: { where: { active: true } } } });
  if (!emp) throw new ContractError("Karyawan tidak ditemukan");
  const open = await prisma.termination.findFirst({ where: { employeeId: emp.id, status: { in: ["DRAFT", "DITERBITKAN"] } } });
  if (open) throw new ContractError(`Sudah ada pengakhiran ${open.number} untuk karyawan ini`);
  const contract = await prisma.contract.findFirst({ where: { employeeId: emp.id, status: "AKTIF", kind: "PKWT" }, orderBy: [{ startDate: "desc" }, { seq: "desc" }] });
  if (!contract) throw new ContractError("Karyawan belum punya kontrak PKWT yang terkunci");
  // Addendum terbaru menggantikan gaji pokok / masa kerja
  const add = await prisma.contract.findFirst({ where: { parentId: contract.id, status: "AKTIF", kind: "ADD" }, orderBy: { seq: "desc" } });
  const snap = (add ?? contract).snapshot as unknown as ContractSnapshot;
  const start = dateStr(contract.startDate);
  const end = add ? dateStr(add.endDate) : dateStr(contract.endDate);
  if (input.effective < start) throw new ContractError("Tanggal efektif sebelum kontrak dimulai");
  const joinDate = emp.joinDate ? dateStr(emp.joinDate) : start;
  const cyc = finalPay({ reason, baseSalary: snap.pay.baseSalary, allowanceTotal: snap.pay.allowances.reduce((a, x) => a + x.amount, 0), joinDate, contractStart: start, contractEnd: end, effective: input.effective, alpaDays: 0, damage: input.damage });
  const alpa = await prisma.attendance.count({ where: { employeeId: emp.id, status: "ALPA", date: { gte: dateOnly(cyc.cycle.start), lte: dateOnly(input.effective) } } });
  const pay = alpa ? finalPay({ reason, baseSalary: snap.pay.baseSalary, allowanceTotal: snap.pay.allowances.reduce((a, x) => a + x.amount, 0), joinDate, contractStart: start, contractEnd: end, effective: input.effective, alpaDays: alpa, damage: input.damage }) : cyc;
  const today = todayStr(now);
  const year = Number(today.slice(0, 4));
  const calc = { ...pay, baseSalary: snap.pay.baseSalary, contractNumber: contract.number, contractStart: start, contractEnd: end, alpaDays: alpa, damage: input.damage ?? 0, employeeName: emp.name };
  return prisma.$transaction(async (tx) => {
    const seq = await nextSequence(tx, `KONTRAK:${year}`);
    const number = contractNumber(seq, "PHK", today);
    const t = await tx.termination.create({
      data: { number, seq, year, contractId: contract.id, employeeId: emp.id, reason, effectiveDate: dateOnly(input.effective), note: input.note?.trim().slice(0, 1000) || null, evidencePath: input.evidencePath ?? null, calc: calc as unknown as Prisma.InputJsonValue, verifyCode: newVerifyCode((n) => randomBytes(n)), createdBy: actor.name },
    });
    await audit(actor, "PENGAKHIRAN_DIBUAT", "Termination", t.id, { number, alasan: reason, bersih: pay.net }, tx);
    return t;
  });
}

/** HRD menerbitkan surat (tandatangan QR): hitungan dibekukan + hash; tanggal resign karyawan diatur agar akun berhenti pada tanggal efektif */
export async function issueTermination(actor: Actor, id: string, opts: { confirmValue?: boolean } = {}, now = new Date()) {
  const t = await prisma.termination.findUniqueOrThrow({ where: { id } });
  if (t.status !== "DRAFT") throw new ContractError("Surat ini sudah diterbitkan atau dibatalkan");
  const calc = t.calc as unknown as { warnings: string[] };
  if (t.reason === "DIPUTUS_PERUSAHAAN" && !opts.confirmValue) throw new ContractError("Periksa nilai ganti rugi, lalu centang konfirmasi sebelum menerbitkan");
  if (actor.employeeId && actor.employeeId === t.employeeId && actor.role !== "OWNER") throw new ContractError("Surat untuk Anda sendiri harus diterbitkan HRD lain");
  const hash = sha256(canonical({ number: t.number, reason: t.reason, effective: dateStr(t.effectiveDate), calc: t.calc, note: t.note }));
  await prisma.$transaction(async (tx) => {
    const r = await tx.termination.updateMany({ where: { id, status: "DRAFT" }, data: { status: "DITERBITKAN", contentHash: hash, issuedAt: now, issuedBy: actor.name, issuedById: actor.id } });
    if (!r.count) throw new ContractError("Surat ini sudah diterbitkan atau dibatalkan");
    await tx.employee.update({ where: { id: t.employeeId }, data: { resignDate: t.effectiveDate } });
    await audit(actor, "PENGAKHIRAN_DITERBITKAN", "Termination", id, { number: t.number, hash, peringatan: calc.warnings }, tx);
  });
  return hash;
}

export async function voidTermination(actor: Actor, id: string, reason: string) {
  if (reason.trim().length < 3) throw new ContractError("Tulis alasan pembatalan");
  const t = await prisma.termination.findUniqueOrThrow({ where: { id } });
  if (t.status === "BATAL") throw new ContractError("Sudah dibatalkan");
  await prisma.$transaction(async (tx) => {
    await tx.termination.update({ where: { id }, data: { status: "BATAL" } });
    // Resign yang sudah diatur karena surat ini dikembalikan (bila belum berlaku)
    if (t.status === "DITERBITKAN") await tx.employee.updateMany({ where: { id: t.employeeId, resignDate: t.effectiveDate, status: "AKTIF" }, data: { resignDate: null } });
    await audit(actor, "PENGAKHIRAN_DIBATALKAN", "Termination", id, { alasan: reason.trim() }, tx);
  });
}

/** Ringkasan publik surat untuk halaman verifikasi (tanpa rincian uang/alasan) */
export async function verifyTermination(code: string) {
  const t = await prisma.termination.findUnique({ where: { verifyCode: code.trim().toUpperCase() }, include: { employee: { select: { name: true, division: { select: { name: true } } } } } });
  if (!t || t.status === "DRAFT" || !t.issuedAt) return null;
  const intact = sha256(canonical({ number: t.number, reason: t.reason, effective: dateStr(t.effectiveDate), calc: t.calc, note: t.note })) === t.contentHash;
  return { number: t.number, status: t.status, employee: t.employee.name, division: t.employee.division.name, effective: dateStr(t.effectiveDate), issuedBy: t.issuedBy, issuedAt: t.issuedAt, contentHash: t.contentHash, intact };
}
