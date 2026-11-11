import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db";

type Db = PrismaClient | Prisma.TransactionClient;
export type ProductTypeOpt = { code: string; name: string; packQty: number; active: boolean };

/** Daftar tipe produk jadi dari DB (Pengaturan › Tipe produk), urut sortOrder */
export async function productTypes(db: Db = prisma, opts: { includeInactive?: boolean } = {}): Promise<ProductTypeOpt[]> {
  return db.productTypeOption.findMany({ where: opts.includeInactive ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { code: true, name: true, packQty: true, active: true } });
}

/** Label tipe untuk tampilan; kode yang tidak dikenal ditampilkan apa adanya */
export function typeLabel(list: { code: string; name: string }[], code: string) {
  return list.find((t) => t.code === code)?.name ?? code;
}

/** Kode tipe baru otomatis dari nama: "Paket 6" → PAKET_6 (ditambah angka bila sudah dipakai) */
export async function nextTypeCode(db: Db, name: string) {
  const base = name.toUpperCase().normalize("NFKD").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "TIPE";
  let code = base;
  for (let n = 2; await db.productTypeOption.findUnique({ where: { code } }); n++) code = `${base}_${n}`;
  return code;
}
