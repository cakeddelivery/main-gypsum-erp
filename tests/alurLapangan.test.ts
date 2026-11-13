import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { applyShiftStockCount } from "@/lib/shiftReportStock";
import { addShiftReceipt, removeShiftReceipt, unlinkedReceiptGroups } from "@/lib/shiftReceipt";
import { cancelPurchase, createPurchase } from "@/lib/purchase";
import { applyResultCount, parseResultCount, resultCountStatus, resultLines } from "@/lib/shiftResultCount";
import { FLOW_SETTING, flowItem } from "@/lib/shiftReportFlow";
import { lateOf, lateRecap, fmtMinutes } from "@/lib/lateRecap";
import { divisionReportSent } from "@/lib/attendanceSelf";
import { boronganScope, createHandover, receiveHandover } from "@/lib/borongan";
import { plannedFlow, workLines } from "@/lib/shiftReport";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let raw: string;
let wip: string;
let s1: string;
let storeId: string;
const div = (t: string) => prisma.division.findFirstOrThrow({ where: { reportTemplate: t } });
const row = (item: { id: string; name: string; unit: string }, qty: number | null) => ({ itemId: item.id, name: item.name, unit: item.unit, limit: 0, qty });
const at = (d: string, t: string) => jakartaDateTime(d, t);

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  const l = await locationSettings(prisma);
  raw = l.raw!;
  wip = l.wip!;
  s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
});

describe("Barang masuk di laporan shift", () => {
  it("tidak jadi pemakaian, tidak dobel saat ditautkan ke Pembelian, revisi memperhitungkan barang masuk baru", async () => {
    const divisionId = (await div("PRODUKSI")).id;
    const it = await prisma.item.create({ data: { sku: "BB-BMK-UJI-1", name: "Gypsum barang masuk uji", type: "BAHAN_BAKU", unit: "sak", divisionId } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 10, toLocationId: raw, unitCost: 50_000, date: at("2027-04-01", "06:00") }, actor));

    // Shift 2 Jan: datang 20 sak dari toko (belum dicatat Pembelian), sisa dihitung 25 → pemakaian 5 (bukan −15)
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-04-02"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [row(it, 25)] } });
    const rc = await addShiftReceipt(rep.id, { itemId: it.id, qty: 20, supplierName: "Toko Uji" }, actor, at("2027-04-02", "10:00"));
    expect(rc.number).toMatch(/^BMK-202704-/);
    expect((await unlinkedReceiptGroups()).some((g) => g.rows.some((x) => x.id === rc.id))).toBe(true);
    expect(await applyShiftStockCount(rep.id, actor, at("2027-04-02", "16:00"))).toEqual({ adjusted: 1 });
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LAP:${rep.id}` } });
    expect(Number(mv.qty)).toBe(5);
    expect(mv.toLocationId).toBeNull(); // berkurang = pemakaian
    expect(await qtyAt(prisma, it.id, raw)).toBe(5); // 20 sak masih menunggu Pembelian

    // Barang masuk tidak bisa dihapus setelah laporan dikirim
    await expect(removeShiftReceipt(rc.id, actor)).rejects.toThrow(/sudah dikirim/);

    // Pembelian: jumlah harus sama dengan barang masuk
    const base = { supplierId: null, newSupplierName: "Toko Uji", storeId, date: at("2027-04-05", "12:00"), term: "TEMPO" as const, paidNow: 0, bankAccountId: null, dueDate: at("2027-05-05", "12:00"), note: null };
    await expect(createPurchase({ ...base, lines: [{ itemId: it.id, qty: 19, amount: 950_000, receiptId: rc.id }] }, actor)).rejects.toThrow(/jumlah harus sama/);
    const p = await createPurchase({ ...base, lines: [{ itemId: it.id, qty: 20, amount: 1_000_000, receiptId: rc.id }] }, actor);
    // Stok masuk bertanggal waktu barang masuk → total = hitungan fisik (25), tidak dobel
    const pm = await prisma.stockMovement.findFirstOrThrow({ where: { ref: p.number } });
    expect(pm.date.toISOString()).toBe(at("2027-04-02", "10:00").toISOString());
    expect(await qtyAt(prisma, it.id, raw)).toBe(25);
    expect((await prisma.shiftReceipt.findUniqueOrThrow({ where: { id: rc.id } })).purchaseId).toBe(p.id);
    await expect(createPurchase({ ...base, lines: [{ itemId: it.id, qty: 20, amount: 1_000_000, receiptId: rc.id }] }, actor)).rejects.toThrow(/sudah ditautkan/);

    // Hitungan esok hari sama → tidak ada selisih
    const rep2 = await prisma.shiftReport.create({ data: { date: dateOnly("2027-04-03"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [row(it, 25)] } });
    expect(await applyShiftStockCount(rep2.id, actor, at("2027-04-03", "16:00"))).toEqual({ adjusted: 0 });

    // Revisi: barang masuk ditambahkan sesudah laporan dikirim, hitungan direvisi → tidak dianggap selisih
    const rep3 = await prisma.shiftReport.create({ data: { date: dateOnly("2027-04-04"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [row(it, 20)] } });
    expect((await applyShiftStockCount(rep3.id, actor, at("2027-04-04", "16:00"))).adjusted).toBe(1); // pakai 5
    const late = await addShiftReceipt(rep3.id, { itemId: it.id, qty: 7 }, actor, at("2027-04-04", "17:00"));
    expect(late.receivedAt.toISOString()).toBe(at("2027-04-04", "15:00").toISOString()); // tidak melewati jam selesai shift
    await prisma.shiftReport.update({ where: { id: rep3.id }, data: { stockCount: [row(it, 27)] } });
    expect(await applyShiftStockCount(rep3.id, actor, at("2027-04-04", "18:00"))).toEqual({ adjusted: 0 });

    // Pembelian dibatalkan → barang masuknya kembali "belum ditautkan"
    await cancelPurchase(p.id, "salah harga", actor, at("2027-04-05", "13:00"));
    expect((await prisma.shiftReceipt.findUniqueOrThrow({ where: { id: rc.id } })).purchaseId).toBeNull();
  });

  it("barang divisi lain ditolak", async () => {
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-04-06"), shiftId: s1, divisionId: (await div("PACKING")).id, createdBy: "uji" } });
    const other = await prisma.item.findFirstOrThrow({ where: { divisionId: (await div("GIFTBOX")).id, type: "BAHAN_BAKU" } });
    await expect(addShiftReceipt(rep.id, { itemId: other.id, qty: 1 }, actor, at("2027-04-06", "10:00"))).rejects.toThrow(/bahan baku divisi ini/);
  });
});

describe("Stok akhir hasil (patung kering / produk jadi per karakter)", () => {
  it("sebelum sakelar menyala hanya ditandai; sesudahnya stok disamakan, revisi hanya selisih", async () => {
    const divisionId = (await div("PRODUKSI")).id;
    const rc = parseResultCount(["a", "b"], (k) => ({ "rc.a": "1.200" })[k] ?? null)!;
    expect(rc).toEqual({ a: 1200 });
    expect(parseResultCount([], () => null)).toBeNull();
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Hewan" }));
    await prisma.item.update({ where: { id: kering }, data: { avgCost: BigInt(100) } });
    const sys0 = await qtyAt(prisma, kering, wip, at("2027-05-01", "15:00"));

    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-05-01"), shiftId: s1, divisionId, createdBy: "uji", work: { _hasil: { Hewan: sys0 + 30 } } } });
    expect(await applyResultCount(rep.id, actor, at("2027-05-01", "16:00"))).toEqual({ adjusted: 0, skipped: "nonaktif" });
    const st = (await resultCountStatus(rep.id, at("2027-05-01", "16:00")))!;
    expect(st.rows).toEqual([expect.objectContaining({ name: "Patung kering Hewan", diff: 30 })]);
    expect(resultLines(st).join("\n")).toMatch(/selisih \+30[\s\S]*hanya ditandai/);

    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    try {
      expect(await applyResultCount(rep.id, actor, at("2027-05-01", "16:00"))).toEqual({ adjusted: 1 });
      expect(await qtyAt(prisma, kering, wip, at("2027-05-01", "15:00"))).toBe(sys0 + 30);
      await prisma.shiftReport.update({ where: { id: rep.id }, data: { work: { _hasil: { Hewan: sys0 + 25 } } } });
      expect(await applyResultCount(rep.id, actor, at("2027-05-01", "17:00"))).toEqual({ adjusted: 1 });
      expect(await qtyAt(prisma, kering, wip, at("2027-05-01", "15:00"))).toBe(sys0 + 25);
      // Selisih = selisih persediaan, bukan HPP / pemakaian bahan
      const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LPS:${rep.id}` } });
      const lines = await prisma.journalLine.findMany({ where: { journalId: mv.journalId! }, include: { account: true } });
      expect(lines.some((l) => l.account.name.toLowerCase().includes("selisih"))).toBe(true);
    } finally {
      await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
    }
  });

  it("Assembling tidak lagi mengubah stok dari laporan (stok dari setoran borongan); format lama tetap tampil", () => {
    expect(plannedFlow("ASSEMBLING", { jadi: [{ name: "Eva", v: [10, null, null, null] }] })).toEqual([]);
    expect(workLines("ASSEMBLING", {})).toEqual([]);
    expect(workLines("ASSEMBLING", { jadi: [{ name: "Eva", v: [10, null, null, null] }] }).join("\n")).toContain("Eva");
  });
});

describe("Rekap telat & absen pulang", () => {
  it("telat dihitung dari absen Terlambat saja (dalam toleransi tidak dihitung)", async () => {
    expect(lateOf([{ status: "HADIR", lateMinutes: 5 }, { status: "TERLAMBAT", lateMinutes: 25 }, { status: "TERLAMBAT", lateMinutes: 15 }])).toEqual({ count: 2, minutes: 40 });
    expect(fmtMinutes(75)).toBe("1 jam 15 menit");
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: { not: "NONAKTIF" } } });
    await prisma.attendance.createMany({
      data: [
        { employeeId: emp.id, shiftId: s1, date: dateOnly("2027-06-01"), status: "TERLAMBAT", lateMinutes: 20 },
        { employeeId: emp.id, shiftId: s1, date: dateOnly("2027-06-02"), status: "HADIR", lateMinutes: 4 },
        { employeeId: emp.id, shiftId: s1, date: dateOnly("2027-06-03"), status: "TERLAMBAT", lateMinutes: 12 },
      ],
    });
    const r = (await lateRecap("2027-06-01", "2027-06-31")).find((x) => x.employeeId === emp.id)!;
    expect(r).toMatchObject({ count: 2, minutes: 32 });
    expect(r.days).toHaveLength(2);
    expect((await lateRecap("2027-06-02", "2027-06-02")).some((x) => x.employeeId === emp.id)).toBe(false);
  });

  it("peringatan absen pulang bila laporan shift divisinya belum terkirim", async () => {
    const d = await div("PACKING");
    const emp = await prisma.employee.create({ data: { code: "EMP-UJI-ALUR", name: "Uji Alur", position: "Packing", divisionId: d.id, wageType: "BULANAN" } });
    expect(await divisionReportSent(emp.id, dateOnly("2027-06-10"), s1)).toEqual({ sent: false, division: d.name });
    await prisma.shiftReport.create({ data: { date: dateOnly("2027-06-10"), shiftId: s1, divisionId: d.id, createdBy: "uji", status: "TERKIRIM" } });
    expect((await divisionReportSent(emp.id, dateOnly("2027-06-10"), s1))?.sent).toBe(true);
  });
});

describe("Borongan: Kapten Assembling & Kapten Giftbox", () => {
  it("Kapten Assembling mengurus semua titik (kirim bahan & terima hasil); Kapten Giftbox menerima pot cat divisinya", async () => {
    const asm = await div("ASSEMBLING");
    const gft = await div("GIFTBOX");
    const can = () => false;
    const sAsm = await boronganScope(prisma, { id: "x", can, role: "KAPTEN_DIVISI", divisionId: asm.id });
    expect(sAsm.warehouse).toBe(true);
    expect(sAsm.pointIds.length).toBeGreaterThan(0);
    const sGft = await boronganScope(prisma, { id: "x", can, role: "KAPTEN_DIVISI", divisionId: gft.id });
    expect(sGft.warehouse).toBeFalsy();

    const point = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "BMR" } });
    const pot = await prisma.item.create({ data: { sku: "BB-GFT-POT-UJI", name: "Cat giftbox pot uji", type: "BAHAN_BAKU", unit: "pcs", divisionId: gft.id } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: pot.id, qty: 100, toLocationId: point.locationId, unitCost: 100 }, actor));
    const h = await createHandover({ kind: "KEMBALI", pointId: point.id, lines: [{ itemId: pot.id, qty: 60 }] }, actor);
    await expect(receiveHandover(h.id, actor, sGft, { divisionId: asm.id })).rejects.toThrow(/kapten divisi pemilik barang/);
    await receiveHandover(h.id, actor, sGft, { divisionId: gft.id });
    expect(await qtyAt(prisma, pot.id, raw)).toBe(60);
  });
});
