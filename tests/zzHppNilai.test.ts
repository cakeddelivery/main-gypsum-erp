import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { recordMovement, locationSettings, itemQty } from "@/lib/stock";
import { payLines, postResultTx } from "@/lib/borongan";
import { FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { dateOnly, jakartaDateTime } from "@/lib/time";
import { costTargets, pasangResepDariTugas, planResepDariTugas, revaluasiAvgCost } from "@/lib/hppNilai";

const tag = `HN${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const mkItem = (suffix: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI", extra: object = {}) =>
  prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, unit: "pcs", type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : type === "BARANG_JADI" ? "Mainan Gypsum" : "Barang Setengah Jadi", ...extra } });
const lines = async (journalId: string) => prisma.journalLine.findMany({ where: { journalId }, include: { account: true } });
const sum = (ls: { account: { code: string }; debit: bigint; credit: bigint }[], code: string, side: "debit" | "credit") => ls.filter((l) => l.account.code === code).reduce((a, l) => a + Number(l[side]), 0);

const created: { items: string[]; tasks: string[] } = { items: [], tasks: [] };
afterAll(async () => {
  await prisma.pieceTask.updateMany({ where: { id: { in: created.tasks } }, data: { active: false } });
  await prisma.item.updateMany({ where: { id: { in: created.items } }, data: { active: false } });
});

describe("Upah borongan masuk nilai barang hasil (tanpa dobel)", () => {
  it("harga hasil = (bahan + upah) / pcs; jurnal: Dr persediaan, Cr persediaan bahan + Cr Beban Gaji; setara upah yang dibayar", async () => {
    const loc = await prisma.location.create({ data: { code: `${tag}L`, name: `Titik ${tag}` } });
    const src = await prisma.location.create({ data: { code: `${tag}G`, name: `Gudang ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `${tag}P`, name: `Titik ${tag}`, locationId: loc.id } });
    const worker = await prisma.boronganPerson.create({ data: { name: `Pekerja ${tag}`, role: "PEKERJA", pointId: point.id } });
    const bahan = await mkItem("BHN", "BAHAN_BAKU");
    const hasil = await mkItem("SP", "BARANG_JADI");
    created.items.push(bahan.id, hasil.id);
    const task = await prisma.pieceTask.create({ data: { code: `${tag}T`, name: `Assembling ${tag}`, ratePerPcs: 450n, workerRate: 300n, coordinatorRate: 100n, driverRate: 50n, outputItemId: hasil.id, inputs: { create: [{ itemId: bahan.id, qty: 2 }] } }, include: { inputs: { include: { item: true } }, outputItem: true } });
    created.tasks.push(task.id);
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: bahan.id, qty: 100, toLocationId: src.id, unitCost: 10, ref: `TES:${tag}` }, actor);
      await recordMovement(tx, { type: "TRANSFER", itemId: bahan.id, qty: 50, fromLocationId: src.id, toLocationId: loc.id, ref: `KRM:${tag}` }, actor);
    });
    const fresh = await prisma.pieceTask.findUniqueOrThrow({ where: { id: task.id }, include: { inputs: { include: { item: true } }, outputItem: true } });
    const r = await prisma.$transaction((tx) => postResultTx(tx, { point: { id: point.id, code: point.code, name: point.name, locationId: loc.id }, worker, task: fresh, date: new Date("2027-05-03T05:00:00Z"), qty: 10, reject: 0, coordinatorId: null, driverId: null }, actor));
    // bahan 10 pcs × 2 × Rp10 = 200; upah (tanpa koordinator: 300+100) × 10 = 4.000; driver tidak ada
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `HSB:${r.id}`, itemId: hasil.id } });
    expect(Number(mv.unitCost)).toBe(420);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: hasil.id } })).avgCost)).toBe(420);
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "BORONGAN", sourceId: r.id } });
    const ls = await lines(j.id);
    expect(sum(ls, "1-1403", "debit")).toBe(4200);
    expect(sum(ls, "1-1401", "credit")).toBe(200);
    expect(sum(ls, "6-1100", "credit")).toBe(4000);
    expect(ls.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    // Upah yang akan dibayar (Dr 6-1100) = yang dikreditkan di sini → beban bersih 0 selama barang belum terjual
    const full = await prisma.boronganResult.findUniqueOrThrow({ where: { id: r.id }, include: { worker: true, coordinator: true, driver: true } });
    const wages = payLines([full as never]).filter((l) => l.role !== "DRIVER").reduce((a, l) => a + l.amount, 0);
    expect(wages).toBe(4000);
  });
});

describe("Revaluasi avgCost & resep dari tugas", () => {
  it("resep dari tugas: pratinjau tidak mengubah, tidak menimpa resep manual, idempoten", async () => {
    const bahan = await mkItem("RB", "BAHAN_BAKU", { avgCost: 10n });
    const baru = await mkItem("RN", "BARANG_DALAM_PROSES");
    const manual = await mkItem("RM", "BARANG_DALAM_PROSES");
    created.items.push(bahan.id, baru.id, manual.id);
    const mk = (code: string, out: string) => prisma.pieceTask.create({ data: { code: `${tag}${code}`, name: `Tugas ${tag}${code}`, ratePerPcs: 100n, workerRate: 100n, outputItemId: out, inputs: { create: [{ itemId: bahan.id, qty: 3 }] } } });
    created.tasks.push((await mk("A", baru.id)).id, (await mk("B", manual.id)).id);
    await prisma.itemRecipeLine.create({ data: { itemId: manual.id, componentId: bahan.id, qty: 1, useUnit: "pcs" } });

    const prev = await pasangResepDariTugas(prisma, false);
    expect(prev.plan.map((p) => p.itemId)).toContain(baru.id);
    expect(prev.plan.map((p) => p.itemId)).not.toContain(manual.id);
    expect(await prisma.itemRecipeLine.count({ where: { itemId: baru.id } })).toBe(0);

    await pasangResepDariTugas(prisma, true);
    expect(await prisma.itemRecipeLine.count({ where: { itemId: baru.id } })).toBe(1);
    expect(Number((await prisma.itemRecipeLine.findFirstOrThrow({ where: { itemId: manual.id } })).qty)).toBe(1); // tidak ditimpa
    expect((await prisma.recipeLabor.findFirstOrThrow({ where: { itemId: baru.id } })).rate).toBe(100n);
    expect((await planResepDariTugas(prisma)).plan.map((p) => p.itemId)).not.toContain(baru.id);
    const t = (await costTargets(prisma)).get(baru.id)!;
    expect(t).toMatchObject({ mat: 30, labor: 100, total: 130 }); // biaya Single Pack-like = komponen (3 × Rp10) + upah, tanpa upah ganda
  });

  it("revaluasi: avg 0 → harga resep, selisih ke 6-1800, satu jurnal seimbang, idempoten", async () => {
    const baru = (await prisma.item.findFirstOrThrow({ where: { sku: `${tag}-RN` } }));
    const { wip } = await locationSettings(prisma);
    await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: baru.id, qty: 5, toLocationId: wip!, unitCost: 0, ref: `TES:${tag}-RV` }, actor));
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: baru.id } })).avgCost)).toBe(0);

    const prev = await revaluasiAvgCost(prisma, false);
    const row = prev.rows.find((r) => r.itemId === baru.id)!;
    expect(row).toMatchObject({ old: 0, target: 130, qty: 5, delta: 650 });
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: baru.id } })).avgCost)).toBe(0); // pratinjau tidak mengubah

    const done = await revaluasiAvgCost(prisma, true);
    expect(done.journalId).toBeTruthy();
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: baru.id } })).avgCost)).toBe(130);
    const ls = await lines(done.journalId!);
    expect(ls.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    expect(sum(ls, "6-1800", "credit")).toBeGreaterThanOrEqual(650);
    expect(await itemQty(prisma, baru.id)).toBe(5);

    const again = await revaluasiAvgCost(prisma, true);
    expect(again.rows.find((r) => r.itemId === baru.id)).toBeUndefined();
    expect(again.journalId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "REVALUASI_AVGCOST" } })).toBeGreaterThan(0);
  });
});

describe("Laporan shift: setengah jadi bernilai resep", () => {
  it("panen oven → patung kering masuk dengan harga resep (bahan + upah), jurnal seimbang, revisi tidak dobel", async () => {
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Hewan" }));
    const bahan = await mkItem("KB", "BAHAN_BAKU", { avgCost: 10n });
    created.items.push(bahan.id);
    await prisma.itemRecipeLine.create({ data: { itemId: kering, componentId: bahan.id, qty: 2, useUnit: "pcs" } });
    await prisma.recipeLabor.create({ data: { itemId: kering, name: "Upah oven", rate: 5n, override: true } });
    try {
      const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } });
      const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
      const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const day = `${2040 + Math.floor(Math.random() * 50)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: s1, divisionId: d.id, createdBy: "uji", work: { panen: [{ name: "Oven Besar", v: [10, null, null, null] }] } } });
      const act = { id: owner.id, name: owner.name };
      await postShiftWork(rep.id, act, jakartaDateTime(day, "16:00"));
      const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LPH:${rep.id}:1`, itemId: kering } });
      expect(Number(mv.unitCost)).toBe(25); // 2 × Rp10 + upah Rp5
      const j = await prisma.journal.findFirstOrThrow({ where: { source: "LAPORAN_SHIFT", sourceId: `${rep.id}:1:wip` } });
      const ls = await lines(j.id);
      expect(sum(ls, "1-1402", "debit")).toBe(250);
      const used = await prisma.stockMovement.findMany({ where: { ref: `LPH:${rep.id}:1`, type: "KONSUMSI_PRODUKSI" } });
      const out = used.reduce((a, m) => a + Math.round(Number(m.qty) * Number(m.unitCost)), 0); // patung cetak yang dikonsumsi (nilai rata-rata)
      expect(sum(ls, "1-1402", "credit")).toBe(out);
      expect(sum(ls, "6-1100", "credit")).toBe(Math.min(50, Math.max(0, 250 - out))); // upah resep dikapitalisasi, tidak lebih dari nilai bersih
      expect(ls.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
      await postShiftWork(rep.id, act, jakartaDateTime(day, "17:00")); // revisi: versi lama dibalik
      expect(await prisma.journal.count({ where: { source: "LAPORAN_SHIFT", sourceId: `${rep.id}:1:wip`, reversalOfId: null } })).toBe(1);
      expect(await prisma.journal.count({ where: { reversalOfId: j.id } })).toBe(1);
      expect(await prisma.journal.count({ where: { source: "LAPORAN_SHIFT", sourceId: `${rep.id}:2:wip` } })).toBe(1);
    } finally {
      await prisma.itemRecipeLine.deleteMany({ where: { itemId: kering } });
      await prisma.recipeLabor.deleteMany({ where: { itemId: kering } });
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
    }
  });
});
