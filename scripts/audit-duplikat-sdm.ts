/*
 * Deteksi DATA GANDA modul SDM (HANYA MEMBACA, hanya SELECT). Jalankan di VPS:
 *   npx tsx scripts/audit-duplikat-sdm.ts
 * Mencetak ringkasan per pemeriksaan + contoh id. Tidak mengubah data apa pun.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const LIMIT = 8;
let total = 0;

async function check(title: string, sql: string) {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
  total += rows.length;
  console.log(`\n[${rows.length ? "TEMUAN" : "OK"}] ${title}: ${rows.length}`);
  for (const r of rows.slice(0, LIMIT)) console.log("   ", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (rows.length > LIMIT) console.log(`    … dan ${rows.length - LIMIT} lagi`);
}

async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1)} · BACA-SAJA`);

  await check("Absen ganda (karyawan + tanggal sama; seharusnya mustahil karena unique)", `
    SELECT "employeeId", "date"::text AS tanggal, count(*)::int AS n, array_agg(id) AS ids FROM "Attendance" GROUP BY 1,2 HAVING count(*) > 1`);
  await check("Absen pulang lebih awal dari absen masuk", `
    SELECT id, "employeeId", "date"::text AS tanggal FROM "Attendance" WHERE "checkIn" IS NOT NULL AND "checkOut" IS NOT NULL AND "checkOut" <= "checkIn"`);
  await check("Slip ganda (periode + karyawan sama)", `
    SELECT "periodId", "employeeId", count(*)::int AS n, array_agg(id) AS ids FROM "Payslip" GROUP BY 1,2 HAVING count(*) > 1`);
  await check("Periode gaji ganda (jenis + rentang tanggal sama, bukan klaim borongan)", `
    SELECT kind::text, "startDate"::text AS dari, "endDate"::text AS sampai, count(*)::int AS n, array_agg(code) AS kode, array_agg(id) AS ids
    FROM "PayrollPeriod" WHERE kind <> 'BORONGAN' GROUP BY 1,2,3 HAVING count(*) > 1`);
  await check("Periode gaji bulanan dengan kode berakhiran -DD padahal kode dasar ada (tanda dobel siklus)", `
    SELECT a.code, a.id FROM "PayrollPeriod" a WHERE a.kind = 'BULANAN' AND a.code ~ '^GJB-[0-9]{8}-[0-9]{2}$'
      AND EXISTS (SELECT 1 FROM "PayrollPeriod" b WHERE b.code = left(a.code, 12) AND b."endDate" = a."endDate")`);
  await check("Klaim borongan kosong (periode BORONGAN tanpa hasil kerja & slip Rp0)", `
    SELECT p.id, p.code, p.status::text FROM "PayrollPeriod" p WHERE p.kind = 'BORONGAN'
      AND NOT EXISTS (SELECT 1 FROM "PieceWork" w WHERE w."periodId" = p.id) AND COALESCE((SELECT sum(total) FROM "Payslip" s WHERE s."periodId" = p.id),0) = 0`);
  await check("Jurnal hutang gaji (PAYROLL_AKRUAL) aktif lebih dari satu per periode (belum dibalik)", `
    SELECT j."sourceId" AS periode, count(*)::int AS n, array_agg(j.number) AS jurnal FROM "Journal" j
    WHERE j.source = 'PAYROLL_AKRUAL' AND j."reversalOfId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId" = j.id)
    GROUP BY 1 HAVING count(*) > 1`);
  await check("Jurnal pembayaran gaji (PAYROLL) aktif ganda untuk sumber yang sama", `
    SELECT j."sourceId", count(*)::int AS n, array_agg(j.number) AS jurnal FROM "Journal" j
    WHERE j.source = 'PAYROLL' AND j."reversalOfId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId" = j.id)
    GROUP BY 1 HAVING count(*) > 1`);
  await check("Slip berstatus lunas tetapi jurnal pembayarannya sudah dibalik / tidak ada", `
    SELECT s.id, s."periodId", s."paidJournalId" FROM "Payslip" s WHERE s."paidAt" IS NOT NULL AND s.total > 0
      AND (s."paidJournalId" IS NULL OR EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId" = s."paidJournalId"))`);
  await check("Kasbon kembar (karyawan, nominal, tanggal, rekening sama; belum dibatalkan)", `
    SELECT "employeeId", amount::text, "date"::text AS tanggal, "paidFromAccountId", count(*)::int AS n, array_agg(number) AS nomor
    FROM "CashAdvance" WHERE "cancelledAt" IS NULL GROUP BY 1,2,3,4 HAVING count(*) > 1`);
  await check("Kasbon dengan jurnal pemberian aktif ganda", `
    SELECT j."sourceId" AS nomor, count(*)::int AS n FROM "Journal" j JOIN "CashAdvance" c ON c.number = j."sourceId"
    WHERE j.source = 'KASBON' AND j.description LIKE 'Kasbon %' AND j."reversalOfId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Journal" r WHERE r."reversalOfId" = j.id) GROUP BY 1 HAVING count(*) > 1`);
  await check("Kasbon: terbayar melebihi nominal", `SELECT id, number, amount::text, repaid::text FROM "CashAdvance" WHERE repaid > amount`);
  await check("Pengajuan izin/sakit tumpang tindih (MENUNGGU/DISETUJUI, karyawan sama)", `
    SELECT a."employeeId", a.id AS a_id, b.id AS b_id, a."dateFrom"::text AS dari, a."dateTo"::text AS sampai
    FROM "LeaveRequest" a JOIN "LeaveRequest" b ON a."employeeId" = b."employeeId" AND a.id < b.id AND a."dateFrom" <= b."dateTo" AND a."dateTo" >= b."dateFrom"
    WHERE a.status IN ('MENUNGGU','DISETUJUI') AND b.status IN ('MENUNGGU','DISETUJUI')`);
  await check("Pengajuan libur minggu depan ganda (karyawan + minggu sama, MENUNGGU/DISETUJUI)", `
    SELECT "employeeId", "weekStart"::text AS minggu, count(*)::int AS n, array_agg(id) AS ids FROM "DayOffRequest"
    WHERE status IN ('MENUNGGU','DISETUJUI') GROUP BY 1,2 HAVING count(*) > 1`);
  await check("Karyawan ganda: nama sama (abaikan huruf besar/kecil) di divisi sama, belum nonaktif", `
    SELECT "divisionId", lower(trim(name)) AS nama, count(*)::int AS n, array_agg(code) AS kode, array_agg(id) AS ids FROM "Employee"
    WHERE status <> 'NONAKTIF' GROUP BY 1,2 HAVING count(*) > 1`);
  await check("Karyawan ganda: NIK sama", `
    SELECT regexp_replace(nik,'\\D','','g') AS nik, count(*)::int AS n, array_agg(code) AS kode FROM "Employee"
    WHERE nik IS NOT NULL AND nik <> '' GROUP BY 1 HAVING count(*) > 1`);
  await check("Karyawan ganda: nomor rekening gaji sama (bank + no.)", `
    SELECT "bankName", "bankAccountNo", count(*)::int AS n, array_agg(code) AS kode FROM "Employee"
    WHERE "bankAccountNo" IS NOT NULL AND "bankAccountNo" <> '' GROUP BY 1,2 HAVING count(*) > 1`);
  await check("Akun login ganda: lebih dari satu user untuk satu karyawan / nama pengguna beda huruf besar-kecil", `
    SELECT lower(username) AS username, count(*)::int AS n, array_agg(id) AS ids FROM "User" GROUP BY 1 HAVING count(*) > 1
    UNION ALL SELECT "employeeId", count(*)::int, array_agg(id) FROM "User" WHERE "employeeId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
  await check("Transport assembling kembar (karyawan, tanggal, nominal, catatan sama)", `
    SELECT "employeeId", "date"::text AS tanggal, amount::text, count(*)::int AS n, array_agg(id) AS ids FROM "TransportTrip" GROUP BY 1,2,3,note HAVING count(*) > 1`);
  await check("Tunjangan kembar (karyawan + nama + tanggal bayar sama, aktif)", `
    SELECT "employeeId", lower(trim(name)) AS nama, "payDay", count(*)::int AS n, array_agg(id) AS ids FROM "EmployeeAllowance" WHERE active GROUP BY 1,2,3 HAVING count(*) > 1`);
  await check("Hasil borongan (PieceWork) kembar: karyawan, tugas, tanggal, qty sama", `
    SELECT "employeeId", "taskId", "date"::text AS tanggal, qty, count(*)::int AS n, array_agg(id) AS ids FROM "PieceWork" GROUP BY 1,2,3,4 HAVING count(*) > 1`);

  console.log(`\nSelesai. ${total ? `${total} kelompok temuan; periksa contoh di atas sebelum merapikan (jangan hapus jurnal terbukukan: pakai jurnal pembalik).` : "Tidak ada data ganda terdeteksi."}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
