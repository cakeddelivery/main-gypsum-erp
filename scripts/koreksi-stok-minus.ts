/*
 * KOREKSI stok minus di gudang utama (barang jadi / setengah jadi / bahan baku) lewat "Stok awal riil" (tidak menghapus apa pun):
 *   npx tsx scripts/koreksi-stok-minus.ts                       -> PREVIEW (tidak mengubah data)
 *   npx tsx scripts/koreksi-stok-minus.ts --fisik=MG-003:1200,MG-001:800   -> pakai hitungan fisik nyata untuk barang tsb
 *   npm run backup && npx tsx scripts/koreksi-stok-minus.ts -- --jalankan [--tanggal=2026-11-22] [--fisik=…]
 * Hanya barang yang saldonya MINUS di gudang utama jenisnya (loc_raw / loc_wip / loc_finished) yang diproses; barang lain tidak disentuh.
 * Target tiap barang = hitungan fisik dari --fisik (bila ada), selain itu 0 (artinya: tidak ada fisik tersisa, stok awal sebelum cut-over
 * tidak pernah dibuat). ISI --fisik DENGAN HITUNGAN FISIK NYATA bila gudang masih berisi barang itu.
 * Efek: mutasi PENYESUAIAN "Stok awal (hitung fisik)" bertanggal --tanggal (bawaan: sehari sebelum cut-over, 23:59 WIB, agar kartu stok
 * sesudahnya tidak minus) + jurnal Dr Persediaan / Cr Ekuitas Saldo Awal (sama dengan menu Stok → Stok awal). Setting stok_awal_tanggal dikembalikan.
 * PENTING (akuntansi): "Stok awal riil" menilai saldo minus sebagai 0, jadi koreksi kuantitas ini TIDAK membuat jurnal untuk barang yang
 * total stoknya minus (nilai persediaan di buku besar tidak berubah; HPP sudah terlanjur dibebankan saat barang "keluar" tanpa stok masuk).
 * Bila Owner/akuntan memutuskan stok awal itu memang ada fisiknya sebelum cut-over, tambahkan  --jurnal-saldo-awal : jurnal tambahan
 * Dr Persediaan / Cr Ekuitas Saldo Awal sebesar nilai (jumlah minus × harga pokok), supaya buku besar sejalan dengan nilai stok. Bawaan MATI.
 * Minus di titik borongan / driver TIDAK diubah di sini (stoknya lewat menu Borongan; lihat bagian "dilewati").
 */
import { prisma } from "../src/lib/db";
import { locationSettings } from "../src/lib/stock";
import { COA, postJournal } from "../src/lib/accounting";
import { INVENTORY_COA } from "../src/lib/stock";
import { OPENING_SETTING, saveOpeningStock } from "../src/lib/stockOpening";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const run = process.argv.includes("--jalankan");
const withJournal = process.argv.includes("--jurnal-saldo-awal");
const n = (x: number) => x.toLocaleString("id-ID");

async function main() {
  const locs = await locationSettings(prisma);
  const cut = (await prisma.setting.findUnique({ where: { key: "stok_terpadu_mulai" } }))?.value;
  const day = arg("tanggal") ?? (cut ? new Date(new Date(`${cut}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10) : new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--tanggal harus YYYY-MM-DD");
  const date = new Date(`${day}T23:59:00+07:00`);
  const fisik = new Map<string, number>();
  for (const p of (arg("fisik") ?? "").split(",").filter(Boolean)) {
    const [sku, q] = p.split(":");
    const v = Number(q);
    if (!sku || !Number.isFinite(v) || v < 0) throw new Error(`--fisik salah format: "${p}" (pakai SKU:jumlah)`);
    fisik.set(sku.trim().toUpperCase(), v);
  }
  const neg = await prisma.$queryRaw<{ itemId: string; locationId: string; qty: number }[]>`
    SELECT "itemId", "locationId", SUM(q)::float8 AS qty FROM (SELECT "itemId", "toLocationId" AS "locationId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL
    UNION ALL SELECT "itemId", "fromLocationId", -qty FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL) m GROUP BY 1,2 HAVING SUM(q) < -0.0005`;
  const items = new Map((await prisma.item.findMany({ where: { id: { in: neg.map((x) => x.itemId) } } })).map((i) => [i.id, i]));
  const locName = new Map((await prisma.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const rows: { itemId: string; physical: number }[] = [];
  const skipped: string[] = [];
  let value = 0;
  const gap: Record<string, number> = {};
  console.log(`${run ? "EKSEKUSI" : "PREVIEW (tidak mengubah data)"} · tanggal koreksi ${day} 23:59 WIB · ${neg.length} barang×lokasi minus\n`);
  for (const x of neg.sort((a, b) => a.qty - b.qty)) {
    const it = items.get(x.itemId)!;
    const main = it.type === "BAHAN_BAKU" ? locs.raw : it.type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
    if (x.locationId !== main) { skipped.push(`${it.sku} ${it.name} @ ${locName.get(x.locationId)} ${n(x.qty)}`); continue; }
    // Total semua lokasi dipertahankan: yang dikoreksi hanya saldo gudang utama ini
    const target = fisik.get(it.sku.toUpperCase()) ?? 0;
    const add = target - x.qty;
    const v = Math.round(add * Number(it.avgCost));
    value += v;
    gap[it.type] = (gap[it.type] ?? 0) + Math.round(-x.qty * Number(it.avgCost));
    rows.push({ itemId: it.id, physical: target });
    console.log(`  ${it.sku.padEnd(14)} ${it.name.slice(0, 30).padEnd(30)} saldo ${n(x.qty).padStart(10)} → ${n(target).padStart(8)}  (+${n(add)}) ≈ Rp ${n(v)} @ ${n(Number(it.avgCost))}${fisik.has(it.sku.toUpperCase()) ? "  [fisik]" : "  [target 0]"}`);
  }
  console.log(`\nNilai stok yang ditambahkan ≈ Rp ${n(value)}. Jurnal otomatis dari "Stok awal riil" untuk saldo minus = Rp 0 (lihat catatan akuntansi di kepala skrip).`);
  console.log(`Nilai HPP yang dibebankan tanpa stok masuk (jumlah minus × harga pokok) per jenis: ${Object.entries(gap).map(([t, v]) => `${t} Rp ${n(v)}`).join(" · ") || "-"}${withJournal ? "  → AKAN dijurnal (--jurnal-saldo-awal)" : "  (tidak dijurnal; pakai --jurnal-saldo-awal bila diputuskan)"}`);
  if (skipped.length) console.log(`\nDilewati (bukan gudang utama; perbaiki lewat menu Borongan / Serah terima):\n  ${skipped.join("\n  ")}`);
  if (!rows.length) return console.log("\nTidak ada yang perlu dikoreksi.");
  if (!run) return console.log("\nPreview saja. Untuk mengeksekusi: npm run backup, lalu jalankan lagi dengan  -- --jalankan");
  const actor = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  if (!actor) throw new Error("Tidak ada pengguna Owner aktif");
  const before = (await prisma.setting.findUnique({ where: { key: OPENING_SETTING } }))?.value ?? null;
  const r = await saveOpeningStock(rows, date, { id: actor.id, name: `${actor.name} (koreksi stok minus)` });
  if (before) await prisma.setting.update({ where: { key: OPENING_SETTING }, data: { value: before } });
  else await prisma.setting.deleteMany({ where: { key: OPENING_SETTING } });
  if (withJournal) {
    const lines = Object.entries(gap).filter(([, v]) => v > 0).flatMap(([t, v]) => [{ accountCode: INVENTORY_COA[t as keyof typeof INVENTORY_COA], debit: v }, { accountCode: COA.EKUITAS_SALDO_AWAL, credit: v }]);
    const store = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value;
    if (lines.length && store) await prisma.$transaction((tx) => postJournal(tx, { date, storeId: store, description: `Koreksi stok minus: nilai stok awal sebelum cut-over (${day})`, source: "STOK_AWAL", sourceId: `KOREKSI-MINUS-${day}`, actor: { id: actor.id, name: actor.name }, lines }));
  }
  console.log(`\nSelesai: ${r.changed} barang dikoreksi. Jalankan ulang audit-duplikat-stok.ts untuk memeriksa.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
