import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { SAMPLE_KEY, applyReportSamples, parseSamples, sampleRecap, sampleRowIssue } from "@/lib/affiliateSample";
import { addDays, dateOnly, todayStr } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const g = (o: Record<string, string[]>) => (k: string) => o[k] ?? [];

describe("Sample affiliator di laporan Packing/Giftbox", () => {
  it("parseSamples: baris kosong diabaikan; setengah terisi = error; hanya TikTok Shop / Shopee", () => {
    expect(parseSamples(g({ "sm.item": [""], "sm.qty": [""], "sm.platform": [""], "sm.store": [""] }))).toEqual([]);
    expect(parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.platform": ["TIKTOK"], "sm.store": ["s1"] }))).toEqual([{ itemId: "a", qty: 2, platform: "TIKTOK", storeId: "s1" }]);
    expect(() => parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.platform": [""], "sm.store": ["s1"] }))).toThrow(/pilih platform/);
    expect(() => parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.platform": ["OFFLINE"], "sm.store": ["s1"] }))).toThrow(/pilih platform/);
    expect(() => parseSamples(g({ "sm.item": ["a"], "sm.qty": ["2"], "sm.platform": ["SHOPEE"], "sm.store": [""] }))).toThrow(/pilih toko/);
    expect(() => parseSamples(g({ "sm.item": [""], "sm.qty": ["2"], "sm.platform": ["SHOPEE"], "sm.store": ["s1"] }))).toThrow(/pilih produknya/);
  });

  it("baris tanpa produk & jumlah (platform/toko saja) diabaikan; draf melewati baris setengah terisi; pesan per baris", () => {
    expect(parseSamples(g({ "sm.item": [""], "sm.qty": [""], "sm.platform": ["SHOPEE"], "sm.store": ["s1"] }))).toEqual([]);
    const half = g({ "sm.item": ["a", "b"], "sm.qty": ["2", "1"], "sm.platform": ["TIKTOK", "SHOPEE"], "sm.store": ["s1", ""] });
    expect(parseSamples(half, { lenient: true })).toEqual([{ itemId: "a", qty: 2, platform: "TIKTOK", storeId: "s1" }]);
    expect(() => parseSamples(half)).toThrow(/baris 2: pilih toko/);
    expect(sampleRowIssue({ itemId: "b", qty: "1", platform: "SHOPEE", storeId: "" })).toBe("pilih toko");
    expect(sampleRowIssue({ itemId: "", qty: "", platform: "", storeId: "" })).toBeNull();
  });

  describe("di database", () => {
    let prev: string | null | undefined;
    afterAll(async () => {
      if (prev === undefined) return;
      if (prev === null) await prisma.setting.deleteMany({ where: { key: FLOW_SETTING } });
      else await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: prev } });
    });
    it("sakelar mati: hanya dicatat; menyala: stok keluar + Beban Promosi (bukan HPP); revisi tanpa dobel; rekap per platform & toko", async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const actor = { id: u.id, name: u.name };
      prev = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
      const { finished } = await locationSettings(prisma);
      const div = await prisma.division.create({ data: { code: `SM${tag}`, name: `Packing Sample ${tag}`, shiftCount: 1, reportTemplate: "PACKING" } });
      const org = await prisma.organization.findFirstOrThrow();
      const store = await prisma.store.create({ data: { code: `SM${tag}`, name: `Toko Sample ${tag}`, organizationId: org.id } });
      const item = await prisma.item.create({ data: { sku: `SM-${tag}`, name: `Paket 12 Hewan ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: div.id } });
      const day = addDays(todayStr(), -3);
      await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: item.id, qty: 50, toLocationId: finished!, unitCost: 20000, date: new Date(`${day}T01:00:00Z`) }, actor));
      const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: shift.id, divisionId: div.id, createdBy: "t", work: { [SAMPLE_KEY]: [{ itemId: item.id, qty: 2, platform: "TIKTOK", storeId: store.id }, { itemId: item.id, qty: 1, platform: "SHOPEE", storeId: store.id }] } } });

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
      await prisma.shiftReport.update({ where: { id: rep.id }, data: { work: { [SAMPLE_KEY]: [{ itemId: item.id, qty: 1, platform: "SHOPEE", storeId: store.id }] } } });
      await applyReportSamples(rep.id, actor);
      expect(await qtyAt(prisma, item.id, finished!)).toBe(49);
      expect(await prisma.affiliateSample.count({ where: { reportId: rep.id } })).toBe(1);

      const recap = await sampleRecap(30);
      const a = recap.list.find((x) => x.storeId === store.id && x.platform === "SHOPEE")!;
      expect([a.qty, a.value, a.store]).toEqual([1, 20000, `Toko Sample ${tag}`]);
    });
  });
});
