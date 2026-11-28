import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { nextNumber } from "./numbering";
import { StockError, locationSettings, qtyAt, recordMovement, reverseMovementsByRef } from "./stock";

/**
 * AMBIL STOK patung kering: Assembling & Giftbox mengambil dari Oven (gudang setengah jadi, WIP) ke lokasi stok divisinya.
 * Posting = TRANSFER antar lokasi (harga rata-rata ikut, TANPA jurnal laba rugi), ref `AMBIL:<nomor>`.
 * Laporan shift divisi: stok awal + ambil − pakai = stok akhir; pemakaian laporan (LPH) mengambil dari lokasi divisi dulu, sisanya dari WIP.
 * Kiriman borongan tetap dari WIP; sisa di lokasi divisi bisa dikembalikan ke Oven (`kembalikanStok`, ref `AMBIL:<nomor>` juga).
 */
type Actor = { id: string; name: string };
type Db = Prisma.TransactionClient | typeof prisma;
export type TakeDivision = "ASSEMBLING" | "GIFTBOX";
export const TAKE_DIVISIONS: Record<TakeDivision, { code: string; name: string; label: string }> = {
  ASSEMBLING: { code: "STK-ASM", name: "Stok Assembling", label: "Assembling" },
  GIFTBOX: { code: "STK-GFT", name: "Stok Giftbox", label: "Giftbox" },
};
export const KERING_PREFIX = "SJ-PTG-";
export const isKering = (sku: string) => sku.startsWith(KERING_PREFIX);

/** Lokasi stok divisi (dibuat sekali bila belum ada; idempoten & hanya menambah) */
export async function ensureDivisionLocation(db: Db, d: TakeDivision) {
  const cfg = TAKE_DIVISIONS[d];
  const div = await db.division.findFirst({ where: { reportTemplate: d }, select: { id: true } });
  const loc = await db.location.upsert({ where: { code: cfg.code }, create: { code: cfg.code, name: cfg.name, divisionId: div?.id ?? null }, update: {} });
  if (!loc.divisionId && div) await db.location.update({ where: { id: loc.id }, data: { divisionId: div.id } });
  return loc.id;
}
/** Lokasi stok divisi menurut format laporan; null bila belum pernah dipakai */
export async function divisionLocationId(db: Db, template: string | null | undefined): Promise<string | null> {
  if (template !== "ASSEMBLING" && template !== "GIFTBOX") return null;
  return (await db.location.findUnique({ where: { code: TAKE_DIVISIONS[template].code }, select: { id: true } }))?.id ?? null;
}

/** Patung kering: stok di Oven (WIP) + stok di lokasi divisi (bila ada) */
export async function keringStock(division: TakeDivision) {
  const locs = await locationSettings(prisma);
  const divLoc = await divisionLocationId(prisma, division);
  const items = await prisma.item.findMany({ where: { active: true, sku: { startsWith: KERING_PREFIX } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, sku: true, name: true, unit: true } });
  const rows = [];
  for (const it of items) rows.push({ ...it, oven: locs.wip ? await qtyAt(prisma, it.id, locs.wip) : 0, mine: divLoc ? await qtyAt(prisma, it.id, divLoc) : 0 });
  return rows;
}

async function move(kind: "AMBIL" | "BALIK", input: { itemId: string; qty: number; division: TakeDivision; note?: string | null; date?: Date }, actor: Actor) {
  const date = input.date ?? new Date();
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId } });
    if (!isKering(item.sku)) throw new StockError("Hanya patung kering yang bisa diambil dari Oven");
    const { wip } = await locationSettings(tx);
    if (!wip) throw new StockError("Lokasi gudang setengah jadi belum diatur di Pengaturan");
    const divLoc = await ensureDivisionLocation(tx, input.division);
    const number = await nextNumber(tx, kind === "AMBIL" ? "AMB" : "BAL", date);
    const ref = `AMBIL:${number}`;
    const label = TAKE_DIVISIONS[input.division].label;
    const note = `${kind === "AMBIL" ? `Ambil stok ${label} dari Oven` : `Kembalikan stok ${label} ke Oven`}${input.note ? ` · ${input.note}` : ""}`;
    // TRANSFER menolak jumlah melebihi stok asal (tanpa allowNegative)
    const m = await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: input.qty, fromLocationId: kind === "AMBIL" ? wip : divLoc, toLocationId: kind === "AMBIL" ? divLoc : wip, ref, note, date }, actor);
    await audit(actor, kind === "AMBIL" ? "AMBIL_STOK" : "KEMBALIKAN_STOK", "Item", item.id, { number, qty: input.qty, division: input.division }, tx);
    return { number, ref, itemName: item.name, unit: item.unit, qty: input.qty, unitCost: Number(m.unitCost) };
  });
}
export const ambilStok = (i: Parameters<typeof move>[1], a: Actor) => move("AMBIL", i, a);
export const kembalikanStok = (i: Parameters<typeof move>[1], a: Actor) => move("BALIK", i, a);

export async function cancelAmbil(number: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new StockError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    const ref = `AMBIL:${number}`;
    if (await tx.stockMovement.findFirst({ where: { ref: `BATAL-${ref}` } })) throw new StockError(`${number} sudah dibatalkan`);
    if (!(await tx.stockMovement.findFirst({ where: { ref } }))) throw new StockError(`${number} tidak ditemukan`);
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, `Batal ambil stok: ${reason}`, actor);
    await audit(actor, "AMBIL_STOK_BATAL", "StockMovement", number, { reason }, tx);
    return { number };
  });
}

export async function ambilHistory(limit = 30) {
  const rows = await prisma.stockMovement.findMany({ where: { ref: { startsWith: "AMBIL:" }, type: "TRANSFER" }, orderBy: { date: "desc" }, take: limit, include: { item: { select: { name: true, unit: true } }, toLocation: { select: { name: true, code: true } }, fromLocation: { select: { name: true, code: true } } } });
  const cancelled = new Set((await prisma.stockMovement.findMany({ where: { ref: { in: rows.map((r) => `BATAL-${r.ref}`) } }, select: { ref: true } })).map((r) => r.ref!.replace(/^BATAL-/, "")));
  return rows.map((r) => ({ id: r.id, number: r.ref!.slice(6), date: r.date, item: r.item.name, unit: r.item.unit, qty: Number(r.qty), to: r.toLocation?.name ?? "", from: r.fromLocation?.name ?? "", by: r.createdBy, balik: r.ref!.startsWith("AMBIL:BAL"), cancelled: cancelled.has(r.ref!) }));
}

/**
 * Pemakaian patung kering dari laporan shift divisi: lokasi divisi dulu, sisanya dari WIP.
 * Mengembalikan daftar (lokasi, qty) agar pemanggil membuat mutasi per lokasi.
 */
export async function splitConsumption(db: Db, itemId: string, qty: number, divLoc: string | null, wip: string): Promise<{ loc: string; qty: number }[]> {
  if (!divLoc) return [{ loc: wip, qty }];
  const have = Math.max(0, await qtyAt(db, itemId, divLoc));
  const fromDiv = Math.min(have, qty);
  const parts: { loc: string; qty: number }[] = [];
  if (fromDiv > 0) parts.push({ loc: divLoc, qty: Math.round(fromDiv * 1000) / 1000 });
  const rest = Math.round((qty - fromDiv) * 1000) / 1000;
  if (rest > 0) parts.push({ loc: wip, qty: rest });
  return parts;
}

/** Rekap patung kering divisi untuk laporan shift: stok awal + ambil (− kembali) − pakai = stok akhir. Kosong bila divisi tak pernah ambil stok */
export async function ambilRecap(reportId: string): Promise<{ name: string; unit: string; awal: number; ambil: number; kembali: number; pakai: number; akhir: number }[]> {
  const r = await prisma.shiftReport.findUnique({ where: { id: reportId }, include: { shift: true, division: true } });
  if (!r) return [];
  const divLoc = await divisionLocationId(prisma, r.division.reportTemplate);
  if (!divLoc) return [];
  const { shiftWindow } = await import("./workday");
  const day = r.date.toISOString().slice(0, 10);
  const { start, end } = shiftWindow(day, r.shift);
  const mv = await prisma.stockMovement.findMany({ where: { date: { gte: start, lte: end }, OR: [{ toLocationId: divLoc }, { fromLocationId: divLoc }] }, include: { item: { select: { id: true, name: true, unit: true, sku: true } } } });
  const by = new Map<string, { name: string; unit: string; ambil: number; kembali: number; pakai: number }>();
  for (const m of mv) {
    if (!isKering(m.item.sku)) continue;
    const c = by.get(m.item.id) ?? { name: m.item.name, unit: m.item.unit, ambil: 0, kembali: 0, pakai: 0 };
    const q = Number(m.qty);
    if (m.toLocationId === divLoc && m.type === "TRANSFER") c.ambil += q;
    else if (m.fromLocationId === divLoc && m.type === "TRANSFER") c.kembali += q;
    else if (m.fromLocationId === divLoc) c.pakai += q;
    by.set(m.item.id, c);
  }
  const rows = [];
  for (const [id, c] of by) rows.push({ ...c, awal: Math.round((await qtyAt(prisma, id, divLoc, new Date(start.getTime() - 1))) * 1000) / 1000, akhir: Math.round((await qtyAt(prisma, id, divLoc, end)) * 1000) / 1000 });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function ambilRecapLines(reportId: string): Promise<string[]> {
  const rows = await ambilRecap(reportId);
  if (!rows.length) return [];
  const f = (x: number) => x.toLocaleString("id-ID");
  return ["STOK PATUNG KERING DIVISI (awal + ambil − kembali − pakai = akhir)", ...rows.map((r) => `${r.name}: ${f(r.awal)} + ${f(r.ambil)} − ${f(r.kembali)} − ${f(r.pakai)} = ${f(r.akhir)} ${r.unit}`)];
}
