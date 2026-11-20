import type { ItemType, Prisma } from "@prisma/client";
import { audit } from "./audit";
import { COA, postJournal, type LineInput } from "./accounting";
import { INVENTORY_COA, locationSettings, qtyAt, recordMovement } from "./stock";
import { shiftEndAt, type StockCountRow, type WorkData } from "./shiftReport";
import { CUTOVER_SETTING } from "./shiftReportFlow";
import { storedCounts } from "./shiftResultCount";
import { OPENING_SETTING } from "./stockOpening";
import { addDays, dateOnly } from "./time";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

export type CutoverRow = {
  itemId: string; sku: string; name: string; unit: string; type: ItemType;
  locationId: string; location: string;
  system: number; counted: number; diff: number; avgCost: number; value: number;
  /** Laporan sumber hitungan (divisi · shift) */
  source: string; at: Date;
  /** Barang yang dihitung lebih dari satu laporan: hitungan lain yang TIDAK dipakai */
  others: string[];
};
export type CutoverPlan = {
  date: string; ref: string;
  rows: CutoverRow[];
  /** Barang aktif yang tidak dihitung di laporan mana pun (stoknya tidak diubah) */
  notCounted: { sku: string; name: string; type: ItemType }[];
  /** Laporan wajib tanggal itu yang belum terkirim */
  unsent: string[];
  reports: string[];
  delta: Record<ItemType, number>;
};

const TYPE_LABEL: Record<ItemType, string> = { BAHAN_BAKU: "Bahan baku", BARANG_DALAM_PROSES: "Setengah jadi", BARANG_JADI: "Produk jadi" };

/**
 * Rencana cut-over stok dari laporan shift TERKIRIM tanggal `date`: stok sistem per lokasi gudang (bahan baku / setengah jadi /
 * barang jadi, sesuai jenis barang) disamakan dengan hitungan stok akhir laporan — per barang dipakai hitungan dari laporan
 * dengan jam selesai shift paling akhir (Assembling dan divisi lain ikut laporan masing-masing). Stok dibandingkan pada jam
 * selesai shift itu, jadi mutasi sesudahnya tetap. Tidak mengubah apa pun (dipanggil di transaksi yang dibatalkan saat pratinjau).
 */
export async function planReportCutover(tx: Tx, date: string): Promise<CutoverPlan> {
  const { expectedSlots } = await import("./reportExpected");
  const locs = await locationSettings(tx);
  if (!locs.raw || !locs.wip || !locs.finished) throw new Error("Lokasi gudang bahan / setengah jadi / barang jadi belum diatur di Pengaturan");
  const locName = new Map((await tx.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const reports = await tx.shiftReport.findMany({ where: { date: dateOnly(date), status: { not: "DRAFT" } }, include: { shift: true, division: true } });
  const ordered = reports.map((r) => ({ r, at: shiftEndAt(r.date, r.shift) })).sort((a, b) => a.at.getTime() - b.at.getTime() || a.r.shift.code.localeCompare(b.r.shift.code));
  const counts = new Map<string, { qty: number; source: string; at: Date; others: string[] }>();
  for (const { r, at } of ordered) {
    const source = `${r.division.name} · ${r.shift.name}`;
    const put = (itemId: string, qty: number) => {
      const prev = counts.get(itemId);
      const others = prev ? [...prev.others, `${prev.source}: ${prev.qty.toLocaleString("id-ID")}`] : [];
      counts.set(itemId, { qty, source, at, others });
    };
    for (const row of ((r.stockCount as StockCountRow[] | null) ?? [])) if (row.qty != null && Number.isFinite(row.qty)) put(row.itemId, row.qty);
    for (const [itemId, qty] of await storedCounts(r.work as WorkData, r.division.reportTemplate, tx)) put(itemId, qty);
  }
  const items = await tx.item.findMany({ where: { OR: [{ id: { in: [...counts.keys()] } }, { active: true }] }, select: { id: true, sku: true, name: true, unit: true, type: true, avgCost: true, active: true } });
  const rows: CutoverRow[] = [];
  const delta: Record<ItemType, number> = { BAHAN_BAKU: 0, BARANG_DALAM_PROSES: 0, BARANG_JADI: 0 };
  for (const it of items) {
    const c = counts.get(it.id);
    if (!c) continue;
    const loc = it.type === "BAHAN_BAKU" ? locs.raw : it.type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
    const system = Math.round((await qtyAt(tx, it.id, loc, c.at)) * 1000) / 1000;
    const diff = Math.round((c.qty - system) * 1000) / 1000;
    const avgCost = Number(it.avgCost);
    const value = Math.round(diff * avgCost);
    delta[it.type] += value;
    rows.push({ itemId: it.id, sku: it.sku, name: it.name, unit: it.unit, type: it.type, locationId: loc, location: locName.get(loc) ?? loc, system, counted: c.qty, diff, avgCost, value, source: c.source, at: c.at, others: c.others });
  }
  rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const notCounted = items.filter((i) => i.active && !counts.has(i.id)).map((i) => ({ sku: i.sku, name: i.name, type: i.type })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const unsent = (await expectedSlots(date)).filter((s) => !s.sent).map((s) => `${s.division} · ${s.shift}${s.draftId ? " (masih draf)" : " (belum dibuat)"}`);
  return { date, ref: `CUTOVER-${date}`, rows, notCounted, unsent, reports: ordered.map(({ r }) => `${r.division.name} · ${r.shift.name}`), delta };
}

/** Tanggal mulai stok terpadu sesudah cut-over: HARI BERIKUTNYA (laporan tanggal cut-over sudah tercermin di saldo; kirim ulang tidak memposting lagi) */
export const startAfterCutover = (date: string, sameDay = false) => (sameDay ? date : addDays(date, 1));

/**
 * Jalankan cut-over: penyesuaian per barang (ref CUTOVER-<tanggal>, tanggal = jam selesai shift laporan sumber, tanpa jurnal per mutasi)
 * + satu jurnal selisih nilai per jenis persediaan ke Ekuitas Saldo Awal — aturan sama dengan Stok awal riil (bukan laba rugi),
 * atau ke Beban Selisih Persediaan bila `account: "selisih"`. Setting tanggal mulai stok terpadu & tanggal stok awal ikut diubah.
 */
export async function applyReportCutover(tx: Tx, plan: CutoverPlan, actor: Actor, opts: { sameDay?: boolean; account?: "ekuitas" | "selisih" } = {}) {
  const store = (await tx.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
  if (!store) throw new Error("Toko default belum diatur di Pengaturan");
  let n = 0;
  for (const r of plan.rows) {
    if (r.diff === 0) continue;
    await recordMovement(tx, {
      type: "PENYESUAIAN", itemId: r.itemId, qty: Math.abs(r.diff), fromLocationId: r.locationId, increase: r.diff > 0, allowNegative: true, noJournal: true,
      ref: plan.ref, note: `Cut-over stok laporan shift ${plan.date}: sistem ${r.system}, laporan ${r.counted} (${r.source})`, date: r.at,
    }, actor);
    n++;
  }
  const other = opts.account === "selisih" ? COA.BEBAN_SELISIH_PERSEDIAAN : COA.EKUITAS_SALDO_AWAL;
  const lines: LineInput[] = (Object.keys(plan.delta) as ItemType[]).filter((t) => plan.delta[t] !== 0).flatMap((t): LineInput[] =>
    plan.delta[t] > 0
      ? [{ accountCode: INVENTORY_COA[t], debit: plan.delta[t] }, { accountCode: other, credit: plan.delta[t] }]
      : [{ accountCode: other, debit: -plan.delta[t] }, { accountCode: INVENTORY_COA[t], credit: -plan.delta[t] }],
  );
  const lastAt = plan.rows.reduce<Date | null>((a, r) => (!a || r.at > a ? r.at : a), null) ?? dateOnly(plan.date);
  if (lines.length) await postJournal(tx, { date: lastAt, storeId: store, description: `Cut-over stok dari laporan shift ${plan.date} (${plan.ref})`, source: "STOK_AWAL", sourceId: plan.ref, actor, lines });
  const start = startAfterCutover(plan.date, opts.sameDay);
  const prev = (await tx.setting.findUnique({ where: { key: CUTOVER_SETTING } }))?.value ?? null;
  await tx.setting.upsert({ where: { key: CUTOVER_SETTING }, create: { key: CUTOVER_SETTING, value: start }, update: { value: start } });
  await tx.setting.upsert({ where: { key: OPENING_SETTING }, create: { key: OPENING_SETTING, value: lastAt.toISOString() }, update: { value: lastAt.toISOString() } });
  await audit(actor, "CUTOVER_LAPORAN_SHIFT", "StockMovement", null, { ref: plan.ref, mutasi: n, delta: plan.delta, akun: other, tanggalMulaiSebelum: prev, tanggalMulaiSesudah: start, laporanBelumTerkirim: plan.unsent }, tx);
  return { moved: n, start };
}

export function cutoverLines(p: CutoverPlan): string[] {
  const f = (x: number) => x.toLocaleString("id-ID");
  const rp = (x: number) => `${x < 0 ? "-" : ""}Rp${Math.abs(x).toLocaleString("id-ID")}`;
  const L = [`Cut-over stok dari laporan shift TERKIRIM ${p.date} · ref ${p.ref}`, `Laporan sumber (${p.reports.length}): ${p.reports.join(", ") || "-"}`];
  if (p.unsent.length) L.push(`⚠ LAPORAN WAJIB BELUM TERKIRIM (${p.unsent.length}): ${p.unsent.join(", ")}`);
  let loc = "";
  for (const r of p.rows) {
    if (r.location !== loc) { loc = r.location; L.push("", `== ${loc} ==`); }
    L.push(`  ${r.sku} ${r.name}: sistem ${f(r.system)} → laporan ${f(r.counted)} ${r.unit} · selisih ${r.diff > 0 ? "+" : ""}${f(r.diff)} (${rp(r.value)}) · ${r.source}${r.others.length ? ` · hitungan lain tidak dipakai: ${r.others.join("; ")}` : ""}`);
  }
  L.push("", `Selisih nilai: ${(Object.keys(p.delta) as ItemType[]).map((t) => `${TYPE_LABEL[t]} ${rp(p.delta[t])}`).join(" · ")}`);
  L.push(`${p.rows.filter((r) => r.diff !== 0).length} barang disesuaikan, ${p.rows.filter((r) => r.diff === 0).length} sudah sama.`);
  if (p.notCounted.length) L.push("", `TIDAK DIHITUNG di laporan mana pun (${p.notCounted.length}, stok tidak diubah):`, ...p.notCounted.map((i) => `  ${TYPE_LABEL[i.type]} · ${i.sku} ${i.name}`));
  return L;
}
