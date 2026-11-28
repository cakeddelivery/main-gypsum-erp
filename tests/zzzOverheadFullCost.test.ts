import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { recordMovement } from "@/lib/stock";
import { postResultTx, unpostResultTx } from "@/lib/borongan";
import { FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { capAmount, overheadBulanan, overheadApplied } from "@/lib/overheadFullCost";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const tag = `OF${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 2045 + Math.floor(Math.random() * 40);
const created: { items: string[]; tasks: string[] } = { items: [], tasks: [] };
afterAll(async () => {
  await prisma.pieceTask.updateMany({ where: { id: { in: created.tasks } }, data: { active: false } });
  await prisma.item.updateMany({ where: { id: { in: created.items } }, data: { active: false } });
});
const mkItem = (suffix: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI", extra: object = {}) =>
  prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, unit: "pcs", type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : type === "BARANG_JADI" ? "Mainan Gypsum" : "Barang Setengah Jadi", ...extra } });
const sum = (ls: { account: { code: string }; debit: bigint; credit: bigint }[], code: string, side: "debit" | "credit") => ls.filter((l) => l.account.code === code).reduce((a, l) => a + Number(l[side]), 0);

describe("capAmount (batas beban aktual bulan itu)", () => {
  it("min(diinginkan, aktual − sudah dibebankan), tidak minus", () => {
    expect(capAmount(1000, 5000, 0)).toBe(1000);
    expect(capAmount(1000, 5000, 4500)).toBe(500);
    expect(capAmount(1000, 5000, 5000)).toBe(0);
    expect(capAmount(1000, 5000, 7000)).toBe(0);
  });
});

async function setup(ohMonthly: bigint, ohOutput: number, suffix: string) {
  const loc = await prisma.location.create({ data: { code: `${tag}${suffix}L`, name: `Titik ${tag}${suffix}` } });
  const src = await prisma.location.create({ data: { code: `${tag}${suffix}G`, name: `Gudang ${tag}${suffix}` } });
  const point = await prisma.boronganPoint.create({ data: { code: `${tag}${suffix}P`, name: `Titik ${tag}${suffix}`, locationId: loc.id } });
  const worker = await prisma.boronganPerson.create({ data: { name: `Pekerja ${tag}${suffix}`, role: "PEKERJA", pointId: point.id } });
  const bahan = await mkItem(`${suffix}B`, "BAHAN_BAKU");
  const hasil = await mkItem(`${suffix}H`, "BARANG_JADI");
  created.items.push(bahan.id, hasil.id);
  const oh = await prisma.overhead.create({ data: { category: "Sewa Tempat", name: `Sewa ${tag}${suffix}`, monthlyAmount: ohMonthly, outputPerMonth: ohOutput } });
  await prisma.recipeOverhead.create({ data: { itemId: hasil.id, overheadId: oh.id, factor: 1 } });
  const task = await prisma.pieceTask.create({ data: { code: `${tag}${suffix}T`, name: `Tugas ${tag}${suffix}`, ratePerPcs: 450n, workerRate: 300n, coordinatorRate: 100n, driverRate: 50n, outputItemId: hasil.id, inputs: { create: [{ itemId: bahan.id, qty: 2 }] } } });
  created.tasks.push(task.id);
  await prisma.$transaction(async (tx) => {
    await recordMovement(tx, { type: "PENERIMAAN", itemId: bahan.id, qty: 1000, toLocationId: src.id, unitCost: 10, ref: `TES:${tag}${suffix}` }, actor);
    await recordMovement(tx, { type: "TRANSFER", itemId: bahan.id, qty: 500, fromLocationId: src.id, toLocationId: loc.id, ref: `KRM:${tag}${suffix}` }, actor);
  });
  const post = async (day: string, qty: number) => {
    const fresh = await prisma.pieceTask.findUniqueOrThrow({ where: { id: task.id }, include: { inputs: { include: { item: true } }, outputItem: true } });
    return prisma.$transaction((tx) => postResultTx(tx, { point: { id: point.id, code: point.code, name: point.name, locationId: loc.id }, worker, task: fresh, date: new Date(`${day}T05:00:00Z`), qty, reject: 0, coordinatorId: null, driverId: null }, actor));
  };
  return { oh, hasil, post, bahan };
}

describe("Full costing: overhead resep masuk persediaan (borongan)", () => {
  it("unitCost = bahan + upah + overhead; Dr persediaan / Cr 6-1850 (memo per overhead); laba bersih benar saat stok naik lalu sebagian terjual", async () => {
    const day = `${year}-03-10`;
    const { oh, hasil, post } = await setup(1_000_000n, 1000, "A"); // Rp1.000/pcs
    const r = await post(day, 10);
    // bahan 10×2×Rp10 = 200; upah (300+100)×10 = 4.000; overhead 10×1.000 = 10.000 → Rp1.420/pcs
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `HSB:${r.id}`, itemId: hasil.id } });
    expect(Number(mv.unitCost)).toBe(1420);
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "BORONGAN", sourceId: r.id }, include: { lines: { include: { account: true } } } });
    expect(sum(j.lines, "1-1403", "debit")).toBe(14200);
    expect(sum(j.lines, "6-1850", "credit")).toBe(10000);
    expect(j.lines.find((l) => l.account.code === "6-1850")!.memo).toBe(`OH:${oh.id}`);
    expect(j.lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    expect(await overheadApplied(prisma, oh.id, new Date(`${day}T05:00:00Z`))).toBe(10000);

    // Beban aktual dicatat seperti biasa (upah dibayar Rp4.000, sewa/penyusutan Rp10.000), lalu 5 pcs terjual
    const at = new Date(`${day}T08:00:00Z`);
    await prisma.$transaction(async (tx) => {
      const store = await tx.store.findFirstOrThrow();
      await postJournal(tx, { date: at, storeId: store.id, description: `Beban aktual ${tag}`, source: "TES", sourceId: tag, actor, lines: [{ accountCode: "6-1100", debit: 4000 }, { accountCode: "6-1700", debit: 10000 }, { accountCode: "1-1100", credit: 14000 }] });
      const { finished } = await (await import("@/lib/stock")).locationSettings(tx);
      // barang hasil ada di titik: pindahkan ke gudang jadi lalu keluar (terjual) → HPP
      await recordMovement(tx, { type: "TRANSFER", itemId: hasil.id, qty: 10, fromLocationId: (await tx.boronganPoint.findFirstOrThrow({ where: { code: `${tag}AP` } })).locationId, toLocationId: finished!, ref: `TES:${tag}-MV`, date: at }, actor);
      await recordMovement(tx, { type: "PENGELUARAN", itemId: hasil.id, qty: 5, fromLocationId: finished!, ref: `TES:${tag}-JUAL`, date: at }, actor);
    });
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(`${day}T23:59:59Z`);
    const lines = await prisma.journalLine.findMany({ where: { journal: { date: { gte: from, lte: to } }, account: { code: { in: ["5-1000", "6-1100", "6-1700", "6-1850"] } } }, include: { account: true } });
    const net = lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
    // Beban bersih = HPP 5 pcs terjual (5 × 1.420); sisa 5 pcs × 1.420 tetap di persediaan: tidak dobel, tidak hilang
    expect(net).toBe(7100);
  });

  it("dibatasi beban aktual bulan itu; pembatalan setoran mengembalikan kapasitas; laporan cek:overhead-bulanan", async () => {
    const day = `${year}-04-10`;
    const { oh, hasil, post } = await setup(15_000n, 10, "B"); // Rp1.500/pcs, beban aktual hanya Rp15.000/bulan
    const r1 = await post(day, 10); // 15.000 (habis)
    const r2 = await post(day, 10); // sudah habis: tanpa overhead
    const u = (id: string) => prisma.stockMovement.findFirstOrThrow({ where: { ref: `HSB:${id}`, itemId: hasil.id } });
    expect(Number((await u(r1.id)).unitCost)).toBe(Math.round((200 + 4000 + 15000) / 10));
    expect(Number((await u(r2.id)).unitCost)).toBe(Math.round((200 + 4000) / 10));
    expect(await overheadApplied(prisma, oh.id, new Date(`${day}T05:00:00Z`))).toBe(15000);

    const rep = (await overheadBulanan(prisma, new Date(`${day}T05:00:00Z`)))[5];
    const row = rep.rows.find((x) => x.overheadId === oh.id)!;
    expect(row).toMatchObject({ aktual: 15000, dibebankan: 15000, selisih: 0 });

    await prisma.$transaction((tx) => unpostResultTx(tx, r1.id, actor, "uji batal"));
    expect(await overheadApplied(prisma, oh.id, new Date(`${day}T05:00:00Z`))).toBe(0);
    const r3 = await post(day, 10); // kapasitas bulan kembali
    expect(Number((await u(r3.id)).unitCost)).toBe(Math.round((200 + 4000 + 15000) / 10));
  });
});

describe("Full costing: setengah jadi di laporan shift", () => {
  it("overhead resep sendiri → Cr 6-1850; revisi tidak menggandakan", async () => {
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cowok" }));
    // Bersihkan resep sisa tes lain pada patung kering ini agar angka uji deterministik
    await prisma.itemRecipeLine.deleteMany({ where: { itemId: kering } });
    await prisma.recipeOverhead.deleteMany({ where: { itemId: kering } });
    await prisma.recipeLabor.deleteMany({ where: { itemId: kering } });
    const bahan = await mkItem("KB", "BAHAN_BAKU", { avgCost: 10n });
    created.items.push(bahan.id);
    const oh = await prisma.overhead.create({ data: { category: "LPG", name: `LPG ${tag}`, monthlyAmount: 600_000n, outputPerMonth: 600 } }); // Rp1.000/pcs
    await prisma.itemRecipeLine.create({ data: { itemId: kering, componentId: bahan.id, qty: 2, useUnit: "pcs" } });
    await prisma.recipeOverhead.create({ data: { itemId: kering, overheadId: oh.id, factor: 1 } });
    try {
      const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } });
      const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
      const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const day = `${year}-05-${String(1 + Math.floor(Math.random() * 27)).padStart(2, "0")}`;
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(day), shiftId: s1, divisionId: d.id, createdBy: "uji", work: { panen: [{ name: "Oven Besar", v: [null, 10, null, null] }] } } });
      const act = { id: owner.id, name: owner.name };
      await postShiftWork(rep.id, act, jakartaDateTime(day, "16:00"));
      await postShiftWork(rep.id, act, jakartaDateTime(day, "17:00")); // revisi
      const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LPH:${rep.id}:2`, itemId: kering } });
      expect(Number(mv.unitCost)).toBe(20 + 1000); // bahan 2×Rp10 + overhead Rp1.000/pcs
      expect(await overheadApplied(prisma, oh.id, jakartaDateTime(day, "16:00"))).toBe(10_000); // versi 1 dibalik, versi 2 berlaku
      const j = await prisma.journal.findFirstOrThrow({ where: { source: "LAPORAN_SHIFT", sourceId: `${rep.id}:2:wip` }, include: { lines: { include: { account: true } } } });
      expect(sum(j.lines, "6-1850", "credit")).toBe(10_000);
      expect(j.lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    } finally {
      await prisma.itemRecipeLine.deleteMany({ where: { itemId: kering } });
      await prisma.recipeOverhead.deleteMany({ where: { itemId: kering } });
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
    }
  });
});
