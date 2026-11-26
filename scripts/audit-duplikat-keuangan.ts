/*
 * Deteksi DATA GANDA & ketidakseimbangan modul Keuangan (HANYA MEMBACA: semua query SELECT, tidak mengubah data).
 *
 *   npx tsx scripts/audit-duplikat-keuangan.ts            -> ringkasan + contoh id (maks 5 per temuan)
 *   npx tsx scripts/audit-duplikat-keuangan.ts --semua    -> semua id
 *
 * Cakupan: jurnal tak seimbang, nomor jurnal ganda, jurnal sumber sama terposting >1x, jurnal dibalik >1x, penyusutan ganda,
 * transaksi/withdraw/transfer ganda, piutang/hutang/aset kembar, saldo hutang-piutang melebihi pokok, impor marketplace
 * (file sama, penarikan, mutasi saldo, event penghasilan kembar), buku bayangan (Opsi B) tak seimbang / mode LIVE.
 * Keluar dengan kode 1 bila ada temuan, 0 bila bersih.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ALL = process.argv.includes("--semua");
let findings = 0;
const h = (t: string) => console.log(`\n==== ${t} ====`);
const idr = (n: unknown) => "Rp" + Number(n).toLocaleString("id-ID");

type Row = Record<string, unknown>;
async function check(title: string, why: string, sql: Promise<Row[]>, fmt: (r: Row) => string) {
  const rows = await sql;
  if (!rows.length) return console.log(`✓ ${title}: tidak ada`);
  findings += rows.length;
  console.log(`✗ ${title}: ${rows.length} temuan — ${why}`);
  for (const r of ALL ? rows : rows.slice(0, 5)) console.log(`    · ${fmt(r)}`);
  if (!ALL && rows.length > 5) console.log(`    … ${rows.length - 5} lagi (jalankan dengan --semua)`);
}
const q = (s: TemplateStringsArray) => prisma.$queryRaw<Row[]>(s as unknown as TemplateStringsArray);

async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1)} · BACA-SAJA`);

  h("A. JURNAL");
  await check("Jurnal tidak seimbang (debit ≠ kredit)", "neraca pasti salah", q`
    SELECT j.id, j.number, SUM(l.debit)::text AS d, SUM(l.credit)::text AS c FROM "Journal" j JOIN "JournalLine" l ON l."journalId"=j.id GROUP BY j.id HAVING SUM(l.debit)<>SUM(l.credit) LIMIT 500`, (r) => `${r.number} (${r.id}) debit ${r.d} ≠ kredit ${r.c}`);
  await check("Jurnal tanpa baris", "jurnal kosong", q`
    SELECT j.id, j.number FROM "Journal" j WHERE NOT EXISTS (SELECT 1 FROM "JournalLine" l WHERE l."journalId"=j.id) LIMIT 500`, (r) => `${r.number} (${r.id})`);
  await check("Nomor jurnal ganda", "nomor harus unik", q`
    SELECT number, COUNT(*)::int n, MIN(id) id FROM "Journal" GROUP BY number HAVING COUNT(*)>1`, (r) => `${r.number} ×${r.n} (mis. ${r.id})`);
  await check("Jurnal dibalik lebih dari sekali", "satu jurnal hanya boleh punya satu pembalik", q`
    SELECT "reversalOfId" id, COUNT(*)::int n FROM "Journal" WHERE "reversalOfId" IS NOT NULL GROUP BY "reversalOfId" HAVING COUNT(*)>1`, (r) => `jurnal ${r.id} dibalik ${r.n}×`);
  await check("Jurnal aktif dari sumber yang sama terposting >1x", "kemungkinan posting ganda (pembalik & yang sudah dibalik tidak dihitung)", q`
    SELECT j.source, j."sourceId", COUNT(*)::int n, MIN(j.id) id, STRING_AGG(j.number, ', ') nums FROM "Journal" j
    WHERE j."sourceId" IS NOT NULL AND j."reversalOfId" IS NULL AND j.source NOT IN ('PEMBALIK','PIUTANG','UTANG')
      AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId"=j.id)
    GROUP BY j.source, j."sourceId" HAVING COUNT(*)>1 ORDER BY n DESC LIMIT 500`, (r) => `${r.source}/${r.sourceId} ×${r.n}: ${r.nums}`);
  await check("Penyusutan ganda (aset & bulan sama)", "penyusutan terposting dobel", q`
    SELECT "sourceId", COUNT(*)::int n, STRING_AGG(number, ', ') nums FROM "Journal" WHERE source='PENYUSUTAN' AND "reversalOfId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId"="Journal".id)
    GROUP BY "sourceId" HAVING COUNT(*)>1`, (r) => `${r.sourceId} ×${r.n}: ${r.nums}`);
  await check("Jurnal manual identik berdekatan (<2 menit, pembuat sama)", "indikasi klik ganda", q`
    SELECT a.id, a.number, b.number n2, a.description FROM "Journal" a JOIN "Journal" b ON b.id>a.id AND b.source=a.source AND b."createdBy"=a."createdBy" AND b.date=a.date AND b.description=a.description
      AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<120
    WHERE a.source IN ('MANUAL','PENYESUAIAN','SALDO_AWAL','ASET','PIUTANG','UTANG') AND a."reversalOfId" IS NULL AND b."reversalOfId" IS NULL
      AND (SELECT SUM(debit) FROM "JournalLine" WHERE "journalId"=a.id)=(SELECT SUM(debit) FROM "JournalLine" WHERE "journalId"=b.id) LIMIT 500`, (r) => `${r.number} & ${r.n2}: ${r.description}`);

  h("B. TRANSAKSI KEUANGAN / WITHDRAW / TRANSFER");
  await check("Transaksi dibukukan tanpa jurnal / jurnal tak ditemukan", "status tidak sinkron dengan buku besar", q`
    SELECT t.id, t.number FROM "FinanceTransaction" t WHERE t.status IN ('DIBUKUKAN','DALAM_PROSES') AND (t."journalId" IS NULL OR NOT EXISTS (SELECT 1 FROM "Journal" j WHERE j.id=t."journalId")) LIMIT 500`, (r) => `${r.number} (${r.id})`);
  await check("No. referensi withdraw sama di >1 transaksi aktif", "withdraw tercatat 2x (calon unique index tahap 2)", q`
    SELECT "withdrawRef" ref, COUNT(*)::int n, STRING_AGG(number, ', ') nums FROM "FinanceTransaction"
    WHERE "withdrawRef" IS NOT NULL AND "withdrawRef"<>'' AND status NOT IN ('DITOLAK','DIBATALKAN') AND "deletedAt" IS NULL GROUP BY "withdrawRef" HAVING COUNT(*)>1`, (r) => `ref ${r.ref} ×${r.n}: ${r.nums}`);
  await check("Transfer antar rekening kembar (rekening, nominal sama, <3 menit)", "transfer/withdraw dobel", q`
    SELECT a.id, a.number, b.number n2, a.amount::text amt FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.direction=a.direction AND b."accountId"=a."accountId" AND b."toAccountId" IS NOT DISTINCT FROM a."toAccountId" AND b.amount=a.amount
      AND ABS(EXTRACT(EPOCH FROM (b.date-a.date)))<180
    WHERE a.direction='TRANSFER' AND a.status NOT IN ('DITOLAK','DIBATALKAN') AND b.status NOT IN ('DITOLAK','DIBATALKAN') AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL LIMIT 500`, (r) => `${r.number} & ${r.n2}: ${idr(r.amt)}`);
  await check("Transaksi dibukukan dobel (sidik jari sama, <3 menit, catatan sama)", "kemungkinan input ganda", q`
    SELECT a.id, a.number, b.number n2, a.amount::text amt FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.fingerprint=a.fingerprint AND b.note IS NOT DISTINCT FROM a.note AND b."createdBy"=a."createdBy"
      AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<180
    WHERE a.direction<>'TRANSFER' AND a.status='DIBUKUKAN' AND b.status='DIBUKUKAN' AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL LIMIT 500`, (r) => `${r.number} & ${r.n2}: ${idr(r.amt)}`);
  await check("Satu jurnal FINANCE dipakai >1 transaksi", "tautan jurnal ganda", q`
    SELECT "journalId" id, COUNT(*)::int n, STRING_AGG(number, ', ') nums FROM "FinanceTransaction" WHERE "journalId" IS NOT NULL AND status IN ('DIBUKUKAN','DALAM_PROSES') GROUP BY "journalId" HAVING COUNT(*)>1`, (r) => `jurnal ${r.id}: ${r.nums}`);

  h("C. PIUTANG / HUTANG / ASET");
  await check("Piutang kembar (pelanggan, nominal, tanggal sama, <2 menit)", "klik ganda", q`
    SELECT a.number, b.number n2, a.customer FROM "Receivable" a JOIN "Receivable" b ON b.id>a.id AND b.customer=a.customer AND b.amount=a.amount AND b.date=a.date AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<120`, (r) => `${r.number} & ${r.n2} (${r.customer})`);
  await check("Hutang kembar (pemasok, nominal, tanggal sama, <2 menit)", "klik ganda", q`
    SELECT a.number, b.number n2, a.vendor FROM "Payable" a JOIN "Payable" b ON b.id>a.id AND b.vendor=a.vendor AND b.amount=a.amount AND b.date=a.date AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<120`, (r) => `${r.number} & ${r.n2} (${r.vendor})`);
  await check("Piutang terbayar melebihi nominal", "pelunasan paralel / ganda", q`SELECT number, amount::text a, paid::text p FROM "Receivable" WHERE paid>amount`, (r) => `${r.number}: nominal ${r.a}, dibayar ${r.p}`);
  await check("Hutang terbayar melebihi nominal", "pembayaran ganda", q`SELECT number, amount::text a, paid::text p FROM "Payable" WHERE paid>amount`, (r) => `${r.number}: nominal ${r.a}, dibayar ${r.p}`);
  await check("Aset tetap kembar (nama, harga, tanggal sama)", "perolehan aset dobel", q`
    SELECT name, cost::text c, COUNT(*)::int n, MIN(id) id FROM "FixedAsset" GROUP BY name, cost, "acquiredAt" HAVING COUNT(*)>1`, (r) => `${r.name} ${idr(r.c)} ×${r.n} (mis. ${r.id})`);
  await check("Jurnal aset tanpa catatan aset (perolehan tanpa kartu aset)", "jurnal ASET tak punya FixedAsset", q`
    SELECT j.id, j.number, j.description FROM "Journal" j WHERE j.source='ASET' AND j."reversalOfId" IS NULL AND NOT EXISTS (SELECT 1 FROM "FixedAsset" f WHERE f."journalId"=j.id)
      AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId"=j.id) LIMIT 200`, (r) => `${r.number}: ${r.description}`);

  h("D. IMPOR MARKETPLACE");
  await check("File yang sama (hash) diimpor aktif >1x", "unggah ganda", q`
    SELECT stats->>'fileHash' h, COUNT(*)::int n, STRING_AGG("fileName", ' | ') f FROM "MarketplaceImport" WHERE "undoneAt" IS NULL AND stats->>'fileHash' IS NOT NULL GROUP BY stats->>'fileHash' HAVING COUNT(*)>1`, (r) => `${String(r.h).slice(0, 10)}… ×${r.n}: ${r.f}`);
  await check("Penarikan marketplace kembar (toko, kanal, nominal, waktu sama, refId beda)", "withdraw terhitung 2x", q`
    SELECT a."storeId", a.channel, a.amount::text amt, COUNT(*)::int n, STRING_AGG(a."refId", ', ') refs FROM "MarketplaceWithdrawal" a WHERE a."requestedAt" IS NOT NULL
    GROUP BY a."storeId", a.channel, a."txType", a.amount, a."requestedAt" HAVING COUNT(*)>1`, (r) => `${r.channel} ${idr(r.amt)} ×${r.n}: ${r.refs}`);
  await check("Mutasi saldo kembar (toko, kanal, waktu, nominal, pesanan, keterangan, urutan sama; txKey beda)", "baris saldo penjual dobel", q`
    SELECT "storeId", channel, date, amount::text amt, "orderNo", description, pos, COUNT(*)::int n FROM "MarketplaceBalanceTx" GROUP BY "storeId", channel, date, amount, "orderNo", description, pos HAVING COUNT(*)>1 LIMIT 500`, (r) => `${r.channel} ${r.orderNo ?? "-"} ${idr(r.amt)} ×${r.n}`);
  await check("Event penghasilan kembar (income, waktu, nominal sama; eventKey beda)", "cair/fee terhitung 2x", q`
    SELECT "incomeId", "releasedAt", released::text rel, "productAmt"::text pa, COUNT(*)::int n FROM "MarketplaceIncomeEvent" GROUP BY "incomeId", "releasedAt", released, "productAmt", fees HAVING COUNT(*)>1 LIMIT 500`, (r) => `income ${r.incomeId} cair ${idr(r.rel)} ×${r.n}`);
  await check("Pesanan marketplace punya >1 invoice / satu invoice di >1 pesanan", "invoice ganda", q`
    SELECT "invoiceId" id, COUNT(*)::int n FROM "MarketplaceOrder" WHERE "invoiceId" IS NOT NULL GROUP BY "invoiceId" HAVING COUNT(*)>1`, (r) => `invoice ${r.id} dipakai ${r.n} pesanan`);

  h("E. BUKU BAYANGAN (OPSI B)");
  const mode = await prisma.setting.findUnique({ where: { key: "marketplace_gl_mode" } });
  console.log(`Mode buku bayangan: ${mode?.value ?? "SIMULASI (bawaan)"}`);
  if (mode?.value === "LIVE") { findings++; console.log("✗ Mode LIVE terdeteksi padahal belum diaktifkan resmi"); }
  await check("Jurnal bayangan tidak seimbang", "buku bayangan salah hitung", q`
    SELECT j.id, j.key, SUM(l.debit)::text d, SUM(l.credit)::text c FROM "MarketplaceGlJournal" j JOIN "MarketplaceGlLine" l ON l."journalId"=j.id GROUP BY j.id HAVING SUM(l.debit)<>SUM(l.credit) LIMIT 200`, (r) => `${r.key} debit ${r.d} ≠ kredit ${r.c}`);

  console.log(`\n${findings ? `✗ ${findings} temuan. Perbaikan = skrip terpisah (preview dulu, didahului npm run backup); jurnal terbukukan dibalik, bukan dihapus.` : "✓ Bersih: tidak ada data ganda / tak seimbang terdeteksi."}`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(findings ? 1 : 0)).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
