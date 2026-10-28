import type { Role } from "@prisma/client";

export const ROLES: Role[] = ["OWNER", "FINANCE", "ADMIN", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE", "KAPTEN_DIVISI", "PIC_CONTENT", "OPERATOR"];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  FINANCE: "Finance",
  ADMIN: "Admin",
  ADMIN_PRODUKSI: "Admin Produksi",
  ADMIN_MARKETPLACE: "Admin Marketplace",
  KAPTEN_DIVISI: "Kapten Divisi",
  PIC_CONTENT: "PIC Content Creator",
  OPERATOR: "Operator",
};

/** Izin per menu (".view") dan tindakan. */
export const PERMISSIONS = {
  "dashboard.view": "Lihat dashboard",
  "dashboard.finance": "Lihat ringkasan keuangan di dashboard",
  "production.view": "Lihat produksi",
  "production.create": "Input hasil produksi",
  "production.edit": "Ubah/hapus hasil produksi",
  "production.target": "Kelola target produksi",
  "report.view": "Lihat laporan shift",
  "report.create": "Buat & kirim laporan shift",
  "attendance.view": "Lihat absensi",
  "attendance.self": "Absen diri sendiri",
  "attendance.manage": "Kelola jadwal & validasi absensi",
  "stock.view": "Lihat stok",
  "stock.move": "Catat mutasi stok",
  "stock.request": "Ajukan permintaan stok",
  "stock.approve": "Setujui permintaan & penyesuaian stok",
  "master.manage": "Kelola master (supplier, item, lokasi, karakter gypsum)",
  "product.view": "Lihat produk & HPP",
  "product.manage": "Kelola produk, BOM, harga",
  "employee.view": "Lihat karyawan",
  "employee.manage": "Kelola karyawan & akun",
  "payroll.view": "Lihat penggajian",
  "payroll.manage": "Hitung penggajian",
  "payroll.approve": "Setujui & bayar gaji",
  "payroll.self": "Lihat slip gaji sendiri",
  "finance.view": "Lihat Finance Inbox",
  "finance.create": "Input transaksi",
  "finance.review": "Tinjau transaksi",
  "finance.approve": "Setujui & bukukan transaksi",
  "accounting.view": "Lihat akuntansi & laporan keuangan",
  "accounting.post": "Buat jurnal manual, saldo awal, piutang/utang, aset",
  "accounting.close": "Tutup buku",
  "settings.manage": "Pengaturan organisasi & parameter",
  "users.manage": "Kelola pengguna & hak akses",
  "telegram.manage": "Kelola bot Telegram & API Hermes",
  "audit.view": "Lihat audit trail",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const OPERATOR_BASE: Permission[] = ["dashboard.view", "production.view", "production.create", "attendance.self", "attendance.view", "payroll.self", "stock.request", "report.view"];

export const DEFAULT_MATRIX: Record<Role, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  FINANCE: [
    "dashboard.view", "dashboard.finance", "finance.view", "finance.create", "finance.review", "finance.approve",
    "accounting.view", "accounting.post", "accounting.close", "payroll.view", "payroll.approve", "payroll.self",
    "stock.view", "product.view", "employee.view", "production.view", "report.view", "audit.view",
  ],
  ADMIN: [
    "dashboard.view", "dashboard.finance", "production.view", "production.create", "production.edit", "production.target",
    "report.view", "report.create", "attendance.view", "attendance.manage", "attendance.self", "stock.view", "stock.move",
    "stock.request", "stock.approve", "master.manage", "product.view", "product.manage", "employee.view", "employee.manage",
    "payroll.view", "payroll.manage", "payroll.self", "finance.view", "finance.create", "finance.review", "accounting.view", "settings.manage", "audit.view",
  ],
  ADMIN_PRODUKSI: [
    "dashboard.view", "production.view", "production.create", "production.edit", "production.target", "report.view", "report.create",
    "attendance.view", "attendance.manage", "attendance.self", "stock.view", "stock.move", "stock.request", "product.view",
    "employee.view", "payroll.view", "payroll.self",
  ],
  ADMIN_MARKETPLACE: ["dashboard.view", "stock.view", "product.view", "finance.view", "finance.create", "attendance.self", "payroll.self"],
  KAPTEN_DIVISI: [...OPERATOR_BASE, "report.create", "attendance.manage", "stock.view", "employee.view", "production.target"],
  PIC_CONTENT: ["dashboard.view", "product.view", "attendance.self", "payroll.self"],
  OPERATOR: OPERATOR_BASE,
};

export type PermissionOverride = { role: Role; permission: string; allowed: boolean };

/** Hitung izin efektif: matriks default + override dari database. Owner selalu punya semua izin. */
export function effectivePermissions(role: Role, overrides: PermissionOverride[]): Set<Permission> {
  if (role === "OWNER") return new Set(ALL_PERMISSIONS);
  const set = new Set<Permission>(DEFAULT_MATRIX[role]);
  for (const o of overrides) {
    if (o.role !== role || !(o.permission in PERMISSIONS)) continue;
    if (o.allowed) set.add(o.permission as Permission);
    else set.delete(o.permission as Permission);
  }
  // "telegram.manage" (menu pengelolaan bot) khusus Owner
  set.delete("telegram.manage");
  return set;
}

/** Role yang memakai navigasi bawah (mobile, operator/karyawan) */
export const FIELD_ROLES: Role[] = ["OPERATOR", "KAPTEN_DIVISI", "PIC_CONTENT"];
