"use server";
import { z } from "zod";
import { nextTypeCode } from "@/lib/productTypes";
import { normEmail } from "@/lib/email";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { hashPassword, ForbiddenError } from "@/lib/auth";
import { clearLoginBlocks, passwordChangeData } from "@/lib/loginGuard";
import { ALL_PERMISSIONS, ROLES, DEFAULT_MATRIX, MENU_GROUPS, applyMenuChoice, effectivePermissions, overridesFor } from "@/lib/rbac";
import { generateApiKey, API_SCOPES } from "@/lib/apiAuth";
import { sendDailyRecap } from "@/lib/jobs";
import { setBotCommands } from "@/lib/telegram";
import { autoCode } from "@/lib/codes";
import type { ItemType, Role, TxDirection } from "@prisma/client";

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
  const data = { name: z.string().min(2).parse(str(fd, "name")), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.store.update({ where: { id }, data }) : await prisma.store.create({ data: { ...data, code: await autoCode.store(prisma, data.name), organizationId: org.id } });
  await audit(user, "TOKO_DISIMPAN", "Store", s.id, data);
  return "Toko tersimpan";
}, P);

export const saveDivision = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { name: z.string().min(2).parse(str(fd, "name")), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.division.update({ where: { id }, data }) : await prisma.division.create({ data: { ...data, code: await autoCode.division(prisma, data.name) } });
  await audit(user, "DIVISI_DISIMPAN", "Division", s.id, data);
  return "Divisi tersimpan";
}, P);

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Format jam HH:MM");
export const saveShift = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { name: z.string().min(2).parse(str(fd, "name")), startTime: hhmm.parse(str(fd, "startTime")), endTime: hhmm.parse(str(fd, "endTime")), toleranceMinutes: int(fd, "toleranceMinutes"), active: id ? bool(fd, "active") : true };
  const s = id ? await prisma.shift.update({ where: { id }, data }) : await prisma.shift.create({ data: { ...data, code: await autoCode.shift(prisma) } });
  await audit(user, "SHIFT_DISIMPAN", "Shift", s.id, data);
  return "Shift tersimpan";
}, P);

export const saveBank = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { name: z.string().min(2).parse(str(fd, "name")), coaAccountId: str(fd, "coaAccountId"), aliases: str(fd, "aliases").toLowerCase(), active: id ? bool(fd, "active") : true, marketplace: bool(fd, "marketplace") };
  const coa = await prisma.coaAccount.findUniqueOrThrow({ where: { id: data.coaAccountId } });
  if (!coa.isCash) throw new Error("Akun COA rekening harus akun kas/bank");
  // Satu rekening = satu akun COA. Bila dipakai bersama, saldo kedua rekening tercampur dan total saldo terhitung dobel.
  const shared = await prisma.bankAccount.findFirst({ where: { coaAccountId: data.coaAccountId, active: true, ...(id ? { id: { not: id } } : {}) } });
  if (shared && data.active) throw new Error(`Akun COA ${coa.code} ${coa.name} sudah dipakai rekening ${shared.name}. Buat akun COA kas/bank baru untuk rekening ini (Akuntansi › Bagan akun).`);
  const s = id ? await prisma.bankAccount.update({ where: { id }, data }) : await prisma.bankAccount.create({ data: { ...data, code: await autoCode.bank(prisma, data.name) } });
  await audit(user, "REKENING_DISIMPAN", "BankAccount", s.id, data);
  return "Rekening tersimpan";
}, P);

/**
 * Kategori item & produk jadi. Awalan menentukan kode otomatis item BARU (BU-001, MG-001);
 * kode item lama tidak berubah. Ganti nama kategori ikut memperbarui item & produk yang memakainya.
 */
/** Tipe produk jadi (Satuan, Paket 12, …): kode otomatis dari nama, nonaktif = tidak muncul di pilihan */
export const saveProductType = action("settings.manage", async (fd, user) => {
  const code = optStr(fd, "code");
  const name = z.string().trim().min(2, "Nama tipe minimal 2 huruf").max(40).parse(str(fd, "name"));
  const packQty = int(fd, "packQty", 1);
  if (packQty < 1) throw new Error("Isi per kemasan minimal 1");
  const clash = await prisma.productTypeOption.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(code ? { code: { not: code } } : {}) } });
  if (clash) throw new Error(`Tipe ${name} sudah ada`);
  const last = await prisma.productTypeOption.aggregate({ _max: { sortOrder: true } });
  const sortOrder = str(fd, "sortOrder") === "" ? (last._max.sortOrder ?? 0) + 1 : int(fd, "sortOrder");
  if (code) {
    const active = bool(fd, "active");
    if (!active && (await prisma.productTypeOption.count({ where: { active: true, code: { not: code } } })) === 0) throw new Error("Minimal satu tipe produk aktif");
    await prisma.productTypeOption.update({ where: { code }, data: { name, packQty, sortOrder, active } });
  } else await prisma.productTypeOption.create({ data: { code: await nextTypeCode(prisma, name), name, packQty, sortOrder } });
  await audit(user, "TIPE_PRODUK_DISIMPAN", "ProductTypeOption", code ?? name, { name, packQty, sortOrder });
  return "Tipe produk tersimpan";
}, ["/pengaturan", "/produk"]);

export const saveItemCategory = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const type = z.enum(["BAHAN_BAKU", "BARANG_DALAM_PROSES", "BARANG_JADI"]).parse(str(fd, "type")) as ItemType;
  const name = z.string().trim().min(2, "Nama kategori minimal 2 huruf").max(60).parse(str(fd, "name"));
  const prefix = z.string().regex(/^[A-Z]{2,4}$/, "Awalan kode 2–4 huruf, mis. MG").parse(str(fd, "prefix").toUpperCase().replace(/[^A-Z]/g, ""));
  // Urutan kosong = taruh paling bawah, supaya kategori utama tetap jadi pilihan pertama
  const last = await prisma.itemCategory.aggregate({ where: { type }, _max: { sortOrder: true } });
  const sortOrder = str(fd, "sortOrder") === "" ? (last._max.sortOrder ?? 0) + 1 : int(fd, "sortOrder");
  const data = { type, name, prefix, active: id ? bool(fd, "active") : true, sortOrder };
  const clash = await prisma.itemCategory.findFirst({ where: { OR: [{ prefix }, { type, name: { equals: name, mode: "insensitive" } }], ...(id ? { id: { not: id } } : {}) } });
  if (clash) throw new Error(clash.prefix === prefix ? `Awalan ${prefix} sudah dipakai kategori ${clash.name}` : `Kategori ${name} sudah ada`);
  // Awalan BB dipakai kode bahan per divisi (BB-PRD-001)
  if (prefix === "BB") throw new Error("Awalan BB dipakai kode bahan per divisi, pilih awalan lain");
  await prisma.$transaction(async (tx) => {
    if (id) {
      const cur = await tx.itemCategory.findUniqueOrThrow({ where: { id } });
      if (cur.type !== type && (await tx.item.count({ where: { type: cur.type, category: cur.name } }))) throw new Error("Jenis kategori tidak bisa diganti karena sudah dipakai item");
      if (!data.active && (await tx.itemCategory.count({ where: { type, active: true, id: { not: id } } })) === 0) throw new Error("Minimal satu kategori aktif untuk setiap jenis");
      await tx.itemCategory.update({ where: { id }, data });
      if (cur.name !== name) {
        await tx.item.updateMany({ where: { type: cur.type, category: cur.name }, data: { category: name } });
        if (type === "BARANG_JADI") await tx.product.updateMany({ where: { category: cur.name }, data: { category: name } });
      }
    } else await tx.itemCategory.create({ data });
    await audit(user, "KATEGORI_ITEM_DISIMPAN", "ItemCategory", id ?? name, data, tx);
  });
  return "Kategori tersimpan";
}, [...P, "/stok/master", "/produk"]);

export const saveCategory = action("settings.manage", async (fd, user) => {
  const id = optStr(fd, "id");
  const data = { name: z.string().min(2).parse(str(fd, "name")), direction: str(fd, "direction") as TxDirection, coaAccountId: str(fd, "coaAccountId"), keywords: str(fd, "keywords").toLowerCase(), active: id ? bool(fd, "active") : true };
  if (data.direction === "TRANSFER") throw new Error("Transfer internal tidak memakai kategori");
  const s = id ? await prisma.txCategory.update({ where: { id }, data }) : await prisma.txCategory.create({ data });
  await audit(user, "KATEGORI_DISIMPAN", "TxCategory", s.id, data);
  return "Kategori tersimpan";
}, P);

const PARAM_KEYS = ["default_store_id", "loc_raw", "loc_wip", "loc_finished", "late_deduction_per_minute", "payday_offset_days", "weekly_off_quota", "monthly_workdays", "allowance_payday", "go_live_date", "payroll_require_validated", "auto_close_enabled", "auto_close_day", "report_checklist", "company_address", "company_tagline", "company_phone", "company_city"];
export const saveParams = action("settings.manage", async (fd, user) => {
  const changes: Record<string, string> = {};
  for (const k of PARAM_KEYS) {
    if (!fd.has(k)) continue;
    const v = str(fd, k);
    if (k === "auto_close_day" && v && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 28)) throw new Error("Tanggal tutup buku otomatis harus 1–28");
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
    email: normEmail(str(fd, "email")),
  };
  if (data.email && (await prisma.user.findFirst({ where: { email: data.email, ...(id ? { id: { not: id } } : {}) } }))) throw new Error("Email sudah dipakai akun lain");
  if (!id && !password) throw new Error("Password wajib untuk pengguna baru");
  const hash = password ? await hashPassword(password) : null;
  const u = id
    ? await prisma.user.update({ where: { id }, data: { ...data, ...(hash ? passwordChangeData(hash) : {}) } })
    : await prisma.user.create({ data: { ...data, passwordHash: hash! } });
  if (hash) await clearLoginBlocks(u.username);
  await audit(user, id ? "PENGGUNA_DIUBAH" : "PENGGUNA_DIBUAT", "User", u.id, { username: data.username, email: data.email, role, active: data.active, passwordChanged: !!password });
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

/** Tabel akses menu: nyala/mati menu per role (semua role sekaligus; Owner selalu penuh & tidak bisa dikunci) */
export const saveMenuAccess = action("users.manage", async (fd, user) => {
  const all = await prisma.rolePermission.findMany();
  const changed: Record<string, string[]> = {};
  await prisma.$transaction(async (tx) => {
    for (const role of ROLES) {
      if (role === "OWNER") continue;
      const enabled = new Set(fd.getAll(`menu.${role}`).map(String));
      const cur = effectivePermissions(role, all.filter((o) => o.role === role));
      const want = applyMenuChoice(role, cur, enabled);
      if ([...want].length === cur.size && [...want].every((p) => cur.has(p))) continue;
      // Pertahankan override izin yang tidak disentuh (mis. telegram.manage) dengan menulis ulang selisih terhadap bawaan
      await tx.rolePermission.deleteMany({ where: { role } });
      for (const o of overridesFor(role, want)) await tx.rolePermission.create({ data: { role, ...o } });
      changed[role] = MENU_GROUPS.filter((g) => enabled.has(g.key)).map((g) => g.key);
    }
  });
  if (!Object.keys(changed).length) return "Tidak ada perubahan";
  await audit(user, "AKSES_MENU_DIUBAH", "RolePermission", null, changed);
  return `Akses menu tersimpan (${Object.keys(changed).length} role diubah)`;
}, ["/pengaturan/pengguna", "/"]);

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

export const installBotCommands = action("telegram.manage", async (_fd, user) => {
  const r = await setBotCommands();
  await audit(user, "MENU_BOT_DIPASANG", "Telegram", null, r);
  if (!r.ok) throw new Error(`Gagal memasang menu bot: ${r.error}`);
  return "Daftar perintah bot (/menu, /ringkasan, /laporan, …) terpasang";
}, ["/pengaturan/telegram"]);

export const testRecap = action("telegram.manage", async (_fd, user) => {
  const r = await sendDailyRecap();
  await audit(user, "UJI_REKAP_TELEGRAM", "NotificationLog", null, r);
  return `Rekap diproses: ${r.sent} terkirim, ${r.failed} gagal (lihat log)`;
}, ["/pengaturan/telegram"]);
