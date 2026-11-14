import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { mergeChecklist, refreshDraftChecklists } from "@/lib/shiftReportChecklist";
import { toEntries } from "@/lib/shiftReport";
import { dateOnly } from "@/lib/time";

describe("Checklist laporan mengikuti checklist divisi", () => {
  it("merge: urutan & wajib foto dari divisi, jawaban lama dipertahankan bila label sama", () => {
    const cur = [{ label: "Area Cetak  Bersih", photo: false, done: true, photoPath: null }, { label: "Lama", photo: false, done: true, photoPath: null }];
    const next = mergeChecklist([{ label: "Lantai bersih", photo: true, done: false }, { label: "area cetak bersih", photo: false, done: false }], cur);
    expect(next).toEqual([{ label: "Lantai bersih", photo: true, done: false, photoPath: null }, { label: "area cetak bersih", photo: false, done: true, photoPath: null }]);
    // Tugas wajib foto selesai hanya bila fotonya ada
    expect(mergeChecklist([{ label: "Lama", photo: true, done: false }], cur)[0].done).toBe(false);
  });

  it("draf lama (checklist bawaan) diperbarui ke checklist divisi; laporan terkirim tidak berubah", async () => {
    const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const s1 = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const old = [{ label: "Area kerja bersih & rapi", photo: false, done: true }];
    const draft = await prisma.shiftReport.create({ data: { date: dateOnly("2027-12-01"), shiftId: s1.id, divisionId: d.id, createdBy: "uji", checklist: old } });
    const sent = await prisma.shiftReport.create({ data: { date: dateOnly("2027-12-02"), shiftId: s1.id, divisionId: d.id, createdBy: "uji", checklist: old, status: "TERKIRIM" } });
    await prisma.division.update({ where: { id: d.id }, data: { checklist: [{ label: "Area packing bersih", photo: true }, { label: "Area kerja bersih & rapi", photo: false }] } });
    expect(await refreshDraftChecklists({ divisionId: d.id })).toBeGreaterThanOrEqual(1);
    const c = toEntries((await prisma.shiftReport.findUniqueOrThrow({ where: { id: draft.id } })).checklist);
    expect(c.map((x) => [x.label, x.photo, x.done])).toEqual([["Area packing bersih", true, false], ["Area kerja bersih & rapi", false, true]]);
    expect(toEntries((await prisma.shiftReport.findUniqueOrThrow({ where: { id: sent.id } })).checklist)).toHaveLength(1);
    expect(await refreshDraftChecklists({ id: draft.id })).toBe(0); // tidak berubah lagi
  });
});
