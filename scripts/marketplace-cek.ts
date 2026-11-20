/**
 * Cek integritas data marketplace (hanya baca).
 *   npm run marketplace:cek                          → bulan terbaru yang punya data, semua toko
 *   npm run marketplace:cek -- --bulan=2026-08       → bulan tertentu
 *   npm run marketplace:cek -- --toko=MG             → satu toko (kode)
 * Keluar dengan kode 1 bila ada pemeriksaan yang gagal.
 */
import { prisma } from "../src/lib/db";
import { integrityCheck, channelLabel } from "../src/lib/marketplace/integrity";
import { latestMonth } from "../src/lib/marketplace/dashboard";

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const month = arg("bulan") ?? (await latestMonth());
  const code = arg("toko");
  const store = code ? await prisma.store.findUnique({ where: { code } }) : null;
  if (code && !store) throw new Error(`Toko ${code} tidak ditemukan`);
  const r = await integrityCheck({ month, storeId: store?.id });
  console.log(`Cek integritas marketplace · ${month}\n`);
  for (const g of r.groups) {
    console.log(`${g.store} · ${channelLabel(g.channel)}`);
    for (const c of g.checks) {
      console.log(`  ${c.ok ? "✓" : "✗"} ${c.key}. ${c.label} — ${c.detail}`);
      for (const it of (c.items ?? []).slice(0, 10)) console.log(`       · ${it}`);
    }
    console.log();
  }
  const a = r.accounting;
  console.log(`g. Omzet marketplace ${a.omzet.toLocaleString("id-ID")} (${a.orders} pesanan) ↔ pendapatan dibukukan dari withdraw ${a.booked.toLocaleString("id-ID")} (tidak dijumlahkan; beda waktu pengakuan)\n`);
  console.log(`${r.failed} dari ${r.total} pemeriksaan gagal`);
  await prisma.$disconnect();
  if (r.failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(2); });
