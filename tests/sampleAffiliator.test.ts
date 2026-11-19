import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { SAMPLE_KEY, applyReportSamples, parseSamples, sampleRecap } from "@/lib/affiliateSample";
import { addDays, dateOnly, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const g = (o: Record<string, string[]>) => (k: string) => o[k] ?? [];

describe("Sample affiliator di laporan Packing/Giftbox", () => {
  it("parseSamples: baris kosong diabaikan; setengah terisi = error; resi huruf besar", () => {
    expect(parseSamples(g({ "sm.item": [""], "sm.qty": [""], "sm.source": [""], "sm.affiliator": [""], "sm.resi": [""], "sm.note": [""] }))).toEqual([]);
    expect(parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.source": ["TIKTOK"], "sm.affiliator": [" @dina "], "sm.resi": ["jnt123"], "sm.note": [""] }))).toEqual([{ itemId: "a", qty: 2, source: "TIKTOK", affiliator: "@dina", trackingNo: "JNT123", note: null }]);
    expect(() => parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.source": [""], "sm.affiliator": ["x"] }))).toThrow(/pilih sumber/);
    expect(() => parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.source": ["OFFLINE"], "sm.affiliator": [""] }))).toThrow(/nama\/username/);
    expect(() => parseSamples(g({ "sm.item": [""], "sm.qty": ["2"], "sm.source": ["OFFLINE"], "sm.affiliator": ["x"] }))).toThrow(/pilih produknya/);
  });

  describe("di database", () => {
    let prev: string | null | undefined;
    afterAll(async () => {
      if (prev === undefined) return;
      if (prev === null) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
      else await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: prev } });
    });
    it("sakelar mati: hanya dicatat; menyala: stok keluar + Beban Promosi (bukan HPP); revisi tanpa dobel; rekap per affiliator", async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const actor = { id: u.id, name: u.name };
      prev = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
      const { finished } = await locationSettings(prisma);
      const div = await prisma.division.create({ data: { code: `SM${tag}`, name: `Packing Sample ${tag}`, shiftCount: 1, reportTemplate: "PACKING" } });
      const item = await prisma.item.create({ data: { sku: `SM-${tag}`, name: `Paket 12 Hewan ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: div.id } });
      const day = addDays(todayStr(), -3);
      await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 50, toLocationId: finished!, unitCost: 20000, date: new Date(`${day}T01:00:00Z`) }, actor));
      const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: div.id, createdBy: "t", work: { [SAMPLE_KEY]: [{ itemId: item.id, qty: 2, source: "TIKTOK", affiliator: `@dina${tag}`, trackingNo: "JNT1" }, { itemId: item.id, qty: 1, source: "OFFLINE", affiliator: `@dina${tag}` }] } } });

      await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "false" }, update: { value: "false" } });
      expect(await applyReportSamples(rep.id, actor)).toEqual({ rows: 2, posted: 0 });
      expect(await qtyAt(prisma, item.id, finished!)).toBe(50);

      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "true" } });
      expect(await applyReportSamples(rep.id, actor)).toEqual({ rows: 2, posted: 2 });
      expect(await qtyAt(prisma, item.id, finished!)).toBe(47);
      const promo = await prisma.$queryRaw<{ d: number }[]>`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS d FROM "JournalLine" l JOIN "CoaAccount" a ON a.id = l."accountId" JOIN "Journal" j ON j.id = l."journalId" WHERE a.code = '6-1840' AND j.description LIKE ${`%${tag}%`}`;
      const hpp = await prisma.$queryRaw<{ d: number }[]>`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS d FROM "JournalLine" l JOIN "CoaAccount" a ON a.id = l."accountId" JOIN "Journal" j ON j.id = l."journalId" WHERE a.code = '5-1000' AND j.description LIKE ${`%${tag}%`}`;
      expect([promo[0].d, hpp[0].d]).toEqual([60000, 0]); // 3 × Rp20.000 ke beban promosi, bukan HPP

      // Revisi 3 → 1 sample: stok kembali sebagian, tidak dobel
      await prisma.shiftReport.update({ where: { id: rep.id }, data: { work: { [SAMPLE_KEY]: [{ itemId: item.id, qty: 1, source: "SHOPEE", affiliator: `@dina${tag}` }] } } });
      await applyReportSamples(rep.id, actor);
      expect(await qtyAt(prisma, item.id, finished!)).toBe(49);
      expect(await prisma.affiliateSample.count({ where: { reportId: rep.id } })).toBe(1);

      const recap = await sampleRecap(30);
      const a = recap.list.find((x) => x.affiliator === `@dina${tag}`)!;
      expect([a.qty, a.value, [...a.sources]]).toEqual([1, 20000, ["SHOPEE"]]);
    });
  });
});
