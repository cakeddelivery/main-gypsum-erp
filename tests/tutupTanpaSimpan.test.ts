import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { dateOnly } from "@/lib/time";
import { discardEmptyDraft } from "@/lib/reportShift";

const actor = { id: "uji", name: "Uji tutup tanpa simpan" };
const made: string[] = [];
const mk = async (day: string, data: Record<string, unknown> = {}) => {
  const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: { not: null } } });
  const s1 = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
  const r = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: s1.id, divisionId: d.id, createdBy: "uji", checklist: [{ label: "Area bersih", photo: false, done: false }], stockCount: [{ itemId: "x", name: "x", unit: "pcs", limit: 0, qty: null }], ...data } });
  made.push(r.id);
  return r.id;
};
const exists = async (id: string) => !!(await prisma.shiftReport.findUnique({ where: { id } }));

afterAll(async () => {
  await prisma.shiftReport.deleteMany({ where: { id: { in: made } } });
});

describe("Tutup tanpa simpan tidak meninggalkan draf kosong", () => {
  it("draf yang dibuat saat membuka form & belum diisi → dihapus (tercatat di audit)", async () => {
    const id = await mk("2028-01-01");
    expect(await discardEmptyDraft(id, actor)).toBe(true);
    expect(await exists(id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "LAPORAN_DRAF_KOSONG_DIHAPUS" } })).toBe(1);
  });
  it("draf yang pernah disimpan berisi data tetap utuh", async () => {
    const a = await mk("2028-01-02", { checklist: [{ label: "Area bersih", photo: false, done: true }] });
    const b = await mk("2028-01-03", { work: { catatan: "uji" } });
    const c = await mk("2028-01-04", { stockCount: [{ itemId: "x", name: "x", unit: "pcs", limit: 0, qty: 0 }] });
    const d = await mk("2028-01-05", { complaints: "mesin macet" });
    for (const id of [a, b, c, d]) {
      expect(await discardEmptyDraft(id, actor)).toBe(false);
      expect(await exists(id)).toBe(true);
    }
  });
  it("laporan terkirim tidak pernah dihapus walau kosong", async () => {
    const id = await mk("2028-01-06", { status: "TERKIRIM" });
    expect(await discardEmptyDraft(id, actor)).toBe(false);
    expect(await exists(id)).toBe(true);
  });
});
