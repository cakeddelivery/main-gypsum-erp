import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Role, WageType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { autoCode } from "./codes";
import { nextNumber } from "./numbering";
import { hashPassword } from "./auth";
import { dateOnly, todayStr } from "./time";
import { appUrl } from "./botDup";

type Actor = { id: string; name: string };

export class RegistrationError extends Error {}


/** Batas anti-spam: kode salah per IP (15 menit) & jumlah pendaftaran per IP (24 jam) */
export const REG_BAD_CODE_MAX = 10;
export const REG_PER_IP_DAY = 5;

/** Link form pendaftaran untuk kode undangan */
export const inviteLink = (code: string) => `${appUrl()}/daftar?kode=${encodeURIComponent(code)}`;

/** Buat tautan undangan (kode acak). Bisa dipakai beberapa orang sampai kedaluwarsa atau dimatikan. */
export async function createInvite(days: number, note: string | null, actor: Actor, now = new Date()) {
  if (!(days >= 1 && days <= 90)) throw new RegistrationError("Masa berlaku 1–90 hari");
  const code = randomBytes(12).toString("base64url");
  const inv = await prisma.registrationInvite.create({ data: { code, note: note?.trim() || null, expiresAt: new Date(now.getTime() + days * 86_400_000), createdBy: actor.name } });
  await audit(actor, "UNDANGAN_DAFTAR_DIBUAT", "RegistrationInvite", inv.id, { days, note });
  return { invite: inv, code, link: inviteLink(code) };
}

/** Undangan yang masih berlaku untuk kode ini, atau null */
export async function validInvite(code: string | null | undefined, now = new Date()) {
  if (!code || code.length > 64) return null;
  const inv = await prisma.registrationInvite.findUnique({ where: { code } });
  return inv && inv.active && inv.expiresAt > now ? inv : null;
}

/** Catat kode salah; true bila IP ini sudah terlalu sering salah */
export async function badCodeBlocked(ip: string, now = new Date()) {
  const since = new Date(now.getTime() - 15 * 60_000);
  await prisma.registrationAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 2 * 86_400_000) } } });
  return (await prisma.registrationAttempt.count({ where: { ip, createdAt: { gte: since } } })) >= REG_BAD_CODE_MAX;
}
export const recordBadCode = (ip: string, now = new Date()) => prisma.registrationAttempt.create({ data: { ip, createdAt: now } });

/** No. WhatsApp: 08xx / +62 / 62 → 62xxxxxxxx */
export function normalizePhone(raw: string) {
  const d = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  const n = d.startsWith("0") ? `62${d.slice(1)}` : d.startsWith("8") ? `62${d}` : d;
  if (!/^628\d{7,12}$/.test(n)) throw new RegistrationError("No. WhatsApp tidak valid (contoh: 081234567890)");
  return n;
}

const USERNAME = /^[a-z0-9._-]{3,30}$/;

export const registrationSchema = z.object({
  fullName: z.string().trim().min(3, "Nama lengkap minimal 3 huruf").max(80),
  nickname: z.string().trim().min(2, "Nama panggilan minimal 2 huruf").max(30),
  birthPlace: z.string().trim().min(2, "Tempat lahir wajib").max(60),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal lahir wajib"),
  address: z.string().trim().min(10, "Alamat lengkap minimal 10 huruf").max(300),
  phone: z.string().min(8, "No. WhatsApp wajib"),
  email: z.string().trim().toLowerCase().email("Email tidak valid").max(120),
  username: z.string().trim().toLowerCase().regex(USERNAME, "Username 3–30 huruf kecil/angka (boleh . _ -), tanpa spasi"),
  password: z.string().min(8, "Password minimal 8 karakter").max(200),
  gender: z.enum(["L", "P"], { message: "Pilih jenis kelamin" }),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal mulai kerja wajib"),
  bankName: z.string().trim().min(2, "Pilih nama bank / e-wallet").max(60),
  bankAccountNo: z.string().transform((s) => s.replace(/\D/g, "")).pipe(z.string().regex(/^\d{6,20}$/, "No. rekening 6–20 angka")),
  bankAccountName: z.string().trim().min(2, "Atas nama rekening wajib").max(80),
});
export type RegistrationInput = z.input<typeof registrationSchema>;

/** Username / email sudah dipakai akun atau pendaftaran lain yang masih menunggu */
async function assertUnique(username: string, email: string, excludeId?: string) {
  const [u, e] = await Promise.all([
    prisma.user.findUnique({ where: { username } }).then(async (x) => x ?? prisma.employeeRegistration.findFirst({ where: { username, status: "MENUNGGU", ...(excludeId ? { id: { not: excludeId } } : {}) } })),
    prisma.user.findUnique({ where: { email } }).then(async (x) => x ?? prisma.employeeRegistration.findFirst({ where: { email, status: "MENUNGGU", ...(excludeId ? { id: { not: excludeId } } : {}) } })),
  ]);
  if (u) throw new RegistrationError("Username sudah dipakai, pilih yang lain");
  if (e) throw new RegistrationError("Email sudah terdaftar");
}

/** Kirim pendaftaran dari halaman publik /daftar */
export async function submitRegistration(code: string, raw: RegistrationInput, ip: string, now = new Date()) {
  if (await badCodeBlocked(ip, now)) throw new RegistrationError("Terlalu banyak percobaan. Coba lagi 15 menit lagi.");
  const inv = await validInvite(code, now);
  if (!inv) {
    await recordBadCode(ip, now);
    throw new RegistrationError("Tautan pendaftaran tidak berlaku atau sudah kedaluwarsa. Minta tautan baru ke Owner.");
  }
  if ((await prisma.employeeRegistration.count({ where: { ip, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } })) >= REG_PER_IP_DAY) throw new RegistrationError("Terlalu banyak pendaftaran dari jaringan ini hari ini. Coba lagi besok.");
  const d = registrationSchema.parse(raw);
  const phone = normalizePhone(d.phone);
  const today = todayStr(now);
  if (d.birthDate >= today || d.birthDate < "1940-01-01") throw new RegistrationError("Tanggal lahir tidak valid");
  await assertUnique(d.username, d.email);
  const passwordHash = await hashPassword(d.password);
  const r = await prisma.$transaction(async (tx) =>
    tx.employeeRegistration.create({
      data: {
        number: await nextNumber(tx, "DFT", now), inviteId: inv.id, fullName: d.fullName, nickname: d.nickname, birthPlace: d.birthPlace, birthDate: dateOnly(d.birthDate),
        address: d.address, phone, email: d.email, username: d.username, passwordHash, gender: d.gender, startDate: dateOnly(d.startDate),
        bankName: d.bankName, bankAccountNo: d.bankAccountNo, bankAccountName: d.bankAccountName, ip, createdAt: now,
      },
    }),
  );
  await audit({ actorName: `Pendaftar ${d.fullName}` }, "PENDAFTARAN_KARYAWAN", "EmployeeRegistration", r.id, { number: r.number, username: d.username, invite: inv.id });
  void notifyOwners(`🆕 <b>Pendaftaran karyawan baru</b>\n${r.number} · ${escHtml(d.fullName)} (${escHtml(d.nickname)})\nMulai kerja ${d.startDate}\nVerifikasi di Karyawan → Pendaftaran: ${appUrl()}/karyawan/pendaftaran`).catch(() => undefined);
  return r;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function notifyOwners(text: string) {
  const { sendTelegram, telegramConfigured } = await import("./telegram");
  if (!telegramConfigured()) return;
  const owners = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: "OWNER" } } });
  for (const o of owners) await sendTelegram(o.chatId!, text, { type: "PENDAFTARAN" });
}

export type ApproveInput = {
  divisionId: string;
  role: Role;
  wageType: WageType;
  monthlySalary: number;
  dailyRate: number;
  joinDate: string;
  bpjsTk: boolean;
  bpjsTkAmount: number | null;
};

/** Setujui pendaftaran: buat data Karyawan (kode otomatis) + akun login aktif dengan password yang dibuat pendaftar */
export async function approveRegistration(id: string, input: ApproveInput, actor: Actor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.joinDate)) throw new RegistrationError("Isi tanggal masuk");
  if (input.wageType === "BULANAN" && !(input.monthlySalary > 0)) throw new RegistrationError("Isi gaji bulanan");
  if ((input.wageType === "HARIAN" || input.wageType === "CAMPURAN") && !(input.dailyRate > 0)) throw new RegistrationError("Isi upah harian");
  if (input.role === "OWNER") throw new RegistrationError("Role Owner tidak bisa diberikan lewat pendaftaran");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "EmployeeRegistration" WHERE id = ${id} FOR UPDATE`;
    const r = await tx.employeeRegistration.findUniqueOrThrow({ where: { id } });
    if (r.status !== "MENUNGGU") throw new RegistrationError(`${r.number} sudah ${r.status === "DISETUJUI" ? "disetujui" : "ditolak"}`);
    if (await tx.user.findUnique({ where: { username: r.username } })) throw new RegistrationError(`Username ${r.username} sudah dipakai akun lain. Tolak pendaftaran ini dan minta daftar ulang.`);
    if (await tx.user.findUnique({ where: { email: r.email } })) throw new RegistrationError(`Email ${r.email} sudah dipakai akun lain`);
    const division = await tx.division.findUniqueOrThrow({ where: { id: input.divisionId } });
    const emp = await tx.employee.create({
      data: {
        code: await autoCode.employee(tx, division.id), name: r.fullName, divisionId: division.id, status: "AKTIF", wageType: input.wageType,
        monthlySalary: BigInt(Math.round(input.wageType === "BULANAN" ? input.monthlySalary : 0)), dailyRate: BigInt(Math.round(input.wageType === "BULANAN" ? 0 : input.dailyRate)),
        phone: r.phone, joinDate: dateOnly(input.joinDate), nickname: r.nickname, birthPlace: r.birthPlace, birthDate: r.birthDate, address: r.address, gender: r.gender,
        email: r.email, bankName: r.bankName, bankAccountNo: r.bankAccountNo, bankAccountName: r.bankAccountName, bpjsTk: input.bpjsTk, bpjsTkAmount: input.bpjsTk && input.bpjsTkAmount != null ? BigInt(input.bpjsTkAmount) : null,
      },
    });
    const user = await tx.user.create({ data: { username: r.username, name: r.fullName, email: r.email, passwordHash: r.passwordHash, role: input.role, employeeId: emp.id, divisionId: input.role === "KAPTEN_DIVISI" ? division.id : null } });
    await tx.employeeRegistration.update({ where: { id }, data: { status: "DISETUJUI", decidedBy: actor.name, decidedAt: new Date(), employeeId: emp.id } });
    await audit(actor, "PENDAFTARAN_DISETUJUI", "EmployeeRegistration", id, { number: r.number, employee: emp.code, username: user.username, role: input.role, division: division.code, wageType: input.wageType }, tx);
    return { employee: emp, user };
  });
}

/** Tolak pendaftaran (alasan wajib). Data tetap tersimpan untuk riwayat. */
export async function rejectRegistration(id: string, reason: string, actor: Actor) {
  if (!reason?.trim()) throw new RegistrationError("Alasan penolakan wajib diisi");
  const r = await prisma.employeeRegistration.findUniqueOrThrow({ where: { id } });
  if (r.status !== "MENUNGGU") throw new RegistrationError(`${r.number} sudah diproses`);
  // Bersyarat status MENUNGGU: Tolak & Setujui yang ditekan bersamaan tidak bisa sama-sama berhasil (akun aktif tapi tercatat Ditolak)
  const n = await prisma.employeeRegistration.updateMany({ where: { id, status: "MENUNGGU" }, data: { status: "DITOLAK", rejectReason: reason.trim().slice(0, 300), decidedBy: actor.name, decidedAt: new Date() } });
  if (!n.count) throw new RegistrationError(`${r.number} sudah diproses`);
  await audit(actor, "PENDAFTARAN_DITOLAK", "EmployeeRegistration", id, { number: r.number, reason });
}

/** Pesan login untuk username yang masih berupa pendaftaran (belum punya akun) */
export async function registrationLoginHint(username: string) {
  const u = username.trim().toLowerCase();
  if (!USERNAME.test(u) || (await prisma.user.findUnique({ where: { username: u } }))) return null;
  const r = await prisma.employeeRegistration.findFirst({ where: { username: u }, orderBy: { createdAt: "desc" } });
  if (!r) return null;
  if (r.status === "MENUNGGU") return "Pendaftaran Anda masih menunggu verifikasi Owner. Akun bisa dipakai setelah disetujui.";
  if (r.status === "DITOLAK") return "Pendaftaran Anda ditolak. Hubungi Owner untuk informasi lebih lanjut.";
  return null;
}

export async function disableInvite(id: string, actor: Actor) {
  await prisma.registrationInvite.update({ where: { id }, data: { active: false } });
  await audit(actor, "UNDANGAN_DAFTAR_DIMATIKAN", "RegistrationInvite", id, null);
}
