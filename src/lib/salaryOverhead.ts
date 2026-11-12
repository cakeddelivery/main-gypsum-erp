import type { Prisma, PrismaClient, WageType } from "@prisma/client";
import { prisma } from "./db";
import { bpjsAmount, sumAllowances } from "./payroll";
import { addDays, dateOnly, todayStr } from "./time";
import { TEMPLATES, sectionTotal, type WorkData } from "./shiftReport";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Overhead "Gaji Produksi" otomatis: biaya per bulan = jumlah biaya gaji bulanan karyawan di divisi terpilih
 *   gaji pokok (BULANAN = gaji per bulan; HARIAN/CAMPURAN = upah harian × hari kerja sebulan)
 *   + tunjangan aktif + BPJS Ketenagakerjaan yang ditanggung perusahaan.
 * Pekerja borongan tidak dihitung (upahnya sudah di bagian Tenaga Kerja Borongan resep).
 *
 * Ini hanya angka untuk menghitung HPP per patung & saran harga; tidak membuat jurnal. Gaji tetap dibukukan
 * satu kali lewat menu Gaji (Beban Gaji Produksi / Hutang Gaji, lalu dibayar dari rekening), jadi tidak dobel.
 */

export type SalaryEmployee = {
  wageType: WageType;
  monthlySalary: bigint | number;
  dailyRate: bigint | number;
  bpjsTk: boolean;
  bpjsTkAmount: bigint | null;
  allowances: { name: string; amount: bigint | number; active: boolean }[];
};

export function employeeMonthlyCost(e: SalaryEmployee, opts: { workdays: number; bpjsDefault: number }) {
  const base = e.wageType === "BULANAN" ? Number(e.monthlySalary) : e.wageType === "BORONGAN" ? 0 : Number(e.dailyRate) * opts.workdays;
  const allowance = sumAllowances(e.allowances).total;
  const bpjs = bpjsAmount(e, opts.bpjsDefault);
  return { base, allowance, bpjs, total: base + allowance + bpjs };
}

const settingNum = async (db: Db, key: string, def: number) => Number((await db.setting.findUnique({ where: { key } }))?.value) || def;

/** Divisi bawaan: semua divisi aktif yang punya format laporan shift (Produksi, Giftbox, Packing, Assembling) */
export async function defaultSalaryDivisions(db: Db = prisma) {
  return (await db.division.findMany({ where: { active: true, reportTemplate: { not: null } }, select: { id: true } })).map((d) => d.id);
}

/** Rincian biaya gaji per karyawan untuk divisi tertentu (karyawan aktif, belum resign, bukan borongan) */
export async function salaryBreakdown(divisionIds: string[], db: Db = prisma) {
  const ids = divisionIds.length ? divisionIds : await defaultSalaryDivisions(db);
  const [workdays, bpjsDefault] = await Promise.all([settingNum(db, "monthly_workdays", 26), settingNum(db, "bpjs_tk_amount", 28400)]);
  const today = dateOnly(todayStr());
  const emps = await db.employee.findMany({
    where: { divisionId: { in: ids }, status: { not: "NONAKTIF" }, wageType: { not: "BORONGAN" }, OR: [{ resignDate: null }, { resignDate: { gt: today } }] },
    include: { allowances: true, division: { select: { name: true } } },
    orderBy: [{ division: { code: "asc" } }, { name: "asc" }],
  });
  const rows = emps.map((e) => ({ id: e.id, name: e.name, division: e.division.name, wageType: e.wageType, ...employeeMonthlyCost(e, { workdays, bpjsDefault }) })).filter((r) => r.total > 0);
  const sum = (k: "base" | "allowance" | "bpjs" | "total") => rows.reduce((s, r) => s + r[k], 0);
  return { divisionIds: ids, workdays, rows, base: sum("base"), allowance: sum("allowance"), bpjs: sum("bpjs"), total: sum("total") };
}

/** Hari yang dipakai untuk output otomatis (30 hari terakhir, termasuk hari ini) */
export const OUTPUT_DAYS = 30;

/**
 * Output patung per bulan dari laporan shift: total panen patung kering (laporan Produksi yang sudah dikirim)
 * 30 hari terakhir. Hari-hari sebelum laporan pertama tidak dihitung, jadi di awal pemakaian angkanya
 * disetarakan ke 30 hari dari hari yang sudah ada laporannya. 0 = belum ada laporan.
 */
export async function monthlyOutputFromReports(db: Db = prisma, today: string = todayStr()) {
  const start = addDays(today, -(OUTPUT_DAYS - 1));
  const reports = await db.shiftReport.findMany({
    where: { date: { gte: dateOnly(start), lte: dateOnly(today) }, status: { in: ["TERKIRIM", "DIREVISI"] }, division: { reportTemplate: "PRODUKSI" } },
    select: { date: true, work: true },
  });
  const t = TEMPLATES.PRODUKSI;
  const total = reports.reduce((a, r) => a + sectionTotal(t, r.work as WorkData, "panen"), 0);
  if (!total) return { total: 0, days: 0, perMonth: 0 };
  const first = reports.reduce((m, r) => (r.date < m ? r.date : m), reports[0].date).toISOString().slice(0, 10);
  const days = Math.min(OUTPUT_DAYS, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000) + 1);
  return { total, days, perMonth: Math.round((total / days) * OUTPUT_DAYS) };
}

/**
 * Hitung ulang semua overhead otomatis: biaya dari gaji (autoSalary) dan/atau output dari laporan shift (outputAuto).
 * Output otomatis yang belum punya laporan (0) tidak menimpa angka manual. Kembalikan biaya yang berubah.
 */
export async function syncSalaryOverheads(db: Db = prisma) {
  const list = await db.overhead.findMany({ where: { OR: [{ autoSalary: true }, { outputAuto: true }] } });
  const changed: { id: string; name: string; from: number; to: number }[] = [];
  const output = list.some((o) => o.outputAuto) ? await monthlyOutputFromReports(db) : null;
  for (const o of list) {
    const data: Prisma.OverheadUpdateInput = { autoUpdatedAt: new Date() };
    if (o.autoSalary) {
      const { total } = await salaryBreakdown(o.salaryDivisionIds, db);
      if (Number(o.monthlyAmount) !== total) changed.push({ id: o.id, name: o.name, from: Number(o.monthlyAmount), to: total });
      data.monthlyAmount = BigInt(total);
    }
    if (o.outputAuto && output && output.perMonth > 0) data.outputPerMonth = output.perMonth;
    await db.overhead.update({ where: { id: o.id }, data });
  }
  return changed;
}

/** Dipanggil setelah data gaji berubah; kegagalan tidak menggagalkan penyimpanan data gaji */
export async function syncSalaryOverheadsSafe() {
  try {
    return await syncSalaryOverheads();
  } catch (e) {
    console.error("Gagal memperbarui overhead gaji", e);
    return [];
  }
}
