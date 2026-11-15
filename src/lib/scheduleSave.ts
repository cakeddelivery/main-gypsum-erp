import { prisma } from "./db";
import { dateOnly } from "./time";
import type { Change } from "./scheduleEdit";

/**
 * Simpan perubahan jadwal dari tabel sekaligus (satu transaksi).
 * "" → jadwal hari itu dihapus (libur); "IN" → masuk (shift lama dipertahankan, bila belum ada pakai shift pertama =
 * jam kerja divisi 1 shift); "S1"/"S2" → shift aktif ke-1/ke-2 (urut kode).
 */
export async function applyScheduleChanges(changes: Change[]) {
  const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true } });
  if (!shifts.length) throw new Error("Belum ada shift aktif. Hubungi admin.");
  const pick = (v: Change["value"]) => (v === "S2" ? (shifts[1] ?? shifts[0]).id : shifts[0].id);
  let saved = 0;
  let removed = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      const where = { employeeId_date: { employeeId: c.employeeId, date: dateOnly(c.date) } };
      if (c.value === "") {
        removed += (await tx.shiftSchedule.deleteMany({ where: { employeeId: c.employeeId, date: dateOnly(c.date) } })).count;
        continue;
      }
      if (c.value === "IN") {
        const ex = await tx.shiftSchedule.findUnique({ where });
        if (!ex) await tx.shiftSchedule.create({ data: { employeeId: c.employeeId, date: dateOnly(c.date), shiftId: shifts[0].id } });
        saved++;
        continue;
      }
      const shiftId = pick(c.value);
      await tx.shiftSchedule.upsert({ where, create: { employeeId: c.employeeId, date: dateOnly(c.date), shiftId }, update: { shiftId } });
      saved++;
    }
  });
  return { saved, removed };
}
