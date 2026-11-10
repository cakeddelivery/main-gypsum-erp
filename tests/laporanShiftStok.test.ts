import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { applyShiftStockCount, materialOrderList, materialOrderText, unsentReportCount } from "@/lib/shiftReportStock";
import { jakartaDateTime, dateOnly } from "@/lib/time";

let actor: { id: string; name: string };
let raw: string;
let wip: string;
let divisionId: string;
let s1: string;
let s2: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  const l = await locationSettings(prisma);
  raw = l.raw!;
  wip = l.wip!;
  divisionId = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } })).id;
  s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
  s2 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S2" } })).id;
});

const row = (item: { id: string; name: string; unit: string }, qty: number | null, limit = 5) => ({ itemId: item.id, name: item.name, unit: item.unit, limit, qty });

describe("Stock opname laporan shift", () => {
  it("dikirim terlambat: dicatat per jam selesai shift, pembelian sesudahnya tidak terhapus, bahan di lokasi lain tidak ikut", async () => {
    const it = await prisma.item.create({ data: { sku: "BB-LAP-OPN-1", name: "Gypsum opname uji", type: "BAHAN_BAKU", unit: "sak", minStock: 5, divisionId } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 10, toLocationId: raw, unitCost: 1000, date: jakartaDateTime("2027-09-01", "06:00") }, actor));
    // 4 sak sedang di lokasi lain (mis. titik borongan) — tidak ikut dihitung di gudang
    await prisma.$transaction((tx) => recordMovement(tx, { type: "TRANSFER", itemId: it.id, qty: 4, fromLocationId: raw, toLocationId: wip, date: jakartaDateTime("2027-09-01", "07:00") }, actor));
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-09-01"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [row(it, 5)] } });
    // Pembelian esok pagi, laporan baru dikirim siangnya
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 50, toLocationId: raw, unitCost: 1000, date: jakartaDateTime("2027-09-02", "08:00") }, actor));
    const res = await applyShiftStockCount(rep.id, actor, jakartaDateTime("2027-09-02", "12:00"));
    expect(res).toEqual({ adjusted: 1 });
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LAP:${rep.id}` } });
    expect(Number(mv.qty)).toBe(1); // 6 di gudang → hitung 5
    expect(mv.date.toISOString()).toBe(jakartaDateTime("2027-09-01", "15:00").toISOString());
    expect(await qtyAt(prisma, it.id, raw)).toBe(55);
    expect(await qtyAt(prisma, it.id, wip)).toBe(4);

    // Kirim ulang tanpa perubahan: tidak ada mutasi baru
    expect(await applyShiftStockCount(rep.id, actor, jakartaDateTime("2027-09-02", "13:00"))).toEqual({ adjusted: 0 });

    // Laporan lebih lama yang baru dikirim sesudahnya tidak menimpa hitungan yang lebih baru
    const old = await prisma.shiftReport.create({ data: { date: dateOnly("2027-08-31"), shiftId: s2, divisionId, createdBy: "uji", stockCount: [row(it, 9)] } });
    const r2 = await applyShiftStockCount(old.id, actor, jakartaDateTime("2027-09-02", "14:00"));
    expect(r2.adjusted).toBe(0);
    expect(r2.skipped).toContain("laporan lebih baru");
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: old.id } })).stockApplied).toBe(false);
    expect(await qtyAt(prisma, it.id, raw)).toBe(55);

    // Shift 2 di hari yang sama = lebih baru dari Shift 1 → tetap diterapkan
    const sore = await prisma.shiftReport.create({ data: { date: dateOnly("2027-09-01"), shiftId: s2, divisionId, createdBy: "uji", stockCount: [row(it, 3)] } });
    expect((await applyShiftStockCount(sore.id, actor, jakartaDateTime("2027-09-02", "15:00"))).adjusted).toBe(1);
    expect(await qtyAt(prisma, it.id, raw)).toBe(53);
  });

  it("daftar & teks pengingat order bahan: stok akhir terakhir ≤ limit", async () => {
    const groups = await materialOrderList(divisionId);
    const o = groups[0].order.find((x) => x.name === "Gypsum opname uji");
    expect(o).toMatchObject({ qty: 3, limit: 5 });
    const text = materialOrderText(groups, (s) => s)!;
    expect(text).toContain("Order bahan baku");
    expect(text).toContain("Gypsum opname uji: stok 3 · limit 5 sak");
    expect(materialOrderText([{ division: { name: "X" }, order: [] }], (s) => s)).toBeNull();
  });

  it("laporan belum dikirim dihitung per jumlah shift divisi (yang belum dibuat ikut)", async () => {
    // Produksi 2 shift: belum ada yang terkirim tanggal ini
    expect(await unsentReportCount("2027-09-05", divisionId)).toBe(2);
    await prisma.shiftReport.create({ data: { date: dateOnly("2027-09-05"), shiftId: s1, divisionId, createdBy: "uji", status: "TERKIRIM" } });
    expect(await unsentReportCount("2027-09-05", divisionId)).toBe(1);
  });
});
