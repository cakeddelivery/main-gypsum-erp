import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { dateOnly, todayStr } from "./time";
import { sendPush, type PushPayload } from "./push";

/**
 * Pengingat push harian 12.00 & 15.00 WIB:
 * - "Barang masuk?" → anggota semua divisi yang punya laporan shift;
 * - "Setoran borongan diterima?" → anggota divisi penerima borongan (Assembling, Giftbox, atau divisi pemilik tugas borongan).
 * Anggota hanya yang hari itu SUDAH absen masuk dan BELUM absen pulang (yang libur/izin/sakit/belum datang tidak dikirimi).
 * Supervisor & Owner selalu menerima ringkasan semua divisi.
 */
export const REMINDER_SLOTS = [
  { key: "job_push_ingat_12_last", from: 12 * 60, to: 15 * 60, label: "12.00" },
  { key: "job_push_ingat_15_last", from: 15 * 60, to: 18 * 60, label: "15.00" },
] as const;

/** Slot pengingat yang jatuh tempo pada menit ke-n hari itu (jendela 3 jam agar tidak menumpuk saat server sempat mati) */
export function dueSlot(minutes: number) {
  return REMINDER_SLOTS.find((s) => minutes >= s.from && minutes < s.to) ?? null;
}

const MANAGER_ROLES: Role[] = ["OWNER", "SUPERVISOR"];
const RECEIVER_TEMPLATES = ["ASSEMBLING", "GIFTBOX"];

export type Member = { userId: string; role: Role; divisionId: string | null; employeeId: string | null };
export type Att = { employeeId: string; checkIn: Date | null; checkOut: Date | null };
export type DivStatus = { id: string; name: string; receives: boolean; receipts: number; setoran: number; setoranQty: number; diterima: number };
export type Plan = { userIds: string[]; payload: PushPayload };

/** Anggota yang sedang bertugas: sudah absen masuk dan belum absen pulang hari ini */
export function onDuty(members: Member[], atts: Att[]): Member[] {
  const working = new Set(atts.filter((a) => a.checkIn && !a.checkOut).map((a) => a.employeeId));
  return members.filter((m) => !MANAGER_ROLES.includes(m.role) && !!m.employeeId && working.has(m.employeeId));
}

const fmt = (n: number) => n.toLocaleString("id-ID");

function barangBody(d: DivStatus) {
  return d.receipts === 0
    ? `Belum ada barang masuk tercatat hari ini di ${d.name}. Ada kiriman? Ketuk untuk mencatat.`
    : `Sudah ${fmt(d.receipts)} barang masuk tercatat hari ini di ${d.name}. Ada lagi? Ketuk untuk menambah.`;
}

function setoranLine(d: DivStatus) {
  const gap = d.setoran > 0 && d.diterima === 0;
  return `setoran koordinator ${fmt(d.setoran)} catatan${d.setoranQty ? ` (${fmt(d.setoranQty)} pcs)` : ""}, penerimaan divisi ${fmt(d.diterima)}${gap ? " → cek selisih" : ""}`;
}

/**
 * Susun notifikasi (murni, mudah dites): per divisi untuk anggota yang bertugas, plus ringkasan untuk Supervisor & Owner.
 * Divisi tanpa anggota bertugas tidak dikirimi.
 */
export function planReminders(input: { slot: string; divisions: DivStatus[]; members: Member[]; atts: Att[]; managers: string[] }): Plan[] {
  const plans: Plan[] = [];
  const duty = onDuty(input.members, input.atts);
  for (const d of input.divisions) {
    const ids = duty.filter((m) => m.divisionId === d.id).map((m) => m.userId);
    if (!ids.length) continue;
    plans.push({ userIds: ids, payload: { title: "Apakah ada barang masuk?", body: barangBody(d), url: "/laporan/buka?f=masuk", tag: "ingat-barang-masuk" } });
    if (d.receives) {
      plans.push({ userIds: ids, payload: { title: "Apakah ada setoran borongan yang diterima?", body: `Hari ini: ${setoranLine(d)}. Ketuk untuk Terima setoran.`, url: "/borongan?tab=kiriman", tag: "ingat-penerimaan-borongan" } });
    }
  }
  if (input.managers.length && input.divisions.length) {
    plans.push({
      userIds: input.managers,
      payload: { title: `Barang masuk hari ini (${input.slot})`, body: input.divisions.map((d) => `${d.name}: ${fmt(d.receipts)}`).join(" · "), url: "/laporan", tag: "ingat-barang-masuk" },
    });
    const recv = input.divisions.filter((d) => d.receives);
    if (recv.length) {
      plans.push({ userIds: input.managers, payload: { title: `Setoran borongan hari ini (${input.slot})`, body: recv.map((d) => `${d.name}: ${setoranLine(d)}`).join(" · "), url: "/borongan?tab=kiriman", tag: "ingat-penerimaan-borongan" } });
    }
  }
  return plans;
}

/** Kumpulkan data hari ini dari database lalu susun notifikasinya */
export async function buildReminders(now: Date, slot: string): Promise<Plan[]> {
  const date = dateOnly(todayStr(now));
  const [divs, users, atts, receipts, results, recvs] = await Promise.all([
    prisma.division.findMany({ where: { active: true, reportTemplate: { not: null } }, orderBy: { code: "asc" }, select: { id: true, name: true, reportTemplate: true, _count: { select: { pieceTasks: { where: { active: true } } } } } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, role: true, divisionId: true, employeeId: true, employee: { select: { divisionId: true } } } }),
    prisma.attendance.findMany({ where: { date }, select: { employeeId: true, checkIn: true, checkOut: true } }),
    prisma.shiftReceipt.groupBy({ by: ["divisionId"], where: { report: { date } }, _count: true }),
    prisma.boronganResult.findMany({ where: { date }, select: { qty: true, task: { select: { divisionId: true } } } }),
    prisma.boronganReceipt.groupBy({ by: ["divisionId"], where: { date, cancelledAt: null }, _count: true }),
  ]);
  const divisions: DivStatus[] = divs.map((d) => {
    const mine = results.filter((r) => r.task.divisionId === d.id);
    return {
      id: d.id,
      name: d.name,
      receives: RECEIVER_TEMPLATES.includes(d.reportTemplate ?? "") || d._count.pieceTasks > 0,
      receipts: receipts.find((x) => x.divisionId === d.id)?._count ?? 0,
      setoran: mine.length,
      setoranQty: mine.reduce((a, r) => a + r.qty, 0),
      diterima: recvs.find((x) => x.divisionId === d.id)?._count ?? 0,
    };
  });
  // Divisi anggota dari data Karyawan (sama dengan aturan laporan), cadangan divisi akun
  const members: Member[] = users.map((u) => ({ userId: u.id, role: u.role, divisionId: u.employee?.divisionId ?? u.divisionId, employeeId: u.employeeId }));
  const managers = users.filter((u) => MANAGER_ROLES.includes(u.role)).map((u) => u.id);
  return planReminders({ slot, divisions, members, atts, managers });
}

/** Kirim pengingat slot ini (dipanggil job terjadwal) */
export async function sendShiftReminders(now: Date, slot: string) {
  const plans = await buildReminders(now, slot);
  let sent = 0;
  let users = 0;
  for (const p of plans) {
    const r = await sendPush(p.userIds, p.payload);
    sent += r.sent;
    users += r.users;
  }
  return { notifikasi: plans.length, perangkat: sent, user: users };
}
