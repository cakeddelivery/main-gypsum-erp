import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { saveItemRecord } from "@/lib/items";
import { RESULT_KEY } from "@/lib/shiftResultCount";
import { autoRequestsFromReport } from "@/lib/stockRequestAuto";
import { lowProduction, materialOrderList, materialOrderText, orderVerb } from "@/lib/shiftReportStock";
import { dateOnly } from "@/lib/time";

const tag = Date.now().toString(36).slice(-4).toUpperCase();

describe("Limit untuk setengah jadi & barang jadi: perlu diproduksi (bahan baku: perlu diorder)", () => {
  let actor: { id: string; name: string };
  const c = {} as { div: string; raw: string; wip: string; jadi: string; ok: string; zero: string; report: string };

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `LP${tag}`, name: `Limit ${tag}` } });
    const mk = (name: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI", minStock: number, category: string) =>
      saveItemRecord({ name: `${name} ${tag}`, type, category, unit: "pcs", hppFactor: 1, minStock, price: 100, openingQty: 0, divisionId: div.id }, actor);
    const raw = await mk("Bahan LP", "BAHAN_BAKU", 10, "Bahan Pendukung");
    const wip = await mk("Patung Cetak LP", "BARANG_DALAM_PROSES", 100, "Barang Setengah Jadi");
    const jadi = await mk("Single Pack LP", "BARANG_JADI", 20, "Mainan Gypsum");
    const ok = await mk("Patung Kering LP", "BARANG_DALAM_PROSES", 100, "Barang Setengah Jadi");
    const zero = await mk("Tanpa Limit LP", "BARANG_JADI", 0, "Mainan Gypsum");
    const sh = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const report = await prisma.shiftReport.create({
      data: {
        date: dateOnly("2037-05-01"), shiftId: sh.id, divisionId: div.id, createdBy: "uji", status: "TERKIRIM",
        stockCount: [{ itemId: raw.id, name: raw.name, unit: "pcs", limit: 10, qty: 4 }],
        work: { [RESULT_KEY]: { [wip.id]: 80, [jadi.id]: 20, [ok.id]: 500, [zero.id]: 0 } },
      },
    });
    Object.assign(c, { div: div.id, raw: raw.id, wip: wip.id, jadi: jadi.id, ok: ok.id, zero: zero.id, report: report.id });
  });

  it("limit bisa diisi untuk semua tipe barang (master barang)", async () => {
    const items = await prisma.item.findMany({ where: { id: { in: [c.raw, c.wip, c.jadi] } }, select: { type: true, minStock: true } });
    expect(Object.fromEntries(items.map((i) => [i.type, Number(i.minStock)]))).toEqual({ BAHAN_BAKU: 10, BARANG_DALAM_PROSES: 100, BARANG_JADI: 20 });
  });

  it("daftar: bahan baku ≤ limit = perlu diorder; setengah jadi & jadi ≤ limit = perlu diproduksi; di atas limit / limit 0 tidak ditandai", async () => {
    const [g] = await materialOrderList(c.div);
    const by = new Map(g.order.map((o) => [o.itemId, o]));
    expect([...by.keys()].sort()).toEqual([c.raw, c.wip, c.jadi].sort());
    expect(by.get(c.raw)?.kind).toBe("ORDER");
    expect(by.get(c.wip)?.kind).toBe("PRODUKSI");
    expect(by.get(c.jadi)?.kind).toBe("PRODUKSI"); // stok = limit ikut
    expect(by.get(c.wip)).toMatchObject({ qty: 80, limit: 100 });
    expect(orderVerb(by.get(c.raw)?.kind)).toBe("perlu diorder");
    expect(orderVerb(by.get(c.wip)?.kind)).toBe("perlu diproduksi");
    expect(by.has(c.ok)).toBe(false); // 500 > limit 100
    expect(by.has(c.zero)).toBe(false); // limit 0 = tidak dipantau
    // Barang yang sudah dihitung tidak lagi "belum pernah dihitung"
    expect(g.uncounted.some((i) => i.id === c.wip)).toBe(false);
    const text = materialOrderText([g], (x) => x)!;
    expect(text).toContain("Order bahan baku (1)");
    expect(text).toContain("Perlu diproduksi (2)");
    expect(text).toContain("(produksi)");
  });

  it("laporan: lowProduction memuat setengah jadi & jadi ≤ limit saja", async () => {
    const low = await lowProduction(c.report);
    expect(low.map((x) => x.itemId).sort()).toEqual([c.wip, c.jadi].sort());
  });

  it("permintaan stok otomatis hanya untuk bahan baku (tidak ada permintaan beli untuk setengah jadi / jadi)", async () => {
    const r = await autoRequestsFromReport(c.report, actor);
    expect(r.created).toBe(1);
    const reqs = await prisma.stockRequest.findMany({ where: { reportId: c.report } });
    expect(reqs.map((x) => x.itemId)).toEqual([c.raw]);
  });
});
