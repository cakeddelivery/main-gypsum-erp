import { prisma } from "./db";
import { addDays, dateOnly, dateStr, fmtDateTime, fmtDay, todayStr } from "./time";
import { NIGHT_GRACE_HOURS, crossesMidnight, shiftWindow } from "./workday";

/**
 * Perbaikan data shift malam lintas hari (sebelum hotfix tanggal kerja): karyawan shift malam (mis. 16:00–01:00)
 * yang menekan "Absen Masuk" lewat tengah malam karena halaman menampilkan hari baru. Absen "masuk" itu sebenarnya
 * absen PULANG tanggal kerja kemarin.
 *
 * Syarat satu baris diperbaiki (semua harus terpenuhi):
 *  - tanggal D: ada absen masuk, belum pulang;
 *  - tanggal D-1: ada absen masuk di shift lintas tengah malam, BELUM pulang;
 *  - jam "masuk" D jatuh setelah jam masuk D-1 dan sebelum jam selesai shift D-1 + batas wajar.
 * Hasil: D-1 diberi jam pulang = jam "masuk" D (beserta lokasinya), baris D dihapus. Dicatat di audit log.
 */
export type NightFix = { attId: string; prevId: string; employeeId: string; name: string; date: string; prevDate: string; at: Date; line: string };

export async function findNightFixes(days = 14, now = new Date()): Promise<NightFix[]> {
  const from = addDays(todayStr(now), -days);
  const rows = await prisma.attendance.findMany({
    where: { date: { gte: dateOnly(from) }, checkIn: { not: null }, checkOut: null },
    include: { shift: true, employee: { select: { name: true } } },
    orderBy: [{ date: "asc" }],
  });
  const key = (id: string, d: string) => `${id}:${d}`;
  const byKey = new Map(rows.map((r) => [key(r.employeeId, dateStr(r.date)), r]));
  const out: NightFix[] = [];
  for (const r of rows) {
    const date = dateStr(r.date);
    const prevDate = addDays(date, -1);
    const prev = byKey.get(key(r.employeeId, prevDate)) ?? (await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: r.employeeId, date: dateOnly(prevDate) } }, include: { shift: true, employee: { select: { name: true } } } }));
    if (!prev?.checkIn || prev.checkOut || !crossesMidnight(prev.shift)) continue;
    const end = shiftWindow(prevDate, prev.shift).end.getTime() + NIGHT_GRACE_HOURS * 3600_000;
    const at = r.checkIn!;
    if (at <= prev.checkIn || at.getTime() >= end) continue;
    out.push({
      attId: r.id, prevId: prev.id, employeeId: r.employeeId, name: r.employee.name, date, prevDate, at,
      line: `${r.employee.name}: "absen masuk" ${fmtDateTime(at)} (tercatat ${fmtDay(r.date)}, ${r.shift.name}) → jadi absen PULANG ${prev.shift.name} tanggal kerja ${fmtDay(prev.date)} (masuk ${fmtDateTime(prev.checkIn)}). Cek jadwal ${fmtDay(r.date)}: sempat terisi ${r.shift.name} otomatis.`,
    });
  }
  return out;
}

export async function applyNightFixes(fixes: NightFix[]) {
  for (const f of fixes) {
    await prisma.$transaction(async (tx) => {
      const wrong = await tx.attendance.findUniqueOrThrow({ where: { id: f.attId } });
      await tx.attendance.update({
        where: { id: f.prevId },
        data: { checkOut: wrong.checkIn, checkOutLat: wrong.checkInLat, checkOutLng: wrong.checkInLng, checkOutAccuracy: wrong.checkInAccuracy, checkOutDistance: wrong.checkInDistance },
      });
      await tx.attendance.delete({ where: { id: f.attId } });
      await tx.auditLog.create({
        data: { actorName: "Skrip perbaikan shift malam", action: "ABSEN_SHIFT_MALAM_DIPERBAIKI", entity: "Attendance", entityId: f.prevId, data: { nama: f.name, tanggalKerja: f.prevDate, dihapus: { tanggal: f.date, id: f.attId, jamMasuk: wrong.checkIn?.toISOString() ?? null, shiftId: wrong.shiftId, status: wrong.status }, jamPulang: wrong.checkIn?.toISOString() ?? null } },
      });
    });
  }
  return fixes.length;
}

// ---------------- LAPORAN SHIFT MALAM ----------------

/**
 * Laporan shift malam (mis. Cetak Shift 2 16:00–01:00) yang dibuka setelah tengah malam sebelum hotfix tercatat di
 * tanggal hari baru. Tanggal laporan = tanggal MULAI shift, jadi dipindah ke kemarin.
 * Syarat: shift lintas tengah malam, laporan DIBUAT pada tanggalnya sendiri sebelum jam selesai shift + batas wajar.
 * Bila kemarin sudah ada laporan divisi & shift yang sama (bentrok), tidak dipindah — diputuskan manual.
 */
export type ReportFix = { id: string; label: string; from: string; to: string; conflictWith: string | null };

export async function findNightReportFixes(days = 14, now = new Date()): Promise<ReportFix[]> {
  const from = addDays(todayStr(now), -days);
  const rows = await prisma.shiftReport.findMany({ where: { date: { gte: dateOnly(from) } }, include: { shift: true, division: { select: { name: true } } }, orderBy: { date: "asc" } });
  const out: ReportFix[] = [];
  for (const r of rows) {
    if (!crossesMidnight(r.shift)) continue;
    const date = dateStr(r.date);
    if (todayStr(r.createdAt) !== date) continue;
    const prev = addDays(date, -1);
    const limit = shiftWindow(prev, r.shift).end.getTime() + NIGHT_GRACE_HOURS * 3600_000;
    if (r.createdAt.getTime() >= limit) continue;
    const clash = rows.find((x) => x.id !== r.id && dateStr(x.date) === prev && x.shiftId === r.shiftId && x.divisionId === r.divisionId)
      ?? (await prisma.shiftReport.findFirst({ where: { date: dateOnly(prev), shiftId: r.shiftId, divisionId: r.divisionId, id: { not: r.id } }, select: { id: true, status: true, createdBy: true } }));
    out.push({
      id: r.id, from: date, to: prev, conflictWith: clash?.id ?? null,
      label: `${r.division.name} · ${r.shift.name}: laporan ${fmtDay(r.date)} (dibuka ${fmtDateTime(r.createdAt)}, ${r.status}) → ${fmtDay(dateOnly(prev))}${clash ? " — BENTROK: tanggal itu sudah punya laporan divisi & shift yang sama, tidak dipindah (putuskan manual)" : ""}`,
    });
  }
  return out;
}

export async function applyNightReportFixes(fixes: ReportFix[]) {
  let n = 0;
  for (const f of fixes.filter((x) => !x.conflictWith)) {
    await prisma.$transaction(async (tx) => {
      await tx.shiftReport.update({ where: { id: f.id }, data: { date: dateOnly(f.to) } });
      await tx.auditLog.create({ data: { actorName: "Skrip perbaikan shift malam", action: "LAPORAN_SHIFT_MALAM_DIPINDAH", entity: "ShiftReport", entityId: f.id, data: { dari: f.from, ke: f.to } } });
    });
    n++;
  }
  return n;
}
