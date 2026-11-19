import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { FLOW_SETTING } from "./shiftReportFlow";
import { resultCountStatus, type ResultRow } from "./shiftResultCount";
import { locationSettings } from "./stock";
import { addDays, dateOnly, todayStr } from "./time";

/**
 * Selisih stok aplikasi vs stok akhir laporan shift (HANYA MEMBACA): per divisi & laporan, barang setengah jadi / jadi yang
 * dihitung di laporan dibanding stok sistem pada jam selesai shift, plus ringkasan mutasi per jenis (ref) pada periode itu,
 * termasuk mutasi borongan (KRM/BGI/HSB/PND/AMB) agar terlihat dari mana selisih berasal.
 */
export type GapRow = ResultRow & { reportId: string; division: string; date: string; shift: string };
export type FlowRow = { itemId: string; item: string; division: string | null; kind: string; count: number; masukWip: number; keluarWip: number };

const KIND_LABEL: Record<string, string> = {
  KRM: "Kiriman borongan (KRM)", BGI: "Pembagian ke pekerja (BGI)", HSB: "Hasil/pakai di titik (HSB)", PND: "Penerimaan divisi dari titik (PND)", AMB: "Ambil setoran (AMB)", SRT: "Serah terima (SRT)",
  LPH: "Hasil kerja laporan shift (LPH)", LPS: "Stok akhir laporan shift (LPS)", PRD: "Produksi manual (PRD)", RTR: "Retur (RTR)", AWAL: "Stok awal", JUAL: "Penjualan",
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? (k === "-" ? "Tanpa ref" : k);

export async function stockGapReport(days = 14, now: Date = new Date()) {
  const from = addDays(todayStr(now), -days);
  const setting = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
  const locs = await locationSettings(prisma);
  const reports = await prisma.shiftReport.findMany({
    where: { date: { gte: dateOnly(from) }, status: { in: ["TERKIRIM", "DIREVISI"] } },
    include: { shift: true, division: true },
    orderBy: [{ date: "asc" }, { division: { name: "asc" } }],
  });
  const rows: GapRow[] = [];
  for (const r of reports) {
    const st = await resultCountStatus(r.id, now);
    for (const x of st?.rows ?? []) rows.push({ ...x, reportId: r.id, division: r.division.name, date: r.date.toISOString().slice(0, 10), shift: r.shift.name });
  }
  const locIds = [locs.wip, locs.finished].filter(Boolean) as string[];
  let flows: FlowRow[] = [];
  if (locIds.length) {
    const since = new Date(`${from}T00:00:00+07:00`);
    const raw = await prisma.$queryRaw<{ itemId: string; kind: string; count: bigint; masuk: Prisma.Decimal; keluar: Prisma.Decimal }[]>`
      SELECT m."itemId", COALESCE(NULLIF(regexp_replace(COALESCE(m.ref, ''), '[:\\-].*$', ''), ''), '-') AS kind, COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN m."toLocationId" = ANY(${locIds}) THEN m.qty ELSE 0 END), 0) AS masuk,
        COALESCE(SUM(CASE WHEN m."fromLocationId" = ANY(${locIds}) THEN m.qty ELSE 0 END), 0) AS keluar
      FROM "StockMovement" m JOIN "Item" i ON i.id = m."itemId"
      WHERE m.date >= ${since} AND i.type IN ('BARANG_DALAM_PROSES', 'BARANG_JADI') AND (m."toLocationId" = ANY(${locIds}) OR m."fromLocationId" = ANY(${locIds}))
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const items = await prisma.item.findMany({ where: { id: { in: [...new Set(raw.map((x) => x.itemId))] } }, select: { id: true, name: true, division: { select: { name: true } } } });
    flows = raw.map((x) => {
      const it = items.find((i) => i.id === x.itemId);
      return { itemId: x.itemId, item: it?.name ?? x.itemId, division: it?.division?.name ?? null, kind: x.kind, count: Number(x.count), masukWip: Number(x.masuk), keluarWip: Number(x.keluar) };
    }).sort((a, b) => (a.division ?? "~").localeCompare(b.division ?? "~", "id") || a.item.localeCompare(b.item, "id"));
  }
  return { setting, settingOn: setting === "true", from, days, rows, flows, reportsChecked: reports.length };
}
