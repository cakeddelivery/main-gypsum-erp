import { prisma } from "./db";
import { audit } from "./audit";
import { addDays, dateOnly, dateStr, fmtDay, todayStr } from "./time";
import { crossesMidnight, shiftWindow, NIGHT_GRACE_HOURS } from "./workday";
import { resolveWorkday } from "./attendanceSelf";

type Actor = { id: string; name: string };

/**
 * Shift & tanggal LAPORAN anggota divisi 2 shift ditentukan dari ABSEN-nya (bukan pilihan sendiri):
 * tanggal kerja saat ini (lihat lib/workday) + shift yang tercatat di absen masuk tanggal itu.
 * null = divisi 1 shift (tidak dibatasi). Melempar error bila belum absen masuk.
 */
export async function memberReportSlot(employeeId: string, divisionId: string, now: Date = new Date()): Promise<{ date: string; shiftId: string } | null> {
  const div = await prisma.division.findUniqueOrThrow({ where: { id: divisionId }, select: { shiftCount: true } });
  if (div.shiftCount < 2) return null;
  const wd = await resolveWorkday(employeeId, now);
  let att = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(wd.date) } }, include: { shift: true } });
  // Mengirim laporan shift malam setelah absen pulang (mis. 01:10): masih milik tanggal kerja kemarin
  if (!att?.checkIn) {
    const y = addDays(todayStr(now), -1);
    const prev = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOnly(y) } }, include: { shift: true } });
    // Laporan shift kemarin yang belum terkirim tetap bisa dikirim sampai absen masuk berikutnya (tidak terkunci setelah jam shift selesai)
    if (prev?.checkIn && ((crossesMidnight(prev.shift) && now < new Date(shiftWindow(y, prev.shift).end.getTime() + NIGHT_GRACE_HOURS * 3600_000)) || !(await prisma.shiftReport.findFirst({ where: { date: prev.date, shiftId: prev.shiftId, divisionId, status: { not: "DRAFT" } }, select: { id: true } })))) att = prev;
  }
  if (!att?.checkIn) throw new Error("Anda belum absen masuk. Absen masuk dulu di menu Absensi: shift laporan mengikuti shift absen Anda.");
  return { date: dateStr(att.date), shiftId: att.shiftId };
}

/** Anggota divisi 2 shift hanya boleh mengisi laporan di shift & tanggal absennya sendiri */
export async function assertMemberOwnsReport(employeeId: string, r: { date: Date; shiftId: string; divisionId: string; shift?: { name: string } | null }) {
  const div = await prisma.division.findUniqueOrThrow({ where: { id: r.divisionId }, select: { shiftCount: true } });
  if (div.shiftCount < 2) return;
  const att = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date: r.date } }, include: { shift: true } });
  if (!att?.checkIn) throw new Error(`Anda belum absen masuk pada ${fmtDay(r.date)}. Laporan ${r.shift?.name ?? "shift"} hanya bisa diisi karyawan yang absen di shift itu.`);
  if (att.shiftId !== r.shiftId) throw new Error(`Laporan ini untuk ${r.shift?.name ?? "shift lain"}, sedangkan absen Anda ${att.shift.name}. Minta Supervisor memindahkan laporan bila salah shift.`);
}

export type MoveMode = "pindah" | "tukar";

/**
 * Pindahkan laporan ke shift lain (tanggal & divisi sama), mis. laporan yang salah shift. Wajib alasan, tercatat di audit.
 * Shift tujuan sudah punya laporan → ditolak kecuali mode "tukar" (kedua laporan saling bertukar shift).
 * Catatan: stok yang sudah diposting dari laporan tetap bertanggal shift lama (tidak dibalik).
 */
export async function moveReportShift(reportId: string, toShiftId: string, reason: string, actor: Actor, mode: MoveMode = "pindah") {
  if (reason.trim().length < 3) throw new Error("Tulis alasan pemindahan");
  return prisma.$transaction(async (tx) => {
    const r = await tx.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true, division: true } });
    if (r.shiftId === toShiftId) throw new Error("Laporan sudah di shift itu");
    const allowed = (await tx.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, take: Math.max(1, r.division.shiftCount) })).map((s) => s.id);
    if (!allowed.includes(toShiftId)) throw new Error(`${r.division.name} hanya punya ${r.division.shiftCount} shift`);
    const to = await tx.shift.findUniqueOrThrow({ where: { id: toShiftId } });
    const other = await tx.shiftReport.findUnique({ where: { date_shiftId_divisionId: { date: r.date, shiftId: toShiftId, divisionId: r.divisionId } }, include: { shift: true } });
    if (other && mode !== "tukar") throw new Error(`${to.name} tanggal ${fmtDay(r.date)} sudah punya laporan (${other.status === "DRAFT" ? "draf" : "terkirim"}, PIC ${other.picName ?? "-"}). Pilih "Tukar" untuk saling menukar shift kedua laporan.`);
    if (other) {
      // Tukar: parkir laporan tujuan sementara di tanggal lain agar tidak bentrok kunci unik
      const park = dateOnly("1900-01-01");
      await tx.shiftReport.update({ where: { id: other.id }, data: { date: park } });
      await tx.shiftReport.update({ where: { id: r.id }, data: { shiftId: toShiftId } });
      await tx.shiftReport.update({ where: { id: other.id }, data: { date: r.date, shiftId: r.shiftId } });
    } else {
      await tx.shiftReport.update({ where: { id: r.id }, data: { shiftId: toShiftId } });
    }
    await audit(actor, "LAPORAN_SHIFT_DIPINDAH", "ShiftReport", r.id, { dari: r.shift.name, ke: to.name, tanggal: dateStr(r.date), alasan: reason.trim(), tukarDengan: other?.id ?? null }, tx);
    return { from: r.shift.name, to: to.name, swapped: !!other };
  });
}

export type ShiftMismatch = { id: string; label: string; from: string; to: string; toShiftId: string; conflictWith: string | null };

/** Laporan 2 shift yang shift-nya tidak cocok dengan absen PIC pengirimnya (pratinjau; tidak mengubah data) */
export async function findReportShiftMismatches(days = 30, now: Date = new Date()): Promise<ShiftMismatch[]> {
  const since = dateOnly(addDays(todayStr(now), -days));
  const reports = await prisma.shiftReport.findMany({ where: { date: { gte: since }, picName: { not: null }, division: { shiftCount: { gte: 2 } } }, include: { shift: true, division: true }, orderBy: { date: "asc" } });
  const users = await prisma.user.findMany({ where: { username: { in: [...new Set(reports.map((r) => r.picName!))] } }, select: { username: true, employeeId: true } });
  const out: ShiftMismatch[] = [];
  for (const r of reports) {
    const empId = users.find((u) => u.username === r.picName)?.employeeId;
    if (!empId) continue;
    const att = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: empId, date: r.date } }, include: { shift: true } });
    if (!att?.checkIn || att.shiftId === r.shiftId) continue;
    const clash = await prisma.shiftReport.findUnique({ where: { date_shiftId_divisionId: { date: r.date, shiftId: att.shiftId, divisionId: r.divisionId } }, select: { picName: true, status: true } });
    out.push({
      id: r.id, from: r.shift.name, to: att.shift.name, toShiftId: att.shiftId,
      label: `${r.division.name} · ${fmtDay(r.date)} · ${r.shift.name} (PIC ${r.picName}, ${r.status}) → absen PIC ${att.shift.name}${clash ? ` — BENTROK: ${att.shift.name} sudah punya laporan (PIC ${clash.picName ?? "-"}, ${clash.status})` : ""}`,
      conflictWith: clash ? `${att.shift.name} (PIC ${clash.picName ?? "-"})` : null,
    });
  }
  return out;
}

export async function applyReportShiftFixes(fixes: ShiftMismatch[]) {
  let n = 0;
  for (const f of fixes.filter((x) => !x.conflictWith)) {
    await moveReportShift(f.id, f.toShiftId, "Skrip perbaikan: shift laporan disamakan dengan absen PIC", { id: "script", name: "Skrip perbaikan shift laporan" });
    n++;
  }
  return n;
}

// ---------------- Draf ganda shift tanpa karyawan ----------------

const hasData = (v: unknown): boolean => {
  if (v == null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "0";
  if (Array.isArray(v)) return v.some(hasData);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(hasData);
  return true;
};

export type ExtraDraft = { id: string; label: string; empty: boolean };

/**
 * Draf laporan di divisi 2 shift untuk shift yang TIDAK ada karyawannya hari itu (mis. Oven 1 orang). Draf KOSONG (checklist belum
 * ada yang dicentang, hasil/stok/barang masuk/kendala belum diisi) boleh dihapus; yang berisi data hanya dilaporkan.
 */
export async function findExtraDrafts(days = 30, now: Date = new Date()): Promise<ExtraDraft[]> {
  const { expectedSlots } = await import("./reportExpected");
  const since = dateOnly(addDays(todayStr(now), -days));
  const drafts = await prisma.shiftReport.findMany({
    where: { date: { gte: since }, status: "DRAFT", division: { shiftCount: { gte: 2 } } },
    include: { shift: true, division: true, _count: { select: { receipts: true } } },
    orderBy: { date: "asc" },
  });
  const out: ExtraDraft[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof expectedSlots>>>();
  for (const r of drafts) {
    const day = dateStr(r.date);
    if (!cache.has(day)) cache.set(day, await expectedSlots(day));
    if (cache.get(day)!.some((x) => x.divisionId === r.divisionId && x.shiftId === r.shiftId)) continue;
    const checklist = (r.checklist as { done?: boolean }[] | null) ?? [];
    const filled = checklist.some((c) => c.done) || hasData(r.work) || (r.stockCount as { qty: number | null }[]).some((x) => x.qty != null) || r._count.receipts > 0
      || !!r.complaints?.trim() || !!r.followUp?.trim() || r.workPostedVersion > 0 || r.stockApplied || r.resultApplied != null;
    out.push({ id: r.id, empty: !filled, label: `${r.division.name} · ${fmtDay(r.date)} · ${r.shift.name} (PIC ${r.picName ?? "-"}) — checklist ${checklist.filter((c) => c.done).length}/${checklist.length} — ${filled ? "BERISI DATA (tidak dihapus)" : "kosong"}` });
  }
  return out;
}

export async function deleteEmptyExtraDrafts(items: ExtraDraft[], actor: Actor) {
  let n = 0;
  for (const x of items.filter((i) => i.empty)) {
    await prisma.$transaction(async (tx) => {
      await tx.shiftReport.delete({ where: { id: x.id } });
      await audit(actor, "LAPORAN_DRAF_KOSONG_DIHAPUS", "ShiftReport", x.id, { label: x.label }, tx);
    });
    n++;
  }
  return n;
}
