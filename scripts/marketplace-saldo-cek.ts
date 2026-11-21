/**
 * Rincian saldo dompet marketplace per toko × kanal (HANYA BACA; hanya angka agregat, tanpa data pribadi).
 *   npm run marketplace:saldo-cek                 → semua toko
 *   npm run marketplace:saldo-cek -- --toko=MG    → satu toko (kode)
 * Mencetak: saldo awal (sumber) + cair + penyesuaian − top-up iklan − GMV Pay − withdraw = estimasi; vs saldo menurut
 * marketplace (Saldo Akhir file Saldo Penjual Shopee / isian Finance) → selisih + kandidat penyebab.
 */
import { prisma } from "../src/lib/db";
import { matchWithdrawals, saldoPanel } from "../src/lib/marketplace/saldo";

const idr = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;
async function main() {
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
    console.log(`  Withdraw: file ${fileRows.length} · tercatat di ERP ${ok.length} (${fromFile.length} di rekening bersama ditetapkan tokonya dari file) · belum tercatat ${miss.length} (${idr(miss.reduce((a, x) => a + (x.fileAmount ?? 0), 0))})`);
    for (const c of w.causes) console.log(`  ! ${c}`);
    console.log();
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(2); });
