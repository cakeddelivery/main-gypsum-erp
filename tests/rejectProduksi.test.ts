import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { REJECT_KEY, applyReportRejects, parseRejects } from "@/lib/productionReject";
import { stageOfTemplate } from "@/lib/rejectShared";
import { addDays, dateOnly, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const lines = (o: Record<string, string[]>) => (k: string) => o[k] ?? [];

describe("Reject produksi per tahap", () => {
  it("parseRejects: baris kosong diabaikan, setengah terisi = error, jumlah koma desimal", () => {
    expect(parseRejects(lines({ "rj.item": ["", "a"], "rj.qty": ["", "1,5"], "rj.reason": ["", "RETAK"], "rj.note": ["", " retak halus "] }))).toEqual([{ itemId: "a", qty: 1.5, reason: "RETAK", note: "retak halus" }]);
    expect(() => parseRejects(lines({ "rj.item": ["a"], "rj.qty": [""], "rj.reason": ["RETAK"] }))).toThrow(/isi jumlahnya/);
    expect(() => parseRejects(lines({ "rj.item": [""], "rj.qty": ["3"], "rj.reason": ["RETAK"] }))).toThrow(/pilih barangnya/);
    expect(() => parseRejects(lines({ "rj.item": ["a"], "rj.qty": ["3"], "rj.reason": [""] }))).toThrow(/pilih alasannya/);
  });
  it("tahap menurut format laporan", () => {
    expect(["CETAK", "PRODUKSI", "ASSEMBLING", "GIFTBOX", "PACKING", null].map(stageOfTemplate)).toEqual(["CETAK", "OVEN", "ASSEMBLING", "GIFTBOX", "PACKING", null]);
  });

  describe("di database", () => {
    let prevFlow: string | null | undefined;
    afterAll(async () => {
      if (prevFlow === undefined) return;
      if (prevFlow === null) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
      else await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: prevFlow } });
    });
    it("sakelar mati: hanya dicatat; menyala: stok keluar + Beban Reject Produksi; revisi menggantikan, tanpa dobel", async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const actor = { id: u.id, name: u.name };
      prevFlow = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
      const { wip } = await locationSettings(prisma);
      const div = await prisma.division.create({ data: { code: `RJ${tag}`, name: `Cetak Rj ${tag}`, shiftCount: 1, reportTemplate: "CETAK" } });
      const item = await prisma.item.create({ data: { sku: `RJ-${tag}`, name: `Patung basah ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs", divisionId: div.id } });
      const day = addDays(todayStr(), -3);
      await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 100, toLocationId: wip!, unitCost: 500, date: new Date(`${day}T01:00:00Z`) }, actor));
      const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: div.id, createdBy: "t", work: { [REJECT_KEY]: [{ itemId: item.id, qty: 10, reason: "RETAK", note: "x" }] } } });

      // Mati: hanya dicatat
      await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "false" }, update: { value: "false" } });
      expect(await applyReportRejects(rep.id, actor)).toEqual({ rows: 1, posted: 0 });
      expect(await qtyAt(prisma, item.id, wip!)).toBe(100);
      expect((await prisma.productionReject.findFirstOrThrow({ where: { reportId: rep.id } })).posted).toBe(false);

      // Menyala: stok keluar, beban tercatat
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "true" } });
      expect(await applyReportRejects(rep.id, actor)).toEqual({ rows: 1, posted: 1 });
      expect(await qtyAt(prisma, item.id, wip!)).toBe(90);
      const row = await prisma.productionReject.findFirstOrThrow({ where: { reportId: rep.id } });
      expect([row.stage, row.posted, Number(row.qty), Number(row.unitCost)]).toEqual(["CETAK", true, 10, 500]);
      const beban = await prisma.$queryRaw<{ d: number }[]>`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS d FROM "JournalLine" l JOIN "CoaAccount" a ON a.id = l."accountId" JOIN "Journal" j ON j.id = l."journalId" WHERE a.code = '6-1830' AND j.description LIKE ${`%${tag}%`}`;
      expect(beban[0].d).toBe(5000);

      // Revisi 10 → 4: versi lama dibalik, tidak dobel
      await prisma.shiftReport.update({ where: { id: rep.id }, data: { work: { [REJECT_KEY]: [{ itemId: item.id, qty: 4, reason: "PECAH" }] } } });
      await applyReportRejects(rep.id, actor);
      expect(await qtyAt(prisma, item.id, wip!)).toBe(96);
      expect(await prisma.productionReject.count({ where: { reportId: rep.id } })).toBe(1);
      const net = await prisma.$queryRaw<{ d: number }[]>`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS d FROM "JournalLine" l JOIN "CoaAccount" a ON a.id = l."accountId" JOIN "Journal" j ON j.id = l."journalId" WHERE a.code = '6-1830' AND (j.description LIKE ${`%${tag}%`} OR j."reversalOfId" IN (SELECT id FROM "Journal" WHERE description LIKE ${`%${tag}%`}))`;
      expect(net[0].d).toBe(2000);
    });
  });
});
