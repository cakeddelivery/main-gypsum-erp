import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { saveItemRecord } from "@/lib/items";
import { applyTipeHasil, planTipeHasil } from "@/lib/koreksiTipeHasil";
import { locationSettings, stockBalances } from "@/lib/stock";
import { resultItems } from "@/lib/shiftResultCount";
import { materialOrderList } from "@/lib/shiftReportStock";
import { RESULT_KEY } from "@/lib/shiftResultCount";
import { dateOnly } from "@/lib/time";

const tag = Date.now().toString(36).slice(-4).toUpperCase();

describe("Koreksi tipe hasil Cat → barang setengah jadi", () => {
  let actor: { id: string; name: string };
  const c = {} as { div: string; item: string; task: string; ok: string };

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `KT${tag}`, name: `Koreksi ${tag}` } });
    // Hasil "Cat plastik" salah bertipe BAHAN_BAKU, tanpa divisi, ada stok di gudang bahan baku
    const item = await saveItemRecord({ name: `Cat plastik merah ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 30, price: 500, openingQty: 40 }, actor);
    const ok = await saveItemRecord({ name: `Cat giftbox ok ${tag}`, type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 0 }, actor);
    const task = await prisma.pieceTask.create({ data: { code: `KTC${tag}`, name: `Cat plastik merah ${tag}`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n, outputItemId: item.id, resultAtReceipt: true } });
    await prisma.pieceTask.create({ data: { code: `KTG${tag}`, name: `Cat giftbox ${tag}`, divisionId: div.id, ratePerPcs: 100n, workerRate: 80n, coordinatorRate: 20n, driverRate: 0n, outputItemId: ok.id } });
    Object.assign(c, { div: div.id, item: item.id, task: task.id, ok: ok.id });
  });
  afterAll(async () => {
    await prisma.pieceTask.updateMany({ where: { id: c.task }, data: { active: false } });
  });

  it("pratinjau mendaftar hanya yang bukan setengah jadi dan tidak mengubah apa pun", async () => {
    const plan = (await planTipeHasil()).filter((r) => r.itemId === c.item || r.itemId === c.ok);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ itemId: c.item, fromType: "BAHAN_BAKU", qtyRaw: 40, qtyTotal: 40, setDivision: true });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: c.item } })).type).toBe("BAHAN_BAKU");
  });

  it("koreksi: tipe setengah jadi, stok pindah gudang (total sama), jurnal reklasifikasi seimbang, ikut hitungan hasil & limit produksi; aman diulang", async () => {
    const before = (await stockBalances(prisma, c.item)).reduce((a, b) => a + b.qty, 0);
    const journals0 = await prisma.journal.count({ where: { source: "KOREKSI_TIPE_HASIL" } });
    const r = await applyTipeHasil(actor);
    expect(r.items).toBeGreaterThanOrEqual(1);
    const it = await prisma.item.findUniqueOrThrow({ where: { id: c.item } });
    expect([it.type, it.category, it.divisionId]).toEqual(["BARANG_DALAM_PROSES", "Barang Setengah Jadi", c.div]);
    // Stok: total sama, sekarang di gudang setengah jadi
    const locs = await locationSettings(prisma);
    const bal = await stockBalances(prisma, c.item);
    expect(bal.reduce((a, b) => a + b.qty, 0)).toBe(before);
    expect(bal.find((b) => b.locationId === locs.wip)?.qty).toBe(40);
    expect(bal.find((b) => b.locationId === locs.raw)?.qty ?? 0).toBe(0);
    // Jurnal reklasifikasi: Dr BDP / Cr Bahan, seimbang
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "KOREKSI_TIPE_HASIL", sourceId: c.item }, include: { lines: { include: { account: true } } } });
    expect(j.lines.reduce((a, l) => a + l.debit, 0n)).toBe(j.lines.reduce((a, l) => a + l.credit, 0n));
    expect(j.lines.find((l) => l.debit > 0n)?.account.code).toBe("1-1402");
    expect(j.lines.find((l) => l.credit > 0n)?.account.code).toBe("1-1401");
    expect(await prisma.journal.count({ where: { source: "KOREKSI_TIPE_HASIL" } })).toBe(journals0 + 1);
    // Ikut hitungan stok akhir hasil & limit "perlu diproduksi" di divisinya
    expect((await resultItems(c.div)).some((i) => i.id === c.item)).toBe(true);
    const sh = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    await prisma.shiftReport.create({ data: { date: dateOnly("2037-06-01"), shiftId: sh.id, divisionId: c.div, createdBy: "uji", status: "TERKIRIM", work: { [RESULT_KEY]: { [c.item]: 20 } } } });
    const row = (await materialOrderList(c.div))[0].order.find((o) => o.itemId === c.item);
    expect(row?.kind).toBe("PRODUKSI"); // 20 ≤ limit 30
    // Aman diulang
    const again = await applyTipeHasil(actor);
    expect(again.rows.filter((x) => x.itemId === c.item)).toHaveLength(0);
    expect(await prisma.journal.count({ where: { source: "KOREKSI_TIPE_HASIL" } })).toBe(journals0 + 1);
  });
});
