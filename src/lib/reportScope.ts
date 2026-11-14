import type { Role } from "@prisma/client";

/** Peran pengelola yang melihat laporan shift SEMUA divisi */
const ALL_DIVISIONS: Role[] = ["OWNER", "ADMIN", "ADMIN_PRODUKSI", "SUPERVISOR", "FINANCE"];

type ScopeUser = { role: Role; divisionId: string | null; employeeId?: string | null; employee?: { divisionId: string | null } | null };

/**
 * Divisi anggota: divisi DATA KARYAWAN-nya lebih dulu (tempat ia benar-benar bekerja), baru kolom divisi akun.
 * Kolom divisi akun bisa tertinggal (mis. diisi saat pernah jadi kapten divisi lain) dan dulu membuat operator
 * Packing bisa membuka laporan Assembling.
 */
export function memberDivision(user: ScopeUser): string | null {
  return user.employee?.divisionId ?? user.divisionId ?? null;
}

/**
 * Divisi yang boleh dilihat/diisi pengguna di menu Laporan Shift.
 * null = semua divisi (pengelola). Karyawan (kapten, operator, atau akun yang tertaut ke data karyawan)
 * hanya divisinya sendiri; tanpa divisi → "-" (tidak ada laporan yang cocok).
 */
export function reportDivision(user: ScopeUser): string | null {
  if (ALL_DIVISIONS.includes(user.role)) return null;
  if (user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR" || user.employeeId) return memberDivision(user) ?? "-";
  return null;
}

/** Boleh membuka laporan divisi ini? */
export function canSeeDivision(user: ScopeUser, divisionId: string) {
  const d = reportDivision(user);
  return d === null || d === divisionId;
}

/** Yang menindaklanjuti kendala laporan shift (dapat peringatan bila kendala belum selesai) */
export const FOLLOW_UP_ROLES: Role[] = ["OWNER", "SUPERVISOR", "FINANCE"];
export function canFollowUp(user: { role: Role }) {
  return FOLLOW_UP_ROLES.includes(user.role);
}
