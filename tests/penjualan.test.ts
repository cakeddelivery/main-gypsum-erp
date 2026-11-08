import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { finishedGoodsOpname, locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { cancelSale, cancelSalePayment, createSale, paySale, saleStatus, saleTotals, SALE_SOURCE } from "@/lib/sales";
import { effectivePermissions } from "@/lib/rbac";
import { jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let seabank: string;
let storeId: string;
let finished: string;
const d = (s: string) => jakartaDateTime(s, "10:00");
/** Saldo (debit − kredit) satu akun dari jurnal tertentu */
const net = async (journalIds: string[], code: string) => {
  const ls = await prisma.journalLine.findMany({ where: { journalId: { in: journalIds }, account: { code } } });
  return ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
};
const saleJournals = async (number: string) => {
  const moves = await prisma.stockMovement.findMany({ where: { ref: number } });
  const js = await prisma.journal.findMany({ where: { OR: [{ source: SALE_SOURCE, sourceId: number }, { source: "STOK", sourceId: { in: moves.map((m) => m.id) } }] } });
  const rev = await prisma.journal.findMany({ where: { reversalOfId: { in: js.map((j) => j.id) } } });
  return [...js, ...rev].map((j) => j.id);
};
async function product(sku: string, qty: number, cost: number) {
  const it = await prisma.item.create({ data: { sku, name: `Produk ${sku}`, type: "BARANG_JADI", unit: "pcs" } });
  if (qty > 0) await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: it.id, qty, toLocationId: finished, unitCost: cost, date: d("2027-06-01") }, actor));
  return it;
}

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  finished = (await locationSettings(prisma)).finished!;
});

describe("Hitungan nota", () => {
  it("subtotal − diskon + ongkir, sisa = tagihan − dibayar", () => {
    const t = saleTotals([{ itemId: "a", qty: 2, price: 15000 }, { itemId: "b", qty: 1, price: 10000 }], 5000, 12000, 20000);
    expect(t).toMatchObject({ subtotal: 40000, discount: 5000, shipping: 12000, total: 47000, paid: 20000, debt: 27000 });
    expect(() => saleTotals([{ itemId: "a", qty: 1, price: 1000 }], 2000)).toThrow(/Diskon/);
    expect(() => saleTotals([{ itemId: "a", qty: 1, price: 1000 }], 0, 0, 1500)).toThrow(/melebihi/);
  });
  it("status bayar", () => {
    expect(saleStatus({ total: 100, paid: 100 }).key).toBe("LUNAS");
    expect(saleStatus({ total: 100, paid: 40 }).key).toBe("SEBAGIAN");
    expect(saleStatus({ total: 100, paid: 0, dueDate: new Date("2020-01-01") }).key).toBe("JATUH_TEMPO");
    expect(saleStatus({ total: 100, paid: 0, cancelledAt: new Date() }).key).toBe("BATAL");
  });
  it("izin penjualan untuk Owner/Finance/Admin/Admin Marketplace saja", () => {
    for (const r of ["OWNER", "FINANCE", "ADMIN", "ADMIN_MARKETPLACE"] as const) expect(effectivePermissions(r, []).has("sales.manage")).toBe(true);
    for (const r of ["OPERATOR", "SUPERVISOR", "ADMIN_PRODUKSI"] as const) expect(effectivePermissions(r, []).has("sales.view")).toBe(false);
  });
});

describe("Penjualan offline", () => {
  it("lunas: pendapatan, ongkir, rekening, HPP dan stok barang jadi tercatat", async () => {
    const it = await product("BJ-JUAL-1", 10, 4000);
    const { sale, warnings } = await createSale({ date: d("2027-06-02"), storeId, newCustomerName: "Bu Ani Uji", lines: [{ itemId: it.id, qty: 3, price: 15000 }], discount: 5000, shipping: 10000, paidNow: 50000, bankAccountId: seabank }, actor);
    expect(warnings).toEqual([]);
    expect(sale.number).toMatch(/^JUAL-202706-\d{4}$/);
    expect(Number(sale.total)).toBe(50000);
    expect(Number(sale.hpp)).toBe(12000);
    expect(await qtyAt(prisma, it.id, finished)).toBe(7);
    const js = await saleJournals(sale.number);
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { id: seabank }, include: { coaAccount: true } });
    expect(await net(js, bank.coaAccount.code)).toBe(50000);
    expect(await net(js, COA.PENJUALAN)).toBe(-40000);
    expect(await net(js, COA.PENDAPATAN_ONGKIR)).toBe(-10000);
    expect(await net(js, COA.HPP)).toBe(12000);
    expect(await net(js, COA.PERSEDIAAN_JADI)).toBe(-12000);
    // Pelanggan baru otomatis masuk master Pelanggan dengan kode otomatis
    const c = await prisma.customer.findFirstOrThrow({ where: { name: "Bu Ani Uji" } });
    expect(c.code).toMatch(/^PLG-\d{3}$/);
    expect(sale.customerId).toBe(c.id);
  });

  it("opname akhir bulan tidak menghitung HPP dua kali untuk barang yang sudah dijual", async () => {
    const it = await product("BJ-JUAL-2", 10, 2000);
    await createSale({ date: d("2027-06-03"), storeId, lines: [{ itemId: it.id, qty: 4, price: 5000 }], paidNow: 20000, bankAccountId: seabank }, actor);
    // Fisik 5: 4 sudah tercatat terjual, 1 sisanya (mis. pesanan marketplace) baru masuk HPP lewat opname
    const r = await finishedGoodsOpname([{ itemId: it.id, physical: 5 }], jakartaDateTime("2027-06-30", "23:00"), actor);
    expect(r).toMatchObject({ changed: 1, sold: 1, hpp: 2000 });
  });

  it("tempo + cicilan + pelunasan; piutang ikut berkurang", async () => {
    const it = await product("BJ-JUAL-3", 5, 1000);
    const cust = await prisma.customer.create({ data: { name: "Toko Uji Tempo" } });
    await expect(createSale({ date: d("2027-06-04"), storeId, customerId: cust.id, lines: [{ itemId: it.id, qty: 2, price: 30000 }], paidNow: 0 }, actor)).rejects.toThrow(/jatuh tempo/);
    await expect(createSale({ date: d("2027-06-04"), storeId, lines: [{ itemId: it.id, qty: 2, price: 30000 }], paidNow: 0, dueDate: d("2027-06-20") }, actor)).rejects.toThrow(/pelanggan/);
    const { sale } = await createSale({ date: d("2027-06-04"), storeId, customerId: cust.id, lines: [{ itemId: it.id, qty: 2, price: 30000 }], paidNow: 10000, bankAccountId: seabank, dueDate: d("2027-06-20") }, actor);
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { saleId: sale.id } });
    expect(Number(rec.amount)).toBe(50000);
    expect(await net(await saleJournals(sale.number), COA.PIUTANG)).toBe(50000);

    const p1 = await paySale(sale.id, { amount: 20000, bankAccountId: seabank, date: d("2027-06-10") }, actor);
    expect(p1.lunas).toBe(false);
    await expect(paySale(sale.id, { amount: 40000, bankAccountId: seabank, date: d("2027-06-11") }, actor)).rejects.toThrow(/melebihi/);
    // Penjualan yang sudah dicicil tidak bisa dibatalkan langsung
    await expect(cancelSale(sale.id, "salah", actor)).rejects.toThrow(/dicicil/);
    await cancelSalePayment(p1.payment.id, "salah nominal", actor);
    expect(Number((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).paid)).toBe(10000);
    const p2 = await paySale(sale.id, { amount: 50000, bankAccountId: seabank, date: d("2027-06-12") }, actor);
    expect(p2.lunas).toBe(true);
    const after = await prisma.receivable.findUniqueOrThrow({ where: { id: rec.id } });
    expect(Number(after.paid)).toBe(50000);
    expect(await net(await saleJournals(sale.number), COA.PIUTANG)).toBe(0);
  });

  it("stok kurang: tetap tersimpan, stok minus + peringatan", async () => {
    const it = await product("BJ-JUAL-4", 1, 1000);
    const { warnings } = await createSale({ date: d("2027-06-05"), storeId, lines: [{ itemId: it.id, qty: 3, price: 5000 }], paidNow: 15000, bankAccountId: seabank }, actor);
    expect(warnings.length).toBe(1);
    expect(await qtyAt(prisma, it.id, finished)).toBe(-2);
  });

  it("batal penjualan: jurnal penjualan & HPP dibalik, stok kembali, piutang dihapus", async () => {
    const it = await product("BJ-JUAL-5", 6, 3000);
    const cust = await prisma.customer.create({ data: { name: "Pelanggan Batal Uji" } });
    const { sale } = await createSale({ date: d("2027-06-06"), storeId, customerId: cust.id, lines: [{ itemId: it.id, qty: 2, price: 20000 }], shipping: 5000, paidNow: 0, dueDate: d("2027-06-30") }, actor);
    await cancelSale(sale.id, "salah input", actor);
    expect(await qtyAt(prisma, it.id, finished)).toBe(6);
    expect(await prisma.receivable.findUnique({ where: { saleId: sale.id } })).toBeNull();
    const ids = await saleJournals(sale.number);
    for (const code of [COA.PENJUALAN, COA.PENDAPATAN_ONGKIR, COA.PIUTANG, COA.HPP, COA.PERSEDIAAN_JADI]) expect(await net(ids, code)).toBe(0);
    await expect(cancelSale(sale.id, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);
  });

  it("bukan barang jadi ditolak", async () => {
    const bb = await prisma.item.create({ data: { sku: "BB-JUAL-X", name: "Bahan X", type: "BAHAN_BAKU", unit: "pcs" } });
    await expect(createSale({ date: d("2027-06-07"), storeId, lines: [{ itemId: bb.id, qty: 1, price: 1000 }], paidNow: 1000, bankAccountId: seabank }, actor)).rejects.toThrow(/bukan produk jadi/);
  });
});
