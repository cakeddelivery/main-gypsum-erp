import { prisma } from "./db";
import { addDays, dateOnly, todayStr } from "./time";
import { isTemplate, plannedFlow, type FlowStep, type StockCountRow, type WorkData } from "./shiftReport";
import { bomStockQty } from "./unitcost";

/**
 * STANDAR PEMAKAIAN.
 *  A. Standar proses (gram gypsum per patung basah, rendemen basah→kering): median 30 hari dari laporan shift (AUTO) atau ditetapkan Owner (MANUAL).
 *  B. Standar bahan pendukung = resep BOM × hasil shift, dibandingkan pemakaian aktual dari stock opname laporan (awal + masuk − sisa hitung).
 */
export const TOLERANCE_PCT = 15;
export const MIN_SAMPLE = 10;
export const GYPSUM_GRAM_PER_SAK = 18000;
export const STD_GYPSUM = "gypsum_gram_per_basah";
export const STD_RENDEMEN = "rendemen_kering_dari_basah";
export const STANDARD_DEFS: Record<string, { label: string; unit: string }> = {
  [STD_GYPSUM]: { label: "Gram gypsum per patung basah", unit: "gram" },
  [STD_RENDEMEN]: { label: "Rendemen patung kering dari patung basah", unit: "%" },
};

// ---------- statistik ----------
export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Median tahan pencilan: buang nilai yang jauh (> 3 × MAD) dari median lalu ambil median lagi */
export function robustMedian(xs: number[]): number | null {
  const m = median(xs);
  if (m == null) return null;
  const mad = median(xs.map((x) => Math.abs(x - m))) ?? 0;
  if (mad === 0) return m;
  const kept = xs.filter((x) => Math.abs(x - m) <= 3 * 1.4826 * mad);
  return median(kept.length ? kept : xs);
}

// ---------- bahan pendukung: standar BOM × hasil ----------
const VARIANT_SKU = (kind: string, key: string) => (kind === "kering" ? `SJ-PTG-${key.toUpperCase()}` : kind === "basah" ? `SJ-CTK-${key.toUpperCase()}` : kind === "giftbox" ? `BJ-GB-${key.toUpperCase()}` : null);

/** Barang hasil satu langkah alur (hanya membaca, tidak membuat barang baru) */
async function stepItemId(s: FlowStep): Promise<string | null> {
  const sku = VARIANT_SKU(s.kind, s.key);
  if (sku) return (await prisma.item.findUnique({ where: { sku }, select: { id: true } }))?.id ?? null;
  if (s.kind === "produk") return (await prisma.product.findUnique({ where: { id: s.key }, select: { finishedItemId: true } }))?.finishedItemId ?? null;
  if (s.kind === "jadi") {
    const VARIANT: Record<string, string> = { Hewan: "HEWAN", Cowok: "COWOK", Transportasi: "TRANSPORTASI", Cewek: "CEWEK" };
    return (await prisma.product.findFirst({ where: { type: "SATUAN", variant: VARIANT[s.key] as never, active: true, finishedItemId: { not: null } }, orderBy: { sku: "asc" }, select: { finishedItemId: true } }))?.finishedItemId ?? null;
  }
  return null;
}

/** Bahan baku/pendukung yang SEHARUSNYA terpakai untuk hasil laporan (resep barang hasil + BOM produknya) */
export async function expectedUsage(reportId: string): Promise<Map<string, number>> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { division: true } });
  const out = new Map<string, number>();
  const template = r.division.reportTemplate;
  if (!isTemplate(template)) return out;
  const steps = plannedFlow(template, r.work as WorkData).filter((s) => s.dir === "in");
  const add = (id: string, q: number) => out.set(id, (out.get(id) ?? 0) + q);
  for (const s of steps) {
    const itemId = await stepItemId(s);
    if (!itemId) continue;
    const [lines, product] = await Promise.all([
      prisma.itemRecipeLine.findMany({ where: { itemId }, include: { component: true } }),
      prisma.product.findFirst({ where: { finishedItemId: itemId }, include: { bom: { include: { item: true } } } }),
    ]);
    for (const l of lines) if (l.component.type === "BAHAN_BAKU") add(l.componentId, bomStockQty(l.qty, l.component) * s.qty);
    for (const b of product?.bom ?? []) if (b.item.type === "BAHAN_BAKU") add(b.itemId, bomStockQty(b.qty, b.item) * s.qty);
  }
  return out;
}

/** Pemakaian aktual bahan dari stock opname laporan: Σ penyesuaian kurang − Σ penyesuaian tambah (ref LAP:<laporan>) */
export async function actualUsage(reportId: string): Promise<Map<string, number>> {
  const moves = await prisma.stockMovement.findMany({ where: { ref: `LAP:${reportId}`, type: "PENYESUAIAN" }, select: { itemId: true, qty: true, fromLocationId: true, toLocationId: true } });
  const out = new Map<string, number>();
  for (const m of moves) out.set(m.itemId, (out.get(m.itemId) ?? 0) + (m.fromLocationId && !m.toLocationId ? Number(m.qty) : -Number(m.qty)));
  return out;
}

export type UsageRow = { itemId: string; name: string; unit: string; standard: number; actual: number; ratio: number | null; overPct: number | null; over: boolean; valueOver: number };

/**
 * Pemakaian vs standar per bahan untuk satu laporan. over = pemakaian aktual melebihi standar lebih dari toleransi (bawaan 15%).
 * Bahan yang punya standar tetapi tidak dihitung di laporan: actual = 0 dan ditandai notCounted oleh pemanggil bila perlu.
 */
export async function usageCheck(reportId: string, tolerancePct = TOLERANCE_PCT): Promise<UsageRow[]> {
  const [exp, act] = await Promise.all([expectedUsage(reportId), actualUsage(reportId)]);
  const ids = [...new Set([...exp.keys(), ...act.keys()])];
  if (!ids.length) return [];
  const items = await prisma.item.findMany({ where: { id: { in: ids }, type: "BAHAN_BAKU" } });
  const rows: UsageRow[] = items.map((it) => {
    const standard = Math.round((exp.get(it.id) ?? 0) * 1000) / 1000;
    const actual = Math.round((act.get(it.id) ?? 0) * 1000) / 1000;
    const ratio = standard > 0 ? actual / standard : null;
    const overPct = ratio == null ? null : Math.round((ratio - 1) * 1000) / 10;
    const over = standard > 0 && actual > standard * (1 + tolerancePct / 100);
    return { itemId: it.id, name: it.name, unit: it.unit, standard, actual, ratio, overPct, over, valueOver: over ? Math.round((actual - standard) * Number(it.avgCost)) : 0 };
  });
  return rows.filter((x) => x.standard > 0 || x.actual > 0).sort((a, b) => Number(b.over) - Number(a.over) || a.name.localeCompare(b.name, "id"));
}

// ---------- standar proses (AUTO / MANUAL) ----------
export async function computeAutoStandards(days = 30, now: Date = new Date()) {
  const since = dateOnly(addDays(todayStr(now), -days));
  const reports = await prisma.shiftReport.findMany({ where: { date: { gte: since }, status: { in: ["TERKIRIM", "DIREVISI"] } }, include: { division: true } });
  const gypsum = await prisma.item.findMany({ where: { type: "BAHAN_BAKU", active: true, name: { contains: "gypsum", mode: "insensitive" } }, select: { id: true, hppUnit: true, hppFactor: true } });
  const gypsumIds = new Set(gypsum.map((g) => g.id));
  const gramPerSak = (id: string) => {
    const g = gypsum.find((x) => x.id === id);
    return g && g.hppUnit && /gram|gr/i.test(g.hppUnit) && Number(g.hppFactor) > 1 ? Number(g.hppFactor) : GYPSUM_GRAM_PER_SAK;
  };
  const gram: number[] = [];
  const rend: number[] = [];
  for (const r of reports) {
    const template = r.division.reportTemplate;
    if (!isTemplate(template)) continue;
    const steps = plannedFlow(template, r.work as WorkData);
    const basahIn = steps.filter((s) => s.kind === "basah" && s.dir === "in").reduce((a, s) => a + s.qty, 0);
    const basahOut = steps.filter((s) => s.kind === "basah" && s.dir === "out").reduce((a, s) => a + s.qty, 0);
    const keringIn = steps.filter((s) => s.kind === "kering" && s.dir === "in").reduce((a, s) => a + s.qty, 0);
    if (basahIn > 0 && gypsumIds.size) {
      const act = await actualUsage(r.id);
      const sak = [...act].filter(([id]) => gypsumIds.has(id)).reduce((a, [id, q]) => a + q * gramPerSak(id), 0);
      if (sak > 0) gram.push(sak / basahIn);
    }
    if (basahOut > 0 && keringIn > 0) rend.push((keringIn / basahOut) * 100);
  }
  return [
    { key: STD_GYPSUM, value: gram.length >= MIN_SAMPLE ? robustMedian(gram) : null, sample: gram.length },
    { key: STD_RENDEMEN, value: rend.length >= MIN_SAMPLE ? robustMedian(rend) : null, sample: rend.length },
  ];
}

/** Hitung ulang standar AUTO dan simpan (mode MANUAL tidak berubah, hanya nilai otomatisnya diperbarui) */
export async function refreshStandards(days = 30, now: Date = new Date()) {
  const rows = await computeAutoStandards(days, now);
  for (const x of rows) {
    const def = STANDARD_DEFS[x.key];
    const data = { autoValue: x.value, sampleCount: x.sample, computedAt: now };
    await prisma.usageStandard.upsert({ where: { key: x.key }, create: { key: x.key, label: def.label, unit: def.unit, ...data }, update: data });
  }
  return rows;
}

export type StandardView = { key: string; label: string; unit: string; mode: string; auto: number | null; manual: number | null; effective: number | null; sample: number; enough: boolean };
export async function listStandards(): Promise<StandardView[]> {
  const rows = await prisma.usageStandard.findMany();
  return Object.entries(STANDARD_DEFS).map(([key, def]) => {
    const r = rows.find((x) => x.key === key);
    const auto = r?.autoValue != null ? Number(r.autoValue) : null;
    const manual = r?.manualValue != null ? Number(r.manualValue) : null;
    const mode = r?.mode ?? "AUTO";
    const effective = mode === "MANUAL" && manual != null ? manual : auto;
    return { key, label: def.label, unit: def.unit, mode, auto, manual, effective, sample: r?.sampleCount ?? 0, enough: (r?.sampleCount ?? 0) >= MIN_SAMPLE };
  });
}

/** Owner menetapkan nilai manual (menimpa AUTO); value null/kembali = otomatis lagi */
export async function setStandard(key: string, input: { mode: "AUTO" | "MANUAL"; value?: number | null }, actor: { name: string }) {
  const def = STANDARD_DEFS[key];
  if (!def) throw new Error("Standar tidak dikenal");
  if (input.mode === "MANUAL" && !(Number(input.value) > 0)) throw new Error("Isi nilai standar lebih dari 0");
  const data = { mode: input.mode, manualValue: input.mode === "MANUAL" ? input.value! : null, pinnedBy: input.mode === "MANUAL" ? actor.name : null };
  await prisma.usageStandard.upsert({ where: { key }, create: { key, label: def.label, unit: def.unit, ...data }, update: data });
}

// ---------- barang belum terpantau ----------
/** Barang aktif bahan baku tanpa divisi pemilik, atau yang tidak pernah dihitung di laporan divisinya selama N hari */
export async function unmonitoredItems(days = 30, now: Date = new Date()) {
  const since = dateOnly(addDays(todayStr(now), -days));
  const [items, reports] = await Promise.all([
    prisma.item.findMany({ where: { active: true, type: "BAHAN_BAKU" }, select: { id: true, name: true, unit: true, divisionId: true, division: { select: { name: true } } }, orderBy: { name: "asc" } }),
    prisma.shiftReport.findMany({ where: { date: { gte: since }, status: { in: ["TERKIRIM", "DIREVISI"] } }, select: { stockCount: true } }),
  ]);
  const counted = new Set(reports.flatMap((r) => (r.stockCount as StockCountRow[]).filter((x) => x.qty != null).map((x) => x.itemId)));
  return items.filter((i) => !i.divisionId || !counted.has(i.id)).map((i) => ({ id: i.id, name: i.name, unit: i.unit, division: i.division?.name ?? null, reason: i.divisionId ? ("TIDAK_DIHITUNG" as const) : ("TANPA_DIVISI" as const) }));
}
