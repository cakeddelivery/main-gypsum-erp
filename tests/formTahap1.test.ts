import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { choiceMode, matchesQuery } from "@/lib/choice";
import { lineAmounts, termFor, createPurchase } from "@/lib/purchase";
import { BASE_UNITS, PURCHASE_UNITS, normalizeUnit, saveItemRecord, unitOptions } from "@/lib/items";
import { COA } from "@/lib/accounting";
import { itemTotals, needsReorder } from "@/lib/stock";
import { jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
let seabank: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id;
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Aturan kolom pilihan", () => {
  it("≤ 3 opsi tombol, > 3 opsi dropdown cari", () => {
    expect([1, 2, 3, 4, 9].map(choiceMode)).toEqual(["buttons", "buttons", "buttons", "search", "search"]);
  });
  it("pencarian cocok semua kata tanpa urutan & huruf besar", () => {
    expect(matchesQuery("BU-001 Bubuk Gypsum Super Casting (sak)", "gypsum bubuk")).toBe(true);
    expect(matchesQuery("Cat akrilik merah", "gypsum")).toBe(false);
    expect(matchesQuery("apa saja", "  ")).toBe(true);
  });
});

describe("Satuan & reorder", () => {
  it("satuan lama tetap muncul, huruf besar dinormalkan", () => {
    expect(normalizeUnit(PURCHASE_UNITS, "Sak")).toBe("sak");
    expect(unitOptions(PURCHASE_UNITS, "lembar").at(-1)).toEqual({ value: "lembar", label: "lembar (lama)" });
    expect(unitOptions(BASE_UNITS, "gram")).toHaveLength(BASE_UNITS.length);
  });
  it("reorder saat stok menyentuh atau di bawah batas", () => {
    expect(needsReorder(10, 10)).toBe(true);
    expect(needsReorder(9, 10)).toBe(true);
    expect(needsReorder(11, 10)).toBe(false);
    expect(needsReorder(0, 0)).toBe(false);
  });
});

describe("Status bayar pembelian", () => {
  it("nominal = tagihan lunas, kurang = hutang, lebih ditolak", () => {
    expect(termFor(500_000, 500_000)).toBe("LUNAS");
    expect(termFor(500_000, 200_000)).toBe("BERTAHAP");
    expect(termFor(500_000, 0)).toBe("TEMPO");
    expect(() => termFor(500_000, 600_000)).toThrow(/melebihi/);
  });
  it("total per baris → harga per satuan otomatis", () => {
    const [l] = lineAmounts([{ itemId: "x", qty: 5, amount: 360_000 }]);
    expect(l).toMatchObject({ amount: 360_000, unitCost: 72_000 });
    expect(lineAmounts([{ itemId: "x", qty: 2, unitCost: 1500 }])[0].amount).toBe(3000);
  });
});

describe("Master item & pembelian (database)", () => {
  it("kode otomatis per kategori + stok awal dibukukan ke saldo awal", async () => {
    const a = await saveItemRecord({ name: "Gypsum Uji Kategori", type: "BAHAN_BAKU", category: "Bahan Utama", unit: "sak", hppUnit: "kg", hppFactor: 40, minStock: 5, price: 72_000, openingQty: 3 }, actor);
    const b = await saveItemRecord({ name: "Gypsum Uji Kategori 2", type: "BAHAN_BAKU", category: "Bahan Utama", unit: "sak", hppUnit: "sak", hppFactor: 40, minStock: 0 }, actor);
    expect(a.sku).toMatch(/^BU-\d{3}$/);
    expect(Number(b.sku.slice(3))).toBe(Number(a.sku.slice(3)) + 1);
    expect(b.hppUnit).toBeNull();
    expect(Number(b.hppFactor)).toBe(1);
    expect((await itemTotals()).get(a.id)).toBe(3);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: a.id } });
    const lines = await prisma.journalLine.findMany({ where: { journalId: mv.journalId! }, include: { account: true } });
    expect(lines.find((l) => l.account.code === COA.PERSEDIAAN_BAHAN)?.debit.toString()).toBe("216000");
    expect(lines.find((l) => l.account.code === COA.EKUITAS_SALDO_AWAL)?.credit.toString()).toBe("216000");
    await expect(saveItemRecord({ name: "Salah kategori", type: "BARANG_JADI", category: "Bahan Utama", unit: "pcs", hppFactor: 1, minStock: 0 }, actor)).rejects.toThrow(/Kategori/);
  });

  it("pembelian banyak item ke supplier baru, nominal kurang → hutang", async () => {
    const [g, c] = await Promise.all([
      saveItemRecord({ name: "Bahan Uji A", type: "BAHAN_BAKU", category: "Bahan Utama", unit: "sak", hppFactor: 1, minStock: 0 }, actor),
      saveItemRecord({ name: "Cat Uji B", type: "BAHAN_BAKU", category: "Cat & Pewarna", unit: "botol", hppFactor: 1, minStock: 0 }, actor),
    ]);
    const bill = 360_000 + 90_000;
    const p = await createPurchase({ storeId, newSupplierName: "UD Supplier Baru Uji", date: jakartaDateTime("2027-03-01", "12:00"), term: termFor(bill, 300_000), paidNow: 300_000, bankAccountId: seabank, dueDate: jakartaDateTime("2027-03-15", "12:00"), proofPath: "2027/03/x.jpg", proofMime: "image/jpeg", lines: [{ itemId: g.id, qty: 5, amount: 360_000 }, { itemId: c.id, qty: 3, amount: 90_000 }] }, actor);
    expect(Number(p.total)).toBe(bill);
    expect(p.term).toBe("BERTAHAP");
    expect(p.proofPath).toBe("2027/03/x.jpg");
    const sup = await prisma.supplier.findFirstOrThrow({ where: { name: "UD Supplier Baru Uji" } });
    expect(p.supplierId).toBe(sup.id);
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.payableId! } })).amount)).toBe(150_000);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: g.id } })).lastCost)).toBe(72_000);
    // supplier yang sama diketik lagi tidak dobel
    await createPurchase({ storeId, newSupplierName: "ud supplier baru uji", date: jakartaDateTime("2027-03-02", "12:00"), term: "LUNAS", paidNow: 30_000, bankAccountId: seabank, lines: [{ itemId: c.id, qty: 1, amount: 30_000 }] }, actor);
    expect(await prisma.supplier.count({ where: { name: { equals: "UD Supplier Baru Uji", mode: "insensitive" } } })).toBe(1);
  });
});
