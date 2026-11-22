import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { decideDayOff, submitDayOff } from "@/lib/dayOff";
import { decideLeave } from "@/lib/leave";
import { canSetOwnSchedule, ownRecordBlocked } from "@/lib/scheduleAccess";
import { dateOnly, jakartaDateTime } from "@/lib/time";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));
import { sendPush } from "@/lib/push";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
// 2033-05-11 = Rabu; minggu depan = 2033-05-16..22
const now = jakartaDateTime("2033-05-11", "09:00");
const DAYS = ["2033-05-17", "2033-05-18"];

async function mk(code: string, role: "OPERATOR" | "SUPERVISOR" | "OWNER") {
  const div = await prisma.division.findFirstOrThrow({ where: { active: true, reportTemplate: { not: null } } });
  const emp = await prisma.employee.create({ data: { code: `SJS-${code}-${tag}`, name: `Jadwal ${code} ${tag}`, divisionId: div.id, joinDate: dateOnly("2031-01-01") } });
  const u = await prisma.user.create({ data: { username: `sjs-${code.toLowerCase()}-${tag.toLowerCase()}`, name: emp.name, role, passwordHash: "x", employeeId: emp.id } });
  return { emp, actor: { id: u.id, name: u.name, role: u.role, employeeId: emp.id } };
}
const schedule = async (employeeId: string) => {
  const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
  for (const d of DAYS) await prisma.shiftSchedule.create({ data: { employeeId, shiftId: shift.id, date: dateOnly(d) } });
};
const left = async (employeeId: string) => (await prisma.shiftSchedule.count({ where: { employeeId, date: { in: DAYS.map(dateOnly) } } }));

describe("Supervisor mengatur jadwal sendiri tanpa menunggu atasan", () => {
  it("izin akses: Owner & Supervisor boleh jadwal sendiri; absensi sendiri tetap hanya Owner", () => {
    expect(canSetOwnSchedule("SUPERVISOR")).toBe(true);
    expect(canSetOwnSchedule("OPERATOR")).toBe(false);
    const sup = { role: "SUPERVISOR", employeeId: "e1" };
    expect(ownRecordBlocked(sup, "e1", { schedule: true })).toBe(false); // jadwal sendiri boleh
    expect(ownRecordBlocked(sup, "e1")).toBe(true); // absensi/validasi sendiri tetap dikunci
    expect(ownRecordBlocked(sup, "e2", { schedule: true })).toBe(false);
    expect(ownRecordBlocked({ role: "OWNER", employeeId: "e1" }, "e1")).toBe(false);
    expect(ownRecordBlocked({ role: "ADMIN", employeeId: "e1" }, "e1", { schedule: true })).toBe(true);
  });

  it("libur Supervisor otomatis DISETUJUI: jadwal langsung dihapus, audit 'disetujui sendiri', Owner dapat info", async () => {
    const sup = await mk("S1", "SUPERVISOR");
    const owner = await mk("O1", "OWNER");
    await schedule(sup.emp.id);
    vi.mocked(sendPush).mockClear();
    const r = await submitDayOff(sup.actor, { dates: DAYS, reason: "Keperluan keluarga" }, now);
    expect(r.status).toBe("DISETUJUI");
    expect(r.decidedBy).toMatch(/disetujui sendiri, Supervisor/);
    expect(await left(sup.emp.id)).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: "LIBUR_DISETUJUI" } });
    expect(log.data).toMatchObject({ jadwalDihapus: 2, catatan: "disetujui sendiri (Supervisor)" });
    const calls = vi.mocked(sendPush).mock.calls;
    expect(calls.some(([ids, p]) => ids.includes(owner.actor.id) && /disetujui sendiri/.test(p.title))).toBe(true);
    expect(calls.every(([ids]) => !ids.includes(sup.actor.id))).toBe(true); // bukan permintaan persetujuan ke Supervisor lain
  });

  it("hari yang sudah absen masuk dibiarkan; karyawan biasa tetap MENUNGGU persetujuan atasan", async () => {
    const sup = await mk("S2", "SUPERVISOR");
    await schedule(sup.emp.id);
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    await prisma.attendance.create({ data: { employeeId: sup.emp.id, shiftId: shift.id, date: dateOnly(DAYS[1]), checkIn: new Date(), status: "HADIR" } });
    const r = await submitDayOff(sup.actor, { dates: DAYS }, now);
    expect(r.status).toBe("DISETUJUI");
    expect(await left(sup.emp.id)).toBe(1);
    const op = await mk("P1", "OPERATOR");
    await schedule(op.emp.id);
    const q = await submitDayOff(op.actor, { dates: DAYS }, now);
    expect(q.status).toBe("MENUNGGU");
    expect(await left(op.emp.id)).toBe(2);
    await expect(decideDayOff(op.actor, q.id, true)).rejects.toThrow(/Supervisor atau Owner/);
  });

  it("pengajuan Supervisor yang masih MENUNGGU (lama) boleh disetujui Supervisor itu sendiri; 'tidak libur' tetap otomatis", async () => {
    const sup = await mk("S3", "SUPERVISOR");
    await schedule(sup.emp.id);
    const old = await prisma.dayOffRequest.create({ data: { employeeId: sup.emp.id, userId: sup.actor.id, weekStart: dateOnly("2033-05-16"), dates: DAYS } });
    const res = await decideDayOff(sup.actor, old.id, true);
    expect(res.removed).toBe(2);
    expect(await left(sup.emp.id)).toBe(0);
    const none = await submitDayOff((await mk("S4", "SUPERVISOR")).actor, { dates: [], none: true }, now);
    expect(none.status).toBe("DISETUJUI");
  });

  it("izin/sakit TIDAK diubah: Supervisor tetap tidak bisa menyetujui izinnya sendiri", async () => {
    const sup = await mk("S5", "SUPERVISOR");
    const lr = await prisma.leaveRequest.create({ data: { employeeId: sup.emp.id, userId: sup.actor.id, kind: "IZIN", dateFrom: dateOnly("2033-05-12"), dateTo: dateOnly("2033-05-12"), reason: "uji" } });
    await expect(decideLeave(sup.actor, lr.id, true)).rejects.toThrow(/atasan lain/);
  });
});
