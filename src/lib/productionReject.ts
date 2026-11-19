import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { COA, reverseJournal, reversalDate } from "./accounting";
import { flowEnabled } from "./shiftReportFlow";
import { locationSettings, recordMovement, reverseMovementsByRef, StockError } from "./stock";
import { shiftEndAt } from "./shiftReport";
import { REJECT_REASONS, REJECT_STAGE_LABEL, stageOfTemplate } from "./rejectShared";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Kunci data reject di laporan (work._reject = [{itemId, qty, reason, note}]) */
export const REJECT_KEY = "_reject";

export { REJECT_STAGES, REJECT_STAGE_LABEL, REJECT_REASONS, stageOfTemplate, type RejectStage } from "./rejectShared";

export type RejectEntry = { itemId: string; qty: number; reason: string; note?: string | null };

/** Baca isian form: rj.item / rj.qty / rj.reason / rj.note (baris kosong diabaikan, baris setengah terisi = error) */
export function parseRejects(getAll: (k: string) => string[]): RejectEntry[] {
  const items = getAll("rj.item"), qtys = getAll("rj.qty"), reasons = getAll("rj.reason"), notes = getAll("rj.note");
  const out: RejectEntry[] = [];
  items.forEach((itemId, i) => {
    const raw = (qtys[i] ?? "").trim().replace(/\./g, "").replace(",", ".");
    const qty = raw === "" ? 0 : Number(raw);
    if (!itemId && !(qty > 0)) return;
    if (!itemId) throw new Error(`Reject baris ${i + 1}: pilih barangnya`);
    if (!Number.isFinite(qty) || !(qty > 0)) throw new Error(`Reject baris ${i + 1}: isi jumlahnya`);
    const reason = reasons[i] ?? "";
    if (!REJECT_REASONS[reason]) throw new Error(`Reject baris ${i + 1}: pilih alasannya`);
    out.push({ itemId, qty: Math.round(qty * 1000) / 1000, reason, note: (notes[i] ?? "").trim().slice(0, 200) || null });
  });
  return out;
}

export function storedRejects(work: unknown): RejectEntry[] {
  const raw = work && typeof work === "object" ? (work as Record<string, unknown>)[REJECT_KEY] : null;
  return Array.isArray(raw) ? (raw as RejectEntry[]).filter((r) => r?.itemId && r.qty > 0) : [];
}

/**
 * Terapkan reject laporan shift. Daftar reject selalu disimpan di tabel (ProductionReject) sebagai catatan per tahap.
 * Bila sakelar "Hasil kerja → stok" menyala: stok barang itu keluar (setengah jadi dari gudang setengah jadi, produk jadi dari gudang jadi)
 * dan nilainya langsung jadi Beban Reject Produksi (6-1830). Revisi: versi lama dibalik (mutasi & jurnal), lalu versi baru diposting.
 * Aman dipanggil berulang untuk laporan yang sama.
 */
export async function applyReportRejects(reportId: string, actor: Actor, now: Date = new Date()): Promise<{ rows: number; posted: number }> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const stage = stageOfTemplate(r.division.reportTemplate);
  const entries = storedRejects(r.work);
  const on = await flowEnabled();
  const locs = await locationSettings(prisma);
  const at = shiftEndAt(r.date, r.shift, now);
  let posted = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${r.id} FOR UPDATE`;
    await undoRejects(tx, r.id, actor);
    if (!entries.length) return;
    if (!stage) throw new StockError("Divisi ini belum punya format laporan, reject tidak bisa dicatat");
    const ref = `RJK:${r.id}:${Date.now().toString(36)}`;
    const items = await tx.item.findMany({ where: { id: { in: entries.map((e) => e.itemId) } } });
    for (const e of entries) {
      const item = items.find((i) => i.id === e.itemId);
      if (!item) throw new StockError("Barang reject tidak ditemukan");
      let postedRow = false;
      let unitCost = Number(item.avgCost);
      if (on) {
        const loc = item.type === "BARANG_DALAM_PROSES" ? locs.wip : item.type === "BARANG_JADI" ? locs.finished : locs.raw;
        if (!loc) throw new StockError("Lokasi gudang belum diatur di Pengaturan");
        const mv = await recordMovement(tx, { type: "PENYESUAIAN", itemId: item.id, qty: e.qty, fromLocationId: loc, increase: false, allowNegative: true, expenseCode: COA.BEBAN_REJECT_PRODUKSI, ref, note: `Reject ${REJECT_STAGE_LABEL[stage]} (${REJECT_REASONS[e.reason]}) ${r.division.name} ${r.shift.name}`, date: at }, actor);
        unitCost = Number(mv.unitCost);
        postedRow = true;
        posted++;
      }
      await tx.productionReject.create({ data: { reportId: r.id, divisionId: r.divisionId, stage, itemId: item.id, qty: new Prisma.Decimal(e.qty), reason: e.reason, note: e.note ?? null, posted: postedRow, ref: postedRow ? ref : null, unitCost: BigInt(Math.round(unitCost)), createdBy: actor.name } });
    }
  }, { timeout: 30000 });
  return { rows: entries.length, posted };
}

/** Batalkan reject lama laporan: mutasi stok & jurnal beban dibalik, baris dihapus */
async function undoRejects(tx: Tx, reportId: string, actor: Actor) {
  const old = await tx.productionReject.findMany({ where: { reportId } });
  for (const ref of new Set(old.map((o) => o.ref).filter(Boolean) as string[])) {
    const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, "Revisi laporan shift (reject)", actor, { keepDate: true });
    const journals = await tx.journal.findMany({ where: { reversalOfId: null, source: "STOK", sourceId: { in: moves.map((m) => m.id) } } });
    for (const j of journals) await reverseJournal(tx, j.id, await reversalDate(tx, j.date), actor, "Revisi laporan shift (reject)");
  }
  if (old.length) await tx.productionReject.deleteMany({ where: { reportId } });
}

/** Ringkasan reject per tahap & alasan untuk periode (halaman/alert tahap berikutnya) */
export async function rejectSummary(from: Date, to: Date) {
  const rows = await prisma.productionReject.findMany({ where: { createdAt: { gte: from, lt: to } } });
  const out = new Map<string, { stage: string; reason: string; qty: number; value: number }>();
  for (const x of rows) {
    const k = `${x.stage}|${x.reason}`;
    const cur = out.get(k) ?? { stage: x.stage, reason: x.reason, qty: 0, value: 0 };
    cur.qty += Number(x.qty);
    cur.value += Number(x.qty) * Number(x.unitCost);
    out.set(k, cur);
  }
  return [...out.values()];
}

