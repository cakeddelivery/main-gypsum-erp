import { redirect } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reportDivision } from "@/lib/reportScope";
import { todayStr } from "@/lib/time";
import { PageHeader } from "@/components/ui";
import { ReportStartForm } from "@/components/ReportStartForm";

export const metadata = { title: "Buka laporan" };

/**
 * Tujuan ketukan notifikasi pengingat: buka laporan shift hari ini milik divisi anggota (shift dari jam HP, sama seperti
 * tombol + Lapor) lalu langsung tampilkan popup "+ Barang masuk" (f=masuk) atau "+ Penerimaan borongan" (f=terima).
 * Supervisor/Owner (tanpa divisi tetap) diarahkan ke daftar laporan / penerimaan borongan.
 */
export default async function BukaLaporan({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const user = await requirePerm("report.view");
  const { f } = await searchParams;
  // Penerimaan borongan sekarang lewat Borongan › Kiriman (per pengambilan AMB)
  if (f === "terima") redirect("/borongan?tab=kiriman");
  const go = f === "terima" ? "terima" : f === "panen" ? "panen" : "masuk";
  const fixed = reportDivision(user);
  if (!fixed || fixed === "-" || !(user.can("report.create") || (go === "panen" && user.can("report.harvest")))) redirect(go === "terima" ? "/borongan?tab=terima" : "/laporan");
  const [division, shifts] = await Promise.all([
    prisma.division.findUnique({ where: { id: fixed }, select: { id: true, name: true, shiftCount: true } }),
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, name: true, startTime: true, endTime: true } }),
  ]);
  if (!division) redirect("/laporan");
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={go === "terima" ? "Penerimaan borongan" : go === "panen" ? "Hasil panen" : "Barang masuk"} />
      <div className="card p-4">
        <ReportStartForm data={{ auto: true, today: todayStr(), divisions: [division], shifts }} go={go} />
      </div>
    </div>
  );
}
