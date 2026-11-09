/**
 * Tautkan uang rekening lama dari menu lain (pembelian, gaji, kasbon, borongan, dana sisihan, penjualan, pinjaman,
 * piutang, aset) ke menu Transaksi sebagai baris tertaut. TIDAK membuat jurnal baru: baris Transaksi merujuk jurnal
 * sumbernya, jadi saldo & laporan tidak berubah. Jurnal yang sudah dibalik → baris berstatus Dibatalkan.
 *
 *   npm run tautkan:transaksi                 → pratinjau (tidak mengubah apa pun)
 *   npm run tautkan:transaksi -- --jalankan   → simpan
 *
 * Aman diulang: jurnal yang sudah punya baris tertaut dilewati.
 */
import { prisma } from "../src/lib/db";
import { bankMoves, mirrorJournal, MIRROR_SOURCES } from "../src/lib/txMirror";

const run = process.argv.includes("--jalankan");
const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");
const wib = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16);

async function main() {
  console.log(run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)");
  const banks = await prisma.bankAccount.findMany({ select: { id: true, coaAccountId: true, name: true } });
  const journals = await prisma.journal.findMany({
    where: { source: { in: Object.keys(MIRROR_SOURCES) }, reversalOfId: null, lines: { some: { accountId: { in: banks.map((b) => b.coaAccountId) } } } },
    include: { lines: true },
    orderBy: { date: "asc" },
  });
  const reversed = new Set((await prisma.journal.findMany({ where: { reversalOfId: { in: journals.map((j) => j.id) } }, select: { reversalOfId: true } })).map((j) => j.reversalOfId!));
  const existing = new Set((await prisma.financeTransaction.findMany({ where: { origin: { not: null } }, select: { idempotencyKey: true } })).map((t) => t.idempotencyKey));
  let add = 0;
  let skip = 0;
  const per = new Map<string, number>();
  for (const j of journals) {
    const rows = bankMoves(j.id, j.lines, banks).filter((r) => !existing.has(r.key));
    if (!rows.length) {
      skip++;
      continue;
    }
    for (const r of rows) {
      const bank = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "-";
      console.log(`  ${wib(j.date)} ${j.number.padEnd(16)} ${MIRROR_SOURCES[j.source].label.padEnd(14)} ${r.direction.padEnd(8)} ${idr(r.amount).padStart(14)}  ${bank(r.accountId)}${r.toAccountId ? ` → ${bank(r.toAccountId)}` : ""}${reversed.has(j.id) ? "  [jurnal sudah dibalik → Dibatalkan]" : ""}  ${j.description.slice(0, 60)}`);
      per.set(j.source, (per.get(j.source) ?? 0) + 1);
      add++;
    }
    if (run) await prisma.$transaction((tx) => mirrorJournal(tx, j.id, { status: reversed.has(j.id) ? "DIBATALKAN" : "DIBUKUKAN" }));
  }
  console.log(`\nBaris baru: ${add} (${[...per].map(([s, n]) => `${MIRROR_SOURCES[s].label} ${n}`).join(", ") || "-"}) · sudah tertaut: ${skip}`);
  console.log(run ? "Tersimpan. Saldo rekening tidak berubah (tidak ada jurnal baru)." : "Belum ada yang diubah.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
