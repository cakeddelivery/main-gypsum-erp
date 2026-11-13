import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { withdrawIncomeLines } from "@/lib/finance";
import { marketplaceMonthSummary, saveMarketplaceMonth, MP_SOURCE } from "@/lib/marketplaceMonthly";
import { postJournal, profitLoss } from "@/lib/accounting";
import { jakartaDateTime, monthRange } from "@/lib/time";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

const fees = (admin: number, service = 0) => ({ admin, service, affiliate: 0, other: 0 });

describe("Biaya marketplace bulanan (omzet kotor + biaya admin)", () => {
  it("withdraw neto + biaya = omzet kotor, laba tidak berubah, simpan ulang membalik jurnal lama", async () => {
    const seller = await prisma.bankAccount.findFirstOrThrow({ where: { marketplace: true } });
    const target = await prisma.bankAccount.findFirstOrThrow({ where: { marketplace: false, active: true } });
    const store = await prisma.store.findFirstOrThrow({ orderBy: { code: "asc" } });
    const { start, end } = monthRange(2028, 3);
    const pick = async () => (await marketplaceMonthSummary(2028, 3)).rows.find((r) => r.bank.id === seller.id && r.store.id === store.id);
    const net0 = (await pick())?.net ?? 0;
    // Jurnal withdraw seperti dari menu Transaksi: pemasukan penjualan (neto) + pindah saldo penjual → rekening
    await prisma.$transaction((tx) => postJournal(tx, { date: jakartaDateTime("2028-03-10", "10:00"), storeId: store.id, description: "WD uji biaya marketplace", source: "FINANCE", actor, lines: [
      ...withdrawIncomeLines(seller.coaAccountId, seller.name, 850_000),
      { accountId: target.coaAccountId, debit: 850_000 }, { accountId: seller.coaAccountId, credit: 850_000 },
    ] }));
    const before = await profitLoss({ start, end });

    await saveMarketplaceMonth({ year: 2028, month: 3, bankId: seller.id, storeId: store.id, fees: fees(100_000, 50_000), gross: 1_000_000 }, actor, jakartaDateTime("2028-04-02", "09:00"));
    let row = (await pick())!;
    expect(row).toMatchObject({ net: net0 + 850_000, fees: 150_000, grossBook: net0 + 1_000_000, grossMarket: 1_000_000, feePct: 15 });
    const after = await profitLoss({ start, end });
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.totalRevenue - before.totalRevenue).toBe(150_000);
    const j = await prisma.journal.findFirstOrThrow({ where: { source: MP_SOURCE }, orderBy: { createdAt: "desc" } });
    expect(j.date.toISOString()).toBe(jakartaDateTime("2028-03-31", "23:59").toISOString());

    // Ubah: jurnal lama dibalik, hanya satu jurnal aktif
    await saveMarketplaceMonth({ year: 2028, month: 3, bankId: seller.id, storeId: store.id, fees: fees(120_000), gross: 1_000_000 }, actor, jakartaDateTime("2028-04-03", "09:00"));
    row = (await pick())!;
    expect(row.fees).toBe(120_000);
    expect((await profitLoss({ start, end })).totalRevenue - before.totalRevenue).toBe(120_000);
  });

  it("menolak rekening bukan saldo penjual, biaya minus, dan biaya melebihi omzet", async () => {
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { marketplace: false } });
    const seller = await prisma.bankAccount.findFirstOrThrow({ where: { marketplace: true } });
    const store = await prisma.store.findFirstOrThrow();
    const now = jakartaDateTime("2028-04-02", "09:00");
    await expect(saveMarketplaceMonth({ year: 2028, month: 3, bankId: bank.id, storeId: store.id, fees: fees(1000) }, actor, now)).rejects.toThrow(/bukan saldo penjual/);
    await expect(saveMarketplaceMonth({ year: 2028, month: 3, bankId: seller.id, storeId: store.id, fees: fees(-5) }, actor, now)).rejects.toThrow(/minus/);
    await expect(saveMarketplaceMonth({ year: 2028, month: 3, bankId: seller.id, storeId: store.id, fees: fees(5000), gross: 1000 }, actor, now)).rejects.toThrow(/melebihi omzet/);
  });
});
