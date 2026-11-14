import type { Role } from "@prisma/client";

export const ROLES: Role[] = ["OWNER", "FINANCE", "ADMIN", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE", "KAPTEN_DIVISI", "SUPERVISOR", "PIC_CONTENT", "OPERATOR", "KOORDINATOR"];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  FINANCE: "Finance",
  ADMIN: "Admin",
  ADMIN_PRODUKSI: "Admin Produksi",
  ADMIN_MARKETPLACE: "Admin Marketplace",
  KAPTEN_DIVISI: "Kapten Divisi",
  SUPERVISOR: "Supervisor",
  PIC_CONTENT: "PIC Content Creator",
  OPERATOR: "Operator",
  KOORDINATOR: "Koordinator Borongan",
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
  "attendance.location": "Atur titik lokasi kerja untuk absen (GPS)",
  "material.manage": "Kelola bahan baku divisi, limit & checklist laporan shift",
  "stock.view": "Lihat stok",
  "stock.move": "Catat mutasi stok",
  "stock.request": "Ajukan permintaan stok",
  "stock.approve": "Setujui permintaan & penyesuaian stok",
  "stock.receive": "Terima barang pesanan (validasi barang datang)",
  "master.manage": "Kelola master (item, lokasi, karakter gypsum)",
  "partner.view": "Lihat supplier & pelanggan",
  "partner.manage": "Kelola supplier & pelanggan",
  "product.view": "Lihat produk & HPP",
  "product.manage": "Kelola produk, BOM, harga",
  "borongan.view": "Lihat borongan tetangga",
  "borongan.point": "Koordinator titik: terima bahan, catat hasil, kelola pekerja titiknya",
  "borongan.manage": "Kelola borongan: titik, orang, tugas & tarif, kirim bahan, terima hasil",
  "borongan.pay": "Bayar upah borongan",
  "employee.view": "Lihat karyawan",
  "employee.manage": "Kelola karyawan & akun",
  "payroll.view": "Lihat penggajian",
  "payroll.manage": "Hitung penggajian",
  "payroll.approve": "Setujui & bayar gaji",
  "payroll.self": "Lihat slip gaji sendiri",
  "sales.view": "Lihat penjualan & piutang pelanggan",
  "sales.manage": "Catat penjualan, terima cicilan piutang, batalkan penjualan",
  "finance.view": "Lihat Transaksi",
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

// Anggota (Operator/Kapten) tidak lagi input hasil produksi sendiri: hasil kerja dicatat lewat Laporan Shift
// (semua karyawan bergaji bulanan). Override yang tersimpan di Hak akses tetap berlaku.
const OPERATOR_BASE: Permission[] = ["dashboard.view", "production.view", "attendance.self", "attendance.view", "payroll.self", "stock.request", "report.view"];

export const DEFAULT_MATRIX: Record<Role, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  FINANCE: [
    "dashboard.view", "dashboard.finance", "finance.view", "finance.create", "finance.review", "finance.approve",
    "accounting.view", "accounting.post", "accounting.close", "payroll.view", "payroll.approve", "payroll.self",
    "stock.view", "product.view", "employee.view", "production.view", "production.target", "report.view", "audit.view",
    "attendance.view", "attendance.manage", "partner.view", "partner.manage", "borongan.view", "borongan.pay",
    "sales.view", "sales.manage",
  ],
  ADMIN: [
    "dashboard.view", "dashboard.finance", "production.view", "production.create", "production.edit",
    "report.view", "report.create", "attendance.view", "attendance.self", "attendance.location", "stock.view", "stock.move",
    "stock.request", "stock.approve", "master.manage", "product.view", "product.manage", "employee.view", "employee.manage",
    "payroll.view", "payroll.manage", "payroll.self", "finance.view", "finance.create", "finance.review", "accounting.view", "settings.manage", "audit.view",
    "partner.view", "partner.manage", "borongan.view", "borongan.manage", "sales.view", "sales.manage",
  ],
  ADMIN_PRODUKSI: [
    "dashboard.view", "production.view", "production.create", "production.edit", "report.view", "report.create",
    "attendance.view", "attendance.self", "stock.view", "stock.move", "stock.request", "product.view",
    "employee.view", "payroll.self", "partner.view", "borongan.view", "borongan.manage",
  ],
  ADMIN_MARKETPLACE: ["dashboard.view", "stock.view", "product.view", "finance.view", "finance.create", "attendance.self", "payroll.self", "partner.view", "partner.manage", "sales.view", "sales.manage"],
  KAPTEN_DIVISI: [...OPERATOR_BASE, "report.create", "stock.view", "stock.receive", "employee.view"],
  SUPERVISOR: [
    "dashboard.view", "production.view", "production.create", "production.edit", "production.target", "report.view", "report.create",
    "attendance.view", "attendance.manage", "attendance.self", "attendance.location", "stock.view", "stock.move", "stock.request", "stock.receive", "product.view",
    "employee.view", "payroll.self", "partner.view", "borongan.view", "borongan.manage",
  ],
  PIC_CONTENT: ["dashboard.view", "product.view", "attendance.self", "payroll.self"],
  OPERATOR: [...OPERATOR_BASE, "report.create"],
  KOORDINATOR: ["borongan.view", "borongan.point"],
};

// Lihat gaji seluruh karyawan: Owner, Finance, Admin. Supervisor & Admin Produksi cukup slip sendiri (audit 8 Nov 2026)
/** Validasi/atur absensi, target produksi, dan titik lokasi absen hanya untuk role ini (tidak bisa dibuka lewat override) */
export const RESTRICTED: Partial<Record<Permission, Role[]>> = {
  "attendance.manage": ["OWNER", "SUPERVISOR", "FINANCE"],
  "production.target": ["OWNER", "SUPERVISOR", "FINANCE"],
  "attendance.location": ["OWNER", "ADMIN", "SUPERVISOR"],
};

/**
 * Izin sensitif (uang, gaji, akuntansi, pengaturan): diberi label merah di Pengaturan, dan memberikannya ke role
 * lapangan wajib dikonfirmasi Owner (lihat sensitiveGrants).
 */
export const SENSITIVE: Permission[] = [
  "dashboard.finance", "finance.view", "finance.create", "finance.review", "finance.approve",
  "accounting.view", "accounting.post", "accounting.close", "payroll.view", "payroll.manage", "payroll.approve",
  "sales.manage", "borongan.pay", "settings.manage", "users.manage", "audit.view",
];
export const isSensitive = (p: string) => (SENSITIVE as string[]).includes(p);

/** Role lapangan: tidak semestinya melihat keuangan/gaji/pengaturan */
export const FIELD_ROLES_SENSITIVE: Role[] = ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "KOORDINATOR", "PIC_CONTENT"];

/** Izin sensitif yang BARU diberikan ke role lapangan (before → after); kosong = aman disimpan tanpa konfirmasi */
export function sensitiveGrants(role: Role, before: Set<Permission>, after: Set<Permission>): Permission[] {
  if (!FIELD_ROLES_SENSITIVE.includes(role)) return [];
  return SENSITIVE.filter((p) => after.has(p) && !before.has(p));
}

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
  for (const [p, roles] of Object.entries(RESTRICTED)) if (!roles.includes(role)) set.delete(p as Permission);
  return set;
}

/**
 * Menu untuk tabel "Akses menu" (Pengaturan › Pengguna & hak akses). Satu menu = sekelompok izin;
 * menu dimatikan = semua izinnya dicabut sehingga halaman & tindakan ditolak di server juga.
 * `on` = izin minimal saat menu dinyalakan untuk role yang tidak punya bawaan.
 */
export const MENU_GROUPS: { key: string; label: string; perms: Permission[]; on: Permission[] }[] = [
  { key: "dashboard", label: "Dashboard", perms: ["dashboard.view", "dashboard.finance"], on: ["dashboard.view"] },
  { key: "production", label: "Produksi", perms: ["production.view", "production.create", "production.edit", "production.target"], on: ["production.view"] },
  { key: "report", label: "Laporan Shift", perms: ["report.view", "report.create", "material.manage"], on: ["report.view"] },
  { key: "attendance", label: "Absensi", perms: ["attendance.view", "attendance.self", "attendance.manage", "attendance.location"], on: ["attendance.self"] },
  { key: "stock", label: "Stok & Persediaan", perms: ["stock.view", "stock.move", "stock.request", "stock.approve", "stock.receive", "master.manage"], on: ["stock.view"] },
  { key: "product", label: "Produk & HPP", perms: ["product.view", "product.manage"], on: ["product.view"] },
  { key: "sales", label: "Penjualan", perms: ["sales.view", "sales.manage"], on: ["sales.view"] },
  { key: "partner", label: "Supplier & Pelanggan", perms: ["partner.view", "partner.manage"], on: ["partner.view"] },
  { key: "borongan", label: "Borongan", perms: ["borongan.view", "borongan.point", "borongan.manage", "borongan.pay"], on: ["borongan.view"] },
  { key: "employee", label: "Karyawan", perms: ["employee.view", "employee.manage"], on: ["employee.view"] },
  { key: "payroll", label: "Penggajian", perms: ["payroll.view", "payroll.manage", "payroll.approve", "payroll.self"], on: ["payroll.self"] },
  { key: "finance", label: "Transaksi", perms: ["finance.view", "finance.create", "finance.review", "finance.approve"], on: ["finance.view"] },
  { key: "accounting", label: "Akuntansi & Analitik", perms: ["accounting.view", "accounting.post", "accounting.close"], on: ["accounting.view"] },
  { key: "settings", label: "Pengaturan", perms: ["settings.manage", "users.manage", "audit.view"], on: ["audit.view"] },
];

/**
 * Terapkan pilihan menu (nyala/mati) ke himpunan izin efektif sebuah role.
 * Menu yang dimatikan: semua izinnya dicabut. Menu yang dinyalakan tapi sebelumnya mati: izin bawaan role
 * untuk menu itu, atau izin minimal `on` bila role tidak punya bawaan. Menu yang sudah menyala tidak diubah.
 */
export function applyMenuChoice(role: Role, current: Set<Permission>, enabled: Set<string>): Set<Permission> {
  const next = new Set(current);
  const defaults = new Set(DEFAULT_MATRIX[role]);
  for (const g of MENU_GROUPS) {
    const isOn = g.perms.some((p) => current.has(p));
    if (!enabled.has(g.key)) for (const p of g.perms) next.delete(p);
    else if (!isOn) {
      const base = g.perms.filter((p) => defaults.has(p));
      for (const p of base.length ? base : g.on) next.add(p);
    }
  }
  return next;
}

/** Override yang perlu disimpan agar izin efektif role = `want` (selisih dengan matriks bawaan) */
export function overridesFor(role: Role, want: Set<Permission>): { permission: Permission; allowed: boolean }[] {
  const defaults = new Set(DEFAULT_MATRIX[role]);
  return ALL_PERMISSIONS.filter((p) => want.has(p) !== defaults.has(p)).map((p) => ({ permission: p, allowed: want.has(p) }));
}
