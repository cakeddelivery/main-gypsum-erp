/*
 * Sinkronkan transfer lama di menu Transaksi ke Dana sisihan (sekali jalan, aman diulang).
 *
 *   npm run sinkron:sisihan                                   -> hanya MENAMPILKAN rencana (aman)
 *   npm run sinkron:sisihan -- --jalankan                     -> menyimpan yang pasti (✓)
 *   npm run sinkron:sisihan -- --pilih=TRX-202611-0069:0      -> pilih kemungkinan ke-0 untuk transaksi yang belum pasti (?)
 *   npm run sinkron:sisihan -- --lewati=TRX-202611-0070       -> jangan disinkronkan (bukan sisihan)
 *   (--pilih & --lewati boleh beberapa, pisahkan koma; gabungkan dengan --jalankan untuk menyimpan)
 *
 * Yang dicari (status Dibukukan, belum tercatat di Dana sisihan):
 * - Transfer dari rekening asal dana ke rekening simpanannya (Seabank → ShopeePay kompensasi Cak Ed & Jojo,
 *   Seabank → rekening tabungan untuk nabung cicilan SPinjam), nominal = kelipatan sisihan harian
 *   (tabungan cicilan boleh nominal bebas).
 * - Transfer bank → Saldo Penjual Shopee/TikTok (tidak mungkin; mis. TRX-202611-0069 "Ops 5 Nov 26"):
 *   rekening tujuan dibetulkan ke ShopeePay.
 * - Pengeluaran berketerangan nabung/tabung/spinjam/sisih/kompensasi/ops dari rekening asal dana: diubah jadi transfer.
 * Hasilnya: jurnal lama dibalik & dibukukan ulang (plus beban kompensasi untuk dana owner), sisihan tercatat
 * dengan bukti transfer transaksi tsb. Sisihan tanpa bukti di tanggal yang sama memakai transfer ini (tidak dobel).
 *
 * WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { linkBookedTransfer } from "../src/lib/finance";
import { reserveOptions } from "../src/lib/reserveSync";
import { walletForMarketplace } from "../src/lib/extract";
import { todayStr } from "../src/lib/time";

const apply = process.argv.includes("--jalankan");
const list = (k: string) => (process.argv.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const picks = new Map(list("pilih").map((x) => [x.split(":")[0].toUpperCase(), Number(x.split(":")[1] ?? 0)]));
const skips = new Set(list("lewati").map((x) => x.toUpperCase()));
const idr = (n: number | bigint) => `Rp ${Number(n).toLocaleString("id-ID")}`;
const KEYWORDS = /\b(nabung|tabung|tabungan|spinjam|sisih|sisihan|kompensasi|pengelola|ops|gaji owner)\b/i;
const LOAN_WORDS = /\b(nabung|tabung|tabungan|spinjam|cicil|pinjam|hutang|utang)\b/i;

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("User owner tidak ditemukan");
  const actor = { id: owner.id, name: "skrip sinkron-sisihan" };
  const [banks, funds] = await Promise.all([prisma.bankAccount.findMany(), prisma.reserveFund.findMany({ where: { active: true, kind: { in: ["OWNER", "LOAN_SAVING"] } } })]);
  const bankName = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "-";
  console.log("Dana sisihan aktif:");
  for (const f of funds) console.log(`   ${f.name} · ${idr(f.dailyAmount)}/hari · ${bankName(f.fromBankId)} → ${bankName(f.toBankId)}`);

  const rows = await prisma.financeTransaction.findMany({
    where: { status: "DIBUKUKAN", deletedAt: null, direction: { in: ["TRANSFER", "KELUAR"] }, reserveEntries: { none: {} } },
    orderBy: { date: "asc" },
    include: { _count: { select: { splits: true } } },
  });
  const fromBanks = new Set(funds.map((f) => f.fromBankId));
  let done = 0;
  let pending = 0;
  console.log("\nTransaksi yang cocok dengan dana sisihan:");
  for (const t of rows) {
    if (!t.accountId || !fromBanks.has(t.accountId)) continue;
    const text = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" ");
    const link = t.reserveLink as { skip?: boolean } | null;
    if (link?.skip) continue;
    let toId = t.toAccountId;
    let why = "";
    if (t.direction === "TRANSFER") {
      const to = banks.find((b) => b.id === toId);
      const from = banks.find((b) => b.id === t.accountId);
      const fix = to && from && !from.marketplace ? walletForMarketplace(to, banks) : null;
      if (fix) {
        toId = fix.id;
        why = ` · rekening tujuan ${to!.name} → ${fix.name}`;
      }
    } else {
      // Pengeluaran yang sebenarnya pindah ke rekening simpanan dana
      if (t.payableId || t._count.splits || !KEYWORDS.test(text)) continue;
      const mine = funds.filter((f) => f.fromBankId === t.accountId);
      const prefer = LOAN_WORDS.test(text) ? mine.filter((f) => f.kind === "LOAN_SAVING") : mine.filter((f) => f.kind === "OWNER");
      toId = (prefer[0] ?? mine[0])?.toBankId ?? null;
      why = ` · pengeluaran → transfer ke ${bankName(toId)}`;
    }
    if (!toId) continue;
    const m = await reserveOptions(prisma, { amount: Number(t.amount), fromBankId: t.accountId, toBankId: toId, date: todayStr(t.date), text, excludeTxId: t.id });
    if (!m) {
      // Rute sama dengan dana sisihan tapi nominal/tanggal tidak cocok: mungkin sisihannya sudah tercatat terpisah (dobel)
      if (funds.some((f) => f.fromBankId === t.accountId && f.toBankId === toId) && (t.direction === "TRANSFER" || why))
        console.log(`\n ! ${t.number} · ${todayStr(t.date)} · ${idr(t.amount)} · ${bankName(t.accountId)} → ${bankName(toId)}${why} · "${(t.note ?? "").slice(0, 50)}": rekeningnya alur dana sisihan tapi nominal tidak cocok / tanggalnya sudah tercatat berbukti. Cek manual (mungkin dobel).`);
      continue;
    }
    const key = t.number.toUpperCase();
    const pick = picks.get(key);
    const chosen = skips.has(key) ? null : pick !== undefined ? m.options[pick] : m.sure ? m.options[0] : null;
    const mark = skips.has(key) ? "–" : chosen ? "✓" : "?";
    console.log(`\n ${mark} ${t.number} · ${todayStr(t.date)} · ${idr(t.amount)} · ${bankName(t.accountId)} → ${bankName(t.toAccountId)}${why} · "${(t.note ?? "").slice(0, 50)}"${t.proofPath ? " · ada bukti" : " · TANPA bukti"}`);
    m.options.forEach((o, k) => console.log(`     [${k}] ${o.label} · tanggal ${o.dates.join(", ")}${chosen === o ? "   ← dipakai" : ""}`));
    if (!chosen) {
      if (!skips.has(key)) {
        pending++;
        console.log(`     Belum pasti: tambahkan --pilih=${t.number}:<nomor> atau --lewati=${t.number}`);
      }
      continue;
    }
    if (!apply) continue;
    try {
      const r = await linkBookedTransfer(t.id, { parts: chosen.parts, toAccountId: toId }, actor);
      done++;
      console.log(`     ✓ Tersinkron: ${r.created} sisihan baru, ${r.absorbed} sisihan lama memakai transfer ini`);
    } catch (e) {
      console.log(`     ✗ Gagal: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${apply ? `Tersinkron ${done} transaksi.` : "Ini pratinjau (tanggal dihitung per transaksi; saat dijalankan dihitung berurutan)."} ${pending ? `${pending} transaksi belum pasti (?) dilewati.` : ""}`);
  if (!apply) console.log("Tambahkan  --jalankan  untuk menyimpan.");
}

main()
  .catch((e) => {
    console.error("GAGAL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
