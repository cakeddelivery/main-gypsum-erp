import type { AttendanceStatus, LeaveKind, Role } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { lockKey } from "./advisoryLock";
import { addDays, dateOnly, dateStr, fmtDate, todayStr } from "./time";
import { sendPush } from "./push";
import { esc, sendTelegram } from "./telegram";

/**
 * Izin & Sakit diajukan karyawan sendiri; disetujui Supervisor ATAU Owner (salah satu cukup).
 * Hari yang disetujui dicatat di absensi sebagai IZIN/SAKIT (aturan gaji yang sudah ada) dan menggantikan Alpa otomatis.
 */
export const LEAVE_APPROVERS: Role[] = ["SUPERVISOR", "OWNER"];
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = { IZIN: "Izin", SAKIT: "Sakit" };
/** Rentang terpanjang sekali pengajuan */
export const MAX_LEAVE_DAYS = 14;
/** Boleh mengajukan untuk hari yang sudah lewat (mis. sakit mendadak) sampai sekian hari ke belakang */
export const BACKDATE_DAYS = 7;
export const LEAVE_NOTE = "Pengajuan disetujui";

export const canDecideLeave = (role: Role) => LEAVE_APPROVERS.includes(role);

/** Daftar tanggal (YYYY-MM-DD) dari..sampai, inklusif */
export function leaveDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_LEAVE_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

export type LeaveInput = { kind: LeaveKind; from: string; to: string; reason: string; hasAttachment: boolean };

/** Cek isian pengajuan (murni, mudah dites). Mengembalikan pesan error atau null. */
export function leaveError(i: LeaveInput, today: string): string | null {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (i.kind !== "IZIN" && i.kind !== "SAKIT") return "Pilih jenis: Izin atau Sakit";
  if (!ymd.test(i.from) || !ymd.test(i.to)) return "Tanggal tidak valid";
  if (i.to < i.from) return "Tanggal selesai tidak boleh sebelum tanggal mulai";
  if (i.from < addDays(today, -BACKDATE_DAYS)) return `Pengajuan untuk hari yang sudah lewat paling lama ${BACKDATE_DAYS} hari ke belakang`;
  if (leaveDays(i.from, i.to).length > MAX_LEAVE_DAYS) return `Paling lama ${MAX_LEAVE_DAYS} hari per pengajuan`;
  if (i.reason.trim().length < 3) return "Alasan wajib diisi";
  if (i.kind === "SAKIT" && i.from !== i.to && !i.hasAttachment) return "Sakit lebih dari 1 hari wajib melampirkan foto surat dokter";
  return null;
}

/**
 * Status absensi baru untuk satu hari yang disetujui, atau null bila hari itu dibiarkan
 * (sudah absen masuk / hadir / libur tetap apa adanya). Alpa (otomatis atau manual) diganti.
 */
export function leaveAttendanceStatus(kind: LeaveKind, existing: { status: AttendanceStatus; checkIn: Date | null } | null): AttendanceStatus | null {
  if (!existing) return kind;
  if (existing.checkIn || existing.status === "HADIR" || existing.status === "TERLAMBAT" || existing.status === "LIBUR") return null;
  return kind;
}

type Actor = { id: string; name: string; role: Role; employeeId: string | null };

function rangeText(from: Date, to: Date) {
  const a = dateStr(from);
  const b = dateStr(to);
  return a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
}

async function approverIds(exceptUserId?: string) {
  const us = await prisma.user.findMany({ where: { active: true, role: { in: LEAVE_APPROVERS }, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) }, select: { id: true } });
  return us.map((u) => u.id);
}

async function telegramTo(userIds: string[], text: string) {
  if (!userIds.length) return;
  const ids = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, userId: { in: userIds }, user: { active: true } }, select: { chatId: true } });
  await Promise.all(ids.map((i) => sendTelegram(i.chatId!, text, { type: "IZIN_SAKIT" }).catch(() => {})));
}

/** Karyawan mengajukan izin/sakit untuk dirinya sendiri */
export async function submitLeave(user: Actor, input: LeaveInput & { attachmentPath?: string | null }, now = new Date()) {
  if (!user.employeeId) throw new Error("Akun Anda belum ditautkan ke data karyawan");
  const err = leaveError(input, todayStr(now));
  if (err) throw new Error(err);
  const from = dateOnly(input.from);
  const to = dateOnly(input.to);
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: user.employeeId }, select: { name: true, division: { select: { name: true } } } });
  // Cek bentrok + simpan dalam satu transaksi berkunci per karyawan: klik ganda/submit ulang bersamaan tidak membuat pengajuan dobel
  const r = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `leave:${user.employeeId}`);
    const clash = await tx.leaveRequest.findFirst({ where: { employeeId: user.employeeId!, status: { in: ["MENUNGGU", "DISETUJUI"] }, dateFrom: { lte: to }, dateTo: { gte: from } } });
    if (clash) throw new Error(`Sudah ada pengajuan ${LEAVE_KIND_LABEL[clash.kind].toLowerCase()} untuk ${rangeText(clash.dateFrom, clash.dateTo)}`);
    return tx.leaveRequest.create({
      data: { employeeId: user.employeeId!, userId: user.id, kind: input.kind, dateFrom: from, dateTo: to, reason: input.reason.trim().slice(0, 500), attachmentPath: input.attachmentPath ?? null },
    });
  });
  await audit(user, "IZIN_DIAJUKAN", "LeaveRequest", r.id, { kind: r.kind, from: input.from, to: input.to });
  const label = LEAVE_KIND_LABEL[r.kind];
  const when = rangeText(from, to);
  const ids = await approverIds(user.id);
  await sendPush(ids, { title: `Pengajuan ${label.toLowerCase()} baru`, body: `${emp.name} (${emp.division.name}) · ${when}: ${r.reason}`, url: "/absensi?tab=izin", tag: `izin-${r.id}` }).catch(() => {});
  await telegramTo(ids, `📝 <b>Pengajuan ${esc(label)}</b>\n${esc(emp.name)} · ${esc(emp.division.name)}\n${esc(when)}\nAlasan: ${esc(r.reason)}${r.attachmentPath ? "\n📎 Ada lampiran" : ""}\n\nSetujui/tolak di menu Absensi → Izin & Sakit.`);
  return r;
}

/** Setujui / tolak (Supervisor atau Owner). Setuju → absensi tiap hari jadi IZIN/SAKIT (menggantikan Alpa). */
export async function decideLeave(user: Actor, id: string, approve: boolean, rejectReason?: string | null) {
  if (!canDecideLeave(user.role)) throw new Error("Hanya Supervisor atau Owner yang dapat menyetujui izin/sakit");
  const req = await prisma.leaveRequest.findUniqueOrThrow({ where: { id }, include: { employee: { select: { id: true, name: true } } } });
  if (req.status !== "MENUNGGU") throw new Error("Pengajuan ini sudah diputuskan");
  if (user.employeeId && req.employeeId === user.employeeId && user.role !== "OWNER") throw new Error("Pengajuan Anda sendiri harus disetujui atasan lain");
  if (!approve && !rejectReason?.trim()) throw new Error("Tulis alasan penolakan");
  let applied = 0;
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    // Kunci: hanya berhasil bila masih menunggu (dua atasan menekan bersamaan → yang kedua ditolak)
    const upd = await tx.leaveRequest.updateMany({
      where: { id, status: "MENUNGGU" },
      data: { status: approve ? "DISETUJUI" : "DITOLAK", decidedBy: user.name, decidedAt: new Date(), rejectReason: approve ? null : rejectReason!.trim().slice(0, 300) },
    });
    if (!upd.count) throw new Error("Pengajuan ini sudah diputuskan");
    if (!approve) return;
    const shifts = await tx.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true } });
    const note = `${LEAVE_NOTE}: ${req.reason}`.slice(0, 300);
    for (const day of leaveDays(dateStr(req.dateFrom), dateStr(req.dateTo))) {
      const d = dateOnly(day);
      const ex = await tx.attendance.findUnique({ where: { employeeId_date: { employeeId: req.employeeId, date: d } } });
      const status = leaveAttendanceStatus(req.kind, ex);
      if (!status) {
        skipped++;
        continue;
      }
      if (ex) {
        await tx.attendance.update({ where: { id: ex.id }, data: { status, note, validated: true, lateMinutes: 0 } });
      } else {
        const sched = await tx.shiftSchedule.findUnique({ where: { employeeId_date: { employeeId: req.employeeId, date: d } } });
        const shiftId = sched?.shiftId ?? shifts[0]?.id;
        if (!shiftId) throw new Error("Belum ada shift aktif. Hubungi admin.");
        await tx.attendance.create({ data: { employeeId: req.employeeId, date: d, shiftId, status, note, validated: true } });
      }
      applied++;
    }
    await audit(user, "IZIN_DISETUJUI", "LeaveRequest", id, { kind: req.kind, applied, skipped }, tx);
  });
  if (!approve) await audit(user, "IZIN_DITOLAK", "LeaveRequest", id, { alasan: rejectReason });
  const label = LEAVE_KIND_LABEL[req.kind].toLowerCase();
  const when = rangeText(req.dateFrom, req.dateTo);
  const title = approve ? `Pengajuan ${label} disetujui ✅` : `Pengajuan ${label} ditolak`;
  const body = approve ? `${when} — disetujui ${user.name}.` : `${when} — ditolak ${user.name}: ${rejectReason}`;
  if (req.userId) {
    await sendPush([req.userId], { title, body, url: "/absensi?tab=izin", tag: `izin-${id}` }).catch(() => {});
    await telegramTo([req.userId], `${approve ? "✅" : "❌"} <b>${esc(title)}</b>\n${esc(body)}`);
  }
  return { applied, skipped };
}

/** Karyawan membatalkan pengajuannya sendiri yang masih menunggu */
export async function cancelLeave(user: Actor, id: string) {
  const r = await prisma.leaveRequest.deleteMany({ where: { id, employeeId: user.employeeId ?? "-", status: "MENUNGGU" } });
  if (!r.count) throw new Error("Pengajuan tidak ditemukan atau sudah diputuskan");
  await audit(user, "IZIN_DIBATALKAN", "LeaveRequest", id);
}
