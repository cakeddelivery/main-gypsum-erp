import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { COA, reverseJournal, reversalDate } from "./accounting";
import { flowEnabled } from "./shiftReportFlow";
import { locationSettings, recordMovement, reverseMovementsByRef, StockError } from "./stock";
import { recipeMaterialCost } from "./hpp";
import { shiftEndAt } from "./shiftReport";
import { addDays, dateOnly, todayStr } from "./time";
import { SAMPLE_KEY, SAMPLE_PLATFORMS, isSampleTemplate, sampleRowEmpty, sampleRowIssue, type SampleEntry } from "./sampleShared";

export { SAMPLE_KEY, SAMPLE_PLATFORMS, isSampleTemplate, sampleRowEmpty, sampleRowIssue, type SampleEntry, type SampleRow } from "./sampleShared";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Isian form: sm.item / sm.qty / sm.platform / sm.store (baris kosong diabaikan, setengah terisi = error) */
/** lenient (simpan draf): baris yang terisi sebagian dilewati, bukan error; saat kirim tetap diperiksa */
export function parseSamples(getAll: (k: string) => string[], opts: { lenient?: boolean } = {}): SampleEntry[] {
  const items = getAll("sm.item"), qtys = getAll("sm.qty"), platforms = getAll("sm.platform"), stores = getAll("sm.store");
  const out: SampleEntry[] = [];
  items.forEach((itemId, i) => {
    const row = { itemId, qty: qtys[i] ?? "", platform: platforms[i] ?? "", storeId: stores[i] ?? "" };
    if (sampleRowEmpty(row)) return; // baris kosong diabaikan
    const issue = sampleRowIssue(row);
    if (issue) {
      if (opts.lenient) return;
      throw new Error(`Sample baris ${i + 1}: ${issue}`);
    }
    out.push({ itemId, qty: Number(row.qty.trim().replace(/\./g, "").replace(",", ".")), platform: row.platform, storeId: row.storeId });
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
    const stores = await tx.store.findMany({ where: { id: { in: entries.map((e) => e.storeId) } }, select: { id: true, name: true } });
    const storeName = new Map(stores.map((x) => [x.id, x.name]));
    for (const e of entries) if (!storeName.has(e.storeId)) throw new StockError("Toko sample tidak ditemukan");
    const ref = `SMP:${r.id}:${Date.now().toString(36)}`;
    for (const e of entries) {
      const item = items.find((i) => i.id === e.itemId);
      if (!item) throw new StockError("Produk sample tidak ditemukan");
      let unitCost = Number(item.avgCost);
      let didPost = false;
      if (on) {
        if (!finished) throw new StockError("Lokasi gudang barang jadi belum diatur di Pengaturan");
        const fb = unitCost > 0 ? 0 : await recipeMaterialCost(item.id);
        const mv = await recordMovement(tx, { type: "PENYESUAIAN", itemId: item.id, qty: e.qty, fromLocationId: finished, increase: false, allowNegative: true, expenseCode: COA.BEBAN_PROMOSI_SAMPLE, fallbackUnitCost: fb > 0 ? { value: fb, note: "harga pokok dari resep" } : null, ref, note: `Sample affiliator ${SAMPLE_PLATFORMS[e.platform]} · ${storeName.get(e.storeId) ?? "toko"}`, date: at }, actor);
        unitCost = Number(mv.unitCost);
        didPost = true;
        posted++;
      }
      await tx.affiliateSample.create({ data: { reportId: r.id, divisionId: r.divisionId, date: r.date, itemId: item.id, qty: new Prisma.Decimal(e.qty), platform: e.platform, storeId: e.storeId, posted: didPost, ref: didPost ? ref : null, unitCost: BigInt(Math.round(unitCost)), createdBy: actor.name } });
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

/** Rekap sample per platform & toko (periode): jumlah, nilai (HPP × jumlah), rincian produk */
export async function sampleRecap(days = 30, now: Date = new Date()) {
  const since = dateOnly(addDays(todayStr(now), -days));
  const rows = await prisma.affiliateSample.findMany({ where: { date: { gte: since } }, orderBy: { date: "desc" } });
  const [items, stores] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.itemId))] } }, select: { id: true, name: true } }),
    prisma.store.findMany({ select: { id: true, name: true } }),
  ]);
  const by = new Map<string, { platform: string; storeId: string; store: string; qty: number; value: number; lines: { date: Date; item: string; qty: number; value: number }[] }>();
  for (const x of rows) {
    const k = `${x.platform}|${x.storeId}`;
    const c = by.get(k) ?? { platform: x.platform, storeId: x.storeId, store: stores.find((s) => s.id === x.storeId)?.name ?? "-", qty: 0, value: 0, lines: [] };
    const v = Number(x.qty) * Number(x.unitCost);
    c.qty += Number(x.qty); c.value += v;
    c.lines.push({ date: x.date, item: items.find((i) => i.id === x.itemId)?.name ?? "-", qty: Number(x.qty), value: v });
    by.set(k, c);
  }
  const list = [...by.values()].sort((a, b) => b.value - a.value);
  return { list, totalQty: list.reduce((a, x) => a + x.qty, 0), totalValue: list.reduce((a, x) => a + x.value, 0), days };
}
