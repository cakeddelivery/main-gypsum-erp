/*
 * DIAGNOSA READ-ONLY stok minus & selisih persediaan vs buku besar (hanya SELECT, tidak mengubah apa pun):
 *   npx tsx scripts/diagnosa-stok-minus.ts            -> sejak 1 Nov 2026
 *   npx tsx scripts/diagnosa-stok-minus.ts --sejak=2026-10-01
 * A. Tiap barang × lokasi yang minus: saldo sebelum cut-over, ringkasan mutasi per jenis × awalan ref (LPH laporan shift, PRD produksi,
 *    JUAL, BATAL, MUT manual, AWAL/OPN opname, dst.) sejak tanggal --sejak dan sejak cut-over (setting stok_terpadu_mulai).
 *    Pola khas: "saldo sebelum cut-over ≤ 0 + banyak keluar LPH Packing/Giftbox" = stok awal barang jadi belum dibuat saat cut-over.
 * B. Akun 1-1401/1402/1403 per bulan: mutasi buku besar (per sumber jurnal) vs mutasi nilai stok (qty × harga pokok mutasi),
 *    dan nilai mutasi stok yang TIDAK punya jurnal (KONSUMSI_PRODUKSI / HASIL_PRODUKSI / pembalik tidak berjurnal sendiri).
 */
import { prisma } from "../src/lib/db";

const sejak = process.argv.find((a) => a.startsWith("--sejak="))?.slice(8) ?? "2026-11-01";
const n = (x: unknown) => Number(x ?? 0).toLocaleString("id-ID");
type R = Record<string, unknown>;

async function main() {
  const cut = (await prisma.setting.findUnique({ where: { key: "stok_terpadu_mulai" } }))?.value ?? null;
  const flow = (await prisma.setting.findUnique({ where: { key: "laporan_shift_ke_stok" } }))?.value ?? null;
  console.log(`DIAGNOSA STOK MINUS (read-only) · sejak ${sejak} · cut-over stok terpadu: ${cut ?? "(belum diatur)"} · laporan_shift_ke_stok=${flow ?? "(kosong)"}\n`);
  const cutAt = cut ? new Date(`${cut}T00:00:00+07:00`) : null;
  const from = new Date(`${sejak}T00:00:00+07:00`);

  console.log("== A. Barang × lokasi minus ==");
  const neg = await prisma.$queryRaw<{ itemId: string; locationId: string; sku: string; name: string; type: string; lokasi: string; qty: number }[]>`
    SELECT b."itemId", b."locationId", i.sku, i.name, i.type::text AS type, l.name AS lokasi, b.qty::float8 AS qty FROM (
      SELECT "itemId", "locationId", SUM(q) AS qty FROM (SELECT "itemId", "toLocationId" AS "locationId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL
      UNION ALL SELECT "itemId", "fromLocationId", -qty FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL) m GROUP BY 1,2 HAVING SUM(q) < -0.0005) b
    JOIN "Item" i ON i.id = b."itemId" JOIN "Location" l ON l.id = b."locationId" ORDER BY b.qty`;
  console.log(`${neg.length} barang×lokasi minus\n`);
  for (const x of neg) {
    console.log(`• ${x.sku} ${x.name} @ ${x.lokasi} [${x.type}] saldo ${n(x.qty)}`);
    if (cutAt) {
      const [pre] = await prisma.$queryRaw<{ q: number | null }[]>`SELECT (SUM(CASE WHEN "toLocationId" = ${x.locationId} THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" = ${x.locationId} THEN qty ELSE 0 END))::float8 AS q
        FROM "StockMovement" WHERE "itemId" = ${x.itemId} AND date < ${cutAt} AND ("toLocationId" = ${x.locationId} OR "fromLocationId" = ${x.locationId})`;
      console.log(`    saldo SEBELUM cut-over (${cut}): ${n(pre?.q)}`);
    }
    const rows = await prisma.$queryRaw<R[]>`
      SELECT type::text AS jenis, COALESCE(split_part(split_part(ref, ':', 1), ' ', 1), '(tanpa ref)') AS awalan,
             COUNT(*)::int AS baris, SUM(CASE WHEN "toLocationId" = ${x.locationId} THEN qty ELSE 0 END)::float8 AS masuk,
             SUM(CASE WHEN "fromLocationId" = ${x.locationId} THEN qty ELSE 0 END)::float8 AS keluar,
             SUM(CASE WHEN ${cutAt ?? new Date(0)}::timestamp <= date THEN 1 ELSE 0 END)::int AS sejak_cutover
      FROM "StockMovement" WHERE "itemId" = ${x.itemId} AND date >= ${from} AND ("toLocationId" = ${x.locationId} OR "fromLocationId" = ${x.locationId})
      GROUP BY 1,2 ORDER BY keluar DESC, masuk DESC`;
    for (const r of rows) console.log(`    ${String(r.jenis).padEnd(18)} ${String(r.awalan).padEnd(12)} ${String(r.baris).padStart(5)}× masuk ${n(r.masuk)} · keluar ${n(r.keluar)} · ${r.sejak_cutover} baris sejak cut-over`);
  }

  console.log("\n== B. Persediaan: buku besar vs nilai mutasi stok, per bulan ==");
  for (const [code, type] of [["1-1401", "BAHAN_BAKU"], ["1-1402", "BARANG_DALAM_PROSES"], ["1-1403", "BARANG_JADI"]]) {
    console.log(`\n-- ${code} (${type}) --`);
    const gl = await prisma.$queryRaw<R[]>`
      SELECT to_char(j.date + interval '7 hours', 'YYYY-MM') AS bulan, j.source, SUM(jl.debit - jl.credit)::float8 AS net, COUNT(*)::int AS baris
      FROM "JournalLine" jl JOIN "Journal" j ON j.id = jl."journalId" JOIN "CoaAccount" a ON a.id = jl."accountId" WHERE a.code = ${code} GROUP BY 1,2 ORDER BY 1,2`;
    const [glTot] = await prisma.$queryRaw<{ v: number | null }[]>`SELECT SUM(jl.debit - jl.credit)::float8 AS v FROM "JournalLine" jl JOIN "CoaAccount" a ON a.id = jl."accountId" WHERE a.code = ${code}`;
    const mv = await prisma.$queryRaw<R[]>`
      SELECT to_char(m.date + interval '7 hours', 'YYYY-MM') AS bulan,
        SUM((CASE WHEN m."toLocationId" IS NOT NULL THEN m.qty ELSE 0 END - CASE WHEN m."fromLocationId" IS NOT NULL THEN m.qty ELSE 0 END) * m."unitCost")::float8 AS net,
        SUM(CASE WHEN m."journalId" IS NULL THEN (CASE WHEN m."toLocationId" IS NOT NULL THEN m.qty ELSE 0 END - CASE WHEN m."fromLocationId" IS NOT NULL THEN m.qty ELSE 0 END) * m."unitCost" ELSE 0 END)::float8 AS tanpa_jurnal
      FROM "StockMovement" m JOIN "Item" i ON i.id = m."itemId" WHERE i.type::text = ${type} GROUP BY 1 ORDER BY 1`;
    const glBy = new Map<string, number>();
    for (const r of gl) glBy.set(String(r.bulan), (glBy.get(String(r.bulan)) ?? 0) + Number(r.net));
    const months = [...new Set([...glBy.keys(), ...mv.map((r) => String(r.bulan))])].sort();
    console.log("   bulan     buku besar        nilai mutasi stok   selisih (BB − stok)   dari mutasi tanpa jurnal");
    for (const m of months) {
      const g = glBy.get(m) ?? 0;
      const s = Number(mv.find((r) => r.bulan === m)?.net ?? 0);
      console.log(`   ${m}  ${n(Math.round(g)).padStart(14)}  ${n(Math.round(s)).padStart(18)}  ${n(Math.round(g - s)).padStart(18)}  ${n(Math.round(Number(mv.find((r) => r.bulan === m)?.tanpa_jurnal ?? 0))).padStart(18)}`);
    }
    console.log(`   TOTAL buku besar ${n(Math.round(Number(glTot?.v ?? 0)))}`);
    console.log("   buku besar per bulan × sumber jurnal:");
    for (const r of gl) console.log(`     ${r.bulan} ${String(r.source).padEnd(16)} ${n(Math.round(Number(r.net))).padStart(14)}  (${r.baris} baris)`);
  }
  console.log("\nCatatan baca: selisih bulan tertentu besar + 'tanpa jurnal' besar = mutasi stok tanpa jurnal (mis. KONSUMSI/HASIL_PRODUKSI, pembalik laporan shift, saldo awal) ; selisih besar tanpa mutasi tanpa jurnal = jurnal tanpa mutasi / akun salah.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
