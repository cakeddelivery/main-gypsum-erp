import { prisma } from "./db";
import { lowStockItems } from "./stock";
import { addDays, dateOnly, todayStr } from "./time";
import type { Permission } from "./rbac";

export type Alert = { key: string; label: string; count: number; href: string; tone: "red" | "amber" | "blue" };

/** Notifikasi pekerjaan tertunda sesuai izin pengguna */
export async function alertsFor(can: (p: Permission) => boolean, divisionId?: string | null): Promise<Alert[]> {
  const out: Alert[] = [];
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const tasks: Promise<void>[] = [];
  if (can("finance.approve")) {
    tasks.push(prisma.financeTransaction.count({ where: { status: "MENUNGGU_KONFIRMASI" } }).then((c) => void (c && out.push({ key: "approve", label: "Transaksi menunggu persetujuan", count: c, href: "/finance?status=MENUNGGU_KONFIRMASI", tone: "red" }))));
  }
  if (can("finance.review")) {
    tasks.push(prisma.financeTransaction.count({ where: { status: "PERLU_DITINJAU" } }).then((c) => void (c && out.push({ key: "review", label: "Transaksi perlu ditinjau", count: c, href: "/finance?status=PERLU_DITINJAU", tone: "amber" }))));
  }
  if (can("stock.view")) {
    tasks.push(lowStockItems().then((l) => void (l.length && out.push({ key: "lowstock", label: "Item stok menipis", count: l.length, href: "/stok?filter=menipis", tone: "amber" }))));
  }
  if (can("stock.approve")) {
    tasks.push(prisma.stockRequest.count({ where: { status: "DIAJUKAN" } }).then((c) => void (c && out.push({ key: "stockreq", label: "Permintaan stok menunggu", count: c, href: "/stok/permintaan", tone: "blue" }))));
  }
  if (can("report.create")) {
    tasks.push(
      (async () => {
        const [shifts, divisions] = await Promise.all([prisma.shift.count({ where: { active: true } }), divisionId ? Promise.resolve(1) : prisma.division.count({ where: { active: true, code: { not: "GDG" } } })]);
        const sent = await prisma.shiftReport.count({ where: { date: dateOnly(yesterday), status: "TERKIRIM", ...(divisionId ? { divisionId } : {}) } });
        const missing = shifts * divisions - sent;
        if (missing > 0) out.push({ key: "report", label: "Laporan shift kemarin belum dikirim", count: missing, href: `/laporan?date=${yesterday}`, tone: "amber" });
      })(),
    );
  }
  if (can("attendance.manage")) {
    tasks.push(prisma.attendance.count({ where: { validated: false, date: { lte: dateOnly(today) }, ...(divisionId ? { employee: { divisionId } } : {}) } }).then((c) => void (c && out.push({ key: "att", label: "Absensi belum divalidasi", count: c, href: "/absensi?tab=validasi", tone: "blue" }))));
  }
  if (can("payroll.approve")) {
    tasks.push(prisma.payrollPeriod.count({ where: { status: { in: ["DRAFT", "DISETUJUI"] }, payslips: { some: {} } } }).then((c) => void (c && out.push({ key: "payroll", label: "Penggajian menunggu persetujuan/pembayaran", count: c, href: "/gaji", tone: "blue" }))));
  }
  if (can("finance.approve")) {
    tasks.push(
      (async () => {
        const [funds, done] = await Promise.all([prisma.reserveFund.count({ where: { active: true } }), prisma.reserveEntry.count({ where: { date: dateOnly(today), type: "SISIH", fund: { active: true } } })]);
        if (funds > done) out.push({ key: "reserve", label: "Dana sisihan hari ini belum dicatat", count: funds - done, href: "/finance/sisihan", tone: "amber" });
      })(),
    );
  }
  if (can("accounting.view")) {
    tasks.push(
      prisma.payable.findMany({ where: { dueDate: { lte: new Date(Date.now() + 7 * 86400000) } }, select: { amount: true, paid: true } }).then((rows) => {
        const due = rows.filter((r) => r.paid < r.amount).length;
        if (due) out.push({ key: "payable", label: "Utang jatuh tempo ≤ 7 hari", count: due, href: "/akuntansi/piutang-utang?tab=utang", tone: "red" });
      }),
    );
  }
  if (can("payroll.approve")) {
    tasks.push(prisma.payrollPeriod.count({ where: { status: { not: "DIBAYAR" }, payDate: { lte: dateOnly(today) }, payslips: { some: {} } } }).then((c) => void (c && out.push({ key: "payday", label: "Gaji sudah jatuh tanggal gajian", count: c, href: "/gaji", tone: "red" }))));
  }
  await Promise.all(tasks);
  return out;
}
