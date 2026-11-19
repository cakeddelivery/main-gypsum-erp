import { prisma } from "./db";
import { audit } from "./audit";
import { checkGeofence, evaluateCheckIn, type GeoPoint } from "./attendance";
import { SHIFT_NOTE_PREFIX, SYSTEM_VALIDATOR, actualShift, divisionShifts, isAutoNote, isShiftDivision } from "./attendanceRules";
import { addDays, dateOnly, dateStr, fmtDay, todayStr } from "./time";
import { checkoutDiff, crossesMidnight, workdayFor } from "./workday";

type Actor = { id: string; name: string; employeeId: string | null };
const activeSites = () => prisma.workSite.findMany({ where: { active: true } });

/**
 * Tanggal kerja absen saat ini untuk satu karyawan. Shift malam lintas hari (mis. 16:00–01:00): pukul 01:03 masih
 * milik tanggal kerja kemarin bila absen masuk kemarin belum pulang (lihat lib/workday).
 */
export async function resolveWorkday(employeeId: string, now: Date = new Date()) {
  const y = dateOnly(addDays(todayStr(now), -1));
  const [att, sched, emp] = await Promise.all([
    prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: y } }, include: { shift: true } }),
    prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId, date: y } }, include: { shift: true } }),
    prisma.employee.findUnique({ where: { id: employeeId }, select: { division: { select: { shiftCount: true } } } }),
  ]);
  return workdayFor(now, { att, sched, shiftDivision: !!emp?.division && isShiftDivision(emp.division) });
}

/** Absen masuk diri sendiri dengan cek geofence. Dipakai halaman Absensi dan bot Telegram (`via`). */
export async function selfCheckIn(user: Actor, pos: GeoPoint | null, via: "WEB" | "TELEGRAM" = "WEB") {
  if (!user.employeeId) throw new Error("Akun Anda belum ditautkan ke data karyawan");
  const now = new Date();
  const wd = await resolveWorkday(user.employeeId, now);
  if (wd.carried === "pulang") throw new Error(`Anda masih di shift malam tanggal kerja ${fmtDay(dateOnly(wd.date))} dan belum absen pulang. Tekan Absen Pulang dulu.`);
  // Datang telat ke shift malam kemarin (mis. 00.30 untuk shift 16:00–01:00) → tetap tanggal kerja kemarin
  const lateNight = wd.carried === "masuk";
  const date = lateNight ? wd.date : todayStr(now);
  const sched = await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
  const exists = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
  if (exists && !exists.checkIn && (exists.status === "IZIN" || exists.status === "SAKIT")) throw new Error(`Hari ini Anda tercatat ${exists.status === "IZIN" ? "Izin" : "Sakit"}. Bila ternyata masuk kerja, minta Supervisor mengubah absensi.`);
  // Alpa/Libur otomatis (dibuat sistem) boleh ditimpa absen masuk sungguhan; selain itu tolak
  const replace = exists && !exists.checkIn && isAutoNote(exists.note) ? exists : null;
  if (exists && !replace) throw new Error("Anda sudah absen masuk hari ini");
  const geo = checkGeofence(pos, await activeSites());
  if (!geo.ok) throw new Error(geo.error);
  // Divisi 2 shift (Cetak, Oven): shift mengikuti jam masuk walau jadwalnya shift lain (jadwal ikut diperbarui).
  // Divisi 1 shift: shift jadwal bila ada, selain itu shift terdekat. Absen tanpa jadwal → jadwal hari itu diisi otomatis.
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: user.employeeId }, select: { division: { select: { shiftCount: true } } } });
  const active = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  const shiftDiv = isShiftDivision(emp.division);
  const shift = lateNight && sched ? await prisma.shift.findUnique({ where: { id: sched.shiftId } }) : actualShift(shiftDiv ? divisionShifts(active, emp.division.shiftCount) : active, now, sched?.shiftId ?? null, shiftDiv) ?? (sched ? await prisma.shift.findUnique({ where: { id: sched.shiftId } }) : null);
  if (!shift) throw new Error("Belum ada shift aktif. Hubungi admin.");
  const ev = evaluateCheckIn(shift, now);
  const moved = !!sched && sched.shiftId !== shift.id;
  const notes = [moved ? `${SHIFT_NOTE_PREFIX}: ${active.find((x) => x.id === sched!.shiftId)?.name ?? "jadwal"} → ${shift.name}` : null, via === "TELEGRAM" ? "Absen via Telegram" : null].filter(Boolean);
  const a = await prisma.$transaction(async (tx) => {
    if (replace) await tx.attendance.delete({ where: { id: replace.id } });
    const row = await tx.attendance.create({
      data: {
        employeeId: user.employeeId!, shiftId: shift.id, date: dateOnly(date), checkIn: now, status: ev.status, lateMinutes: ev.lateMinutes,
        checkInLat: pos?.lat, checkInLng: pos?.lng, checkInAccuracy: pos?.accuracy, checkInDistance: geo.distance, checkInSiteId: geo.site?.id,
        note: notes.length ? notes.join(" · ") : null,
        // Tervalidasi otomatis (GPS & jam dicek sistem); koreksi lewat tab Alpa & koreksi
        validated: true, validatedBy: SYSTEM_VALIDATOR, validatedAt: now,
      },
    });
    await tx.shiftSchedule.upsert({ where: { employeeId_date: { employeeId: user.employeeId!, date: dateOnly(date) } }, create: { employeeId: user.employeeId!, date: dateOnly(date), shiftId: shift.id }, update: { shiftId: shift.id } });
    return row;
  });
  await audit(user, "ABSEN_MASUK", "Attendance", a.id, { ...ev, lat: pos?.lat, lng: pos?.lng, lokasi: geo.site?.name, jarak: geo.distance, via });
  return { status: ev.status, lateMinutes: ev.lateMinutes, shift: shift.name, site: geo.site?.name ?? null, distance: geo.distance, date };
}

/**
 * Laporan shift divisi karyawan di tanggal & shift absennya sudah terkirim? (null = divisi tanpa laporan shift)
 * Divisi 1 shift memakai laporan shift mana pun di tanggal itu.
 */
export async function divisionReportSent(employeeId: string, date: Date, shiftId: string): Promise<{ sent: boolean; division: string } | null> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, include: { division: true } });
  if (!e?.division?.reportTemplate || !e.division.active) return null;
  const reports = await prisma.shiftReport.findMany({ where: { date, divisionId: e.divisionId, status: { in: ["TERKIRIM", "DIREVISI"] } }, select: { shiftId: true } });
  // Divisi 2 shift: laporan shift absennya, atau semua laporan yang diharapkan hari itu (hanya shift yang ada karyawannya) sudah terkirim
  let sent = reports.length > 0;
  if (e.division.shiftCount > 1) {
    const { expectedSlots } = await import("./reportExpected");
    const slots = (await expectedSlots(dateStr(date), e.divisionId)).filter((x) => x.divisionId === e.divisionId);
    sent = reports.some((r) => r.shiftId === shiftId) || (slots.length > 0 && slots.every((x) => x.sent));
  }
  return { sent, division: e.division.name };
}

/** Absen pulang diri sendiri dengan cek geofence. Laporan shift divisi belum terkirim = peringatan saja (tidak dikunci). */
export async function selfCheckOut(user: Actor, pos: GeoPoint | null, via: "WEB" | "TELEGRAM" = "WEB") {
  if (!user.employeeId) throw new Error("Akun belum ditautkan ke karyawan");
  const now = new Date();
  // Shift malam lintas hari: pulang 01.05 menutup absen tanggal kerja kemarin, bukan hari baru
  const wd = await resolveWorkday(user.employeeId, now);
  const date = wd.carried === "pulang" ? wd.date : todayStr(now);
  const a = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
  if (!a?.checkIn) throw new Error("Belum absen masuk");
  if (a.checkOut) throw new Error("Sudah absen pulang");
  const geo = checkGeofence(pos, await activeSites());
  if (!geo.ok) throw new Error(geo.error);
  const rep = await divisionReportSent(user.employeeId, a.date, a.shiftId);
  const reportMissing = !!rep && !rep.sent;
  // Shift tercatat bukan shift malam tetapi jadwalnya shift malam (salah terpilih): samakan dengan jadwal agar lembur/pulang cepat benar
  let shiftId = a.shiftId;
  if (wd.carried === "pulang") {
    const [cur, sch] = await Promise.all([
      prisma.shift.findUnique({ where: { id: a.shiftId } }),
      prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: a.date } }, include: { shift: true } }),
    ]);
    if (cur && sch && !crossesMidnight(cur) && crossesMidnight(sch.shift)) shiftId = sch.shiftId;
  }
  await prisma.attendance.update({
    where: { id: a.id },
    data: { shiftId, checkOut: now, checkOutLat: pos?.lat, checkOutLng: pos?.lng, checkOutAccuracy: pos?.accuracy, checkOutDistance: geo.distance, reportMissing },
  });
  const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
  const diff = shift ? checkoutDiff(date, shift, now) : { earlyMinutes: 0, overtimeMinutes: 0 };
  await audit(user, "ABSEN_PULANG", "Attendance", a.id, { tanggalKerja: date, lat: pos?.lat, lng: pos?.lng, lokasi: geo.site?.name, jarak: geo.distance, via, laporanBelumTerkirim: reportMissing || undefined, pulangCepatMenit: diff.earlyMinutes || undefined, lemburMenit: diff.overtimeMinutes || undefined });
  const when = date === todayStr(now) ? "hari ini" : `tanggal ${fmtDay(a.date)}`;
  const warning = reportMissing ? `Laporan shift ${rep!.division} ${when} belum dikirim. Ingatkan PIC divisi untuk mengirimnya.` : null;
  return { checkIn: a.checkIn, checkOut: now, site: geo.site?.name ?? null, distance: geo.distance, warning, date, ...diff };
}
