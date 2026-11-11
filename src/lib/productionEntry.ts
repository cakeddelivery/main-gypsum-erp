import { z } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { postProductionStock, reverseProductionStock, STAGES } from "./stock";
import { REJECT_REASONS } from "./reject";
import { audit } from "./audit";
import { dateOnly } from "./time";

export const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal wajib"),
  shiftId: z.string().min(1, "Pilih shift"),
  divisionId: z.string().min(1, "Pilih divisi"),
  employeeId: z.string().min(1, "Pilih karyawan"),
  stage: z.enum(STAGES as [string, ...string[]]),
  productId: z.string().min(1, "Pilih produk"),
  qtyGood: z.number().int().min(0).max(100000),
  qtyReject: z.number().int().min(0).max(100000),
  rejectReason: z.enum(REJECT_REASONS).nullable(),
});
export type EntryInput = z.input<typeof entrySchema> & { note?: string | null };
type Actor = { id: string; name: string; role: Role; employeeId: string | null; divisionId: string | null };

export class EntryForbidden extends Error {
  constructor() {
    super("Anda tidak memiliki izin untuk tindakan ini");
  }
}

/** Catat hasil produksi + mutasi stok + audit. Dipakai form web dan bot Telegram. */
export async function recordProductionEntry(input: EntryInput, user: Actor) {
  const data = entrySchema.parse(input);
  if (data.qtyReject > 0 && !data.rejectReason) throw new Error("Pilih penyebab reject");
  if (data.qtyReject === 0) data.rejectReason = null;
  if (data.qtyGood + data.qtyReject === 0) throw new Error("Isi jumlah hasil atau reject");
  // Operator hanya boleh mencatat hasil dirinya; kapten hanya divisinya
  if (user.role === "OPERATOR" && data.employeeId !== user.employeeId) throw new EntryForbidden();
  if (user.role === "KAPTEN_DIVISI" && user.divisionId && data.divisionId !== user.divisionId) throw new EntryForbidden();
  // Laporan shift jadi sumber hasil tahap ini: input manual hanya Owner (koreksi), agar stok tidak dobel
  const { FLOW_STAGES, flowEnabled } = await import("./shiftReportFlow");
  if (user.role !== "OWNER" && (FLOW_STAGES as readonly string[]).includes(data.stage) && (await flowEnabled())) {
    throw new Error("Hasil tahap ini sekarang dicatat otomatis dari Laporan Shift. Input manual hanya untuk Owner (koreksi).");
  }
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: data.employeeId } });
  if (emp.status === "NONAKTIF") throw new Error("Karyawan nonaktif");
  return prisma.$transaction(async (tx) => {
    const e = await tx.productionEntry.create({ data: { ...data, stage: data.stage as (typeof STAGES)[number], date: dateOnly(data.date), note: input.note ?? null, createdBy: user.name } });
    await postProductionStock(tx, e.id, user);
    await audit(user, "PRODUKSI_DICATAT", "ProductionEntry", e.id, data, tx);
    return e;
  });
}

/**
 * Hapus entri produksi: stok, harga rata-rata, dan jurnal dibalik dalam satu transaksi.
 * Baris entri dikunci dulu agar dua klik "Hapus" bersamaan tidak membalik stok dua kali.
 */
export async function deleteProductionEntry(id: string, actor: { id: string; name: string }) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ProductionEntry" WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw new Error("Entri produksi sudah dihapus");
    const e = await tx.productionEntry.findUniqueOrThrow({ where: { id } });
    if (e.stockPosted) await reverseProductionStock(tx, id, actor);
    await tx.productionEntry.delete({ where: { id } });
    await audit(actor, "PRODUKSI_DIHAPUS", "ProductionEntry", id, e, tx);
    return e;
  });
}
