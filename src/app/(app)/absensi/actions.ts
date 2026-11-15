"use server";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { evaluateCheckIn, readGeo } from "@/lib/attendance";
import { selfCheckIn, selfCheckOut } from "@/lib/attendanceSelf";
import { dateOnly, jakartaDateTime, todayStr } from "@/lib/time";
import { ForbiddenError } from "@/lib/auth";
import type { AttendanceStatus, LeaveKind } from "@prisma/client";
import { cancelLeave, decideLeave, leaveError, submitLeave } from "@/lib/leave";
import { parseChanges } from "@/lib/scheduleEdit";
import { applyScheduleChanges } from "@/lib/scheduleSave";
import { reconcileAfterSchedule } from "@/lib/attendanceAuto";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, saveProof } from "@/lib/storage";
import { sniffMime } from "@/lib/imageCompress";

export const checkIn = action(
  "attendance.self",
  async (fd, user) => {
    const r = await selfCheckIn(user, readGeo(fd));
    return r.status === "TERLAMBAT" ? `Absen tercatat — terlambat ${r.lateMinutes} menit` : "Absen masuk tercatat";
  },
  ["/absensi", "/"],
);

export const checkOut = action(
  "attendance.self",
  async (fd, user) => {
    const r = await selfCheckOut(user, readGeo(fd));
    return r.warning ? `Absen pulang tercatat. ⚠ ${r.warning}` : "Absen pulang tercatat";
  },
  ["/absensi"],
);

const activeSites = () => prisma.workSite.findMany({ where: { active: true } });

/** Tambah / ubah titik lokasi kerja (geofence absen) */
export const saveWorkSite = action(
  "attendance.location",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const name = str(fd, "name");
    if (!name) throw new Error("Nama lokasi wajib diisi");
    const latitude = Number(str(fd, "latitude").replace(",", "."));
    const longitude = Number(str(fd, "longitude").replace(",", "."));
    if (!str(fd, "latitude") || !Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new Error("Latitude tidak valid");
    if (!str(fd, "longitude") || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("Longitude tidak valid");
    const radiusM = int(fd, "radiusM", 100);
    if (radiusM < 20 || radiusM > 5000) throw new Error("Radius harus 20–5000 meter");
    const data = { name, latitude, longitude, radiusM, active: id ? bool(fd, "active") : true };
    const s = id ? await prisma.workSite.update({ where: { id }, data }) : await prisma.workSite.create({ data });
    await audit(user, id ? "LOKASI_ABSEN_DIUBAH" : "LOKASI_ABSEN_DITAMBAH", "WorkSite", s.id, data);
    return id ? "Lokasi kerja diperbarui" : "Lokasi kerja ditambahkan";
  },
  ["/absensi"],
);

export const deleteWorkSite = action(
  "attendance.location",
  async (fd, user) => {
    const id = str(fd, "id");
    const s = await prisma.workSite.delete({ where: { id } });
    await audit(user, "LOKASI_ABSEN_DIHAPUS", "WorkSite", id, { name: s.name });
    return "Lokasi kerja dihapus";
  },
  ["/absensi"],
);

async function guardEmployee(employeeId: string, user: { role: string; divisionId: string | null; employeeId: string | null }) {
  // Absensi sendiri tidak boleh diatur/divalidasi sendiri (dasar potongan gaji), kecuali Owner
  if (user.role !== "OWNER" && user.employeeId && employeeId === user.employeeId) throw new Error("Absensi Anda sendiri harus diatur/divalidasi oleh atasan lain");
  if (user.role !== "KAPTEN_DIVISI" || !user.divisionId) return;
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  if (e.divisionId !== user.divisionId) throw new ForbiddenError();
}

/** Input / koreksi absensi manual oleh admin/kapten (izin, sakit, alpa, jam masuk) */
export const saveAttendance = action(
  "attendance.manage",
  async (fd, user) => {
    const employeeId = str(fd, "employeeId");
    await guardEmployee(employeeId, user);
    const date = str(fd, "date");
    const shiftId = str(fd, "shiftId");
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    let status = str(fd, "status") as AttendanceStatus;
    const time = optStr(fd, "checkIn");
    let lateMinutes = 0;
    let checkIn: Date | null = null;
    if (time && (status === "HADIR" || status === "TERLAMBAT")) {
      checkIn = jakartaDateTime(date, time);
      const ev = evaluateCheckIn(shift, checkIn);
      status = ev.status;
      lateMinutes = ev.lateMinutes;
    }
    const data = { shiftId, status, lateMinutes, checkIn, note: optStr(fd, "note"), validated: true, validatedBy: user.name, validatedAt: new Date() };
    const a = await prisma.attendance.upsert({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, create: { employeeId, date: dateOnly(date), ...data }, update: data });
    await audit(user, "ABSENSI_DIATUR", "Attendance", a.id, data);
    return "Absensi tersimpan & tervalidasi";
  },
  ["/absensi"],
);

/** Koreksi satu baris absensi (Supervisor/Owner), alasan wajib; tercatat di audit log */
export const correctAttendance = action(
  "attendance.view",
  async (fd, user) => {
    if (user.role !== "SUPERVISOR" && user.role !== "OWNER") throw new ForbiddenError();
    const employeeId = str(fd, "employeeId");
    await guardEmployee(employeeId, user);
    const date = str(fd, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal tidak valid");
    const reason = str(fd, "reason");
    if (reason.length < 3) throw new Error("Alasan koreksi wajib diisi");
    let status = str(fd, "status") as AttendanceStatus;
    if (!["HADIR", "IZIN", "SAKIT", "LIBUR", "ALPA"].includes(status)) throw new Error("Status tidak valid");
    const prev = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(date) } } });
    const sched = await prisma.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(date) } } });
    const shiftId = prev?.shiftId ?? sched?.shiftId ?? (await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } })).id;
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    let checkIn: Date | null = prev?.checkIn ?? null;
    let lateMinutes = 0;
    if (status === "HADIR") {
      const time = optStr(fd, "checkIn");
      if (time) checkIn = jakartaDateTime(date, time);
      if (!checkIn) checkIn = jakartaDateTime(date, shift.startTime);
      const ev = evaluateCheckIn(shift, checkIn);
      status = ev.status;
      lateMinutes = ev.lateMinutes;
    } else checkIn = null;
    const data = { shiftId, status, lateMinutes, checkIn, note: `Koreksi ${user.name}: ${reason}`.slice(0, 300), validated: true, validatedBy: user.name, validatedAt: new Date() };
    const a = await prisma.attendance.upsert({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, create: { employeeId, date: dateOnly(date), ...data }, update: data });
    if (status === "HADIR" || status === "TERLAMBAT") await prisma.shiftSchedule.upsert({ where: { employeeId_date: { employeeId, date: dateOnly(date) } }, create: { employeeId, date: dateOnly(date), shiftId }, update: {} });
    await audit(user, "ABSENSI_DIKOREKSI", "Attendance", a.id, { tanggal: date, dari: prev?.status ?? null, ke: status, alasan: reason });
    return "Koreksi tersimpan";
  },
  ["/absensi", "/"],
);

/** Atur jadwal langsung di tabel: semua perubahan disimpan sekaligus */
export const saveScheduleCells = action(
  "attendance.manage",
  async (fd, user) => {
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "changes") || "[]");
    } catch {
      throw new Error("Data jadwal tidak valid");
    }
    const changes = parseChanges(raw);
    if (!changes.length) return "Tidak ada perubahan";
    for (const employeeId of new Set(changes.map((c) => c.employeeId))) await guardEmployee(employeeId, user);
    const r = await applyScheduleChanges(changes);
    // Jadwal hari yang sudah lewat diubah → status absensi otomatis hari itu ikut dihitung ulang
    await reconcileAfterSchedule(changes.map((c) => c.date), [...new Set(changes.map((c) => c.employeeId))]);
    await audit(user, "JADWAL_DIATUR", "ShiftSchedule", null, { perubahan: changes.length, masuk: r.saved, libur: r.removed });
    return `Jadwal tersimpan (${changes.length} perubahan)`;
  },
  ["/absensi"],
);

/** Karyawan mengajukan izin / sakit (lampiran foto opsional; wajib untuk sakit > 1 hari) */
export const submitLeaveRequest = action(
  "attendance.self",
  async (fd, user) => {
    const file = fd.get("attachment");
    const has = file instanceof File && file.size > 0;
    if (has && file.size > MAX_PROOF_BYTES) throw new Error(MAX_PROOF_TEXT);
    const kind = str(fd, "kind") as LeaveKind;
    const from = str(fd, "dateFrom");
    const to = optStr(fd, "dateTo") || from;
    const input = { kind, from, to, reason: str(fd, "reason"), hasAttachment: has };
    const err = leaveError(input, todayStr());
    if (err) throw new Error(err);
    let attachmentPath: string | null = null;
    if (has) {
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime || (!mime.startsWith("image/") && mime !== "application/pdf")) throw new Error("Lampiran harus foto atau PDF");
      attachmentPath = await saveProof(buf, mime);
    }
    await submitLeave(user, { ...input, attachmentPath });
    return "Pengajuan terkirim. Menunggu persetujuan Supervisor/Owner.";
  },
  ["/absensi"],
);

export const decideLeaveRequest = action(
  "attendance.view",
  async (fd, user) => {
    const approve = str(fd, "decision") === "setuju";
    const r = await decideLeave(user, str(fd, "id"), approve, optStr(fd, "rejectReason"));
    return approve ? `Disetujui — ${r.applied} hari dicatat di absensi${r.skipped ? ` (${r.skipped} hari sudah hadir/libur, dibiarkan)` : ""}` : "Pengajuan ditolak";
  },
  ["/absensi", "/"],
);

export const cancelLeaveRequest = action(
  "attendance.self",
  async (fd, user) => {
    await cancelLeave(user, str(fd, "id"));
    return "Pengajuan dibatalkan";
  },
  ["/absensi"],
);
