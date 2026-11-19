import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { COA, reverseJournal, reversalDate } from "./accounting";
import { flowEnabled } from "./shiftReportFlow";
import { locationSettings, recordMovement, reverseMovementsByRef, StockError } from "./stock";
import { recipeMaterialCost } from "./hpp";
import { shiftEndAt } from "./shiftReport";
import { addDays, dateOnly, todayStr } from "./time";
import { SAMPLE_KEY, SAMPLE_SOURCES, isSampleTemplate, type SampleEntry } from "./sampleShared";

export { SAMPLE_KEY, SAMPLE_SOURCES, isSampleTemplate, type SampleEntry } from "./sampleShared";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Isian form: sm.item / sm.qty / sm.source / sm.affiliator / sm.resi / sm.note (baris kosong diabaikan, setengah terisi = error) */
export function parseSamples(getAll: (k: string) => string[]): SampleEntry[] {
  const items = getAll("sm.item"), qtys = getAll("sm.qty"), sources = getAll("sm.source"), affs = getAll("sm.affiliator"), resi = getAll("sm.resi"), notes = getAll("sm.note");
  const out: SampleEntry[] = [];
  items.forEach((itemId, i) => {
    const raw = (qtys[i] ?? "").trim().replace(/\./g, "").replace(",", ".");
    const qty = raw === "" ? 0 : Number(raw);
    const aff = (affs[i] ?? "").trim();
    if (!itemId && !(qty > 0) && !aff) return;
    if (!itemId) throw new Error(`Sample baris ${i + 1}: pilih produknya`);
    if (!Number.isFinite(qty) || !(qty > 0) || !Number.isInteger(qty)) throw new Error(`Sample baris ${i + 1}: isi jumlah (bilangan bulat)`);
    const source = sources[i] ?? "";
    if (!SAMPLE_SOURCES[source]) throw new Error(`Sample baris ${i + 1}: pilih sumber (TikTok/Shopee/Offline)`);
    if (!aff) throw new Error(`Sample baris ${i + 1}: isi nama/username affiliator`);
    out.push({ itemId, qty, source, affiliator: aff.slice(0, 80), trackingNo: (resi[i] ?? "").trim().toUpperCase().slice(0, 40) || null, note: (notes[i] ?? "").trim().slice(0, 200) || null });
  });
  return out;
}

export function storedSamples(work: unknown): SampleEntry[] {
  const raw = work && typeof work === "object" ? (work as Record<string, unknown>)[SAMPLE_KEY] : null;
  return Array.isArray(raw) ? (raw as SampleEntry[]).filter((x) => x?.itemId && x.qty > 0) : [];
}

/**
 * Terapkan sample laporan Packing/Giftbox. Selalu dicatat (AffiliateSample). Bila sakelar "Hasil kerja → stok" menyala: stok produk jadi
 * keluar dan nilainya jadi Beban Promosi & Sample (6-1840), BUKAN HPP penjualan; sample tidak dihitung sebagai resi penjualan.
 * Revisi membalik versi lama (mutasi & jurnal). Aman dipanggil berulang.
 */
export async function applyReportSamples(reportId: string, actor: Actor, now: Date = new Date()): Promise<{ rows: number; posted: number }> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const entries = isSampleTemplate(r.division.reportTemplate) ? storedSamples(r.work) : [];
  const on = await flowEnabled();
  const { finished } = await locationSettings(prisma);
  const at = shiftEndAt(r.date, r.shift, now);
  let posted = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${r.id} FOR UPDATE`;
    await undoSamples(tx, r.id, actor);
    if (!entries.length) return;
    const items = await tx.item.findMany({ where: { id: { in: entries.map((e) => e.itemId) } } });
    const ref = `SMP:${r.id}:${Date.now().toString(36)}`;
    for (const e of entries) {
      const item = items.find((i) => i.id === e.itemId);
      if (!item) throw new StockError("Produk sample tidak ditemukan");
      let unitCost = Number(item.avgCost);
      let didPost = false;
      if (on) {
        if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
        const fb = unitCost > 0 ? 0 : await recipeMaterialCost(item.id);
        const mv = await recordMovement(tx, { type: "PENYESUAIAN", itemId: item.id, qty: e.qty, fromLocationId: finished, increase: false, allowNegative: true, expenseCode: COA.BEBAN_PROMOSI_SAMPLE, fallbackUnitCost: fb > 0 ? { value: fb, note: "harga pokok dari resep" } : null, ref, note: `Sample affiliator ${e.affiliator} (${SAMPLE_SOURCES[e.source]})${e.trackingNo ? ` resi ${e.trackingNo}` : ""}`, date: at }, actor);
        unitCost = Number(mv.unitCost);
        didPost = true;
        posted++;
      }
      await tx.affiliateSample.create({ data: { reportId: r.id, divisionId: r.divisionId, date: r.date, itemId: item.id, qty: new Prisma.Decimal(e.qty), source: e.source, affiliator: e.affiliator, trackingNo: e.trackingNo ?? null, note: e.note ?? null, posted: didPost, ref: didPost ? ref : null, unitCost: BigInt(Math.round(unitCost)), createdBy: actor.name } });
    }
  }, { timeout: 30000 });
  return { rows: entries.length, posted };
}

async function undoSamples(tx: Tx, reportId: string, actor: Actor) {
  const old = await tx.affiliateSample.findMany({ where: { reportId } });
  for (const ref of new Set(old.map((o) => o.ref).filter(Boolean) as string[])) {
    const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, "Revisi laporan shift (sample)", actor, { keepDate: true });
    const journals = await tx.journal.findMany({ where: { reversalOfId: null, source: "STOK", sourceId: { in: moves.map((m) => m.id) } } });
    for (const j of journals) await reverseJournal(tx, j.id, await reversalDate(tx, j.date), actor, "Revisi laporan shift (sample)");
  }
  if (old.length) await tx.affiliateSample.deleteMany({ where: { reportId } });
}

/** Rekap sample per affiliator (periode): jumlah, nilai (HPP × jumlah), per sumber */
export async function sampleRecap(days = 30, now: Date = new Date()) {
  const since = dateOnly(addDays(todayStr(now), -days));
  const rows = await prisma.affiliateSample.findMany({ where: { date: { gte: since } }, orderBy: { date: "desc" } });
  const items = await prisma.item.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.itemId))] } }, select: { id: true, name: true } });
  const by = new Map<string, { affiliator: string; qty: number; value: number; sources: Set<string>; last: Date; lines: { date: Date; item: string; qty: number; source: string; trackingNo: string | null; value: number }[] }>();
  for (const x of rows) {
    const k = x.affiliator.toLowerCase();
    const c = by.get(k) ?? { affiliator: x.affiliator, qty: 0, value: 0, sources: new Set<string>(), last: x.date, lines: [] };
    const v = Number(x.qty) * Number(x.unitCost);
    c.qty += Number(x.qty); c.value += v; c.sources.add(x.source);
    c.lines.push({ date: x.date, item: items.find((i) => i.id === x.itemId)?.name ?? "-", qty: Number(x.qty), source: x.source, trackingNo: x.trackingNo, value: v });
    by.set(k, c);
  }
  const list = [...by.values()].sort((a, b) => b.value - a.value);
  return { list, totalQty: list.reduce((a, x) => a + x.qty, 0), totalValue: list.reduce((a, x) => a + x.value, 0), days };
}
