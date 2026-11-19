import { prisma } from "./db";
import { sendPush } from "./push";
import { negativeStock } from "./stock";
import { addDays, dateOnly, todayStr } from "./time";
import { bigDiff } from "./shiftResultCount";
import { lpgSummary } from "./lpg";
import { unmonitoredItems, usageCheck, TOLERANCE_PCT } from "./usageStandard";

/**
 * ALERT ANOMALI stok & produksi (Owner, Supervisor, Finance): neraca selisih, pemakaian > standar, reject di atas normal, stok minus,
 * barang tidak bergerak (slow/dead stock), prakiraan habis, LPG, rantai putus, belum terpantau. Dideteksi harian (dan setelah laporan dikirim),
 * dedupe per jenis + ruang lingkup + tanggal, TINGGI dikirim push.
 */
export type Severity = "RENDAH" | "SEDANG" | "TINGGI";
export type Found = { type: string; scope: string; severity: Severity; title: string; detail?: string; value?: number; divisionId?: string | null; itemId?: string | null; reportId?: string | null };

export const ANOMALY_LABEL: Record<string, { label: string; hint: string }> = {
  NERACA_SELISIH: { label: "Selisih neraca stok", hint: "Stok hitung fisik lebih sedikit dari yang seharusnya ada menurut catatan. Kemungkinan hilang, bocor, atau belum tercatat." },
  PAKAI_BERLEBIH: { label: "Pemakaian bahan di atas standar", hint: "Bahan terpakai lebih banyak dari resep × hasil shift. Cek takaran, reject, atau bahan terbuang." },
  REJECT_TINGGI: { label: "Reject di atas normal", hint: "Barang rusak/gagal shift ini jauh lebih banyak dari rata-rata 30 hari." },
  STOK_MINUS: { label: "Stok minus", hint: "Stok tercatat negatif: ada pemakaian/pengiriman yang belum diimbangi pencatatan masuk." },
  BARANG_DIAM: { label: "Barang tidak bergerak", hint: "Barang menumpuk tanpa keluar dalam waktu lama; uang tertahan di stok." },
  PRAKIRAAN_HABIS: { label: "Perkiraan stok habis", hint: "Dengan kecepatan pakai 14 hari terakhir, stok akan habis dalam beberapa hari walau belum di bawah batas." },
  LPG: { label: "LPG tabung", hint: "Tabung habis dan isi ulang tidak sinkron, isi ulang belum dicatat Finance, atau jumlah tabung tidak sama dengan aset." },
  RANTAI_PUTUS: { label: "Rantai putus", hint: "Ada barang/dokumen yang berhenti di tengah alur melewati batas waktu wajar." },
  BELUM_TERPANTAU: { label: "Barang belum terpantau", hint: "Bahan aktif tanpa divisi pemilik atau tidak pernah dihitung di laporan; kebocorannya tidak bisa dideteksi." },
};

/** Ambang hari tanpa keluar per jenis barang (bisa diubah Owner lewat setting anomali_diam_*) */
export const IDLE_DAYS = { BAHAN_BAKU: 30, BARANG_JADI: 30, BARANG_DALAM_PROSES: 14, BASAH: 3 } as const;
export const FORECAST_DAYS = 7;

const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const f = (n: number) => Number(n.toFixed(2)).toLocaleString("id-ID");

async function neracaSelisih(since: Date): Promise<Found[]> {
  const rows = await prisma.shiftBalance.findMany({ where: { computedAt: { gte: since }, diff: { not: null } } });
  const items = await prisma.item.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } }, select: { id: true, name: true, unit: true } });
  return rows.filter((r) => Number(r.diff) < 0 && bigDiff(Number(r.diff), Number(r.systemClosing))).map((r) => {
    const it = items.find((i) => i.id === r.itemId);
    const value = Math.abs(Number(r.diff)) * Number(r.unitCost);
    return { type: "NERACA_SELISIH", scope: `${r.reportId}:${r.itemId}`, severity: "TINGGI" as const, title: `${it?.name ?? "Barang"}: fisik kurang ${f(Math.abs(Number(r.diff)))} ${it?.unit ?? ""}`, detail: `Sistem ${f(Number(r.systemClosing))}, hitung fisik ${f(Number(r.counted))}${r.picName ? ` (PIC ${r.picName})` : ""}`, value, divisionId: r.divisionId, itemId: r.itemId, reportId: r.reportId };
  });
}

async function pakaiBerlebih(since: Date): Promise<Found[]> {
  const reports = await prisma.shiftReport.findMany({ where: { date: { gte: dateOnly(todayStr(since)) }, status: { in: ["TERKIRIM", "DIREVISI"] } }, select: { id: true, divisionId: true }, take: 80 });
  const out: Found[] = [];
  for (const r of reports) {
    for (const x of (await usageCheck(r.id).catch(() => [])).filter((y) => y.over)) {
      out.push({ type: "PAKAI_BERLEBIH", scope: `${r.id}:${x.itemId}`, severity: x.valueOver >= 100_000 ? "TINGGI" : "SEDANG", title: `${x.name}: pemakaian ${x.overPct}% di atas standar`, detail: `Standar ${f(x.standard)} ${x.unit}, aktual ${f(x.actual)} (batas +${TOLERANCE_PCT}%)`, value: x.valueOver, divisionId: r.divisionId, itemId: x.itemId, reportId: r.id });
    }
  }
  return out;
}

async function rejectTinggi(since: Date, now: Date): Promise<Found[]> {
  const recent = await prisma.productionReject.findMany({ where: { createdAt: { gte: since } } });
  if (!recent.length) return [];
  const base = await prisma.productionReject.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000), lt: since } } });
  const avgBy = new Map<string, number>();
  const groups = new Map<string, Set<string>>();
  for (const b of base) { const k = `${b.divisionId}|${b.stage}`; avgBy.set(k, (avgBy.get(k) ?? 0) + Number(b.qty)); (groups.get(k) ?? groups.set(k, new Set()).get(k)!).add(b.reportId); }
  const byReport = new Map<string, { div: string; stage: string; qty: number; value: number }>();
  for (const r of recent) { const k = r.reportId; const c = byReport.get(k) ?? { div: r.divisionId, stage: r.stage, qty: 0, value: 0 }; c.qty += Number(r.qty); c.value += Number(r.qty) * Number(r.unitCost); byReport.set(k, c); }
  const out: Found[] = [];
  for (const [reportId, c] of byReport) {
    const k = `${c.div}|${c.stage}`;
    const n = groups.get(k)?.size ?? 0;
    const avg = n ? (avgBy.get(k) ?? 0) / n : 0;
    if (c.qty >= 5 && (n === 0 ? c.qty >= 20 : c.qty > avg * 1.5)) {
      out.push({ type: "REJECT_TINGGI", scope: reportId, severity: "SEDANG", title: `Reject ${c.stage.toLowerCase()} ${f(c.qty)} pcs shift ini`, detail: n ? `Rata-rata 30 hari ${f(avg)} per laporan` : "Belum ada pembanding 30 hari", value: c.value, divisionId: c.div, reportId });
    }
  }
  return out;
}

async function stokMinus(): Promise<Found[]> {
  return (await negativeStock()).map((r) => ({ type: "STOK_MINUS", scope: `${r.itemId}:${r.locationId}`, severity: "TINGGI" as const, title: `${r.item.name} minus ${f(Math.abs(r.qty))} ${r.item.unit}`, detail: `di ${r.location.name}`, value: Math.abs(r.qty) * Number(r.item.avgCost), itemId: r.itemId }));
}

/** Barang tidak bergerak + prakiraan habis, dari mutasi stok */
async function pergerakan(now: Date): Promise<Found[]> {
  const items = await prisma.item.findMany({ where: { active: true, type: { in: ["BAHAN_BAKU", "BARANG_DALAM_PROSES", "BARANG_JADI"] } }, select: { id: true, sku: true, name: true, unit: true, type: true, avgCost: true, minStock: true, divisionId: true } });
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const [last, use14, stock] = await Promise.all([
    prisma.$queryRaw<{ itemId: string; d: Date }[]>`SELECT "itemId", MAX(date) AS d FROM "StockMovement" WHERE "itemId" = ANY(${ids}) AND ("fromLocationId" IS NOT NULL) AND type IN ('KONSUMSI_PRODUKSI','PENGELUARAN','TRANSFER','PENYESUAIAN') GROUP BY "itemId"`,
    prisma.$queryRaw<{ itemId: string; q: number }[]>`SELECT "itemId", SUM(qty)::float8 AS q FROM "StockMovement" WHERE "itemId" = ANY(${ids}) AND date >= ${new Date(now.getTime() - 14 * 86_400_000)} AND ("fromLocationId" IS NOT NULL AND "toLocationId" IS NULL) AND type IN ('KONSUMSI_PRODUKSI','PENGELUARAN','PENYESUAIAN') GROUP BY "itemId"`,
    prisma.$queryRaw<{ itemId: string; q: number }[]>`SELECT "itemId", (SUM(CASE WHEN "toLocationId" IS NOT NULL THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" IS NOT NULL THEN qty ELSE 0 END))::float8 AS q FROM "StockMovement" WHERE "itemId" = ANY(${ids}) GROUP BY "itemId"`,
  ]);
  const lastBy = new Map(last.map((x) => [x.itemId, x.d]));
  const useBy = new Map(use14.map((x) => [x.itemId, x.q / 14]));
  const stockBy = new Map(stock.map((x) => [x.itemId, x.q]));
  const out: Found[] = [];
  for (const it of items) {
    const q = stockBy.get(it.id) ?? 0;
    if (q <= 0) continue;
    const isBasah = /^SJ-CTK-/i.test(it.sku);
    const limitDays = isBasah ? IDLE_DAYS.BASAH : IDLE_DAYS[it.type];
    const l = lastBy.get(it.id);
    const idleDays = l ? Math.floor((now.getTime() - new Date(l).getTime()) / 86_400_000) : null;
    const value = q * Number(it.avgCost);
    if (idleDays != null && idleDays >= limitDays) {
      out.push({ type: isBasah ? "RANTAI_PUTUS" : "BARANG_DIAM", scope: `diam:${it.id}`, severity: value >= 2_000_000 ? "SEDANG" : "RENDAH", title: isBasah ? `Patung cetak ${it.name} ${f(q)} ${it.unit} belum masuk Oven ${idleDays} hari` : `${it.name} tidak bergerak ${idleDays} hari (${f(q)} ${it.unit})`, detail: `Nilai tertahan ${rp(value)}`, value, itemId: it.id, divisionId: it.divisionId });
      continue;
    }
    const perDay = useBy.get(it.id) ?? 0;
    if (perDay > 0 && q / perDay < FORECAST_DAYS) {
      out.push({ type: "PRAKIRAAN_HABIS", scope: `habis:${it.id}`, severity: q / perDay < 3 ? "TINGGI" : "SEDANG", title: `${it.name} habis ±${Math.max(0, Math.floor(q / perDay))} hari lagi`, detail: `Stok ${f(q)} ${it.unit}, pemakaian ±${f(perDay)} per hari`, value: 0, itemId: it.id, divisionId: it.divisionId });
    }
  }
  return out;
}

async function lpg(now: Date): Promise<Found[]> {
  const s = await lpgSummary(7, now).catch(() => null);
  if (!s) return [];
  const out: Found[] = [];
  if (Math.abs(s.selisih) > 1) out.push({ type: "LPG", scope: "selisih", severity: "SEDANG", title: `Tabung habis ${s.habis} vs isi ulang ${s.isiUlang} (7 hari)`, detail: s.pricePerTabung ? `Harga isi ulang ±${rp(s.pricePerTabung)} per tabung` : undefined });
  if (s.lateWaiting > 0) out.push({ type: "LPG", scope: "belum-dicatat", severity: "RENDAH", title: `${s.lateWaiting} isi ulang LPG belum dicatat Finance (>2 hari)`, detail: "Catat transaksi isi ulang dan sebut LPG agar dipasangkan otomatis" });
  if (s.totalMismatch) out.push({ type: "LPG", scope: "aset", severity: "TINGGI", title: `Jumlah tabung ${s.latestTotal} ≠ aset ${s.aset}`, detail: "Tabung hilang atau bertambah tanpa pembelian tabung baru" });
  return out;
}

async function rantaiPutus(now: Date): Promise<Found[]> {
  const day = (n: number) => dateOnly(addDays(todayStr(now), -n));
  const [krm, amb, retur] = await Promise.all([
    prisma.boronganShipment.findMany({ where: { cancelledAt: null, waitingSupport: false, date: { lt: day(2) }, allots: { none: {} } }, select: { id: true, number: true } }),
    prisma.boronganPickup.findMany({ where: { status: "DIBAWA", date: { lt: day(2) } }, select: { id: true, number: true } }),
    prisma.returnCase.findMany({ where: { cancelledAt: null, status: "DITERIMA", receivedAt: { lt: new Date(now.getTime() - 3 * 86_400_000) } }, select: { id: true, number: true } }),
  ]);
  return [
    ...krm.map((s) => ({ type: "RANTAI_PUTUS", scope: `krm:${s.id}`, severity: "SEDANG" as const, title: `Kiriman ${s.number} belum dibagi ke pekerja (>2 hari)`, detail: "Bahan sudah keluar dari gudang tetapi belum dibagi" })),
    ...amb.map((p) => ({ type: "RANTAI_PUTUS", scope: `amb:${p.id}`, severity: "SEDANG" as const, title: `Setoran ${p.number} belum dihitung divisi (>2 hari)`, detail: "Setoran sudah diambil driver tetapi belum diterima/dihitung" })),
    ...retur.map((r) => ({ type: "RANTAI_PUTUS", scope: `rtr:${r.id}`, severity: "RENDAH" as const, title: `Retur ${r.number} belum diperiksa (>3 hari)` })),
  ];
}

async function belumTerpantau(): Promise<Found[]> {
  const list = await unmonitoredItems().catch(() => []);
  if (!list.length) return [];
  return [{ type: "BELUM_TERPANTAU", scope: "semua", severity: "RENDAH", title: `${list.length} bahan aktif belum terpantau`, detail: list.slice(0, 8).map((x) => x.name).join(", ") + (list.length > 8 ? `, +${list.length - 8} lainnya` : "") }];
}

/** Kumpulkan semua temuan hari ini (tanpa menyimpan) */
export async function detectAnomalies(now: Date = new Date()): Promise<Found[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000);
  const parts = await Promise.all([neracaSelisih(since), pakaiBerlebih(since), rejectTinggi(since, now), stokMinus(), pergerakan(now), lpg(now), rantaiPutus(now), belumTerpantau()]);
  return parts.flat();
}

/**
 * Deteksi lalu simpan (dedupe per jenis+lingkup+tanggal; status/catatan yang sudah ada dipertahankan).
 * Anomali TINGGI yang baru dikirim push ke Owner, Supervisor, Finance (satu push ringkas per eksekusi).
 */
export async function runStockAlerts(now: Date = new Date()) {
  const date = dateOnly(todayStr(now));
  const found = await detectAnomalies(now);
  let created = 0;
  for (const x of found) {
    const key = `${x.type}|${x.scope}|${todayStr(now)}`;
    const data = { type: x.type, severity: x.severity, title: x.title.slice(0, 200), detail: x.detail?.slice(0, 500) ?? null, value: BigInt(Math.round(x.value ?? 0)), divisionId: x.divisionId ?? null, itemId: x.itemId ?? null, reportId: x.reportId ?? null, date };
    const ex = await prisma.stockAnomaly.findUnique({ where: { key }, select: { id: true } });
    if (ex) await prisma.stockAnomaly.update({ where: { key }, data });
    else { await prisma.stockAnomaly.create({ data: { key, ...data } }); created++; }
  }
  const fresh = await prisma.stockAnomaly.findMany({ where: { severity: "TINGGI", pushedAt: null, status: "BARU" }, orderBy: { value: "desc" }, take: 20 });
  let pushed = 0;
  if (fresh.length) {
    const users = await prisma.user.findMany({ where: { active: true, role: { in: ["OWNER", "SUPERVISOR", "FINANCE"] } }, select: { id: true } });
    const r = await sendPush(users.map((u) => u.id), { title: `⚠ ${fresh.length} peringatan stok penting`, body: fresh.slice(0, 3).map((x) => x.title).join(" · ").slice(0, 240), url: "/laporan/kebocoran", tag: "stok-anomali" }).catch(() => null);
    pushed = r?.sent ?? 0;
    await prisma.stockAnomaly.updateMany({ where: { id: { in: fresh.map((x) => x.id) } }, data: { pushedAt: now } });
  }
  return { found: found.length, created, pushed };
}

/** Jumlah peringatan terbuka (14 hari) untuk lonceng: BARU/DILIHAT dengan tingkat SEDANG/TINGGI */
export async function openAnomalyCount(now: Date = new Date()) {
  return prisma.stockAnomaly.count({ where: { status: { in: ["BARU", "DILIHAT"] }, severity: { in: ["SEDANG", "TINGGI"] }, date: { gte: dateOnly(addDays(todayStr(now), -14)) } } });
}
