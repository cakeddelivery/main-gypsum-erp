/*
 * Rapikan hutang & transaksi berkategori kosong / Beban Lain-lain (sekali jalan, aman diulang).
 *
 *   npm run rapikan:hutang -- --data=/tmp/pinjaman.json               -> hanya MENAMPILKAN rencana (aman)
 *   npm run rapikan:hutang -- --data=/tmp/pinjaman.json --jalankan    -> menyimpan
 *
 * Data pinjaman (nama pemberi pinjaman, nominal) TIDAK disimpan di repo; ditulis di file JSON di server:
 *   [{ "lender": "Nama", "match": "kata di catatan transfer", "amount": 15000000, "date": "2026-05-01",
 *      "paidTotal": 9000000, "installments": null, "interestTotal": null, "note": "..." }]
 *   paidTotal = pokok yang sudah dibayar sampai hari ini, termasuk yang sudah tercatat di aplikasi.
 *
 * 1. Mencatat pinjaman lama (diterima sebelum memakai aplikasi) sesuai file data:
 *    sisa pokok saat mulai memakai aplikasi = hutang, lawannya Ekuitas Saldo Awal.
 * 2. Transaksi pembayarannya yang sudah dibukukan (mis. "Bayar hutang <nama>" di Beban Lain-lain) dipindah menjadi
 *    cicilan pinjaman: pokok mengurangi hutang, bunga/biaya ke Beban Bunga & Biaya Pinjaman.
 * 3. Iuran sampah/kebersihan di Beban Lain-lain → kategori Iuran Lingkungan & Kebersihan.
 * 4. Hutang supplier yang akun debitnya Piutang Usaha (salah pilih di form) → Persediaan Bahan Baku.
 * Jurnal lama tidak diubah: dibalik lalu dibukukan ulang. Saldo rekening tidak berubah.
 *
 * WAJIB backup dulu: npm run backup
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { assertPeriodOpen, COA, postJournal, reverseJournal } from "../src/lib/accounting";
import { reclassifyBooked } from "../src/lib/finance";
import { createLoanRecord, splitPayment } from "../src/lib/payables";
import { jakartaDateTime } from "../src/lib/time";

const apply = process.argv.includes("--jalankan");
const idr = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const day = (d: Date) => d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric" });

type LoanData = { lender: string; match: string; amount: number; date: string; paidTotal: number; installments?: number | null; interestTotal?: number | null; note?: string | null };
const dataArg = process.argv.find((x) => x.startsWith("--data="))?.slice(7);
const LOANS = (dataArg ? (JSON.parse(readFileSync(dataArg, "utf8")) as LoanData[]) : []).map((l) => ({
  ...l,
  installments: l.installments ?? null,
  interestTotal: l.interestTotal ?? null,
  note: l.note ?? null,
  match: new RegExp(`\\b(${l.match.split(",").map((w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|")})\\b`, "i"),
}));
const IURAN = /\b(iuran|sampah|kebersihan|keamanan|ronda|retribusi)\b/i;

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("User owner tidak ditemukan");
  const actor = { id: owner.id, name: "skrip rapikan-hutang" };
  const bebanLain = await prisma.txCategory.findMany({ where: { coaAccount: { code: COA.BEBAN_LAIN } } });
  const vague = new Set(bebanLain.map((c) => c.id));
  const booked = await prisma.financeTransaction.findMany({ where: { status: "DIBUKUKAN", direction: "KELUAR", deletedAt: null, payableId: null, splits: { none: {} } }, orderBy: { date: "asc" } });
  const text = (t: (typeof booked)[number]) => [t.note, t.counterparty, t.rawText].filter(Boolean).join(" ");
  const used = new Set<string>();

  // ---------- 1 & 2. Pinjaman lama + cicilannya ----------
  console.log("== Pinjaman modal ==");
  if (!LOANS.length) console.log("  (tanpa --data=file.json: tidak ada pinjaman lama yang dicatat)");
  for (const L of LOANS) {
    const existing = await prisma.payable.findFirst({ where: { kind: "PINJAMAN", vendor: { equals: L.lender, mode: "insensitive" } } });
    const pays = booked.filter((t) => !used.has(t.id) && L.match.test(text(t)));
    pays.forEach((t) => used.add(t.id));
    // Pokok tiap pembayaran di aplikasi (cicilan terjadwal: dikurangi bunga)
    let paidSim = 0;
    const plan = { amount: L.amount, installments: L.installments, interestTotal: L.interestTotal };
    const inApp = pays.reduce((s, t) => s + splitPayment({ ...plan, paid: L.paidTotal - Number(t.amount) }, Number(t.amount)).principal, 0);
    const paidBefore = L.paidTotal - inApp;
    console.log(`\n${L.lender}: pinjaman ${idr(L.amount)} (${L.date}) · sudah dibayar ${idr(L.paidTotal)} · sisa ${idr(L.amount - L.paidTotal)}`);
    if (existing) console.log(`  sudah tercatat: ${existing.number} (sisa ${idr(Number(existing.amount - existing.paid))}) → tidak dibuat ulang`);
    else console.log(`  dicatat sebagai pinjaman lama: pokok dibayar sebelum aplikasi ${idr(paidBefore)} · saldo awal hutang ${idr(L.amount - paidBefore)}`);
    for (const t of pays) console.log(`  ${t.number} · ${day(t.date)} · ${idr(Number(t.amount))} · ${text(t).slice(0, 70)} → cicilan ${L.lender}`);
    if (!pays.length) console.log("  (tidak ada transaksi pembayaran di aplikasi)");
    if (paidBefore < 0) {
      console.log("  ⚠️ Pembayaran di aplikasi melebihi total yang sudah dibayar. Dilewati, cek datanya.");
      continue;
    }
    if (!apply) continue;
    const loan = existing ?? (await createLoanRecord({ lender: L.lender, amount: L.amount, date: jakartaDateTime(L.date, "12:00"), paidBefore, installments: L.installments, interestTotal: L.interestTotal, note: L.note }, actor));
    for (const t of pays) {
      await reclassifyBooked(t.id, { payableId: loan.id }, actor);
      paidSim++;
    }
    const after = await prisma.payable.findUniqueOrThrow({ where: { id: loan.id } });
    console.log(`  ✓ ${after.number} tercatat, ${paidSim} transaksi dipindah. Sisa hutang ${idr(Number(after.amount - after.paid))}`);
  }

  // ---------- 3. Iuran lingkungan ----------
  console.log("\n== Iuran lingkungan ==");
  const iuran = await prisma.txCategory.findFirst({ where: { name: "Iuran Lingkungan & Kebersihan" } });
  const iuranTx = booked.filter((t) => !used.has(t.id) && (!t.categoryId || vague.has(t.categoryId)) && IURAN.test(text(t)));
  for (const t of iuranTx) {
    used.add(t.id);
    console.log(`  ${t.number} · ${day(t.date)} · ${idr(Number(t.amount))} · ${text(t).slice(0, 70)} → Iuran Lingkungan & Kebersihan`);
    if (apply && iuran) await reclassifyBooked(t.id, { categoryId: iuran.id }, actor);
  }
  if (!iuranTx.length) console.log("  (tidak ada)");

  // ---------- Sisa yang masih kosong / Beban Lain-lain ----------
  const rest = booked.filter((t) => !used.has(t.id) && (!t.categoryId || vague.has(t.categoryId)));
  console.log(`\n== Masih kosong / Beban Lain-lain (perlu dicek manual): ${rest.length} ==`);
  for (const t of rest) console.log(`  ${t.number} · ${day(t.date)} · ${idr(Number(t.amount))} · ${text(t).slice(0, 80)}`);

  // ---------- 4. Hutang supplier dengan debit Piutang Usaha ----------
  console.log("\n== Hutang supplier: akun debit ==");
  const persediaan = await prisma.coaAccount.findUniqueOrThrow({ where: { code: COA.PERSEDIAAN_BAHAN } });
  const usaha = await prisma.payable.findMany({ where: { kind: "USAHA", journalId: { not: null } }, orderBy: { date: "asc" } });
  let wrong = 0;
  for (const p of usaha) {
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: p.journalId! }, include: { lines: { include: { account: true } } } });
    if (await prisma.journal.findFirst({ where: { reversalOfId: j.id } })) continue;
    const bad = j.lines.filter((l) => l.debit > BigInt(0) && l.account.code.startsWith("1-13"));
    if (!bad.length) continue;
    wrong++;
    console.log(`  ${p.number} · ${p.vendor} · ${idr(Number(p.amount))} · debit ${bad[0].account.code} ${bad[0].account.name} → ${persediaan.code} ${persediaan.name}`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      const date = await assertPeriodOpen(tx, j.date).then(() => j.date, () => new Date());
      await reverseJournal(tx, j.id, date, actor, `koreksi akun debit ${p.number}`);
      const nj = await postJournal(tx, { date, storeId: j.storeId, description: j.description, source: j.source, sourceId: j.sourceId, actor, lines: j.lines.map((l) => ({ accountId: bad.some((b) => b.id === l.id) ? persediaan.id : l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined })) });
      await tx.payable.update({ where: { id: p.id }, data: { journalId: nj.id } });
    });
  }
  if (!wrong) console.log("  Semua sudah benar (persediaan/beban/aset).");

  // ---------- Dana sisihan cicilan yang belum terhubung ke pinjaman ----------
  const funds = await prisma.reserveFund.findMany({ where: { kind: { in: ["LOAN_SAVING", "LOAN_PAYMENT"] }, payableId: null, active: true } });
  if (funds.length) console.log(`\nCatatan: dana sisihan cicilan belum terhubung ke pinjaman: ${funds.map((f) => f.name).join(", ")}. Hubungkan lewat Transaksi › Dana sisihan › Ubah.`);

  console.log(apply ? "\nSelesai." : "\nIni pratinjau. Jalankan dengan  npm run rapikan:hutang -- --jalankan  untuk menyimpan.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
