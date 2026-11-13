import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ruleTemplate, setupItemDivisions } from "@/lib/itemDivisionSetup";
import { FLOW_SETTING } from "@/lib/shiftReportFlow";
import { applyResultCount, bigDiff, parseResultCount, resultCountStatus, resultItems, resultLines } from "@/lib/shiftResultCount";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Divisi penanggung jawab barang setengah jadi & produk jadi", () => {
  it("aturan bawaan nama → divisi", () => {
    expect(ruleTemplate("Patung kering Hewan")).toBe("PRODUKSI");
    expect(ruleTemplate("Cat Giftbox")).toBe("GIFTBOX");
    expect(ruleTemplate("Giftbox Custom · Bonus Magnet · Cewek")).toBe("GIFTBOX");
    expect(ruleTemplate("Paket Single Pack Cowok")).toBe("PACKING");
    expect(ruleTemplate("Paket isi 24")).toBe("PACKING");
    expect(ruleTemplate("Figur Satuan Cewek (Jadi)")).toBe("ASSEMBLING");
    expect(ruleTemplate("Barang aneh")).toBeNull();
  });

  it("skrip: pratinjau tidak menyimpan, hanya barang aktif tanpa divisi yang diisi", async () => {
    const a = await prisma.item.create({ data: { sku: "BJ-DIVUJI-1", name: "Giftbox Uji Divisi", type: "BARANG_JADI", unit: "box" } });
    const old = await prisma.item.create({ data: { sku: "BJ-DIVUJI-2", name: "Figur Satuan Uji (Jadi)", type: "BARANG_JADI", unit: "pcs", active: false } });
    const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const set = await prisma.item.create({ data: { sku: "BJ-DIVUJI-3", name: "Giftbox Manual", type: "BARANG_JADI", unit: "box", divisionId: pck.id } });
    const pre = await setupItemDivisions(prisma, false);
    expect(pre.plan.some((p) => p.id === a.id)).toBe(true);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).divisionId).toBeNull();
    await setupItemDivisions(prisma, true);
    const gft = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).divisionId).toBe(gft.id);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: old.id } })).divisionId).toBeNull();
    expect((await prisma.item.findUniqueOrThrow({ where: { id: set.id } })).divisionId).toBe(pck.id);
    // Laporan shift Giftbox menampilkan barang aktif milik divisi
    const ids = (await resultItems(gft.id)).map((i) => i.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(set.id);
  });

  it("stok akhir per barang: selisih ditandai, selisih besar diberi tanda, disamakan bila sakelar menyala", async () => {
    expect(bigDiff(-12, 50)).toBe(true);
    expect(bigDiff(-12, 500)).toBe(false);
    expect(bigDiff(5, 0)).toBe(false);
    const { finished } = await locationSettings(prisma);
    const gft = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
    const it = await prisma.item.create({ data: { sku: "BJ-DIVUJI-4", name: "Giftbox Stok Akhir Uji", type: "BARANG_JADI", unit: "box", divisionId: gft.id, avgCost: BigInt(1000) } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: it.id, qty: 50, toLocationId: finished!, unitCost: 1000, date: jakartaDateTime("2027-08-01", "06:00") }, actor));
    const s1 = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const work = { _hasil: parseResultCount([it.id], (k) => (k === `rc.${it.id}` ? "35" : null)) };
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-08-02"), shiftId: s1.id, divisionId: gft.id, createdBy: "uji", work } });
    const st = (await resultCountStatus(rep.id, jakartaDateTime("2027-08-02", "16:00")))!;
    expect(st.rows[0]).toMatchObject({ itemId: it.id, counted: 35, system: 50, diff: -15, big: true });
    expect(resultLines(st).join("\n")).toContain("SELISIH BESAR");
    expect((await applyResultCount(rep.id, actor, jakartaDateTime("2027-08-02", "16:00"))).skipped).toBe("nonaktif");
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    try {
      expect(await applyResultCount(rep.id, actor, jakartaDateTime("2027-08-02", "16:00"))).toEqual({ adjusted: 1 });
      expect(await qtyAt(prisma, it.id, finished!)).toBe(35);
      // Kirim ulang tanpa perubahan: tidak dobel
      expect(await applyResultCount(rep.id, actor, jakartaDateTime("2027-08-02", "17:00"))).toEqual({ adjusted: 0 });
    } finally {
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
    }
  });
});
