import { prisma } from "./db";
import { lowStockItems, negativeStock } from "./stock";
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
  if (can("stock.view")) {
    tasks.push(negativeStock().then((l) => void (l.length && out.push({ key: "negstock", label: "Stok minus (pemakaian melebihi stok tercatat)", count: l.length, href: "/stok?filter=minus", tone: "red" }))));
  }
  if (can("stock.approve")) {
    tasks.push(prisma.stockRequest.count({ where: { status: "DIAJUKAN" } }).then((c) => void (c && out.push({ key: "stockreq", label: "Permintaan stok menunggu", count: c, href: "/stok/permintaan", tone: "blue" }))));
  }
  if (can("report.create")) {
    tasks.push(
      (async () => {
        // Jumlah shift per divisi (Produksi 2, lainnya 1); laporan yang belum dibuat ikut terhitung
        const { unsentReportCount } = await import("./shiftReportStock");
        const missing = await unsentReportCount(yesterday, divisionId);
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
  if (can("finance.approve")) {
    // Rekening simpanan dana sisihan dipakai untuk operasional: harus dikembalikan dari rekening operasional
    tasks.push(
      import("./talangan")
        .then((m) => m.talanganOutstanding())
        .then((t) => void (t.total > 0 && out.push({ key: "talangan", label: `Dana talangan belum dikembalikan · Rp ${t.total.toLocaleString("id-ID")} (klik untuk kirim bukti)`, count: t.count, href: "/finance/talangan?kembali=1", tone: "red" })))
        .catch(() => {}),
    );
  }
  if (can("accounting.view")) {
    tasks.push(
      prisma.payable.findMany({ where: { dueDate: { lte: new Date(Date.now() + 7 * 86400000) } }, select: { amount: true, paid: true } }).then((rows) => {
        const due = rows.filter((r) => r.paid < r.amount).length;
        if (due) out.push({ key: "payable", label: "Hutang jatuh tempo ≤ 7 hari", count: due, href: "/akuntansi/piutang-utang?tab=utang", tone: "red" });
      }),
    );
  }
  if (can("accounting.view")) {
    // Anggaran beban bulan berjalan: realisasi ≥100% (merah) dan ≥80% (kuning)
    tasks.push(
      import("./budget")
        .then((m) => m.budgetWarnings())
        .then((w) => {
          if (w.over.length) out.push({ key: "budget-over", label: `Beban melewati anggaran: ${w.over.slice(0, 3).map((r) => r.name).join(", ")}${w.over.length > 3 ? ", …" : ""}`, count: w.over.length, href: "/akuntansi/anggaran", tone: "red" });
          if (w.warn.length) out.push({ key: "budget-warn", label: `Beban mendekati anggaran (≥80%): ${w.warn.slice(0, 3).map((r) => r.name).join(", ")}${w.warn.length > 3 ? ", …" : ""}`, count: w.warn.length, href: "/akuntansi/anggaran", tone: "amber" });
        })
        .catch(() => {}),
    );
  }
  if (can("payroll.approve")) {
    tasks.push(prisma.payrollPeriod.count({ where: { status: { not: "DIBAYAR" }, payDate: { lte: dateOnly(today) }, payslips: { some: {} } } }).then((c) => void (c && out.push({ key: "payday", label: "Gaji sudah jatuh tanggal gajian", count: c, href: "/gaji", tone: "red" }))));
  }
  await Promise.all(tasks);
  return out;
}
