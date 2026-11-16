import type { PrismaClient } from "@prisma/client";
import { dateOnly, todayStr } from "./time";

/**
 * Divisi Oven memakai Shift 1 & Shift 2 seperti Cetak. Jam shift berlaku sama untuk semua divisi (master Shift),
 * jadi cukup menyamakan jumlah shift divisi Oven dengan Cetak. Jadwal "centang" lama sudah tersimpan sebagai Shift 1.
 * Setelah itu deteksi shift dari jam masuk & penyesuaian jadwal (#112/#115) otomatis berlaku untuk Oven.
 */
export async function setupOvenShift(db: PrismaClient, apply: boolean): Promise<string[]> {
  const log: string[] = [];
  const [divs, shifts] = await Promise.all([
    db.division.findMany({ where: { active: true }, select: { id: true, name: true, shiftCount: true } }),
    db.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, startTime: true, endTime: true } }),
  ]);
  const cetak = divs.find((d) => /\bcetak\b/i.test(d.name));
  const ovens = divs.filter((d) => /\boven\b/i.test(d.name));
  if (!ovens.length) return ["! Divisi Oven tidak ditemukan"];
  const target = Math.max(2, cetak?.shiftCount ?? 2);
  log.push(`Jam shift (sama untuk semua divisi, ubah di Pengaturan › Shift bila perlu):`);
  for (const s of shifts.slice(0, target)) log.push(`  ${s.code} ${s.name}: ${s.startTime}–${s.endTime}${s.endTime < s.startTime ? " (lintas hari)" : ""}`);
  if (shifts.length < target) log.push(`! Baru ada ${shifts.length} shift aktif; tambahkan Shift 2 di Pengaturan dulu`);
  log.push(`Cetak: ${cetak ? `${cetak.shiftCount} shift` : "tidak ditemukan (pakai 2 shift)"}`);
  const today = dateOnly(todayStr());
  for (const d of ovens) {
    const sched = await db.shiftSchedule.groupBy({ by: ["shiftId"], where: { date: { gte: today }, employee: { divisionId: d.id } }, _count: true });
    const s1 = sched.find((x) => x.shiftId === shifts[0]?.id)?._count ?? 0;
    const other = sched.reduce((a, x) => a + x._count, 0) - s1;
    if (d.shiftCount >= target) {
      log.push(`= ${d.name}: sudah ${d.shiftCount} shift`);
      continue;
    }
    log.push(`~ ${d.name}: ${d.shiftCount} shift → ${target} shift (jadwal tampil S1/S2, bukan centang)`);
    log.push(`  Jadwal mendatang: ${s1} hari tercentang = ${shifts[0]?.code ?? "S1"}${other ? `, ${other} shift lain` : ""} (tidak berubah)`);
    if (apply) await db.division.update({ where: { id: d.id }, data: { shiftCount: target } });
  }
  return log;
}
