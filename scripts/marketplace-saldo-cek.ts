/**
 * Rincian saldo dompet marketplace per toko × kanal (HANYA BACA; hanya angka agregat, tanpa data pribadi).
 *   npm run marketplace:saldo-cek                 → semua toko
 *   npm run marketplace:saldo-cek -- --toko=MG    → satu toko (kode)
 *   npm run marketplace:saldo-cek -- --diagnosa [--dari=2026-11-01 --sampai=2026-11-30]  → cara withdraw tercatat di Keuangan
 * Mencetak: saldo awal (sumber) + cair + penyesuaian − top-up iklan − GMV Pay − withdraw = estimasi; vs saldo menurut
 * marketplace (Saldo Akhir file Saldo Penjual Shopee / isian Finance) → selisih + kandidat penyebab.
 */
import { prisma } from "../src/lib/db";
import { matchWithdrawals, saldoPanel, wdSummary } from "../src/lib/marketplace/saldo";
import { diagnoseWithdraws } from "../src/lib/marketplace/diagnosa";

const idr = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;
async function diagnosa() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const d = await diagnoseWithdraws({ from: arg("dari") ?? "2026-11-01", to: arg("sampai") ?? new Date().toISOString().slice(0, 10) });
  console.log(`DIAGNOSA withdraw ${d.range.from} s/d ${d.range.to} (baca saja, tanpa data pribadi)`);
  console.log(`Penarikan di file: ${d.fileWithdraws} (${d.fileByChannel.map((c) => `${c.ch === "SHP" ? "Shopee" : "TikTok"} ${c.count} = ${idr(c.sum)}`).join(" · ")}) · hari dengan >1 penarikan satu kanal: ${d.daysWithMultipleWithdraws}`);
  console.log(`Transaksi Keuangan (masuk/transfer) pada rentang: ${d.financeTxInRange}; kandidat (nominal sama dengan penarikan file ATAU kata withdraw/tarik/shopee/tiktok/tts/shp): ${d.candidates.length}`);
  console.log("\nRingkasan kombinasi (jumlah · total · yang nominalnya sama dengan penarikan file):");
  for (const [k, v] of d.combos) console.log(`  ${v.count} × ${idr(v.sum)} · nominal-sama ${v.sameAmt} · ${k}`);
  console.log("\nBila toleransi tanggal dilebarkan (nominal sama, satu-satu, di antara kandidat):");
  for (const t of d.tol) console.log(`  ±${t.days} hari: ${t.files} penarikan file cocok dengan ${t.txs} transaksi`);
  console.log("\nDistribusi selisih HARI KALENDER WIB (tanggal transaksi − tanggal file) pada pasangan nominal-sama ±5 hari:");
  for (const [ch, m] of Object.entries(d.dayDistribution)) console.log(`  ${ch === "SHP" ? "Shopee" : "TikTok"}: ${[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((k) => `${k > 0 ? "+" : ""}${k}:${m[k] ?? 0}`).join("  ")}`);
  console.log(`\nPenarikan file TANPA padanan (±5 hari, nominal sama): ${d.unmatchedFiles.length}`);
  for (const f of d.unmatchedFiles) console.log(`  ${f.date} · ${f.ch === "SHP" ? "Shopee" : "TikTok"} · ${f.store} · ${idr(f.amount)}`);
  console.log(`Transaksi dari rekening Saldo Penjual TANPA padanan: ${d.unmatchedTx.length}`);
  for (const c of d.unmatchedTx) console.log(`  ${c.date} · ${c.from} → ${c.to} · ${c.source} · ${c.store} · ${idr(c.amount)}`);
  console.log(`\nSatu transaksi = jumlah 2–4 penarikan file (satu kanal, ±2 hari; sisa yang belum cocok 1-1 pada ±5 hari): ${d.sumMatches.txs} transaksi cocok dari ${d.sumMatches.candidatesLeft} sisa kandidat${d.sumMatches.details.length ? ` (${d.sumMatches.details.map((x) => `${x.parts} penarikan${x.crossStore ? " lintas toko" : ""}`).join(", ")})` : ""}`);
  console.log("\nDaftar kandidat (tanggal · jenis · asal → tujuan · kategori · sumber · toko · ref · nominal):");
  for (const c of d.candidates) console.log(`  ${c.date} · ${c.dir} · ${c.from} → ${c.to} · ${c.cat} · ${c.source}${c.origin !== "-" ? `/${c.origin}` : ""} · ${c.store} · ref ${c.hasRef ? "ada" : "tidak"} · ${idr(c.amount)}${c.sameAmountAsFile ? " · =file" : ""}${c.keyword ? " · kata" : ""}`);
  await prisma.$disconnect();
}
async function main() {
  if (process.argv.includes("--diagnosa")) return diagnosa();
  const code = process.argv.find((a) => a.startsWith("--toko="))?.split("=")[1];
  const store = code ? await prisma.store.findUnique({ where: { code } }) : null;
  if (code && !store) throw new Error(`Toko ${code} tidak ditemukan`);
  const rows = await saldoPanel({ storeId: store?.id });
  if (!rows.length) console.log("Belum ada data cair.");
  for (const r of rows) {
    const w = r.wallet;
    console.log(`${r.store} · ${r.channel === "SHP" ? "Shopee" : "TikTok"}`);
    console.log(`  Saldo awal (${w.opening.source === "FILE" ? `file Saldo Penjual ${w.opening.from}` : "tidak diketahui → 0"}) : ${idr(w.opening.amount)}`);
    console.log(`  + Cair pesanan                : ${idr(w.cair)}`);
    console.log(`  + Penyesuaian                 : ${idr(w.adjust)}`);
    console.log(`  + Top-up saldo iklan          : ${idr(w.topup)}`);
    console.log(`  + Potongan GMV Pay            : ${idr(w.gmv)}`);
    console.log(`  − Withdraw (satu sumber)      : ${idr(w.withdraw)}`);
    console.log(`  = Estimasi ERP sejak awal     : ${idr(w.estimate)}`);
    if (r.channel === "TTS") console.log(`  Dana dalam perjalanan (withdraw diminta, belum masuk rekening): ${idr(w.transit.amount)} (${w.transit.count} withdraw)`);
    console.log(`  Saldo menurut marketplace     : ${w.official ? `${idr(w.official.amount)} per ${w.official.asOf}${w.official.at ? ` ${w.official.at} WIB` : ""} (${w.official.source === "FILE" ? "Saldo Akhir file" : "isian Finance"})` : "belum ada acuan"}`);
    if (w.diff !== null) console.log(`  Selisih (acuan − estimasi)    : ${idr(w.diff)}`);
    console.log(`  Saldo untuk kartu dashboard   : ${idr(w.balance)} (${w.basis === "ACUAN" ? "acuan + mutasi sesudahnya" : "estimasi"})`);
    console.log(`  Withdraw Keuangan tanpa padanan di file (tidak dikurangkan): ${w.ignoredErp.count} (${idr(w.ignoredErp.amount)}) · penarikan file belum di Keuangan: ${w.notInErp.count} (${idr(w.notInErp.amount)})`);
    const m = await matchWithdrawals({ storeId: r.storeId, channel: r.channel as "SHP" | "TTS", from: "2020-01-01", to: "2099-12-31" });
    const fileRows = m.filter((x) => x.fileAmount !== null), ok = m.filter((x) => x.status === "COCOK"), miss = m.filter((x) => x.status === "BELUM_DI_ERP"), fromFile = ok.filter((x) => x.via?.startsWith("FILE"));
    const sm = wdSummary(m);
    console.log(`  Withdraw: file ${fileRows.length} · tercatat di ERP ${ok.length} (${fromFile.length} di rekening bersama ditetapkan tokonya dari file) · belum tercatat ${miss.length} (${idr(miss.reduce((a, x) => a + (x.fileAmount ?? 0), 0))})`);
    console.log(`    dari yang belum tercatat: ${sm.before.length} (${idr(sm.beforeSum)}) SEBELUM withdraw tercatat pertama di Keuangan (${sm.firstDay ?? "-"}) · ${sm.recent.length} (${idr(sm.recentSum)}) sesudahnya`);
    for (const c of w.causes) console.log(`  ! ${c}`);
    console.log();
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(2); });
