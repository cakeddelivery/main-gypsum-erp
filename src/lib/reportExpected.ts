import { prisma } from "./db";
import { dateOnly } from "./time";

/**
 * Laporan shift yang DIHARAPKAN pada satu tanggal kerja. Divisi 1 shift: 1 laporan. Divisi 2 shift: hanya untuk shift yang
 * benar-benar ada karyawannya (absen masuk, atau terjadwal dan tidak tercatat libur/izin/sakit/alpa) — Oven berisi 1 orang
 * hanya diharapkan 1 laporan (shift absennya), bukan 2.
 */
export type ExpectedSlot = { divisionId: string; division: string; shiftId: string; shift: string; sent: boolean; draftId: string | null };

export async function expectedSlots(date: string, divisionId?: string | null): Promise<ExpectedSlot[]> {
  const d = dateOnly(date);
  const [shifts, divisions] = await Promise.all([
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.division.findMany({ where: { active: true, reportTemplate: { not: null }, ...(divisionId ? { id: divisionId } : {}) }, select: { id: true, name: true, shiftCount: true } }),
  ]);
  if (!divisions.length) return [];
  const divIds = divisions.map((x) => x.id);
  const multi = divisions.filter((x) => x.shiftCount > 1).map((x) => x.id);
  const [atts, scheds, reports] = await Promise.all([
    multi.length ? prisma.attendance.findMany({ where: { date: d, employee: { divisionId: { in: multi } } }, select: { employeeId: true, shiftId: true, checkIn: true, status: true, employee: { select: { divisionId: true } } } }) : [],
    multi.length ? prisma.shiftSchedule.findMany({ where: { date: d, employee: { divisionId: { in: multi }, status: "AKTIF" } }, select: { employeeId: true, shiftId: true, employee: { select: { divisionId: true } } } }) : [],
    prisma.shiftReport.findMany({ where: { date: d, divisionId: { in: divIds } }, select: { id: true, divisionId: true, shiftId: true, status: true } }),
  ]);
  const out: ExpectedSlot[] = [];
  for (const div of divisions) {
    const divShifts = shifts.slice(0, Math.max(1, Math.min(div.shiftCount, shifts.length)));
    let wanted = divShifts;
    if (div.shiftCount > 1) {
      const ids = new Set<string>();
      for (const a of atts) if (a.employee.divisionId === div.id && a.checkIn) ids.add(a.shiftId);
      for (const s of scheds) {
        if (s.employee.divisionId !== div.id) continue;
        const att = atts.find((a) => a.employeeId === s.employeeId);
        if (att && !att.checkIn && ["LIBUR", "IZIN", "SAKIT", "ALPA"].includes(att.status)) continue;
        ids.add(s.shiftId);
      }
      wanted = divShifts.filter((s) => ids.has(s.id));
    }
    for (const s of wanted) {
      const rs = reports.filter((r) => r.divisionId === div.id && r.shiftId === s.id);
      out.push({ divisionId: div.id, division: div.name, shiftId: s.id, shift: s.name, sent: rs.some((r) => r.status !== "DRAFT"), draftId: rs.find((r) => r.status === "DRAFT")?.id ?? null });
    }
  }
  return out;
}
