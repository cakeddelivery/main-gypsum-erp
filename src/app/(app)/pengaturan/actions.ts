"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { hashPassword, ForbiddenError } from "@/lib/auth";
import { ALL_PERMISSIONS, ROLES, DEFAULT_MATRIX } from "@/lib/rbac";
import { generateApiKey, API_SCOPES } from "@/lib/apiAuth";
import { sendDailyRecap } from "@/lib/jobs";
import type { Role, TxDirection } from "@prisma/client";

const P = ["/pengaturan"];

export const saveOrg = action("settings.manage", async (fd, user) => {
  const org = await prisma.organization.findFirstOrThrow();
  await prisma.organization.update({ where: { id: org.id }, data: { name: z.string().min(2).parse(str(fd, "name")) } });
  await audit(user, "ORGANISASI_DIUBAH", "Organization", org.id);
  return "Organisasi tersimpan";
}, P);

export const saveStore = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const org = await prisma.organization.findFirstOrThrow();
  const data = { code: z.string().min(2).parse(str(fd, "code").toUpperCase()), name: z.string().min(2).parse(str(fd, "name")), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.store.update({ where: { id }, data }) : await prisma.store.create({ data: { ...data, organizationId: org.id } });
  await audit(user, "TOKO_DISIMPAN", "Store", s.id, data);
  return "Toko tersimpan";
}, P);

export const saveDivision = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { code: z.string().min(2).parse(str(fd, "code").toUpperCase()), name: z.string().min(2).parse(str(fd, "name")), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.division.update({ where: { id }, data }) : await prisma.division.create({ data });
  await audit(user, "DIVISI_DISIMPAN", "Division", s.id, data);
  return "Divisi tersimpan";
}, P);

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Format jam HH:MM");
export const saveShift = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { code: z.string().min(1).parse(str(fd, "code").toUpperCase()), name: z.string().min(2).parse(str(fd, "name")), startTime: hhmm.parse(str(fd, "startTime")), endTime: hhmm.parse(str(fd, "endTime")), toleranceMinutes: int(fd, "toleranceMinutes"), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.shift.update({ where: { id }, data }) : await prisma.shift.create({ data });
  await audit(user, "SHIFT_DISIMPAN", "Shift", s.id, data);
  return "Shift tersimpan";
}, P);

export const saveBank = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { code: z.string().min(2).parse(str(fd, "code").toUpperCase()), name: z.string().min(2).parse(str(fd, "name")), coaAccountId: str(fd, "coaAccountId"), aliases: str(fd, "aliases").toLowerCase(), active: id ? bool(fd, "active") : true };
  const coa = await prisma.coaAccount.findUniqueOrThrow({ where: { id: data.coaAccountId } });
  if (!coa.isCash) throw new Error("Akun COA rekening harus akun kas/bank");
  const s = id ? await prisma.bankAccount.update({ where: { id }, data }) : await prisma.bankAccount.create({ data });
  await audit(user, "REKENING_DISIMPAN", "BankAccount", s.id, data);
  return "Rekening tersimpan";
}, P);

export const saveCategory = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { name: z.string().min(2).parse(str(fd, "name")), direction: str(fd, "direction") as TxDirection, coaAccountId: str(fd, "coaAccountId"), keywords: str(fd, "keywords").toLowerCase(), active: id ? bool(fd, "active") : true };
  if (data.direction === "TRANSFER") throw new Error("Transfer internal tidak memakai kategori");
  const s = id ? await prisma.txCategory.update({ where: { id }, data }) : await prisma.txCategory.create({ data });
  await audit(user, "KATEGORI_DISIMPAN", "TxCategory", s.id, data);
  return "Kategori tersimpan";
}, P);

const PARAM_KEYS = ["default_store_id", "loc_raw", "loc_wip", "loc_finished", "late_deduction_per_minute", "payday_offset_days", "weekly_off_quota", "monthly_workdays", "allowance_payday", "go_live_date", "payroll_require_validated", "auto_close_enabled", "report_checklist", "company_address"];
export const saveParams = action("settings.manage", async (fd, user) => {
  const changes: Record<string, string> = {};
  for (const k of PARAM_KEYS) {
    if (!fd.has(k)) continue;
    const v = str(fd, k);
    changes[k] = v;
    await prisma.setting.upsert({ where: { key: k }, create: { key: k, value: v }, update: { value: v } });
  }
  await audit(user, "PARAMETER_DIUBAH", "Setting", null, changes);
  return "Parameter tersimpan";
}, P);

export const saveUser = action("users.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const role = str(fd, "role") as Role;
  if (!ROLES.includes(role)) throw new Error("Role tidak valid");
  if (role === "OWNER" && user.role !== "OWNER") throw new ForbiddenError();
  if (id) {
    const target = await prisma.user.findUniqueOrThrow({ where: { id } });
    if (target.role === "OWNER" && user.role !== "OWNER") throw new ForbiddenError();
    if (target.id === user.id && (role !== target.role || !bool(fd, "active"))) throw new Error("Tidak bisa mengubah role/menonaktifkan akun sendiri");
  }
  const password = str(fd, "password");
  const data = {
    username: z.string().regex(/^[a-z0-9._-]{3,30}$/, "Username 3-30 huruf kecil/angka").parse(str(fd, "username").toLowerCase()),
    name: z.string().min(2).parse(str(fd, "name")),
    role,
    divisionId: optStr(fd, "divisionId"),
    active: id ? bool(fd, "active") : true,
    ...(password ? { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } : {}),
  };
  if (!id && !password) throw new Error("Password wajib untuk pengguna baru");
  const u = id ? await prisma.user.update({ where: { id }, data }) : await prisma.user.create({ data: { ...data, passwordHash: data.passwordHash! } });
  await audit(user, id ? "PENGGUNA_DIUBAH" : "PENGGUNA_DIBUAT", "User", u.id, { username: data.username, role, active: data.active, passwordChanged: !!password });
  return "Pengguna tersimpan";
}, ["/pengaturan/pengguna"]);

/** Simpan matriks hak akses per role (Owner selalu penuh) */
export const saveMatrix = action("users.manage", async (fd, user) => {
  const role = str(fd, "role") as Role;
  if (role === "OWNER") throw new Error("Hak akses Owner tidak dapat dikurangi");
  const checked = new Set(fd.getAll("perm").map(String));
  const defaults = new Set<string>(DEFAULT_MATRIX[role]);
  await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { role } });
    for (const p of ALL_PERMISSIONS) {
      const want = checked.has(p);
      if (want !== defaults.has(p)) await tx.rolePermission.create({ data: { role, permission: p, allowed: want } });
    }
  });
  await audit(user, "HAK_AKSES_DIUBAH", "RolePermission", role, { granted: [...checked] });
  return "Hak akses tersimpan";
}, ["/pengaturan/pengguna"]);

// ---------- Telegram & Hermes (khusus Owner) ----------
export const saveIdentity = action("telegram.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = {
    telegramUserId: z.string().regex(/^\d{3,20}$/, "ID Telegram berupa angka").parse(str(fd, "telegramUserId")),
    telegramName: optStr(fd, "telegramName"),
    userId: str(fd, "userId"),
    canSubmit: bool(fd, "canSubmit"),
    canConfirm: bool(fd, "canConfirm"),
    receiveRecap: bool(fd, "receiveRecap"),
    chatId: optStr(fd, "chatId"),
    active: id ? bool(fd, "active") : true,
  };
  const s = id ? await prisma.telegramIdentity.update({ where: { id }, data }) : await prisma.telegramIdentity.create({ data });
  await audit(user, "IDENTITAS_TELEGRAM_DISIMPAN", "TelegramIdentity", s.id, data);
  return "Identitas Telegram tersimpan";
}, ["/pengaturan/telegram"]);

export const createApiClient = action("telegram.manage", async (fd, user) => {
  const scopes = fd.getAll("scopes").map(String).filter((s) => s in API_SCOPES);
  if (!scopes.length) throw new Error("Pilih minimal satu scope");
  const k = generateApiKey();
  const c = await prisma.apiClient.create({ data: { name: z.string().min(2).parse(str(fd, "name")), keyPrefix: k.prefix, keyHash: k.hash, scopes: scopes.join(",") } });
  await audit(user, "API_KEY_DIBUAT", "ApiClient", c.id, { name: c.name, scopes });
  return `API key (simpan sekarang, hanya ditampilkan sekali): ${k.key}`;
}, ["/pengaturan/telegram"]);

export const revokeApiClient = action("telegram.manage", async (fd, user) => {
  const id = str(fd, "id");
  await prisma.apiClient.update({ where: { id }, data: { active: false } });
  await audit(user, "API_KEY_DICABUT", "ApiClient", id);
  return "API key dicabut";
}, ["/pengaturan/telegram"]);

export const testRecap = action("telegram.manage", async (_fd, user) => {
  const r = await sendDailyRecap();
  await audit(user, "UJI_REKAP_TELEGRAM", "NotificationLog", null, r);
  return `Rekap diproses: ${r.sent} terkirim, ${r.failed} gagal (lihat log)`;
}, ["/pengaturan/telegram"]);
