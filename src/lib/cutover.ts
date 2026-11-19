import { prisma } from "./db";
import { CUTOVER_SETTING, FLOW_SETTING, cutoverDate, flowEnabled } from "./shiftReportFlow";
import { locationSettings, negativeStock, stockBalances } from "./stock";
import { OPENING_SETTING } from "./stockOpening";
import { addDays, dateOnly, todayStr } from "./time";

export { CUTOVER_SETTING, FLOW_SETTING };

export type Check = { key: string; label: string; ok: boolean; detail: string; href?: string };

/** Kesiapan cut-over stok terpadu (hanya membaca) */
export async function cutoverReadiness(now: Date = new Date()): Promise<{ date: string | null; flowOn: boolean; daysLeft: number | null; checks: Check[] }> {
  const t = await cutoverDate();
  const flowOn = await flowEnabled();
  const today = todayStr(now);
  const daysLeft = t ? Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  const [noDivision, lastOpening, negatives, unsent, unlinked, lpgTotal, tables] = await Promise.all([
    prisma.item.count({ where: { active: true, type: "BAHAN_BAKU", divisionId: null } }),
    prisma.setting.findUnique({ where: { key: OPENING_SETTING } }),
    negativeStock(),
    prisma.shiftReport.count({ where: { status: "DRAFT", date: { gte: dateOnly(addDays(today, -7)) } } }),
    prisma.shiftReceipt.count({ where: { purchaseId: null } }),
    prisma.setting.findUnique({ where: { key: "lpg_total_aset" } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name IN ('ProductionReject', 'ShiftBalance', 'LpgState', 'StockAnomaly', 'UsageStandard')`.catch(() => [{ n: 0n }]),
  ]);
  const openingDate = lastOpening?.value?.slice(0, 10) ?? null;
  const checks: Check[] = [
    { key: "tanggal", label: "Tanggal mulai ditetapkan", ok: !!t, detail: t ? `Mulai ${t}${daysLeft != null ? ` (${daysLeft >= 0 ? `${daysLeft} hari lagi` : `${-daysLeft} hari lalu`})` : ""}` : "Belum diatur" },
    { key: "opname", label: "Stok awal riil (hitung semua barang) sudah diisi", ok: !!openingDate && (!t || openingDate >= addDays(t, -2)), detail: openingDate ? `Terakhir diisi ${openingDate}` : "Belum pernah — hitung semua barang lalu isi Stok awal riil", href: "/stok/awal" },
    { key: "divisi", label: "Semua bahan baku aktif punya divisi pemilik", ok: noDivision === 0, detail: noDivision ? `${noDivision} bahan tanpa divisi` : "Semua punya divisi", href: "/stok/master" },
    { key: "minus", label: "Tidak ada stok minus", ok: negatives.length === 0, detail: negatives.length ? `${negatives.length} barang minus` : "Tidak ada", href: "/stok?filter=minus" },
    { key: "draf", label: "Tidak ada draf laporan shift tergantung (7 hari)", ok: unsent === 0, detail: unsent ? `${unsent} draf belum dikirim` : "Bersih", href: "/laporan" },
    { key: "bmk", label: "Barang masuk sudah ditautkan ke Pembelian", ok: unlinked === 0, detail: unlinked ? `${unlinked} barang masuk belum dicatat di Pembelian` : "Semua tertaut", href: "/stok/pembelian" },
    { key: "lpg", label: "Total tabung LPG ditetapkan", ok: !!lpgTotal, detail: lpgTotal ? `${lpgTotal.value} tabung` : "Belum diatur (bawaan 3)" },
    { key: "tabel", label: "Fitur stok terpadu terpasang di server", ok: Number(tables[0]?.n ?? 0) >= 5, detail: `${Number(tables[0]?.n ?? 0)} dari 5 tabel P1–P5 ada` },
    { key: "sakelar", label: "Sakelar Hasil kerja → stok", ok: flowOn, detail: flowOn ? "Menyala" : "Masih mati — nyalakan di Laporan › Bahan & checklist divisi pada tanggal mulai", href: "/laporan/bahan" },
  ];
  return { date: t, flowOn, daysLeft, checks };
}

/** Daftar hitung stok awal: semua barang aktif per jenis & divisi dengan stok sistem sekarang (untuk dihitung fisik sehari sebelum mulai) */
export async function countList() {
  const [items, balances, locs, divisions] = await Promise.all([
    prisma.item.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { name: "asc" }], select: { id: true, sku: true, name: true, unit: true, type: true, divisionId: true } }),
    stockBalances(),
    locationSettings(prisma),
    prisma.division.findMany({ select: { id: true, name: true } }),
  ]);
  const locOf = (t: string) => (t === "BAHAN_BAKU" ? locs.raw : t === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished);
  const TYPE = { BAHAN_BAKU: "Bahan baku", BARANG_DALAM_PROSES: "Setengah jadi", BARANG_JADI: "Produk jadi" } as const;
  return items.map((i) => ({
    sku: i.sku, name: i.name, unit: i.unit, type: TYPE[i.type], division: divisions.find((d) => d.id === i.divisionId)?.name ?? "(tanpa divisi)",
    system: Math.round((balances.find((b) => b.itemId === i.id && b.locationId === locOf(i.type))?.qty ?? 0) * 1000) / 1000,
  }));
}
