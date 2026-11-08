import type { Prisma, Supplier } from "@prisma/client";
import { prisma } from "./db";
import { autoCode } from "./codes";
import { audit } from "./audit";

type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { id: string | null; name: string };

/** Kata umum yang tidak membedakan supplier ("Supplier BG Klip Label" = "BG Klip Label", "Toko Afdhol" = "Afdhol") */
const GENERIC = new Set(["supplier", "suplier", "pemasok", "toko", "tk", "cv", "pt", "ud", "pak", "bu", "bpk", "ibu", "mas", "mbak", "bang", "kak"]);

/** Nama supplier dinormalkan untuk dicocokkan: huruf kecil, tanpa tanda baca & kata umum */
export function supplierKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !GENERIC.has(w))
    .join(" ");
}

export function supplierNames(s: Pick<Supplier, "name" | "aliases">): string[] {
  return [s.name, ...s.aliases.split(",")].map((x) => x.trim()).filter(Boolean);
}

/** Supplier yang nama atau nama lainnya sama dengan `name` (setelah dinormalkan); aktif didahulukan */
export async function findSupplierByName(db: Db, name: string): Promise<Supplier | null> {
  const key = supplierKey(name);
  if (key.length < 2) return null;
  const all = await db.supplier.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
  return all.find((s) => supplierNames(s).some((n) => supplierKey(n) === key)) ?? null;
}

/** Supplier yang mirip (salah satu nama memuat nama lain), untuk peringatan "mungkin sama dengan" */
export async function similarSuppliers(db: Db, name: string, excludeId?: string): Promise<Supplier[]> {
  const key = supplierKey(name);
  if (key.length < 3) return [];
  const all = await db.supplier.findMany({ where: excludeId ? { id: { not: excludeId } } : {} });
  return all.filter((s) => supplierNames(s).some((n) => {
    const k = supplierKey(n);
    return k.length >= 3 && (k === key || ` ${k} `.includes(` ${key} `) || ` ${key} `.includes(` ${k} `));
  }));
}

/**
 * Supplier untuk hutang/pembelian baru: yang dipilih, atau nama yang diketik dicocokkan dengan master
 * (termasuk nama lain); bila belum ada dibuat baru. Mencegah supplier dobel antara menu Hutang & Pembelian.
 */
export async function resolveSupplier(db: Db, input: { supplierId?: string | null; name?: string | null }, actor: Actor, from: string): Promise<Supplier | null> {
  if (input.supplierId) return db.supplier.findUniqueOrThrow({ where: { id: input.supplierId } });
  const name = input.name?.trim();
  if (!name) return null;
  const found = await findSupplierByName(db, name);
  if (found) return found;
  const s = await db.supplier.create({ data: { name: name.slice(0, 120), code: await autoCode.supplier(db) } });
  await audit({ actorId: actor.id, actorName: actor.name }, "SUPPLIER_DISIMPAN", "Supplier", s.id, { name, from }, db as Prisma.TransactionClient);
  return s;
}

/**
 * Gabungkan supplier dobel: semua item, pembelian, dan hutang `sourceId` dipindah ke `targetId`, nama dokumen ikut
 * diganti, nama supplier lama disimpan sebagai nama lain supplier tujuan, lalu supplier lama dihapus.
 * Jurnal tidak berubah (nama pemasok hanya keterangan).
 */
export async function mergeSuppliers(sourceId: string, targetId: string, actor: Actor, opts: { name?: string | null } = {}) {
  if (sourceId === targetId) throw new Error("Pilih dua supplier yang berbeda");
  return prisma.$transaction(async (tx) => {
    const src = await tx.supplier.findUniqueOrThrow({ where: { id: sourceId } });
    const dst = await tx.supplier.findUniqueOrThrow({ where: { id: targetId } });
    const name = opts.name?.trim() || dst.name;
    const aliases = [...new Set([...supplierNames(src), ...supplierNames(dst)].filter((n) => supplierKey(n) !== supplierKey(name)))];
    const items = await tx.item.updateMany({ where: { supplierId: src.id }, data: { supplierId: dst.id } });
    // Dokumen dengan nama pemasok lama (tertaut ke supplier lama, atau hanya diketik namanya) ikut dipindah
    const names = supplierNames(src);
    const docWhere = (extra: object) => ({ OR: [{ supplierId: src.id }, { supplierId: null, vendor: { in: names, mode: "insensitive" as const } }], ...extra });
    const purchases = await tx.purchase.updateMany({ where: docWhere({}), data: { supplierId: dst.id, vendor: name } });
    const payables = await tx.payable.updateMany({ where: docWhere({ kind: "USAHA" }), data: { supplierId: dst.id, vendor: name } });
    // Dokumen supplier tujuan ikut memakai nama yang dipilih
    if (name !== dst.name) {
      await tx.purchase.updateMany({ where: { supplierId: dst.id }, data: { vendor: name } });
      await tx.payable.updateMany({ where: { supplierId: dst.id }, data: { vendor: name } });
    }
    const note = [dst.note, src.note].filter(Boolean).join(" · ") || null;
    await tx.supplier.delete({ where: { id: src.id } });
    const out = await tx.supplier.update({
      where: { id: dst.id },
      data: { name, aliases: aliases.join(", ").slice(0, 500), phone: dst.phone ?? src.phone, address: dst.address ?? src.address, note: note?.slice(0, 500) ?? null, active: true },
    });
    await audit({ actorId: actor.id, actorName: actor.name }, "SUPPLIER_DIGABUNG", "Supplier", dst.id, { from: src.name, to: name, items: items.count, purchases: purchases.count, payables: payables.count }, tx);
    return { supplier: out, items: items.count, purchases: purchases.count, payables: payables.count };
  });
}

/** Ringkasan hutang per supplier: total hutang, dibayar, sisa (hutang usaha saja) */
export async function supplierDebt(db: Db = prisma) {
  const rows = await db.payable.groupBy({ by: ["supplierId"], where: { kind: "USAHA", supplierId: { not: null } }, _sum: { amount: true, paid: true } });
  return new Map(rows.map((r) => [r.supplierId!, { amount: Number(r._sum.amount ?? 0), paid: Number(r._sum.paid ?? 0) }]));
}
