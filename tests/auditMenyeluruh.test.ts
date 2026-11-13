// Audit menyeluruh 12–13 Nov 2026: perbaikan bug yang jelas (lihat docs/AUDIT-MENYELURUH.md)
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { parseIDR } from "@/lib/money";
import { evaluateCheckIn } from "@/lib/attendance";
import { giveAdvance } from "@/lib/payroll";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { applyShiftStockCount } from "@/lib/shiftReportStock";
import { recipeMaterialCost } from "@/lib/hpp";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Nominal ber-satuan (rb/jt)", () => {
  it("titik desimal dengan satuan dibaca desimal, bukan ribuan", () => {
    expect(parseIDR("1.5jt")).toBe(1_500_000);
    expect(parseIDR("2.25jt")).toBe(2_250_000);
    expect(parseIDR("1,5jt")).toBe(1_500_000);
    expect(parseIDR("1.250rb")).toBe(1_250_000);
    expect(parseIDR("Rp 1.250.000")).toBe(1_250_000);
  });
});

describe("Telat untuk shift lewat tengah malam", () => {
  it("mulai 22.00, absen 00.10 WIB = telat 130 menit; mulai 00.30, absen 23.50 = tidak telat", () => {
    expect(evaluateCheckIn({ startTime: "22:00", toleranceMinutes: 10 }, jakartaDateTime("2026-11-02", "00:10"))).toEqual({ status: "TERLAMBAT", lateMinutes: 130 });
    expect(evaluateCheckIn({ startTime: "00:30", toleranceMinutes: 10 }, jakartaDateTime("2026-11-01", "23:50"))).toEqual({ status: "HADIR", lateMinutes: 0 });
    expect(evaluateCheckIn({ startTime: "07:00", toleranceMinutes: 10 }, jakartaDateTime("2026-11-01", "07:25"))).toEqual({ status: "TERLAMBAT", lateMinutes: 25 });
  });
});

describe("Kasbon", () => {
  it("pekerja borongan tidak bisa diberi kasbon", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const e = await prisma.employee.create({ data: { code: "UJI-BRG-KSB", name: "Borongan Uji Kasbon", divisionId: div.id, wageType: "BORONGAN" } });
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { active: true } });
    await expect(giveAdvance({ employeeId: e.id, amount: 50000, installment: 0, bankAccountId: bank.id, date: "2027-10-01" }, actor)).rejects.toThrow(/borongan/);
  });
});

describe("Laporan shift dikirim dua kali bersamaan", () => {
  it("stok bahan hanya disesuaikan sekali", async () => {
    const { raw } = await locationSettings(prisma);
    // Divisi sendiri agar urutan "laporan lebih baru" tidak mengganggu tes laporan shift lain
    const divisionId = (await prisma.division.create({ data: { code: "UJIDBL", name: "Divisi Uji Kirim Ganda" } })).id;
    const shiftId = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    const it = await prisma.item.create({ data: { sku: "BB-AUD-DBL", name: "Bahan kirim ganda", type: "BAHAN_BAKU", unit: "sak", divisionId } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 10, toLocationId: raw!, unitCost: 1000, date: jakartaDateTime("2027-11-01", "06:00") }, actor));
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-11-01"), shiftId, divisionId, createdBy: "uji", stockCount: [{ itemId: it.id, name: it.name, unit: "sak", limit: 0, qty: 4 }] } });
    const now = jakartaDateTime("2027-11-01", "18:00");
    const r = await Promise.all([applyShiftStockCount(rep.id, actor, now), applyShiftStockCount(rep.id, actor, now)]);
    expect(r.reduce((s, x) => s + x.adjusted, 0)).toBe(1);
    expect(await qtyAt(prisma, it.id, raw!)).toBe(4);
  });
});

describe("Nilai resep untuk pembukuan", () => {
  it("hanya bahan: upah & overhead di resep barang setengah jadi tidak ikut (sudah dibebankan lewat gaji/beban)", async () => {
    const bahan = await prisma.item.create({ data: { sku: "BB-AUD-RSP", name: "Bahan resep uji", type: "BAHAN_BAKU", unit: "pcs", lastCost: BigInt(1000), avgCost: BigInt(1000) } });
    const sj = await prisma.item.create({ data: { sku: "SJ-AUD-RSP", name: "Setengah jadi uji", type: "BARANG_DALAM_PROSES", unit: "pcs" } });
    await prisma.itemRecipeLine.create({ data: { itemId: sj.id, componentId: bahan.id, qty: 2 } });
    await prisma.recipeLabor.create({ data: { itemId: sj.id, name: "Upah cetak", rate: BigInt(500) } });
    const bj = await prisma.item.create({ data: { sku: "BJ-AUD-RSP", name: "Produk jadi uji", type: "BARANG_JADI", unit: "pcs" } });
    const store = await prisma.store.findFirstOrThrow();
    const p = await prisma.product.create({ data: { sku: "AUD-RSP", name: "Produk resep uji", type: "SATUAN", variant: "HEWAN", storeId: store.id, finishedItemId: bj.id } });
    await prisma.bomLine.create({ data: { productId: p.id, itemId: sj.id, qty: 1 } });
    expect(await recipeMaterialCost(bj.id)).toBe(2000);
  });
});
