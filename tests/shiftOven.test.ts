import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { setupOvenShift } from "@/lib/shiftOvenSetup";
import { actualShift, divisionShifts, isShiftDivision } from "@/lib/attendanceRules";
import { jakartaDateTime } from "@/lib/time";

const tag = `OV${Date.now().toString(36).toUpperCase()}`;
let divId = "";

describe("Divisi Oven: Shift 1 & Shift 2 seperti Cetak", () => {
  afterAll(async () => {
    if (divId) await prisma.division.update({ where: { id: divId }, data: { active: false } });
  });

  it("skrip: pratinjau tidak mengubah, --jalankan menyamakan jumlah shift dengan Cetak", async () => {
    const d = await prisma.division.create({ data: { code: tag, name: `Divisi Oven ${tag}`, shiftCount: 1 } });
    divId = d.id;
    const log = await setupOvenShift(prisma, false);
    expect(log.some((l) => l.includes(`Divisi Oven ${tag}: 1 shift → 2 shift`))).toBe(true);
    expect((await prisma.division.findUniqueOrThrow({ where: { id: d.id } })).shiftCount).toBe(1);
    await setupOvenShift(prisma, true);
    const after = await prisma.division.findUniqueOrThrow({ where: { id: d.id } });
    expect(isShiftDivision(after)).toBe(true);
  });

  it("absen Oven: shift dideteksi dari jam masuk (dijadwalkan S1, masuk jam S2 → S2)", () => {
    const shifts = [{ id: "s1", code: "S1", startTime: "08:30", endTime: "17:30" }, { id: "s2", code: "S2", startTime: "16:00", endTime: "01:00" }];
    const div = divisionShifts(shifts, 2);
    expect(div).toHaveLength(2);
    expect(actualShift(div, jakartaDateTime("2026-11-16", "15:55"), "s1", true)?.id).toBe("s2");
    expect(actualShift(div, jakartaDateTime("2026-11-16", "08:40"), "s2", true)?.id).toBe("s1");
    // Masih 1 shift (belum dijalankan skrip): jadwal tetap S1
    expect(actualShift(divisionShifts(shifts, 1), jakartaDateTime("2026-11-16", "15:55"), "s1", false)?.id).toBe("s1");
  });
});
