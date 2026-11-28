import { divisionLocationId, isKering } from "./ambilStok";
import { Prisma, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { fmtDay } from "./time";
import { locationSettings, qtyAt, recordMovement } from "./stock";
import { VARIANTS, shiftEndAt, type WorkData } from "./shiftReport";
import { flowEnabled, flowEnabledOn, flowItem } from "./shiftReportFlow";

type Actor = { id: string; name: string };
type Tx = Prisma.TransactionClient;

/** Kunci hitungan stok akhir hasil di data hasil kerja laporan (work._hasil = { [itemId]: n }) */
export const RESULT_KEY = "_hasil";
export const RESULT_TITLE = "Stok akhir setengah jadi / produk jadi";

/** Selisih dianggap besar (tanda untuk Owner): ≥ 10 unit dan ≥ 10% stok sistem */
export function bigDiff(diff: number, system: number) {
  return Math.abs(diff) >= 10 && Math.abs(diff) >= Math.abs(system) * 0.1;
}

/**
 * Barang setengah jadi & produk jadi yang menjadi tanggung jawab divisi (Master data → Divisi penanggung jawab).
 * Hanya barang aktif. Setengah jadi dihitung di gudang setengah jadi, produk jadi di gudang barang jadi.
 */
export async function resultItems(divisionId: string, db: Tx | typeof prisma = prisma) {
  // Barang milik divisi (Item.divisionId) + keluaran tugas borongan divisi itu (yang diterima lewat Penerimaan divisi, mis. Single Pack satuan untuk Packing)
  // yang Item.divisionId-nya KOSONG. Yang divisinya terisi divisi lain tidak ditarik (dihitung dua divisi = penyesuaian saling timpa): perbaiki lewat koreksi:divisi-hasil
  const outputs = await db.pieceTask.findMany({ where: { divisionId, active: true, outputItemId: { not: null } }, select: { outputItemId: true } });
  const outIds = [...new Set(outputs.map((t) => t.outputItemId!))];
  return db.item.findMany({
    where: { active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] }, OR: [{ divisionId }, ...(outIds.length ? [{ id: { in: outIds }, divisionId: null }] : [])] },
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, sku: true, name: true, unit: true, type: true, minStock: true },
  });
}

/**
 * Hitungan tersimpan per id barang. Laporan lama menyimpan per karakter ("Hewan": n) untuk patung kering (Produksi)
 * atau produk jadi (Assembling): diterjemahkan ke barangnya.
 */
export async function storedCounts(work: WorkData, template: string | null, tx: Tx): Promise<Map<string, number>> {
  const raw = work[RESULT_KEY];
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number | null>) : {};
  const out = new Map<string, number>();
  for (const [k, n] of Object.entries(v)) {
    if (n == null || !Number.isFinite(n)) continue;
    if (VARIANTS.includes(k)) {
      const kind = template === "PRODUKSI" ? "kering" : template === "ASSEMBLING" ? "jadi" : null;
      if (kind) out.set(await flowItem(tx, { kind, key: k }), n);
    } else out.set(k, n);
  }
  return out;
}

/** Nilai isian form per id barang (termasuk laporan lama per karakter) */
export async function resultValues(work: WorkData, template: string | null): Promise<Record<string, number>> {
  return Object.fromEntries(await prisma.$transaction((tx) => storedCounts(work, template, tx)));
}

/** Baca hitungan dari FormData "rc.<idBarang>" untuk barang divisi */
export function parseResultCount(itemIds: string[], get: (k: string) => string | null): Record<string, number> | null {
  if (!itemIds.length) return null;
  const out: Record<string, number> = {};
  for (const id of itemIds) {
    const s = (get(`rc.${id}`) ?? "").trim().replace(/\./g, "").replace(/,/g, ".");
    if (!s) continue;
    const x = Number(s);
    if (!Number.isFinite(x) || x < 0) throw new Error("Angka stok akhir setengah jadi / produk jadi tidak valid");
    out[id] = Math.round(x * 1000) / 1000;
  }
  return out;
}

export type ResultRow = { itemId: string; name: string; unit: string; counted: number; system: number; diff: number; big: boolean; /** Barang divisi yang TIDAK ada di hitungan laporan (bukan angka 0): tampil sebagai "belum dihitung", tidak menyesuaikan stok */ notCounted?: boolean };

function locOf(type: ItemType, locs: { wip: string | null; finished: string | null }, sku?: string, divLoc?: string | null) {
  // Patung kering milik divisi Assembling/Giftbox dihitung di lokasi stok divisinya (hasil "Ambil stok")
  if (type === "BARANG_DALAM_PROSES" && divLoc && sku && isKering(sku)) return divLoc;
  return type === "BARANG_DALAM_PROSES" ? locs.wip : type === "BARANG_JADI" ? locs.finished : null;
}

/** Hitungan vs stok sistem per jam selesai shift (hanya barang yang dihitung) */
export async function resultCountStatus(reportId: string, now: Date = new Date()): Promise<{ title: string; rows: ResultRow[]; applies: boolean } | null> {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  const counts = await prisma.$transaction((tx) => storedCounts(r.work as WorkData, r.division.reportTemplate, tx));
  if (!counts.size) return null;
  const locs = await locationSettings(prisma);
  const items = await prisma.item.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, name: true, unit: true, type: true, sku: true } });
  const divLoc = await divisionLocationId(prisma, r.division.reportTemplate);
  const at = shiftEndAt(r.date, r.shift, now);
  const rows: ResultRow[] = [];
  for (const it of items) {
    const loc = locOf(it.type, locs, it.sku, divLoc);
    if (!loc) continue;
    const c = counts.get(it.id)!;
    const system = Math.round((await qtyAt(prisma, it.id, loc, at)) * 1000) / 1000;
    const diff = Math.round((c - system) * 1000) / 1000;
    rows.push({ itemId: it.id, name: it.name, unit: it.unit, counted: c, system, diff, big: bigDiff(diff, system) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  // Semua barang divisi harus terlihat di laporan: yang tidak ada di hitungan tampil "belum dihitung" bersama stok sistemnya (termasuk yang minus), bukan hilang
  const mine = (await resultItems(r.divisionId)).filter((i) => !counts.has(i.id));
  const extra: ResultRow[] = [];
  for (const it of mine) {
    const loc = locOf(it.type, locs, it.sku, divLoc);
    if (!loc) continue;
    const system = Math.round((await qtyAt(prisma, it.id, loc, at)) * 1000) / 1000;
    extra.push({ itemId: it.id, name: it.name, unit: it.unit, counted: 0, system, diff: 0, big: false, notCounted: true });
  }
  extra.sort((a, b) => a.name.localeCompare(b.name));
  return { title: RESULT_TITLE, rows: [...rows, ...extra], applies: await flowEnabled() };
}

/** Baris teks selisih hitungan vs sistem untuk pesan laporan (tanda untuk Owner) */
export function resultLines(s: NonNullable<Awaited<ReturnType<typeof resultCountStatus>>>): string[] {
  if (!s.rows.length) return [];
  const f = (x: number) => x.toLocaleString("id-ID");
  return [
    s.title.toUpperCase(),
    // Barang 0 yang sesuai sistem dirangkum satu baris (laporan tidak memanjang oleh puluhan baris "0 ✓")
    ...s.rows.filter((r) => !r.notCounted && (r.counted > 0 || r.diff !== 0 || r.system > 0)).map((r) => `${r.name}: ${f(r.counted)} ${r.unit}${r.diff === 0 ? " ✓ sesuai sistem" : ` ⚠ sistem ${f(r.system)} (selisih ${r.diff > 0 ? "+" : ""}${f(r.diff)})${r.big ? " ‼ SELISIH BESAR" : ""}`}`),
    ...(s.rows.some((r) => !r.notCounted && r.counted === 0 && r.diff === 0 && r.system === 0) ? [`${s.rows.filter((r) => !r.notCounted && r.counted === 0 && r.diff === 0 && r.system === 0).length} item lain: 0, sesuai sistem`] : []),
    ...s.rows.filter((r) => r.notCounted && r.system !== 0).map((r) => `${r.name}: belum dihitung ⚠ stok sistem ${f(r.system)} ${r.unit}`),
    ...(s.rows.some((r) => r.notCounted && r.system === 0) ? [`${s.rows.filter((r) => r.notCounted && r.system === 0).length} item belum dihitung (stok sistem 0)`] : []),
    ...(s.rows.some((r) => r.diff !== 0) ? [s.applies ? "Stok sistem disamakan dengan hitungan (selisih persediaan)." : "Selisih hanya ditandai; stok sistem belum diubah (sakelar Hasil kerja → stok belum menyala)."] : []),
  ];
}

/**
 * Terapkan stok akhir setengah jadi / produk jadi ke stok sistem (hanya bila sakelar "Hasil kerja → stok" menyala).
 * Dipanggil SESUDAH hasil kerja diposting, jadi yang dibukukan hanya selisih sisanya.
 * Sama seperti stock opname bahan: per jam selesai shift, laporan lama tidak menimpa laporan lebih baru, revisi hanya selisihnya.
 * Selisih dibukukan sebagai selisih persediaan (bukan HPP / pemakaian bahan).
 */
export async function applyResultCount(reportId: string, actor: Actor, now: Date = new Date()): Promise<{ adjusted: number; skipped?: string }> {
  if (!(await flowEnabled())) return { adjusted: 0, skipped: "nonaktif" };
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
  if (!(await flowEnabledOn(r.date))) return { adjusted: 0, skipped: "sebelum tanggal mulai stok terpadu" };
  const counts = await prisma.$transaction((tx) => storedCounts(r.work as WorkData, r.division.reportTemplate, tx));
  if (!counts.size && !r.resultApplied) return { adjusted: 0 };
  const locs = await locationSettings(prisma);
  if (!locs.wip || !locs.finished) throw new Error("Lokasi gudang setengah jadi / barang jadi belum diatur di Pengaturan");
  const newer = await prisma.shiftReport.findFirst({
    where: {
      id: { not: r.id },
      divisionId: r.divisionId,
      resultApplied: { not: Prisma.DbNull },
      OR: [{ date: { gt: r.date } }, { date: r.date, shift: { code: { gt: r.shift.code } } }],
    },
    include: { shift: true },
  });
  if (newer) return { adjusted: 0, skipped: `Stok hasil tidak diubah: sudah ada laporan lebih baru (${fmtDay(newer.date)} · ${newer.shift.name})` };
  const at = shiftEndAt(r.date, r.shift, now);
  const items = await prisma.item.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, type: true, sku: true } });
  const divLoc = await divisionLocationId(prisma, r.division.reportTemplate);
  let n = 0;
  await prisma.$transaction(async (tx) => {
    // Kunci laporan & baca ulang hitungan yang sudah diterapkan (cegah selisih dibukukan dua kali saat Kirim ganda)
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${r.id} FOR UPDATE`;
    const fresh = await tx.shiftReport.findUniqueOrThrow({ where: { id: r.id }, select: { resultApplied: true } });
    const prev = new Map(((fresh.resultApplied as { itemId: string; qty: number }[] | null) ?? []).map((x) => [x.itemId, x.qty]));
    const snapshot = new Map(prev);
    for (const it of items) {
      const loc = locOf(it.type, locs, it.sku, divLoc);
      if (!loc) continue;
      const c = counts.get(it.id)!;
      const before = prev.get(it.id);
      const base = before != null ? before : await qtyAt(tx, it.id, loc, at);
      const diff = Math.round((c - base) * 1000) / 1000;
      snapshot.set(it.id, c);
      if (diff === 0) continue;
      await recordMovement(tx, {
        type: "PENYESUAIAN", itemId: it.id, qty: Math.abs(diff), fromLocationId: loc, increase: diff > 0, allowNegative: true,
        ref: `LPS:${r.id}`, note: `${before != null ? "Revisi stok" : "Stok"} akhir laporan shift ${r.division.name} ${r.shift.name}`, date: at,
      }, actor);
      n++;
    }
    await tx.shiftReport.update({ where: { id: r.id }, data: { resultApplied: [...snapshot].map(([itemId, qty]) => ({ itemId, qty })) as unknown as Prisma.InputJsonValue } });
  }, { timeout: 30000 });
  return { adjusted: n };
}

/**
 * Stok akhir WAJIB lengkap sebelum laporan dikirim: semua bahan baku divisi (stockCount) dan semua barang setengah jadi / jadi divisi
 * (work._hasil). Angka 0 sah, kosong tidak. Mengembalikan pesan error (nama barang yang belum diisi) atau null bila lengkap.
 */
export function missingStockCounts(
  stock: { name: string; qty: number | null }[],
  items: { id: string; name: string }[],
  work: WorkData,
): string | null {
  const raw = work[RESULT_KEY];
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number | null>) : {};
  const bahan = stock.filter((r) => r.qty == null || !Number.isFinite(Number(r.qty))).map((r) => r.name);
  const hasil = items.filter((i) => v[i.id] == null || !Number.isFinite(Number(v[i.id]))).map((i) => i.name);
  const cut = (l: string[]) => (l.length > 15 ? `${l.slice(0, 15).join(", ")}, dan ${l.length - 15} lainnya` : l.join(", "));
  const parts = [bahan.length ? `Bahan baku: ${cut(bahan)}` : "", hasil.length ? `Setengah jadi / produk jadi: ${cut(hasil)}` : ""].filter(Boolean);
  return parts.length ? `Stok akhir belum diisi (angka 0 boleh, tapi harus diisi). ${parts.join(" · ")}` : null;
}

export type AuditStokAkhir = {
  divisi: { id: string; nama: string; template: string | null; jumlah: number; /** Keluaran tugas borongan divisi yang Item.divisionId-nya bukan divisi ini (kini tetap masuk daftar) */ lewatKeluaranTugas: { sku: string; nama: string; divisiItem: string | null }[]; /** Keluaran tugas divisi ini yang Item.divisionId-nya divisi LAIN → tidak muncul di form divisi ini (koreksi:divisi-hasil) */ keluaranDivisiLain: { sku: string; nama: string; divisiItem: string }[] }[];
  /** Barang setengah jadi / jadi aktif yang ADA stoknya tetapi tidak masuk daftar stok akhir divisi mana pun */
  yatim: { sku: string; nama: string; tipe: string; qty: number; divisiItem: string | null }[];
};

/** Audit (hanya baca): barang stok akhir per divisi, dan barang berstok yang tidak dihitung oleh divisi mana pun. */
export async function auditStokAkhirDivisi(db: Tx | typeof prisma = prisma): Promise<AuditStokAkhir> {
  const divs = await db.division.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, reportTemplate: true } });
  const names = new Map(divs.map((d) => [d.id, d.name]));
  const covered = new Set<string>();
  const divisi: AuditStokAkhir["divisi"] = [];
  for (const d of divs.filter((x) => x.reportTemplate)) {
    const items = await resultItems(d.id, db);
    items.forEach((i) => covered.add(i.id));
    const own = new Set((await db.item.findMany({ where: { id: { in: items.map((i) => i.id) }, divisionId: d.id }, select: { id: true } })).map((x) => x.id));
    const viaTask = items.filter((i) => !own.has(i.id));
    const meta = viaTask.length ? await db.item.findMany({ where: { id: { in: viaTask.map((i) => i.id) } }, select: { id: true, divisionId: true } }) : [];
    const outs = await db.pieceTask.findMany({ where: { divisionId: d.id, active: true, outputItemId: { not: null } }, select: { outputItem: { select: { sku: true, name: true, divisionId: true, active: true } } } });
    const other = new Map<string, { sku: string; nama: string; divisiItem: string }>();
    for (const t of outs) { const o = t.outputItem; if (o?.active && o.divisionId && o.divisionId !== d.id) other.set(o.sku, { sku: o.sku, nama: o.name, divisiItem: names.get(o.divisionId) ?? o.divisionId }); }
    divisi.push({ id: d.id, nama: d.name, template: d.reportTemplate, jumlah: items.length, keluaranDivisiLain: [...other.values()], lewatKeluaranTugas: viaTask.map((i) => ({ sku: i.sku, nama: i.name, divisiItem: names.get(meta.find((m) => m.id === i.id)?.divisionId ?? "") ?? null })) });
  }
  const locs = await locationSettings(db);
  const rest = await db.item.findMany({ where: { active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] }, id: { notIn: [...covered] } }, select: { id: true, sku: true, name: true, type: true, divisionId: true } });
  const yatim: AuditStokAkhir["yatim"] = [];
  for (const i of rest) {
    const loc = i.type === "BARANG_JADI" ? locs.finished : locs.wip;
    const qty = loc ? Math.round((await qtyAt(db, i.id, loc)) * 1000) / 1000 : 0;
    if (qty > 0) yatim.push({ sku: i.sku, nama: i.name, tipe: i.type, qty, divisiItem: i.divisionId ? names.get(i.divisionId) ?? null : null });
  }
  return { divisi, yatim: yatim.sort((a, b) => b.qty - a.qty) };
}
