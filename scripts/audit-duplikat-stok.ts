/*
 * DETEKSI data ganda & selisih Penjualan / Retur / Pembelian / Stok (HANYA MEMBACA: SELECT saja, tidak mengubah apa pun).
 *   npx tsx scripts/audit-duplikat-stok.ts
 * Mencetak ringkasan per pemeriksaan + contoh id. Kode keluar 0 = bersih, 1 = ada temuan (supaya bisa dipakai di cron).
 * Perbaikan data TIDAK dilakukan di sini: kirim hasilnya ke koordinator, lalu dibuatkan skrip perbaikan terpisah (preview dulu).
 * Cut-over stok terpadu: 23 Nov 2026 (mutasi sebelum tanggal itu tetap diperiksa, selisih lama diberi catatan).
 */
import { prisma } from "../src/lib/db";
import { isSinglePackCandidate } from "../src/lib/singlePackDiag";
import { SINGLE_PACK_VARIANTS } from "../src/lib/singlePackFix";
import { supplierKey } from "../src/lib/suppliers";

let findings = 0;
const f = (n: number | bigint) => Number(n).toLocaleString("id-ID");
const ex = (xs: unknown[], n = 5) => xs.slice(0, n).map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? Number(v) : v)))).join("\n      ");
function report(title: string, rows: unknown[], note = "") {
  if (!rows.length) return console.log(`✓ ${title}: bersih`);
  findings += rows.length;
  console.log(`✗ ${title}: ${f(rows.length)} temuan${note ? ` (${note})` : ""}\n      ${ex(rows)}`);
}
type Row = Record<string, unknown>;
const q = <T = Row>(s: TemplateStringsArray, ...v: unknown[]) => prisma.$queryRaw<T[]>(s, ...v);

async function main() {
  console.log("AUDIT DUPLIKAT & SELISIH STOK (read-only)\n");

  console.log("== 1. Dokumen tersimpan 2x (klik ganda / kirim ulang) ==");
  report("Penjualan kembar (pembuat, pelanggan, total, tanggal sama; dibuat ≤ 2 menit)", await q`
    SELECT a.number AS a, b.number AS b, a."customerName", a.total::text AS total FROM "Sale" a JOIN "Sale" b ON a.id < b.id
    AND a."cancelledAt" IS NULL AND b."cancelledAt" IS NULL AND a."createdBy" = b."createdBy" AND a."customerName" = b."customerName"
    AND a.total = b.total AND a.date = b.date AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= 120 LIMIT 200`);
  report("Pembelian kembar (supplier, total, tanggal sama; dibuat ≤ 2 menit)", await q`
    SELECT a.number AS a, b.number AS b, a.vendor, a.total::text AS total FROM "Purchase" a JOIN "Purchase" b ON a.id < b.id
    AND a."cancelledAt" IS NULL AND b."cancelledAt" IS NULL AND a.vendor = b.vendor AND a.total = b.total AND a.date = b.date
    AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= 120 LIMIT 200`);
  report("Retur aktif dengan no. resi sama", await q`
    SELECT "trackingNo", COUNT(*)::int AS n, array_agg(number) AS nomor FROM "ReturnCase" WHERE "cancelledAt" IS NULL GROUP BY "trackingNo" HAVING COUNT(*) > 1 LIMIT 200`, "retur kedua yang disengaja (konfirmasi) boleh; cek manual");
  report("Penerimaan barang (TRM) kembar: pembelian, isi & waktu sama ≤ 2 menit", await q`
    SELECT a.number AS a, b.number AS b FROM "PurchaseReceipt" a JOIN "PurchaseReceipt" b ON a.id < b.id AND a."purchaseId" = b."purchaseId"
    AND a.value = b.value AND a.lines::text = b.lines::text AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= 120 LIMIT 200`);
  report("Cicilan penjualan kembar (nota, nominal, tanggal sama; dibuat ≤ 2 menit; belum dibatalkan)", await q`
    SELECT s.number, a.amount::text AS amount FROM "SalePayment" a JOIN "SalePayment" b ON a.id < b.id AND a."saleId" = b."saleId" AND a.amount = b.amount
    AND a.date = b.date AND a."cancelledAt" IS NULL AND b."cancelledAt" IS NULL AND NOT a.initial AND NOT b.initial
    AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= 120 JOIN "Sale" s ON s.id = a."saleId" LIMIT 200`);

  console.log("\n== 2. Nomor dokumen ==");
  const tables: [string, string, string][] = [["Sale", "number", "JUAL"], ["Purchase", "number", "PBL"], ["PurchaseReceipt", "number", "TRM"], ["ReturnCase", "number", "RTR"], ["Payable", "number", "UTG"], ["Receivable", "number", "PIU"]];
  const dupNo: Row[] = [];
  const lag: Row[] = [];
  for (const [t, c, p] of tables) {
    for (const r of await prisma.$queryRawUnsafe<Row[]>(`SELECT "${c}" AS nomor, COUNT(*)::int AS n FROM "${t}" GROUP BY "${c}" HAVING COUNT(*) > 1 LIMIT 50`)) dupNo.push({ tabel: t, ...r });
    // Penghitung (Counter) tidak boleh di bawah nomor terbesar yang sudah terpakai, bila tidak nomor berikutnya bentrok
    const maxes = await prisma.$queryRawUnsafe<{ key: string; max: number }[]>(
      `SELECT substring("${c}" from '^(${p}-[0-9]{6})-') AS key, MAX(substring("${c}" from '-([0-9]+)$')::int) AS max FROM "${t}" WHERE "${c}" ~ '^${p}-[0-9]{6}-[0-9]+$' GROUP BY 1`);
    const counters = new Map((await prisma.counter.findMany({ where: { key: { startsWith: `${p}-` } } })).map((x) => [x.key, x.value]));
    for (const m of maxes) if ((counters.get(m.key) ?? 0) < m.max) lag.push({ tabel: t, key: m.key, counter: counters.get(m.key) ?? null, nomorTerbesar: m.max });
  }
  report("Nomor dokumen kembar", dupNo);
  report("Counter tertinggal dari nomor terpakai (nomor berikutnya bisa bentrok)", lag);

  console.log("\n== 3. Mutasi stok ==");
  report("Mutasi persis sama lebih dari sekali (barang, jenis, lokasi, qty, ref, waktu)", await q`
    SELECT "itemId", type::text AS type, ref, qty::text AS qty, date, COUNT(*)::int AS n FROM "StockMovement" WHERE ref IS NOT NULL
    GROUP BY "itemId", type, "fromLocationId", "toLocationId", qty, ref, date, "unitCost" HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 200`, "boleh sah bila satu dokumen punya dua baris barang sama; cek per ref");
  report("Penjualan: qty keluar stok ≠ qty baris nota (nota tidak dibatalkan)", await q`
    SELECT s.number, l.qty::text AS qty_nota, COALESCE(m.qty,0)::text AS qty_stok FROM "Sale" s
    JOIN (SELECT "saleId", SUM(qty) AS qty FROM "SaleLine" GROUP BY 1) l ON l."saleId" = s.id
    LEFT JOIN (SELECT ref, SUM(qty) AS qty FROM "StockMovement" WHERE type = 'PENGELUARAN' GROUP BY ref) m ON m.ref = s.number
    WHERE s."cancelledAt" IS NULL AND l.qty <> COALESCE(m.qty,0) LIMIT 200`);
  report("Penjualan dibatalkan: stok kembali ≠ stok keluar (batal 2x / tidak kembali)", await q`
    SELECT s.number, COALESCE(o.qty,0)::text AS keluar, COALESCE(b.qty,0)::text AS kembali FROM "Sale" s
    LEFT JOIN (SELECT ref, SUM(qty) AS qty FROM "StockMovement" WHERE type = 'PENGELUARAN' GROUP BY ref) o ON o.ref = s.number
    LEFT JOIN (SELECT ref, SUM(qty) AS qty FROM "StockMovement" WHERE type = 'PENERIMAAN' GROUP BY ref) b ON b.ref = 'BATAL ' || s.number
    WHERE s."cancelledAt" IS NOT NULL AND COALESCE(o.qty,0) <> COALESCE(b.qty,0) LIMIT 200`);
  report("Pembelian diterima: qty masuk stok ≠ qty diterima di baris pesanan", await q`
    SELECT p.number, l.qty::text AS qty_diterima, COALESCE(m.qty,0)::text AS qty_stok FROM "Purchase" p
    JOIN (SELECT "purchaseId", SUM("qtyReceived") AS qty FROM "PurchaseLine" GROUP BY 1) l ON l."purchaseId" = p.id
    LEFT JOIN (SELECT ref, SUM(qty) AS qty FROM "StockMovement" WHERE type = 'PENERIMAAN' GROUP BY ref) m ON m.ref = p.number
    WHERE p."cancelledAt" IS NULL AND ABS(l.qty - COALESCE(m.qty,0)) > 0.0005 LIMIT 200`, "pembelian dari saldo awal / sebelum cut-over mungkin berbeda");
  report("Jenis mutasi tidak cocok arah lokasi (mis. PENERIMAAN punya lokasi asal, mutasi tanpa lokasi)", await q`
    SELECT id, type::text AS type, ref FROM "StockMovement" WHERE ("fromLocationId" IS NULL AND "toLocationId" IS NULL)
      OR (type IN ('PENERIMAAN','HASIL_PRODUKSI') AND "fromLocationId" IS NOT NULL) OR (type IN ('PENGELUARAN','KONSUMSI_PRODUKSI') AND "toLocationId" IS NOT NULL)
      OR (type = 'TRANSFER' AND ("fromLocationId" IS NULL OR "toLocationId" IS NULL)) LIMIT 200`);
  report("Mutasi bernilai jurnal tetapi jurnal ganda (lebih dari satu jurnal STOK per mutasi)", await q`
    SELECT "sourceId" AS mutasi, COUNT(*)::int AS n FROM "Journal" WHERE source = 'STOK' AND "reversalOfId" IS NULL AND "sourceId" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 200`);
  report("Jurnal penjualan ganda per nota (jurnal 'Penjualan …' lebih dari satu, bukan pembalik)", await q`
    SELECT "sourceId" AS nota, COUNT(*)::int AS n FROM "Journal" WHERE source = 'PENJUALAN' AND "reversalOfId" IS NULL AND description LIKE 'Penjualan %' GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 200`);

  console.log("\n== 4. Saldo stok vs jumlah mutasi per barang ==");
  // Saldo stok disimpan hanya lewat mutasi (tidak ada kolom saldo): dua jalur hitung harus sama persis (per barang × lokasi)
  report("Selisih saldo per barang: total per lokasi ≠ Σ masuk − Σ keluar semua mutasi", await q`
    WITH loc AS (SELECT "itemId", SUM(q) AS s FROM (
        SELECT "itemId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL UNION ALL SELECT "itemId", -qty FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL) x GROUP BY 1),
      tot AS (SELECT "itemId", SUM(CASE WHEN "toLocationId" IS NOT NULL THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" IS NOT NULL THEN qty ELSE 0 END) AS s FROM "StockMovement" GROUP BY 1)
    SELECT i.sku, i.name, l.s::text AS per_lokasi, t.s::text AS total FROM loc l JOIN tot t USING ("itemId") JOIN "Item" i ON i.id = l."itemId" WHERE ABS(l.s - t.s) > 0.0005 LIMIT 200`);
  report("Stok minus per barang × lokasi (tidak sengaja)", await q`
    SELECT i.sku, i.name, l.name AS lokasi, b.qty::text AS qty FROM (
      SELECT "itemId", "locationId", SUM(q) AS qty FROM (SELECT "itemId", "toLocationId" AS "locationId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL
      UNION ALL SELECT "itemId", "fromLocationId", -qty FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL) m GROUP BY 1,2 HAVING SUM(q) < -0.0005) b
    JOIN "Item" i ON i.id = b."itemId" JOIN "Location" l ON l.id = b."locationId" ORDER BY b.qty LIMIT 200`, "minus saat penjualan sebelum produksi diinput memang diizinkan; cek apakah wajar");
  report("Nilai persediaan stok ≠ buku besar (akun 1-1401/1402/1403)", await (async () => {
    const out: Row[] = [];
    for (const [code, type] of [["1-1401", "BAHAN_BAKU"], ["1-1402", "BARANG_DALAM_PROSES"], ["1-1403", "BARANG_JADI"]]) {
      const [gl] = await q<{ v: bigint | null }>`SELECT SUM(jl.debit - jl.credit) AS v FROM "JournalLine" jl JOIN "CoaAccount" a ON a.id = jl."accountId" WHERE a.code = ${code}`;
      const [st] = await q<{ v: number | null }>`SELECT SUM(b.qty * i."avgCost") AS v FROM (
        SELECT "itemId", SUM(q) AS qty FROM (SELECT "itemId", qty AS q FROM "StockMovement" WHERE "toLocationId" IS NOT NULL UNION ALL SELECT "itemId", -qty FROM "StockMovement" WHERE "fromLocationId" IS NOT NULL) m GROUP BY 1) b
        JOIN "Item" i ON i.id = b."itemId" WHERE i.type::text = ${type}`;
      const diff = Math.round(Number(st?.v ?? 0)) - Number(gl?.v ?? 0);
      if (Math.abs(diff) > 1000) out.push({ akun: code, bukuBesar: Number(gl?.v ?? 0), nilaiStok: Math.round(Number(st?.v ?? 0)), selisih: diff });
    }
    return out;
  })(), "toleransi pembulatan Rp1.000; harga rata-rata berubah-ubah membuat selisih kecil wajar");

  console.log("\n== 5. Master ganda ==");
  report("Barang aktif bernama sama (jenis sama, tanpa beda huruf besar/kecil)", await q`
    SELECT lower(name) AS nama, type::text AS jenis, COUNT(*)::int AS n, array_agg(sku ORDER BY sku) AS sku FROM "Item" WHERE active GROUP BY lower(name), type HAVING COUNT(*) > 1 LIMIT 200`, "bahan baku per divisi (BB-<DIV>-xxx) memang boleh senama; yang mencurigakan: nama sama + SKU satu kelompok, atau dibuat berdekatan");
  report("SKU kembar beda huruf besar/kecil atau spasi", await q`
    SELECT upper(trim(sku)) AS sku, COUNT(*)::int AS n FROM "Item" GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 200`);
  report("Pelanggan bernama sama", await q`
    SELECT lower(trim(name)) AS nama, COUNT(*)::int AS n, array_agg(code) AS kode FROM "Customer" GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 200`);
  const sups = await prisma.supplier.findMany({ select: { id: true, code: true, name: true } });
  const bySup = new Map<string, typeof sups>();
  for (const s of sups) { const k = supplierKey(s.name); if (k.length >= 2) bySup.set(k, [...(bySup.get(k) ?? []), s]); }
  report("Supplier bernama sama (setelah nama dinormalkan seperti di aplikasi)", [...bySup.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ nama: k, kode: v.map((x) => x.code), id: v.map((x) => x.id) })));
  // Sisa Single Pack yang seharusnya sudah disatukan ke barang jadi produk SATUAN per series (MG-001/002/003/064)
  const canon = new Set((await prisma.product.findMany({ where: { type: "SATUAN", active: true, finishedItemId: { not: null } }, select: { finishedItemId: true } })).map((p) => p.finishedItemId!));
  const items = await prisma.item.findMany({ where: { active: true }, select: { id: true, sku: true, name: true } });
  const left: Row[] = [];
  for (const v of SINGLE_PACK_VARIANTS) for (const i of items) if (!canon.has(i.id) && isSinglePackCandidate(v, i)) left.push({ series: v, sku: i.sku, nama: i.name, id: i.id });
  report("Sisa Single Pack aktif yang bukan barang jadi produk SATUAN (belum disatukan)", left, "jalankan npm run single-pack:cek untuk detail");
  report("Produk jadi (aktif) memakai barang yang sama lebih dari satu produk", await q`
    SELECT "finishedItemId", COUNT(*)::int AS n, array_agg(sku) AS produk FROM "Product" WHERE "finishedItemId" IS NOT NULL AND active GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 200`);

  console.log(`\nSelesai. ${findings ? `${f(findings)} temuan: kirim ke koordinator untuk dibuatkan skrip perbaikan (preview dulu, backup dulu).` : "Tidak ada temuan."}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); if (findings && !process.exitCode) process.exitCode = 1; });
