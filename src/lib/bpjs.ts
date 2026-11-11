import { prisma } from "./db";
import { bpjsAmount } from "./payroll";

/** Kategori Transaksi BPJS Ketenagakerjaan dikenali dari akun COA bebannya */
export const BPJS_COA = "6-1120";

/** Karyawan untuk pilihan setoran BPJS (peserta dulu), dengan nominal iuran per bulan */
export async function bpjsEmployeeOptions() {
  const def = Number((await prisma.setting.findUnique({ where: { key: "bpjs_tk_amount" } }))?.value) || 28400;
  const emps = await prisma.employee.findMany({ where: { OR: [{ status: { not: "NONAKTIF" } }, { bpjsTk: true }] }, orderBy: [{ bpjsTk: "desc" }, { name: "asc" }], select: { id: true, name: true, bpjsTk: true, bpjsTkAmount: true } });
  return emps.map((e) => ({ id: e.id, name: e.name, amount: bpjsAmount(e, def), member: e.bpjsTk }));
}

/** Id kategori BPJS Ketenagakerjaan (bisa lebih dari satu bila diduplikat) */
export async function bpjsCategoryIds() {
  return (await prisma.txCategory.findMany({ where: { coaAccount: { code: BPJS_COA } }, select: { id: true } })).map((c) => c.id);
}
