/*
 * Kosongkan data transaksi untuk mulai pembukuan dari nol (isi saldo awal lalu catat transaksi baru).
 *
 *   npm run kosongkan            -> hanya MENAMPILKAN jumlah data yang akan dihapus (aman)
 *   npm run kosongkan -- --hapus -> menghapus, setelah Anda mengetik nama database sebagai konfirmasi
 *
 * DIHAPUS: transaksi keuangan & jurnal (termasuk saldo awal), piutang/utang/pinjaman, aset tetap,
 *   pembelian, sisihan harian (riwayatnya), periode akuntansi; gaji/slip/tunjangan/kasbon/borongan karyawan/
 *   ongkos angkut; absensi & jadwal shift; DATA KARYAWAN; produksi & laporan shift; pergerakan stok
 *   (stok jadi 0) & permintaan stok; setoran/serah terima/pembayaran borongan tetangga; nomor urut dokumen.
 * DISIMPAN: akun (COA), rekening bank, kategori transaksi, toko, divisi, shift, lokasi kerja (geofence),
 *   tarif borongan, item/produk/resep/overhead/harga, supplier, pelanggan, pengaturan, akun login,
 *   orang & titik borongan tetangga, pengaturan dana sisihan, Telegram, audit log.
 * Akun login yang terhubung ke karyawan (selain OWNER) dilepas dari karyawannya dan DINONAKTIFKAN;
 *   aktifkan & hubungkan lagi setelah karyawan dibuat ulang.
 *
 * WAJIB backup dulu: npm run backup
 */
import { PrismaClient } from "@prisma/client";
import { createInterface } from "node:readline/promises";

const prisma = new PrismaClient();
const q = (t: string) => `"${t}"`;

/** Urutan penting: tabel anak dulu, baru induknya (tanpa TRUNCATE CASCADE agar tidak ikut menghapus master). */
const STEPS: { label: string; sql: string; count?: string }[] = [
  { label: "Riwayat persetujuan transaksi", sql: `DELETE FROM ${q("ApprovalLog")}` },
  { label: "Transaksi keuangan (Finance Inbox)", sql: `DELETE FROM ${q("FinanceTransaction")}` },
  { label: "Baris jurnal", sql: `DELETE FROM ${q("JournalLine")}` },
  { label: "Jurnal (termasuk saldo awal)", sql: `DELETE FROM ${q("Journal")}` },
  { label: "Periode akuntansi (tutup buku)", sql: `DELETE FROM ${q("AccountingPeriod")}` },
  { label: "Piutang", sql: `DELETE FROM ${q("Receivable")}` },
  { label: "Baris pembelian", sql: `DELETE FROM ${q("PurchaseLine")}` },
  { label: "Pembelian", sql: `DELETE FROM ${q("Purchase")}` },
  { label: "Riwayat sisihan harian", sql: `DELETE FROM ${q("ReserveEntry")}` },
  { label: "Dana sisihan dilepas dari pinjaman", sql: `UPDATE ${q("ReserveFund")} SET "payableId" = NULL WHERE "payableId" IS NOT NULL`, count: `SELECT count(*) FROM ${q("ReserveFund")} WHERE "payableId" IS NOT NULL` },
  { label: "Utang & pinjaman modal", sql: `DELETE FROM ${q("Payable")}` },
  { label: "Aset tetap", sql: `DELETE FROM ${q("FixedAsset")}` },
  { label: "Slip gaji", sql: `DELETE FROM ${q("Payslip")}` },
  { label: "Hasil borongan karyawan", sql: `DELETE FROM ${q("PieceWork")}` },
  { label: "Periode gaji", sql: `DELETE FROM ${q("PayrollPeriod")}` },
  { label: "Kasbon", sql: `DELETE FROM ${q("CashAdvance")}` },
  { label: "Ongkos angkut", sql: `DELETE FROM ${q("TransportTrip")}` },
  { label: "Tunjangan karyawan", sql: `DELETE FROM ${q("EmployeeAllowance")}` },
  { label: "Absensi", sql: `DELETE FROM ${q("Attendance")}` },
  { label: "Jadwal shift", sql: `DELETE FROM ${q("ShiftSchedule")}` },
  { label: "Input produksi", sql: `DELETE FROM ${q("ProductionEntry")}` },
  { label: "Target produksi per karyawan", sql: `DELETE FROM ${q("ProductionTarget")} WHERE "employeeId" IS NOT NULL`, count: `SELECT count(*) FROM ${q("ProductionTarget")} WHERE "employeeId" IS NOT NULL` },
  { label: "Setoran borongan tetangga", sql: `DELETE FROM ${q("BoronganResult")}` },
  { label: "Pembayaran borongan tetangga", sql: `DELETE FROM ${q("BoronganSettlement")}` },
  { label: "Baris serah terima borongan", sql: `DELETE FROM ${q("BoronganHandoverLine")}` },
  { label: "Serah terima borongan", sql: `DELETE FROM ${q("BoronganHandover")}` },
  { label: "Pergerakan stok (stok jadi 0)", sql: `DELETE FROM ${q("StockMovement")}` },
  { label: "Permintaan stok", sql: `DELETE FROM ${q("StockRequest")}` },
  { label: "Riwayat kirim laporan shift", sql: `DELETE FROM ${q("ReportSend")}` },
  { label: "Laporan shift", sql: `DELETE FROM ${q("ShiftReport")}` },
  { label: "Akun login karyawan dinonaktifkan", sql: `UPDATE ${q("User")} SET "employeeId" = NULL, "active" = false WHERE "employeeId" IS NOT NULL AND "role" <> 'OWNER'`, count: `SELECT count(*) FROM ${q("User")} WHERE "employeeId" IS NOT NULL AND "role" <> 'OWNER'` },
  { label: "Akun OWNER dilepas dari data karyawan (tetap aktif)", sql: `UPDATE ${q("User")} SET "employeeId" = NULL WHERE "employeeId" IS NOT NULL AND "role" = 'OWNER'`, count: `SELECT count(*) FROM ${q("User")} WHERE "employeeId" IS NOT NULL AND "role" = 'OWNER'` },
  { label: "Karyawan", sql: `DELETE FROM ${q("Employee")}` },
  { label: "Nomor urut dokumen (mulai dari 0001 lagi)", sql: `DELETE FROM ${q("Counter")} WHERE "key" NOT LIKE 'SKU-%' AND "key" NOT LIKE 'KODE-%'`, count: `SELECT count(*) FROM ${q("Counter")} WHERE "key" NOT LIKE 'SKU-%' AND "key" NOT LIKE 'KODE-%'` },
  { label: "Notifikasi sudah dibaca", sql: `DELETE FROM ${q("AlertRead")}` },
  { label: "Log notifikasi", sql: `DELETE FROM ${q("NotificationLog")}` },
  { label: "Cache API (idempotensi)", sql: `DELETE FROM ${q("IdempotencyRecord")}` },
];

const PROTECTED: [string, string][] = [
  ["Journal", "journal_no_update"],
  ["JournalLine", "journal_line_no_update"],
];

function countSql(s: (typeof STEPS)[number]) {
  if (s.count) return s.count;
  const m = s.sql.match(/^DELETE FROM ("[A-Za-z]+")(.*)$/);
  if (!m) throw new Error(`Tidak bisa menghitung: ${s.sql}`);
  return `SELECT count(*) FROM ${m[1]}${m[2]}`;
}

async function counts(db: Pick<PrismaClient, "$queryRawUnsafe">) {
  const out: { label: string; n: number }[] = [];
  for (const s of STEPS) {
    const r = await db.$queryRawUnsafe<{ count: bigint }[]>(countSql(s));
    out.push({ label: s.label, n: Number(r[0].count) });
  }
  return out;
}

async function main() {
  const hapus = process.argv.includes("--hapus");
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("SELECT current_database() AS db");
  console.log(`Database : ${db}`);
  console.log(`APP_ENV  : ${process.env.APP_ENV || "(produksi)"}`);
  console.log("");
  const before = await counts(prisma);
  const w = Math.max(...before.map((c) => c.label.length));
  for (const c of before) console.log(`  ${c.label.padEnd(w)}  ${String(c.n).padStart(7)}`);
  console.log("");

  if (!hapus) {
    console.log("Ini baru PRATINJAU, belum ada yang dihapus.");
    console.log("Untuk menghapus: npm run backup  lalu  npm run kosongkan -- --hapus");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Data di atas akan DIHAPUS PERMANEN. Ketik nama database (${db}) untuk lanjut: `)).trim();
  rl.close();
  if (ans !== db) {
    console.log("Dibatalkan, tidak ada yang dihapus.");
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      // Jurnal dilindungi trigger anti-ubah; matikan sementara HANYA di dalam transaksi ini
      // (DDL Postgres ikut transaksi: bila gagal, trigger otomatis kembali aktif)
      for (const [t, trg] of PROTECTED) await tx.$executeRawUnsafe(`ALTER TABLE ${q(t)} DISABLE TRIGGER ${trg}`);
      for (const s of STEPS) await tx.$executeRawUnsafe(s.sql);
      for (const [t, trg] of PROTECTED) await tx.$executeRawUnsafe(`ALTER TABLE ${q(t)} ENABLE TRIGGER ${trg}`);
      await tx.auditLog.create({
        data: { actorName: "skrip kosongkan-data", action: "DATA_TRANSAKSI_DIKOSONGKAN", entity: "Database", entityId: db, data: Object.fromEntries(before.map((c) => [c.label, c.n])) },
      });
    },
    { timeout: 10 * 60_000, maxWait: 60_000 },
  );

  const sisa = (await counts(prisma)).filter((c) => c.n > 0);
  if (sisa.length) {
    console.error("PERINGATAN: masih ada sisa data:", sisa);
    process.exitCode = 1;
    return;
  }
  console.log("Selesai. Semua data transaksi, gaji, absensi, dan karyawan sudah kosong.");
  console.log("Berikutnya: tambah karyawan, lalu Akuntansi → Atur saldo rekening untuk saldo awal.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
