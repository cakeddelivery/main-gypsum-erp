import { prisma } from "./db";
import { VARIANTS, TEMPLATES, colTotals, gridRows, isTemplate, sectionTotal, summaryOf, type ReportTemplate, type WorkData } from "./shiftReport";
import { dateOnly } from "./time";
import { stockBalances } from "./stock";

/**
 * Alur Produksi (tahap yang berlaku sekarang): angka dibaca dari LAPORAN SHIFT (hasil kerja per divisi) + BORONGAN (KRM/AMB),
 * bukan dari input terpisah. Memakai fungsi hitung laporan yang sama dengan detail hasil kerja, sehingga angkanya selalu sama.
 *   Cetak → Oven → Assembling/Borongan & Cat → Packing & Giftbox
 */
export type BoxKey = "CETAK" | "OVEN" | "BORONGAN" | "PACKING" | "GIFTBOX";
export const BOX_LABEL: Record<BoxKey, string> = { CETAK: "Cetak", OVEN: "Oven", BORONGAN: "Assembling / Borongan & Cat", PACKING: "Packing", GIFTBOX: "Giftbox" };
export const BOX_ORDER: BoxKey[] = ["CETAK", "OVEN", "BORONGAN", "PACKING", "GIFTBOX"];

export type BoxSource = { label: string; href: string; detail?: string };
export type AlurBox = {
  key: BoxKey;
  label: string;
  unit: string;
  good: number;
  reject: number;
  /** Rincian per karakter (patung) bila ada */
  byVariant: Record<string, number>;
  extras: { label: string; value: string }[];
  /** Stok di tahap ini (null = tidak dipantau di tahap ini) */
  stock: number | null;
  /** Sumber angka: laporan shift / kiriman / setoran untuk tanggal & filter yang dipilih */
  sources: BoxSource[];
  /** Penjelasan sumber ("Laporan shift", "KRM + AMB") */
  from: string;
};

type Report = { id: string; template: ReportTemplate; work: WorkData; division: string; shift: string; divisionId: string };
const num = (n: number) => n.toLocaleString("id-ID");

/** Total patung cetak (per karakter) dari grid "cetakSeries" satu laporan */
export function cetakOf(r: Pick<Report, "template" | "work">) {
  const t = TEMPLATES[r.template];
  const s = t.sections.find((x) => x.key === "cetakSeries");
  if (!s || s.kind !== "grid") return { total: 0, byVariant: {} as Record<string, number> };
  const cols = colTotals(gridRows(r.work, s), s.cols.length);
  const byVariant = Object.fromEntries(VARIANTS.map((v, i) => [v, cols[i] ?? 0]));
  return { total: cols.reduce((a, b) => a + b, 0), byVariant };
}

export function ovenOf(r: Pick<Report, "template" | "work">) {
  const t = TEMPLATES[r.template];
  const panen = t.sections.find((x) => x.key === "panen");
  const byVariant: Record<string, number> = {};
  if (panen && panen.kind === "grid") colTotals(gridRows(r.work, panen), panen.cols.length).forEach((q, i) => (byVariant[VARIANTS[i]] = q));
  return { good: sectionTotal(t, r.work, "panen"), reject: sectionTotal(t, r.work, "reject"), byVariant };
}

const summaryValue = (r: Pick<Report, "template" | "work">, label: string) => summaryOf(r.template, r.work).find((s) => s.label === label)?.value ?? 0;
export const packingOf = (r: Pick<Report, "template" | "work">) => ({ patung: summaryValue(r, "Total patung"), resi: summaryValue(r, "Total resi") });
export const giftboxOf = (r: Pick<Report, "template" | "work">) => ({ box: summaryValue(r, "Total giftbox"), patung: summaryValue(r, "Total patung"), resi: summaryValue(r, "Total resi") });

/** Kelompok tugas borongan menurut nama: Cat Giftbox, Cat Plastik, selain itu Assembling (Single Pack) */
export function taskGroup(name: string): "CAT_GIFTBOX" | "CAT_PLASTIK" | "ASSEMBLING" {
  if (/giftbox/i.test(name) && /cat/i.test(name)) return "CAT_GIFTBOX";
  if (/cat/i.test(name)) return "CAT_PLASTIK";
  return "ASSEMBLING";
}

export type AlurFilter = { date: string; shiftId?: string | null; divisionId?: string | null };

export async function alurProduksi(f: AlurFilter): Promise<AlurBox[]> {
  const date = dateOnly(f.date);
  const rows = await prisma.shiftReport.findMany({
    where: { date, status: { not: "DRAFT" }, ...(f.shiftId ? { shiftId: f.shiftId } : {}), ...(f.divisionId ? { divisionId: f.divisionId } : {}) },
    include: { division: { select: { name: true, reportTemplate: true } }, shift: { select: { name: true } } },
    orderBy: [{ divisionId: "asc" }, { shiftId: "asc" }],
  });
  const reports: Report[] = rows.filter((r) => isTemplate(r.division.reportTemplate)).map((r) => ({ id: r.id, template: r.division.reportTemplate as ReportTemplate, work: r.work as WorkData, division: r.division.name, shift: r.shift.name, divisionId: r.divisionId }));
  const src = (r: Report, detail: string): BoxSource => ({ label: `${r.division} · ${r.shift}`, href: `/laporan/${r.id}`, detail });

  // Stok per tahap (semua lokasi): patung cetak, patung kering, barang jadi satuan/paket, giftbox
  const items = await prisma.item.findMany({ where: { OR: [{ sku: { startsWith: "SJ-CTK-" } }, { sku: { startsWith: "SJ-PTG-" } }, { type: "BARANG_JADI" }] }, select: { id: true, sku: true, unit: true } });
  const bal = await stockBalances();
  const stockOf = (pred: (i: (typeof items)[number]) => boolean) => items.filter(pred).reduce((a, i) => a + bal.filter((b) => b.itemId === i.id).reduce((s, b) => s + b.qty, 0), 0);

  const boxes: Record<BoxKey, AlurBox> = Object.fromEntries(
    BOX_ORDER.map((k) => [k, { key: k, label: BOX_LABEL[k], unit: k === "GIFTBOX" ? "box" : "pcs", good: 0, reject: 0, byVariant: {}, extras: [], stock: null, sources: [], from: k === "BORONGAN" ? "KRM + AMB (menu Borongan)" : "Laporan shift" } as AlurBox]),
  ) as Record<BoxKey, AlurBox>;
  const add = (to: Record<string, number>, from: Record<string, number>) => { for (const [k, v] of Object.entries(from)) to[k] = (to[k] ?? 0) + v; };

  for (const r of reports) {
    if (r.template === "CETAK" || r.template === "PRODUKSI") {
      const c = cetakOf(r);
      if (c.total > 0 || r.template === "CETAK") {
        boxes.CETAK.good += c.total;
        add(boxes.CETAK.byVariant, c.byVariant);
        boxes.CETAK.sources.push(src(r, `${num(c.total)} pcs`));
      }
    }
    if (r.template === "PRODUKSI") {
      const o = ovenOf(r);
      boxes.OVEN.good += o.good;
      boxes.OVEN.reject += o.reject;
      add(boxes.OVEN.byVariant, o.byVariant);
      boxes.OVEN.sources.push(src(r, `${num(o.good)} pcs · reject ${num(o.reject)}`));
    }
    if (r.template === "PACKING") {
      const p = packingOf(r);
      boxes.PACKING.good += p.patung;
      boxes.PACKING.sources.push(src(r, `${num(p.patung)} pcs · ${num(p.resi)} resi`));
    }
    if (r.template === "GIFTBOX") {
      const g = giftboxOf(r);
      boxes.GIFTBOX.good += g.box;
      boxes.GIFTBOX.sources.push(src(r, `${num(g.box)} box · ${num(g.resi)} resi`));
    }
  }

  // Resi & sample per tahap (laporan Packing/Giftbox)
  const resiOf = (t: ReportTemplate) => reports.filter((r) => r.template === t).reduce((a, r) => a + summaryValue(r, "Total resi"), 0);
  const samples = await prisma.affiliateSample.findMany({ where: { reportId: { in: reports.map((r) => r.id) } }, select: { reportId: true, qty: true } });
  const sampleOf = (t: ReportTemplate) => samples.filter((s) => reports.find((r) => r.id === s.reportId)?.template === t).reduce((a, s) => a + Number(s.qty), 0);
  boxes.PACKING.extras.push({ label: "Resi", value: num(resiOf("PACKING")) }, { label: "Sample", value: `${num(sampleOf("PACKING"))} pcs` });
  boxes.GIFTBOX.extras.push({ label: "Resi", value: num(resiOf("GIFTBOX")) }, { label: "Sample", value: `${num(sampleOf("GIFTBOX"))} pcs` }, { label: "Patung", value: `${num(reports.filter((r) => r.template === "GIFTBOX").reduce((a, r) => a + giftboxOf(r).patung, 0))} pcs` });

  // LPG per patung (Oven): tabung habis dari status LPG laporan Oven ÷ patung kering
  const lpg = await prisma.lpgState.findMany({ where: { reportId: { in: reports.filter((r) => r.template === "PRODUKSI").map((r) => r.id) } }, select: { habis: true, dipasang: true } });
  const habis = lpg.reduce((a, l) => a + l.habis, 0);
  boxes.OVEN.extras.push({ label: "LPG", value: lpg.length ? `${num(habis)} tabung habis${boxes.OVEN.good ? ` · ${(Math.round((habis / boxes.OVEN.good) * 1000 * 10) / 10).toLocaleString("id-ID")} per 1.000 patung` : ""}` : "belum dilaporkan" });

  // Borongan (tidak terikat shift): KRM dikirim, setoran AMB diterima, hasil per kelompok tugas
  const brgDivision = f.divisionId ? (await prisma.division.findUnique({ where: { id: f.divisionId }, select: { reportTemplate: true } }))?.reportTemplate === "ASSEMBLING" : true;
  if (!f.shiftId && brgDivision) {
    const [ships, results, pickups] = await Promise.all([
      prisma.boronganShipment.findMany({ where: { date, cancelledAt: null }, select: { id: true, number: true, tasks: { select: { qty: true } } } }),
      prisma.boronganResult.findMany({ where: { date }, select: { qty: true, reject: true, task: { select: { name: true } }, pickup: { select: { id: true, number: true } } } }),
      prisma.boronganPickup.findMany({ where: { date, status: { not: "DIBATALKAN" } }, select: { id: true, number: true, shipmentId: true } }),
    ]);
    const sent = ships.reduce((a, s) => a + s.tasks.reduce((x, t) => x + t.qty, 0), 0);
    const grp = { ASSEMBLING: 0, CAT_PLASTIK: 0, CAT_GIFTBOX: 0 };
    for (const r of results) {
      grp[taskGroup(r.task.name)] += r.qty;
      boxes.BORONGAN.reject += r.reject;
    }
    boxes.BORONGAN.good = results.reduce((a, r) => a + r.qty, 0);
    boxes.BORONGAN.extras.push({ label: "Dikirim (KRM)", value: `${num(sent)} pcs` }, { label: "Single Pack (Assembling)", value: `${num(grp.ASSEMBLING)} pcs` }, { label: "Cat Plastik", value: `${num(grp.CAT_PLASTIK)} pcs` }, { label: "Cat Giftbox", value: `${num(grp.CAT_GIFTBOX)} pcs` }, { label: "Setoran (AMB)", value: `${pickups.length} pengambilan` });
    for (const s of ships) boxes.BORONGAN.sources.push({ label: s.number, href: `/borongan/riwayat/${s.id}`, detail: `dikirim ${num(s.tasks.reduce((x, t) => x + t.qty, 0))} pcs` });
    for (const p of pickups) boxes.BORONGAN.sources.push({ label: p.number, href: `/borongan/riwayat/${p.shipmentId}`, detail: "setoran" });
  }

  boxes.CETAK.stock = stockOf((i) => i.sku.startsWith("SJ-CTK-"));
  boxes.OVEN.stock = stockOf((i) => i.sku.startsWith("SJ-PTG-"));
  boxes.PACKING.stock = stockOf((i) => i.unit !== "box" && i.sku.startsWith("BJ-") === true);
  boxes.GIFTBOX.stock = stockOf((i) => i.unit === "box");
  return BOX_ORDER.map((k) => boxes[k]);
}
