import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { locationSettings, recordMovement, usageAccountCode } from "@/lib/stock";
import { createSale, SALE_SOURCE } from "@/lib/sales";
import { jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
const d = (s: string) => jakartaDateTime(s, "10:00");
const linesOf = (journalId: string) => prisma.journalLine.findMany({ where: { journalId }, include: { account: true } });

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
});

describe("Akun HPP Pemakaian Bahan Baku", () => {
  it("migrasi membuat akun HPP & setting-nya", async () => {
    const code = await usageAccountCode(prisma);
    const acc = await prisma.coaAccount.findUniqueOrThrow({ where: { code } });
    expect(acc).toMatchObject({ name: "Pemakaian Bahan Baku", type: "HPP" });
  });

  it("stok bahan berkurang dari laporan shift → Dr Pemakaian Bahan Baku (HPP), bukan Beban Selisih", async () => {
    const { raw } = await locationSettings(prisma);
    const it = await prisma.item.create({ data: { sku: "BB-PAKAI-1", name: "Gypsum uji pakai", type: "BAHAN_BAKU", unit: "kg" } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: it.id, qty: 10, toLocationId: raw, unitCost: 2000, date: d("2027-08-01") }, actor));
    const mv = await prisma.$transaction((tx) => recordMovement(tx, { type: "PENYESUAIAN", itemId: it.id, qty: 3, fromLocationId: raw, increase: false, usage: true, allowNegative: true, date: d("2027-08-02") }, actor));
    const ls = await linesOf(mv.journalId!);
    const code = await usageAccountCode(prisma);
    expect(ls.find((l) => l.account.code === code)?.debit).toBe(BigInt(6000));
    expect(ls.find((l) => l.account.code === COA.PERSEDIAAN_BAHAN)?.credit).toBe(BigInt(6000));
    expect(ls.some((l) => l.account.code === COA.BEBAN_SELISIH_PERSEDIAAN)).toBe(false);
  });
});

describe("Cadangan harga pokok dari resep", () => {
  it("barang jadi berharga pokok 0 → HPP penjualan memakai bahan + kemasan resep, dengan catatan di jurnal", async () => {
    const { finished } = await locationSettings(prisma);
    const bahan = await prisma.item.create({ data: { sku: "BB-RESEP-1", name: "Bahan resep uji", type: "BAHAN_BAKU", unit: "pcs", lastCost: BigInt(1500), avgCost: BigInt(1500) } });
    const jadi = await prisma.item.create({ data: { sku: "BJ-RESEP-1", name: "Produk resep uji", type: "BARANG_JADI", unit: "pcs" } });
    await prisma.product.create({ data: { sku: "PRD-RESEP-1", name: "Produk resep uji", type: "SATUAN", variant: "MIX", storeId, finishedItemId: jadi.id, laborCost: BigInt(999), bom: { create: [{ itemId: bahan.id, qty: 2 }] } } });
    expect(finished).toBeTruthy();
    const { sale } = await createSale({ date: d("2027-08-03"), storeId, lines: [{ itemId: jadi.id, qty: 4, price: 10000 }], paidNow: 40000, bankAccountId: (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id }, actor);
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    expect(Number(line.unitCost)).toBe(3000); // 2 × 1.500, tanpa tenaga kerja
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: sale.number, type: "PENGELUARAN" } });
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: mv.journalId! } });
    expect(j.description).toContain("harga pokok dari resep");
    const ls = await linesOf(j.id);
    expect(ls.find((l) => l.account.code === COA.HPP)?.debit).toBe(BigInt(12000));
    expect(await prisma.journal.count({ where: { source: SALE_SOURCE, sourceId: sale.number } })).toBe(1);
  });
});
