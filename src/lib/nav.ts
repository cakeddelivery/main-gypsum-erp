import type { Role } from "@prisma/client";
import type { Permission } from "./rbac";

export type NavItem = { href: string; label: string; icon: string; perms: Permission[] };

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home", perms: ["dashboard.view"] },
  { href: "/analitik", label: "Analitik & Advisor", icon: "chart", perms: ["accounting.view"] },
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

/** Label pendek untuk navigasi bawah (mobile) */
const SHORT_LABEL: Record<string, string> = {
  "/": "Beranda", "/analitik": "Analitik", "/laporan": "Laporan", "/absensi": "Absen", "/stok": "Stok", "/produk": "Produk",
  "/finance": "Finance", "/akuntansi": "Akuntansi", "/gaji": "Gaji", "/karyawan": "Karyawan", "/pengaturan": "Setelan",
};

/** 5 menu prioritas per role untuk navigasi bawah di layar HP (urut kiri → kanan) */
export const PRIORITY_NAV: Record<Role, string[]> = {
  OWNER: ["/", "/finance", "/produksi", "/analitik", "/gaji"],
  FINANCE: ["/", "/finance", "/akuntansi", "/gaji", "/analitik"],
  ADMIN: ["/", "/produksi", "/stok", "/absensi", "/finance"],
  ADMIN_PRODUKSI: ["/", "/produksi", "/laporan", "/absensi", "/stok"],
  ADMIN_MARKETPLACE: ["/", "/finance", "/stok", "/produk", "/absensi"],
  KAPTEN_DIVISI: ["/", "/produksi", "/laporan", "/absensi", "/stok"],
  SUPERVISOR: ["/", "/produksi", "/absensi", "/laporan", "/stok"],
  PIC_CONTENT: ["/", "/produk", "/absensi", "/gaji"],
  OPERATOR: ["/", "/produksi", "/absensi", "/laporan", "/gaji"],
};

export const BOTTOM_NAV_SIZE = 5;

/**
 * Menu navigasi bawah: menu prioritas role yang diizinkan; bila ada yang tidak diizinkan
 * (override hak akses), sisa slot diisi menu lain yang diizinkan sesuai urutan menu utama.
 */
export function bottomNavFor(role: Role, can: (p: Permission) => boolean) {
  const allowed = NAV.filter((n) => n.perms.some(can));
  const byHref = new Map(allowed.map((n) => [n.href, n]));
  const picked = PRIORITY_NAV[role].map((h) => byHref.get(h)).filter((n): n is NavItem => !!n);
  for (const n of allowed) if (picked.length < BOTTOM_NAV_SIZE && !picked.includes(n)) picked.push(n);
  return picked.slice(0, BOTTOM_NAV_SIZE).map((n) => ({ href: n.href, label: SHORT_LABEL[n.href] ?? n.label, icon: n.icon }));
}
