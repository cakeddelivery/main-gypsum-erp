/*
 * Catat bunga tabungan bank sebagai transaksi pemasukan (kategori "Pendapatan Lain") dan langsung dibukukan.
 * Aman diulang: tiap rekening+tanggal hanya dicatat sekali.
 *
 *   npx tsx scripts/catat-bunga.ts --rekening=SEABANK --data=2026-11-02:207,2026-11-03:85
 *        -> PRATINJAU saja
 *   ... --jalankan  -> menyimpan
 *
 * --rekening = kode rekening (Pengaturan › Rekening), mis. SEABANK, SEABANK0006, SHOPEEPAY
 * --data     = daftar tanggal:nominal dipisah koma (pajak bunga, bila ada, kurangi dulu dari nominal)
 */
import { PrismaClient } from "@prisma/client";
import { approveAndBook, createTransaction } from "../src/lib/finance";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const idr = (n: number) => "Rp" + n.toLocaleString("id-ID");

async function main() {
  const code = arg("rekening");
  const rows = (arg("data") ?? "").split(",").filter(Boolean).map((p) => {
    const [d, v] = p.split(":");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") || !/^\d+$/.test(v ?? "")) throw new Error(`Format salah: "${p}". Contoh: 2026-11-02:207`);
    return { day: d, amount: Number(v) };
  });
  if (!code || !rows.length) throw new Error("Wajib isi --rekening=KODE dan --data=YYYY-MM-DD:nominal,...");
  const bank = await prisma.bankAccount.findUnique({ where: { code } });
  if (!bank) throw new Error(`Rekening dengan kode ${code} tidak ditemukan`);
  const cat = await prisma.txCategory.findFirst({ where: { direction: "MASUK", active: true, coaAccount: { code: "4-9000" } } });
  if (!cat) throw new Error('Kategori pemasukan untuk akun 4-9000 "Pendapatan Lain-lain" tidak ditemukan');
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("Akun Owner aktif tidak ditemukan");
  const actor = { id: owner.id, name: "skrip catat-bunga" };

  console.log(`Rekening ${bank.name} · kategori ${cat.name} · mode ${apply ? "JALANKAN" : "pratinjau"}\n`);
  let total = 0;
  for (const r of rows) {
    const key = `BUNGA-${bank.code}-${r.day}`;
    const exist = await prisma.financeTransaction.findUnique({ where: { idempotencyKey: key } });
    if (exist) {
      const pending = ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(exist.status);
      if (pending && apply) await approveAndBook(exist.id, actor, "Bunga tabungan (skrip)");
      console.log(`  = ${r.day} ${idr(r.amount)} sudah tercatat (${exist.number}${pending ? (apply ? ", sekarang dibukukan" : ", belum dibukukan") : ""})`);
      continue;
    }
    total += r.amount;
    if (!apply) {
      console.log(`  + ${r.day} ${idr(r.amount)}`);
      continue;
    }
    const { transaction: t } = await createTransaction(
      { direction: "MASUK", amount: r.amount, date: new Date(`${r.day}T01:00:00+07:00`), accountId: bank.id, categoryId: cat.id, counterparty: "Bunga Tabungan", note: `Bunga tabungan ${bank.name}`, idempotencyKey: key },
      "MANUAL",
      actor,
      { submit: true },
    );
    await approveAndBook(t.id, actor, "Bunga tabungan (skrip)");
    console.log(`  + ${r.day} ${idr(r.amount)} → ${t.number} dibukukan`);
  }
  console.log(`\nTotal bunga baru: ${idr(total)}`);
  if (!apply && total) console.log("Ini baru PRATINJAU. Untuk menyimpan, jalankan lagi dengan --jalankan");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
