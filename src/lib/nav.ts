import type { Permission } from "./rbac";

export type NavItem = { href: string; label: string; icon: string; perms: Permission[] };

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home", perms: ["dashboard.view"] },
  { href: "/produksi", label: "Produksi", icon: "factory", perms: ["production.view"] },
  { href: "/laporan", label: "Laporan Shift", icon: "report", perms: ["report.view"] },
  { href: "/absensi", label: "Absensi", icon: "clock", perms: ["attendance.view", "attendance.self"] },
  { href: "/stok", label: "Stok & Persediaan", icon: "box", perms: ["stock.view", "stock.request"] },
  { href: "/produk", label: "Produk & HPP", icon: "tag", perms: ["product.view"] },
  { href: "/karyawan", label: "Karyawan", icon: "users", perms: ["employee.view"] },
  { href: "/gaji", label: "Penggajian", icon: "wallet", perms: ["payroll.view", "payroll.self"] },
  { href: "/finance", label: "Finance Inbox", icon: "inbox", perms: ["finance.view"] },
  { href: "/akuntansi", label: "Akuntansi", icon: "book", perms: ["accounting.view"] },
  { href: "/pengaturan", label: "Pengaturan", icon: "cog", perms: ["settings.manage", "users.manage", "telegram.manage", "audit.view"] },
];

/** Navigasi bawah untuk operator/karyawan (mobile) */
export const BOTTOM_NAV: NavItem[] = [
  { href: "/", label: "Beranda", icon: "home", perms: ["dashboard.view"] },
  { href: "/produksi", label: "Produksi", icon: "factory", perms: ["production.view"] },
  { href: "/absensi", label: "Absen", icon: "clock", perms: ["attendance.self", "attendance.view"] },
  { href: "/laporan", label: "Laporan", icon: "report", perms: ["report.view"] },
  { href: "/gaji", label: "Gaji", icon: "wallet", perms: ["payroll.self", "payroll.view"] },
];
