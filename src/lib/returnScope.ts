import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { StockError } from "./stock";

/** Divisi yang anggotanya (Operator/Kapten) boleh mencatat retur paket (tanpa refund/komplain) */
export const RETUR_DIVISION_TEMPLATES = ["GIFTBOX", "PACKING"];
const MEMBER_ROLES: Role[] = ["OPERATOR", "KAPTEN_DIVISI"];

/** Anggota Giftbox/Packing mendapat izin retur.manage (refund tetap untuk pengelola) */
export function divisionReturGrant(role: Role, template: string | null | undefined) {
  return MEMBER_ROLES.includes(role) && RETUR_DIVISION_TEMPLATES.includes(template ?? "");
}

type ScopeUser = { role: Role; divisionId: string | null; employee?: { divisionId: string | null } | null };

/**
 * Barang jadi yang boleh dipilih di retur: anggota divisi hanya produk jadi divisinya (Packing tidak melihat Giftbox);
 * pengelola (Supervisor, Owner, Admin, dll.) semua barang jadi. null = tanpa batas.
 */
export async function returnItemScope(user: ScopeUser): Promise<string[] | null> {
  if (!MEMBER_ROLES.includes(user.role)) return null;
  // Divisi dari data Karyawan lebih dulu (sama dengan aturan laporan shift)
  const divisionId = user.employee?.divisionId ?? user.divisionId;
  if (!divisionId) return [];
  const items = await prisma.item.findMany({ where: { active: true, type: "BARANG_JADI", divisionId }, select: { id: true } });
  return items.map((i) => i.id);
}

/** Daftar pilihan barang jadi untuk form retur sesuai cakupan user */
export async function returnItemOptions(user: ScopeUser) {
  const scope = await returnItemScope(user);
  return prisma.item.findMany({ where: { active: true, type: "BARANG_JADI", ...(scope ? { id: { in: scope } } : {}) }, orderBy: { name: "asc" }, select: { id: true, name: true } });
}

/** Tolak barang di luar cakupan divisi (dicek di server, bukan hanya disembunyikan di form) */
export async function assertReturnItems(user: ScopeUser, itemIds: (string | null | undefined)[]) {
  const scope = await returnItemScope(user);
  if (!scope) return;
  const allowed = new Set(scope);
  const bad = itemIds.filter((x): x is string => !!x && !allowed.has(x));
  if (bad.length) throw new StockError("Barang retur di luar produk jadi divisi Anda. Pilih produk divisi sendiri atau minta Supervisor.");
}
