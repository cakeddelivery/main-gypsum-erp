import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { reverseJournal, reversalDate } from "./accounting";
import { locationSettings, recordMovement, reverseMovementsByRef } from "./stock";
import { VARIANTS, type FlowStep, type GridRow, type WorkData } from "./shiftReport";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string; role?: string };

/**
 * Panen Oven realtime ("+ Hasil Panen"): tiap entri langsung diposting ke stok bertanggal jam entri
 * (− patung cetak bagus+reject, + patung kering bagus; sama dengan aturan panen/reject laporan shift).
 * Begitu laporan punya entri, isian panen & reject laporan = jumlah entri aktif (HARVEST_KEY menandainya),
 * dan postShiftWork hanya memposting selisih yang belum diposting entri (tidak dobel).
 */
export const HARVEST_KEY = "_panenRealtime";
export const OVENS = ["Oven Besar", "Oven Kecil"] as const;
/** Peran yang boleh mengoreksi/membatalkan entri setelah laporan dikirim (alasan wajib) */
export const HARVEST_MANAGERS = ["OWNER", "SUPERVISOR"];
export const harvestRef = (id: string) => `PNN:${id}`;

export type HarvestRow = { oven: string; variant: string; good: number; reject: number; posted?: boolean; cancelledAt?: Date | null };

export function isHarvestWork(work: unknown): boolean {
  return !!work && typeof work === "object" && (work as Record<string, unknown>)[HARVEST_KEY] === true;
}

/** Isian grid panen & reject laporan dari entri aktif (baris Oven Besar / Oven Kecil × 4 karakter) */
export function harvestGrids(entries: HarvestRow[]): { panen: GridRow[]; reject: GridRow[] } {
  const active = entries.filter((e) => !e.cancelledAt);
  const grid = (pick: (e: HarvestRow) => number): GridRow[] =>
    OVENS.map((oven) => ({
      name: oven,
      v: VARIANTS.map((v) => {
        const q = active.filter((e) => e.oven === oven && e.variant === v).reduce((a, e) => a + pick(e), 0);
        return q > 0 ? q : null;
      }),
    })).filter((r) => r.v.some((x) => x != null));
  return { panen: grid((e) => e.good), reject: grid((e) => e.reject) };
}

/** Total entri aktif yang SUDAH diposting ke stok, per karakter */
export function postedTotals(entries: HarvestRow[]) {
  const good: Record<string, number> = {};
  const used: Record<string, number> = {};
  for (const e of entries) {
    if (e.cancelledAt || !e.posted) continue;
    good[e.variant] = (good[e.variant] ?? 0) + e.good;
    used[e.variant] = (used[e.variant] ?? 0) + e.good + e.reject;
  }
  return { good, used };
}

/**
 * Rencana stok laporan dikurangi yang sudah diposting entri panen realtime:
 * + patung kering −= bagus, − patung cetak −= bagus+reject. Langkah lain (cetak dsb.) tetap.
 */
export function netOfHarvest(steps: FlowStep[], entries: HarvestRow[]): FlowStep[] {
  const { good, used } = postedTotals(entries);
  const out: FlowStep[] = [];
  for (const s of steps) {
    let qty = s.qty;
    if (s.kind === "kering" && s.dir === "in") qty -= good[s.key] ?? 0;
    if (s.kind === "basah" && s.dir === "out") qty -= used[s.key] ?? 0;
    if (qty > 0) out.push({ ...s, qty });
  }
  return out;
}

export function harvestSummary(entries: HarvestRow[]) {
  const active = entries.filter((e) => !e.cancelledAt);
  const byVariant = Object.fromEntries(VARIANTS.map((v) => [v, { good: 0, reject: 0 }]));
  for (const e of active) {
    byVariant[e.variant].good += e.good;
    byVariant[e.variant].reject += e.reject;
  }
  return { byVariant, good: active.reduce((a, e) => a + e.good, 0), reject: active.reduce((a, e) => a + e.reject, 0), count: active.length };
}

// ---------------- Database ----------------

async function lockReport(tx: Tx, reportId: string) {
  await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${reportId} FOR UPDATE`;
  return tx.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { division: true, shift: true } });
}

/** Isian panen/reject laporan disamakan dengan entri aktif */
async function syncWork(tx: Tx, reportId: string, work: unknown) {
  const entries = await tx.shiftHarvest.findMany({ where: { reportId } });
  const w = { ...((work as WorkData) ?? {}), ...harvestGrids(entries), [HARVEST_KEY]: true };
  await tx.shiftReport.update({ where: { id: reportId }, data: { work: w as Prisma.InputJsonValue } });
}

/** Posting satu entri ke stok (bila stok terpadu menyala pada tanggal laporan) */
async function postEntry(tx: Tx, h: { id: string; variant: string; good: number; reject: number; at: Date; oven: string }, divisionName: string, reportDate: Date, actor: Actor) {
  const { flowEnabledOn, flowItem } = await import("./shiftReportFlow");
  if (!(await flowEnabledOn(reportDate, tx))) return false;
  const { wip } = await locationSettings(tx);
  if (!wip) throw new Error("Lokasi gudang setengah jadi belum diatur di Pengaturan");
  const ref = harvestRef(h.id);
  const note = `Panen ${divisionName} ${h.oven} (realtime)`;
  const used = h.good + h.reject;
  if (used > 0) {
    const basah = await flowItem(tx, { kind: "basah", key: h.variant });
    await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: basah, qty: used, fromLocationId: wip, allowNegative: true, ref, note, date: h.at }, actor);
  }
  if (h.good > 0) {
    const kering = await flowItem(tx, { kind: "kering", key: h.variant });
    await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: kering, qty: h.good, toLocationId: wip, ref, note, date: h.at }, actor);
  }
  return true;
}

async function reverseEntry(tx: Tx, id: string, note: string, actor: Actor) {
  const ref = harvestRef(id);
  const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
  if (!moves.length) return;
  await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, note, actor, { keepDate: true });
  const journals = await tx.journal.findMany({ where: { reversalOfId: null, source: "STOK", sourceId: { in: moves.map((m) => m.id) } } });
  for (const j of journals) await reverseJournal(tx, j.id, await reversalDate(tx, j.date), actor, note);
}

export type HarvestInput = { oven: string; lines: { variant: string; good: number; reject: number }[] };

function validate(input: HarvestInput) {
  if (!(OVENS as readonly string[]).includes(input.oven)) throw new Error("Pilih oven");
  const lines = input.lines.filter((l) => l.good > 0 || l.reject > 0);
  for (const l of lines) {
    if (!VARIANTS.includes(l.variant)) throw new Error("Karakter tidak valid");
    if (![l.good, l.reject].every((x) => Number.isInteger(x) && x >= 0 && x <= 100000)) throw new Error("Jumlah panen tidak valid");
  }
  if (!lines.length) throw new Error("Isi jumlah panen bagus atau reject minimal satu karakter");
  return lines;
}

/** "+ Hasil Panen": satu entri per karakter, langsung diposting ke stok bertanggal jam entri */
export async function addHarvest(reportId: string, input: HarvestInput, actor: Actor, at: Date = new Date()) {
  const lines = validate(input);
  return prisma.$transaction(async (tx) => {
    const r = await lockReport(tx, reportId);
    if (r.division.reportTemplate !== "PRODUKSI") throw new Error("Hasil panen hanya untuk laporan Oven");
    if (r.status !== "DRAFT") throw new Error("Laporan sudah dikirim; entri panen baru tidak bisa ditambahkan");
    const ids: string[] = [];
    let posted = 0;
    for (const l of lines) {
      const h = await tx.shiftHarvest.create({ data: { reportId, oven: input.oven, variant: l.variant, good: l.good, reject: l.reject, at, createdById: actor.id, createdBy: actor.name } });
      if (await postEntry(tx, h, r.division.name, r.date, actor)) {
        await tx.shiftHarvest.update({ where: { id: h.id }, data: { posted: true } });
        posted++;
      }
      ids.push(h.id);
    }
    await syncWork(tx, reportId, r.work);
    await audit(actor, "PANEN_REALTIME", "ShiftReport", reportId, { oven: input.oven, entri: lines, posted }, tx);
    return { ids, posted };
  }, { timeout: 60000 });
}

type Changed = { reportId: string; repost: boolean };

/** Batalkan entri (mutasi pembalik). Sebelum dikirim: pembuat / Owner / Supervisor; sesudahnya Owner/Supervisor + alasan */
async function cancelTx(tx: Tx, id: string, reason: string | null, actor: Actor, label: string): Promise<Changed & { old: { oven: string; variant: string; good: number; reject: number } }> {
  const h = await tx.shiftHarvest.findUniqueOrThrow({ where: { id } });
  const r = await lockReport(tx, h.reportId);
  const fresh = await tx.shiftHarvest.findUniqueOrThrow({ where: { id } });
  if (fresh.cancelledAt) throw new Error("Entri panen sudah dibatalkan");
  const manager = HARVEST_MANAGERS.includes(actor.role ?? "");
  const sent = r.status !== "DRAFT";
  if (sent) {
    if (!manager) throw new Error("Laporan sudah dikirim: koreksi panen hanya oleh Owner/Supervisor");
    if (!reason?.trim()) throw new Error("Alasan wajib diisi");
  } else if (!manager && fresh.createdById !== actor.id) throw new Error("Hanya pembuat entri (atau Owner/Supervisor) yang bisa mengubahnya");
  if (fresh.posted) await reverseEntry(tx, id, `${label} entri panen${reason ? `: ${reason}` : ""}`, actor);
  await tx.shiftHarvest.update({ where: { id }, data: { cancelledAt: new Date(), cancelledBy: actor.name, cancelReason: reason?.trim() || null } });
  return { reportId: h.reportId, repost: sent, old: { oven: fresh.oven, variant: fresh.variant, good: fresh.good, reject: fresh.reject } };
}

/** Laporan yang sudah dikirim: hasil kerja diposting ulang (revisi) agar laporan & stok tetap sama */
async function afterChange(c: Changed, actor: Actor) {
  if (!c.repost) return;
  const { postShiftWork } = await import("./shiftReportFlow");
  await postShiftWork(c.reportId, actor);
}

export async function cancelHarvest(id: string, reason: string | null, actor: Actor) {
  const c = await prisma.$transaction(async (tx) => {
    const res = await cancelTx(tx, id, reason, actor, "Batal");
    const r = await tx.shiftReport.findUniqueOrThrow({ where: { id: res.reportId } });
    await syncWork(tx, res.reportId, r.work);
    await audit(actor, "PANEN_REALTIME_BATAL", "ShiftHarvest", id, { laporan: res.reportId, lama: res.old, alasan: reason }, tx);
    return res;
  }, { timeout: 60000 });
  await afterChange(c, actor);
  return c;
}

/** Koreksi = batalkan entri lama (pembalik) + entri baru (jam entri lama) yang menunjuk entri lama */
export async function correctHarvest(id: string, next: { good: number; reject: number }, reason: string | null, actor: Actor) {
  const c = await prisma.$transaction(async (tx) => {
    const res = await cancelTx(tx, id, reason, actor, "Koreksi");
    const old = await tx.shiftHarvest.findUniqueOrThrow({ where: { id } });
    const r = await tx.shiftReport.findUniqueOrThrow({ where: { id: res.reportId }, include: { division: true } });
    const [line] = validate({ oven: old.oven, lines: [{ variant: old.variant, ...next }] });
    const h = await tx.shiftHarvest.create({ data: { reportId: old.reportId, oven: old.oven, variant: old.variant, good: line.good, reject: line.reject, at: old.at, replacesId: old.id, createdById: old.createdById, createdBy: old.createdBy } });
    if (await postEntry(tx, h, r.division.name, r.date, actor)) await tx.shiftHarvest.update({ where: { id: h.id }, data: { posted: true } });
    await syncWork(tx, res.reportId, r.work);
    await audit(actor, "PANEN_REALTIME_KOREKSI", "ShiftHarvest", id, { laporan: res.reportId, lama: res.old, baru: { good: line.good, reject: line.reject }, alasan: reason, entriBaru: h.id }, tx);
    return { ...res, newId: h.id };
  }, { timeout: 60000 });
  await afterChange(c, actor);
  return c;
}

/** Entri panen laporan (untuk postShiftWork & tampilan) */
export function reportHarvests(reportId: string, db: Tx | typeof prisma = prisma) {
  return db.shiftHarvest.findMany({ where: { reportId }, orderBy: { at: "asc" } });
}
