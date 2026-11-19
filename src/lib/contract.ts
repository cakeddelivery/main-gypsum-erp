import { randomBytes } from "node:crypto";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { dateOnly, dateStr, todayStr } from "./time";
import { letterhead, type Letterhead } from "./letterhead";
import { divisionShifts } from "./attendanceRules";
import {
  DEFAULT_BPJS_SINCE, DEFAULT_CLAUSES, DEFAULT_DURATIONS, DEFAULT_HRD, DEFAULT_RESIGN_DAYS,
  contractEnd, contractNumber, documentHash, fillClauses, finalDocumentHash, newVerifyCode, parseClauses, type Clause,
} from "./contractTemplate";

export class ContractError extends Error {}

type Actor = { id: string; name: string; role: Role; employeeId: string | null };
type Tx = Prisma.TransactionClient;

// ---------- Pengaturan (Owner & HRD) ----------
export const CONTRACT_KEYS = {
  template: "kontrak_template",
  durations: "kontrak_durasi",
  resignDays: "kontrak_resign_hari",
  hrdName: "kontrak_hrd_nama",
  hrdTitle: "kontrak_hrd_jabatan",
  bpjsSince: "kontrak_bpjs_mulai",
} as const;

export type ContractSettings = { clauses: Clause[]; durations: number[]; resignDays: number; hrd: { name: string; title: string }; bpjsSince: string };

export async function contractSettings(): Promise<ContractSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.values(CONTRACT_KEYS) } } });
  const v = (k: string) => rows.find((r) => r.key === k)?.value?.trim() || "";
  let clauses: Clause[] = DEFAULT_CLAUSES;
  try {
    clauses = parseClauses(JSON.parse(v(CONTRACT_KEYS.template) || "null")) ?? DEFAULT_CLAUSES;
  } catch {
    /* template rusak → pakai bawaan */
  }
  const durations = v(CONTRACT_KEYS.durations).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 60);
  const resign = Number(v(CONTRACT_KEYS.resignDays));
  return {
    clauses,
    durations: durations.length ? [...new Set(durations)].sort((a, b) => a - b) : DEFAULT_DURATIONS,
    resignDays: Number.isInteger(resign) && resign >= 0 && resign <= 365 ? resign : DEFAULT_RESIGN_DAYS,
    hrd: { name: v(CONTRACT_KEYS.hrdName) || DEFAULT_HRD.name, title: v(CONTRACT_KEYS.hrdTitle) || DEFAULT_HRD.title },
    bpjsSince: /^\d{4}-\d{2}$/.test(v(CONTRACT_KEYS.bpjsSince)) ? v(CONTRACT_KEYS.bpjsSince) : DEFAULT_BPJS_SINCE,
  };
}

export async function saveContractSettings(actor: Actor, input: { clauses: unknown; durations: string; resignDays: number; hrdName: string; hrdTitle: string; bpjsSince: string }) {
  const clauses = parseClauses(input.clauses);
  if (!clauses) throw new ContractError("Template pasal tidak valid (tiap pasal wajib berjudul dan berisi)");
  const durations = input.durations.split(",").map((x) => Number(x.trim()));
  if (!durations.length || durations.some((n) => !Number.isInteger(n) || n < 1 || n > 60)) throw new ContractError("Lama kontrak: angka bulan dipisah koma, mis. 2,6,12");
  if (!Number.isInteger(input.resignDays) || input.resignDays < 0 || input.resignDays > 365) throw new ContractError("Masa pemberitahuan resign 0–365 hari");
  if (!input.hrdName.trim()) throw new ContractError("Nama penandatangan HRD wajib");
  if (!/^\d{4}-\d{2}$/.test(input.bpjsSince)) throw new ContractError("BPJS mulai: format bulan YYYY-MM");
  const data: [string, string][] = [
    [CONTRACT_KEYS.template, JSON.stringify(clauses)],
    [CONTRACT_KEYS.durations, [...new Set(durations)].sort((a, b) => a - b).join(",")],
    [CONTRACT_KEYS.resignDays, String(input.resignDays)],
    [CONTRACT_KEYS.hrdName, input.hrdName.trim().slice(0, 100)],
    [CONTRACT_KEYS.hrdTitle, input.hrdTitle.trim().slice(0, 60) || DEFAULT_HRD.title],
    [CONTRACT_KEYS.bpjsSince, input.bpjsSince],
  ];
  for (const [key, value] of data) await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await audit(actor, "KONTRAK_PENGATURAN_DIUBAH", "Setting", null, { pasal: clauses.length, durasi: input.durations, resign: input.resignDays });
}

// ---------- Isi dokumen ----------
export type ContractSnapshot = {
  company: Letterhead;
  hrd: { name: string; title: string };
  employee: { id: string; code: string; name: string; nik: string; address: string; division: string; position: string };
  term: { months: number; start: string; end: string };
  work: { schedule: string; tolerance: string };
  pay: { baseSalary: number; cycleDay: number; payOffsetDays: number; allowances: { name: string; amount: number; payDay: number }[]; bpjs: { covered: boolean; since: string } };
  clauses: Clause[];
  city: string;
  signDate: string;
  addendum?: { parentId: string; parentNumber: string };
};

const hhmm = (t: string) => t.replace(":", ".");
export const PAY_OFFSET_DAYS = 7;

export type DraftInput = { employeeId: string; months: number; start: string; baseSalary?: number; nik?: string | null; address?: string | null };

async function buildSnapshot(input: DraftInput, today: string): Promise<{ snap: ContractSnapshot; nik: string }> {
  const st = await contractSettings();
  if (!st.durations.includes(input.months)) throw new ContractError(`Lama kontrak harus salah satu: ${st.durations.join(", ")} bulan`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) throw new ContractError("Tanggal mulai tidak valid");
  const emp = await prisma.employee.findUnique({ where: { id: input.employeeId }, include: { division: true, allowances: { where: { active: true }, orderBy: { createdAt: "asc" } } } });
  if (!emp) throw new ContractError("Karyawan tidak ditemukan");
  if (emp.status !== "AKTIF") throw new ContractError("Karyawan tidak aktif");
  const nik = (input.nik ?? emp.nik ?? "").replace(/\s/g, "");
  if (!/^\d{16}$/.test(nik)) throw new ContractError("NIK wajib 16 digit angka");
  const address = (input.address ?? emp.address ?? "").trim();
  if (!address) throw new ContractError("Alamat karyawan wajib diisi");
  const baseSalary = input.baseSalary ?? Number(emp.monthlySalary);
  if (!Number.isInteger(baseSalary) || baseSalary <= 0) throw new ContractError("Gaji pokok wajib diisi (angka rupiah)");
  const shifts = divisionShifts(await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }), emp.division.shiftCount);
  const schedule = shifts.map((s) => `${s.name} ${hhmm(s.startTime)}–${hhmm(s.endTime)}`).join(" / ") || "sesuai jadwal";
  const tol = Math.max(0, ...shifts.map((s) => s.toleranceMinutes));
  const lh = await letterhead();
  const end = contractEnd(input.start, input.months);
  const cycleDay = emp.joinDate ? Number(dateStr(emp.joinDate).slice(8)) : Number(input.start.slice(8));
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const vars = {
    nama: emp.name, masa: `${input.months} bulan`, mulai: fmt(input.start), selesai: fmt(end), jadwal: schedule, toleransi: `${tol} menit`,
    siklus: String(cycleDay), resign_hari: String(st.resignDays), bpjs_mulai: st.bpjsSince,
  };
  const snap: ContractSnapshot = {
    company: lh,
    hrd: st.hrd,
    employee: { id: emp.id, code: emp.code, name: emp.name, nik, address, division: emp.division.name, position: emp.position || emp.division.name },
    term: { months: input.months, start: input.start, end },
    work: { schedule, tolerance: `${tol} menit` },
    pay: {
      baseSalary, cycleDay, payOffsetDays: PAY_OFFSET_DAYS,
      allowances: emp.allowances.map((a) => ({ name: a.name, amount: Number(a.amount), payDay: a.payDay })),
      bpjs: { covered: true, since: st.bpjsSince },
    },
    clauses: fillClauses(st.clauses, vars),
    city: lh.city,
    signDate: today,
  };
  return { snap, nik };
}

/** Nomor urut berikutnya per tahun, atomik (aman bila dua HRD membuat bersamaan) */
export async function nextSequence(tx: Tx, key: string): Promise<number> {
  const r = await tx.$queryRaw<{ last: number }[]>`INSERT INTO "DocCounter" ("key", "last") VALUES (${key}, 1) ON CONFLICT ("key") DO UPDATE SET "last" = "DocCounter"."last" + 1 RETURNING "last"`;
  return r[0].last;
}

const verifyCode = () => newVerifyCode((n) => randomBytes(n));

export function assertHrd(user: { can: (p: "hrd.manage") => boolean } | { role: Role }) {
  if ("can" in user ? !user.can("hrd.manage") : user.role !== "OWNER") throw new ContractError("Hanya HRD atau Owner yang dapat mengelola kontrak");
}

/** Buat draf PKWT dari data master karyawan */
export async function createContract(actor: Actor, input: DraftInput, now = new Date()) {
  const today = todayStr(now);
  const dup = await prisma.contract.findFirst({ where: { employeeId: input.employeeId, kind: "PKWT", status: { in: ["DRAFT", "HRD_TTD"] } } });
  if (dup) throw new ContractError(`Sudah ada kontrak ${dup.number} yang belum selesai ditandatangani`);
  const running = await prisma.contract.findFirst({ where: { employeeId: input.employeeId, kind: "PKWT", status: "AKTIF", endDate: { gte: dateOnly(input.start) } } });
  if (running) throw new ContractError(`Kontrak ${running.number} masih berlaku sampai ${dateStr(running.endDate)}. Mulai kontrak baru setelah itu, atau buat addendum.`);
  const { snap, nik } = await buildSnapshot(input, today);
  const year = Number(today.slice(0, 4));
  return prisma.$transaction(async (tx) => {
    const seq = await nextSequence(tx, `KONTRAK:${year}`);
    const number = contractNumber(seq, "PKWT", today);
    await tx.employee.update({ where: { id: input.employeeId }, data: { nik, ...(input.address ? { address: input.address.trim() } : {}) } });
    const c = await tx.contract.create({
      data: { number, seq, year, kind: "PKWT", employeeId: input.employeeId, startDate: dateOnly(input.start), endDate: dateOnly(snap.term.end), months: input.months, snapshot: snap as unknown as Prisma.InputJsonValue, verifyCode: verifyCode(), createdBy: actor.name },
    });
    await audit(actor, "KONTRAK_DIBUAT", "Contract", c.id, { number, employee: snap.employee.name, bulan: input.months }, tx);
    return c;
  });
}

/** Ubah draf (isi dibuat ulang dari master + isian baru). Hanya sebelum HRD menandatangani. */
export async function updateDraft(actor: Actor, id: string, input: Omit<DraftInput, "employeeId">, now = new Date()) {
  const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
  if (c.status !== "DRAFT") throw new ContractError("Hanya draf yang dapat diubah. Kontrak yang sudah ditandatangani HRD dibatalkan dulu atau diubah lewat addendum.");
  if (c.kind !== "PKWT") throw new ContractError("Addendum dibuat ulang bila perlu diubah");
  const { snap, nik } = await buildSnapshot({ ...input, employeeId: c.employeeId }, todayStr(now));
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: c.employeeId }, data: { nik, ...(input.address ? { address: input.address.trim() } : {}) } });
    const r = await tx.contract.updateMany({ where: { id, status: "DRAFT" }, data: { snapshot: snap as unknown as Prisma.InputJsonValue, months: input.months, startDate: dateOnly(input.start), endDate: dateOnly(snap.term.end) } });
    if (!r.count) throw new ContractError("Draf sudah berubah status");
    await audit(actor, "KONTRAK_DIUBAH", "Contract", id, { bulan: input.months }, tx);
  });
}

/** HRD menandatangani: isi dibekukan, hash dihitung, QR verifikasi aktif */
export async function hrdSign(actor: Actor, id: string, now = new Date()) {
  const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
  if (c.status !== "DRAFT") throw new ContractError("Kontrak ini sudah ditandatangani HRD atau dibatalkan");
  if (actor.employeeId && actor.employeeId === c.employeeId && actor.role !== "OWNER") throw new ContractError("Kontrak Anda sendiri harus ditandatangani HRD lain");
  const hash = documentHash({ number: c.number, kind: c.kind, startDate: dateStr(c.startDate), endDate: dateStr(c.endDate), snapshot: c.snapshot });
  const r = await prisma.contract.updateMany({ where: { id, status: "DRAFT" }, data: { status: "HRD_TTD", contentHash: hash, hrdSignedAt: now, hrdSignedBy: actor.name, hrdSignedById: actor.id } });
  if (!r.count) throw new ContractError("Kontrak ini sudah ditandatangani HRD atau dibatalkan");
  await audit(actor, "KONTRAK_TTD_HRD", "Contract", id, { number: c.number, hash });
  return hash;
}

const MAX_SIGNATURE = 400_000;

/** Karyawan menandatangani di HP: gambar + waktu + perangkat tersimpan, kontrak TERKUNCI */
export async function employeeSign(actor: Actor, id: string, input: { signature: string; device?: string | null }, now = new Date()) {
  const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
  if (!actor.employeeId || actor.employeeId !== c.employeeId) throw new ContractError("Hanya karyawan yang bersangkutan yang dapat menandatangani");
  if (c.status === "AKTIF") throw new ContractError("Kontrak ini sudah ditandatangani dan terkunci");
  if (c.status !== "HRD_TTD" || !c.contentHash) throw new ContractError("Kontrak belum ditandatangani HRD");
  const sig = input.signature;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > MAX_SIGNATURE) throw new ContractError("Tanda tangan tidak valid");
  if (sig.length < 1200) throw new ContractError("Tanda tangan terlalu singkat. Goreskan tanda tangan Anda.");
  const finalHash = finalDocumentHash(c.contentHash, sig, now.toISOString());
  const r = await prisma.contract.updateMany({
    where: { id, status: "HRD_TTD" },
    data: { status: "AKTIF", employeeSignature: sig, employeeSignedAt: now, employeeDevice: (input.device ?? "").slice(0, 300) || null, lockedAt: now, finalHash },
  });
  if (!r.count) throw new ContractError("Kontrak ini sudah ditandatangani dan terkunci");
  await audit(actor, "KONTRAK_TTD_KARYAWAN", "Contract", id, { number: c.number, finalHash });
  return finalHash;
}

/** Batalkan draf / kontrak yang belum ditandatangani karyawan (alasan wajib, tercatat). Kontrak terkunci tidak bisa dibatalkan. */
export async function voidContract(actor: Actor, id: string, reason: string) {
  if (reason.trim().length < 3) throw new ContractError("Tulis alasan pembatalan");
  const r = await prisma.contract.updateMany({ where: { id, status: { in: ["DRAFT", "HRD_TTD"] } }, data: { status: "BATAL" } });
  if (!r.count) throw new ContractError("Kontrak yang sudah terkunci tidak dapat dibatalkan; buat addendum");
  await audit(actor, "KONTRAK_DIBATALKAN", "Contract", id, { alasan: reason.trim() });
}

/** Addendum bernomor untuk kontrak terkunci: perubahan gaji pokok / masa kerja / ketentuan lain */
export async function createAddendum(actor: Actor, parentId: string, input: { text: string; start: string; baseSalary?: number; endDate?: string }, now = new Date()) {
  const p = await prisma.contract.findUniqueOrThrow({ where: { id: parentId } });
  if (p.status !== "AKTIF" || p.kind !== "PKWT") throw new ContractError("Addendum hanya untuk kontrak PKWT yang sudah terkunci");
  if (input.text.trim().length < 5) throw new ContractError("Tulis isi perubahan");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) throw new ContractError("Tanggal berlaku tidak valid");
  const open = await prisma.contract.findFirst({ where: { parentId, kind: "ADD", status: { in: ["DRAFT", "HRD_TTD"] } } });
  if (open) throw new ContractError(`Addendum ${open.number} belum selesai ditandatangani`);
  const base = p.snapshot as unknown as ContractSnapshot;
  const today = todayStr(now);
  const end = input.endDate ?? dateStr(p.endDate);
  if (end < dateStr(p.endDate) && !input.endDate) throw new ContractError("Tanggal selesai tidak valid");
  const baseSalary = input.baseSalary ?? base.pay.baseSalary;
  if (!Number.isInteger(baseSalary) || baseSalary <= 0) throw new ContractError("Gaji pokok tidak valid");
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const clauses: Clause[] = [
    { title: "Pasal 1 · Dasar", body: `Addendum ini merupakan bagian tidak terpisahkan dari Perjanjian Kerja Waktu Tertentu Nomor ${p.number}, berlaku mulai ${fmt(input.start)}.` },
    { title: "Pasal 2 · Perubahan", body: input.text.trim() + (input.baseSalary ? `\nGaji pokok menjadi Rp ${baseSalary.toLocaleString("id-ID")} per bulan.` : "") + (input.endDate ? `\nMasa kerja berakhir pada ${fmt(end)}.` : "") },
    { title: "Pasal 3 · Ketentuan Lain", body: "Ketentuan lain dalam perjanjian induk yang tidak diubah dalam addendum ini tetap berlaku." },
  ];
  const snap: ContractSnapshot = { ...base, pay: { ...base.pay, baseSalary }, term: { ...base.term, start: input.start, end }, clauses, signDate: today, addendum: { parentId, parentNumber: p.number } };
  const year = Number(today.slice(0, 4));
  return prisma.$transaction(async (tx) => {
    const seq = await nextSequence(tx, `KONTRAK:${year}`);
    const number = contractNumber(seq, "ADD", today);
    const c = await tx.contract.create({
      data: { number, seq, year, kind: "ADD", employeeId: p.employeeId, parentId, startDate: dateOnly(input.start), endDate: dateOnly(end), months: base.term.months, snapshot: snap as unknown as Prisma.InputJsonValue, verifyCode: verifyCode(), createdBy: actor.name },
    });
    await audit(actor, "ADDENDUM_DIBUAT", "Contract", c.id, { number, induk: p.number }, tx);
    return c;
  });
}

/** Ringkasan publik untuk halaman verifikasi QR (tanpa NIK/alamat/gaji) */
export async function verifyContract(code: string) {
  const c = await prisma.contract.findUnique({ where: { verifyCode: code.trim().toUpperCase() } });
  if (!c || c.status === "DRAFT" || !c.hrdSignedAt) return null;
  const s = c.snapshot as unknown as ContractSnapshot;
  const recomputed = documentHash({ number: c.number, kind: c.kind, startDate: dateStr(c.startDate), endDate: dateStr(c.endDate), snapshot: c.snapshot });
  return {
    number: c.number,
    kind: c.kind,
    status: c.status,
    employee: s.employee.name,
    division: s.employee.division,
    start: dateStr(c.startDate),
    end: dateStr(c.endDate),
    hrd: { name: c.hrdSignedBy ?? s.hrd.name, title: s.hrd.title, at: c.hrdSignedAt },
    employeeSignedAt: c.employeeSignedAt,
    contentHash: c.contentHash,
    finalHash: c.finalHash,
    intact: recomputed === c.contentHash,
    company: s.company.name,
  };
}

export const canManageContracts = (user: { can: (p: "hrd.manage") => boolean }) => user.can("hrd.manage");
export const canViewContract = (user: { can: (p: "hrd.manage") => boolean; employeeId: string | null }, c: { employeeId: string; status: string }) =>
  user.can("hrd.manage") || (!!user.employeeId && user.employeeId === c.employeeId && c.status !== "DRAFT" && c.status !== "BATAL");
