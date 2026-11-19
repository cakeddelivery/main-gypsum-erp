import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { alurProduksi, cetakOf, giftboxOf, ovenOf, packingOf, taskGroup } from "@/lib/alurProduksi";
import { summaryOf, TEMPLATES, sectionTotal, type WorkData } from "@/lib/shiftReport";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const DAY = "2033-03-15";

describe("Alur Produksi: kelompok tugas borongan", () => {
  it("Cat Giftbox / Cat Plastik / Assembling", () => {
    expect(taskGroup("Cat Giftbox Hewan")).toBe("CAT_GIFTBOX");
    expect(taskGroup("Cat Plastik Biru")).toBe("CAT_PLASTIK");
    expect(taskGroup("Assembling RH")).toBe("ASSEMBLING");
  });
});

describe("Alur Produksi: sinkron dengan detail hasil kerja laporan shift", () => {
  it("angka tiap kotak = angka hasil kerja di laporan divisinya (Cetak, Oven, Packing, Giftbox) + borongan + sample", async () => {
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const mk = (code: string, template: string) => prisma.division.create({ data: { code: `${code}${tag}`, name: `Div ${code} ${tag}`, shiftCount: 1, reportTemplate: template } });
    const [dCetak, dOven, dPack, dGift] = await Promise.all([mk("CT", "CETAK"), mk("OV", "PRODUKSI"), mk("PK", "PACKING"), mk("GB", "GIFTBOX")]);
    const works: Record<string, WorkData> = {
      CETAK: { cetakSeries: [{ name: "Ani", v: [100, 50, null, 20] }, { name: "Budi", v: [30, null, 10, null] }] },
      PRODUKSI: { panen: [{ name: "Oven Besar", v: [350, 100, 0, 50] }], reject: [{ name: "Oven Besar", v: [10, 0, 0, 5] }], cetakSeries: [{ name: "Cici", v: [40, 0, 0, 0] }] },
      PACKING: { resi: { shopee: 12, tiktok: 8 }, mix: { p12: 5, p24: 3 }, satuan: { cowok: 20 } },
      GIFTBOX: { resi: { shopee: 4, tiktok: 6 }, giftbox: { MIX: 7, CEW: 3 } },
    };
    const mkR = (divisionId: string, w: WorkData) => prisma.shiftReport.create({ data: { date: new Date(`${DAY}T00:00:00Z`), shiftId: shift.id, divisionId, createdBy: "t", status: "TERKIRIM", work: w } });
    const [rCetak, rOven, rPack, rGift] = await Promise.all([mkR(dCetak.id, works.CETAK), mkR(dOven.id, works.PRODUKSI), mkR(dPack.id, works.PACKING), mkR(dGift.id, works.GIFTBOX)]);
    const item = await prisma.item.create({ data: { sku: `AL-${tag}`, name: `Paket ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: dPack.id } });
    await prisma.affiliateSample.createMany({ data: [
      { reportId: rPack.id, divisionId: dPack.id, date: new Date(`${DAY}T00:00:00Z`), itemId: item.id, qty: 3, platform: "TIKTOK", storeId: (await prisma.store.findFirstOrThrow()).id, createdBy: "t" },
      { reportId: rGift.id, divisionId: dGift.id, date: new Date(`${DAY}T00:00:00Z`), itemId: item.id, qty: 2, platform: "SHOPEE", storeId: (await prisma.store.findFirstOrThrow()).id, createdBy: "t" },
    ] });

    try {
    const box = (await alurProduksi({ date: DAY })).reduce((m, b) => ({ ...m, [b.key]: b }), {} as Record<string, Awaited<ReturnType<typeof alurProduksi>>[number]>);

    // Cetak = hasil cetak laporan Cetak + hasil cetak di laporan Produksi (Oven)
    expect(cetakOf({ template: "CETAK", work: works.CETAK }).total).toBe(sectionTotal(TEMPLATES.CETAK, works.CETAK, "cetakSeries"));
    expect(box.CETAK.good).toBe(sectionTotal(TEMPLATES.CETAK, works.CETAK, "cetakSeries") + sectionTotal(TEMPLATES.PRODUKSI, works.PRODUKSI, "cetakSeries"));
    expect(box.CETAK.byVariant.Hewan).toBe(130 + 40);
    // Oven = panen, reject (sama dengan ringkasan laporan Produksi)
    const sumOven = summaryOf("PRODUKSI", works.PRODUKSI);
    expect(box.OVEN.good).toBe(sumOven.find((s) => s.label === "Total panen")!.value);
    expect(box.OVEN.reject).toBe(sumOven.find((s) => s.label === "Total reject")!.value);
    expect(ovenOf({ template: "PRODUKSI", work: works.PRODUKSI })).toMatchObject({ good: box.OVEN.good, reject: box.OVEN.reject });
    // Packing & Giftbox = ringkasan laporan
    const sumP = summaryOf("PACKING", works.PACKING);
    expect(box.PACKING.good).toBe(sumP.find((s) => s.label === "Total patung")!.value);
    expect(packingOf({ template: "PACKING", work: works.PACKING }).resi).toBe(20);
    expect(box.PACKING.extras).toEqual(expect.arrayContaining([{ label: "Resi", value: "20" }, { label: "Sample", value: "3 pcs" }]));
    const sumG = summaryOf("GIFTBOX", works.GIFTBOX);
    expect(box.GIFTBOX.good).toBe(sumG.find((s) => s.label === "Total giftbox")!.value);
    expect(giftboxOf({ template: "GIFTBOX", work: works.GIFTBOX }).box).toBe(10);
    expect(box.GIFTBOX.extras).toEqual(expect.arrayContaining([{ label: "Sample", value: "2 pcs" }]));
    // Sumber = tautan laporan
    expect(box.OVEN.sources.map((s) => s.href)).toContain(`/laporan/${rOven.id}`);
    expect(box.CETAK.sources.map((s) => s.href)).toEqual(expect.arrayContaining([`/laporan/${rCetak.id}`, `/laporan/${rOven.id}`]));

    // Filter divisi: hanya laporan divisi itu
    const only = await alurProduksi({ date: DAY, divisionId: dPack.id });
    expect(only.find((b) => b.key === "PACKING")!.good).toBe(box.PACKING.good);
    expect(only.find((b) => b.key === "OVEN")!.good).toBe(0);
    // Draf tidak dihitung
    await prisma.shiftReport.update({ where: { id: rPack.id }, data: { status: "DRAFT" } });
    expect((await alurProduksi({ date: DAY })).find((b) => b.key === "PACKING")!.good).toBe(0);
    } finally {
      // Data uji dibersihkan: divisi berformat laporan yang tersisa mengganggu tes lain yang mencari divisi menurut format
      await prisma.affiliateSample.deleteMany({ where: { reportId: { in: [rCetak.id, rOven.id, rPack.id, rGift.id] } } });
      await prisma.shiftReport.deleteMany({ where: { id: { in: [rCetak.id, rOven.id, rPack.id, rGift.id] } } });
      await prisma.item.deleteMany({ where: { id: item.id } });
      await prisma.division.deleteMany({ where: { id: { in: [dCetak.id, dOven.id, dPack.id, dGift.id] } } });
    }
  });

  it("borongan: KRM dikirim, setoran hasil per kelompok tugas, reject (hari itu)", async () => {
    const day = "2033-03-16";
    const loc = await prisma.location.create({ data: { code: `LB${tag}`, name: `Titik uji ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `TB${tag}`, name: `Titik ${tag}`, locationId: loc.id } });
    const div = await prisma.division.findFirstOrThrow({ where: { active: true } });
    const mkTask = (name: string) => prisma.pieceTask.create({ data: { code: `T-${name.slice(0, 3)}-${tag}-${Math.random().toString(36).slice(2, 5)}`, name: `${name} ${tag}`, divisionId: div.id, ratePerPcs: BigInt(100) } });
    const [tA, tC, tG] = await Promise.all([mkTask("Assembling Uji"), mkTask("Cat Plastik Uji"), mkTask("Cat Giftbox Uji")]);
    const taskIds = [tA.id, tC.id, tG.id];
    const worker = await prisma.boronganPerson.create({ data: { name: `Pekerja ${tag}`, role: "PEKERJA", pointId: point.id } });
    const ship = await prisma.boronganShipment.create({ data: { number: `KRM-T-${tag}`, date: new Date(`${day}T00:00:00Z`), mode: "LANGSUNG", pointIds: [point.id], createdBy: "t", tasks: { create: [{ taskId: tA.id, qty: 500 }, { taskId: tC.id, qty: 200 }] } } });
    const mkRes = (n: string, taskId: string, qty: number, reject: number) => prisma.boronganResult.create({ data: { number: `HSL-${n}-${tag}`, pointId: point.id, workerId: worker.id, taskId, date: new Date(`${day}T00:00:00Z`), qty, reject, workerRate: BigInt(100), coordinatorRate: BigInt(0), driverRate: BigInt(0), createdBy: "t" } });
    await Promise.all([mkRes("a", tA.id, 300, 4), mkRes("c", tC.id, 150, 1), mkRes("g", tG.id, 80, 0)]);
    const b = (await alurProduksi({ date: day })).find((x) => x.key === "BORONGAN")!;
    expect([b.good, b.reject]).toEqual([530, 5]);
    expect(b.extras).toEqual(expect.arrayContaining([{ label: "Dikirim (KRM)", value: "700 pcs" }, { label: "Cat Plastik", value: "150 pcs" }, { label: "Cat Giftbox", value: "80 pcs" }]));
    expect(b.sources.some((s) => s.href === `/borongan/riwayat/${ship.id}`)).toBe(true);
    // dengan filter shift, borongan (tidak terikat shift) tidak ditampilkan
    expect((await alurProduksi({ date: day, shiftId: (await prisma.shift.findFirstOrThrow()).id })).find((x) => x.key === "BORONGAN")!.good).toBe(0);
    // Bersihkan: tugas bernama "Cat …" mengganggu tes lain yang mencari tugas menurut nama
    await prisma.boronganResult.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.boronganShipmentTask.deleteMany({ where: { shipmentId: ship.id } });
    await prisma.boronganShipment.delete({ where: { id: ship.id } });
    await prisma.boronganPerson.delete({ where: { id: worker.id } });
    await prisma.pieceTask.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.boronganPoint.delete({ where: { id: point.id } });
    await prisma.location.delete({ where: { id: loc.id } });
  });
});
