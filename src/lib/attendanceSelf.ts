import { prisma } from "./db";
import { audit } from "./audit";
import { checkGeofence, evaluateCheckIn, nearestShift, type GeoPoint } from "./attendance";
import { dateOnly, todayStr } from "./time";

type Actor = { id: string; name: string; employeeId: string | null };
const activeSites = () => prisma.workSite.findMany({ where: { active: true } });

/** Absen masuk diri sendiri dengan cek geofence. Dipakai halaman Absensi dan bot Telegram (`via`). */
export async function selfCheckIn(user: Actor, pos: GeoPoint | null, via: "WEB" | "TELEGRAM" = "WEB") {
  if (!user.employeeId) throw new Error("Akun Anda belum ditautkan ke data karyawan");
  const date = todayStr();
  const sched = await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
  const exists = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(date) } } });
  if (exists) throw new Error("Anda sudah absen masuk hari ini");
  const geo = checkGeofence(pos, await activeSites());
  if (!geo.ok) throw new Error(geo.error);
  const now = new Date();
  // Jadwal dari admin dipakai bila ada; selain itu shift dikenali dari jam masuk terdekat
  const shift = sched ? await prisma.shift.findUniqueOrThrow({ where: { id: sched.shiftId } }) : nearestShift(await prisma.shift.findMany({ where: { active: true } }), now);
  if (!shift) throw new Error("Belum ada shift aktif. Hubungi admin.");
  const ev = evaluateCheckIn(shift, now);
  const a = await prisma.attendance.create({
    data: {
      employeeId: user.employeeId, shiftId: shift.id, date: dateOnly(date), checkIn: now, status: ev.status, lateMinutes: ev.lateMinutes,
      checkInLat: pos?.lat, checkInLng: pos?.lng, checkInAccuracy: pos?.accuracy, checkInDistance: geo.distance, checkInSiteId: geo.site?.id,
      ...(via === "TELEGRAM" ? { note: "Absen via Telegram" } : {}),
    },
  });
  await audit(user, "ABSEN_MASUK", "Attendance", a.id, { ...ev, lat: pos?.lat, lng: pos?.lng, lokasi: geo.site?.name, jarak: geo.distance, via });
  return { status: ev.status, lateMinutes: ev.lateMinutes, shift: shift.name, site: geo.site?.name ?? null, distance: geo.distance };
}

/** Absen pulang diri sendiri dengan cek geofence */
export async function selfCheckOut(user: Actor, pos: GeoPoint | null, via: "WEB" | "TELEGRAM" = "WEB") {
  if (!user.employeeId) throw new Error("Akun belum ditautkan ke karyawan");
  const a = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: user.employeeId, date: dateOnly(todayStr()) } } });
  if (!a?.checkIn) throw new Error("Belum absen masuk");
  if (a.checkOut) throw new Error("Sudah absen pulang");
  const geo = checkGeofence(pos, await activeSites());
  if (!geo.ok) throw new Error(geo.error);
  const now = new Date();
  await prisma.attendance.update({
    where: { id: a.id },
    data: { checkOut: now, checkOutLat: pos?.lat, checkOutLng: pos?.lng, checkOutAccuracy: pos?.accuracy, checkOutDistance: geo.distance },
  });
  await audit(user, "ABSEN_PULANG", "Attendance", a.id, { lat: pos?.lat, lng: pos?.lng, lokasi: geo.site?.name, jarak: geo.distance, via });
  return { checkIn: a.checkIn, checkOut: now, site: geo.site?.name ?? null, distance: geo.distance };
}
