import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveAndBook, bankBalances, createTransaction } from "@/lib/finance";
import { profitLoss } from "@/lib/accounting";
import { jakartaDateTime } from "@/lib/time";
import { koreksiWd0061, REDATE } from "../scripts/koreksi-wd-0061";

let actor: { id: string; name: string };
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
});

describe("Akun Retur & Refund Penjualan", () => {
  it("ada sebagai kategori keluar, dibukukan sebagai pengurang pendapatan", async () => {
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Retur & Refund Penjualan" }, include: { coaAccount: true } });
    expect(cat.direction).toBe("KELUAR");
    expect(cat.active).toBe(true);
    expect(cat.coaAccount.code).toBe("4-1200");
    expect(cat.coaAccount.type).toBe("PENDAPATAN");
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const range = { start: jakartaDateTime("2026-11-06", "00:00"), end: jakartaDateTime("2026-11-07", "00:00") };
    const before = (await profitLoss(range)).totalRevenue;
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: 25_000, date: jakartaDateTime("2026-11-06", "10:00"), accountId: bank.id, categoryId: cat.id, note: "refund pembeli uji" }, "MANUAL", actor, { submit: true });
    await approveAndBook(transaction.id, actor);
    const pl = await profitLoss(range);
    expect(pl.totalRevenue).toBe(before - 25_000);
    expect(pl.revenue.find((r) => r.code === "4-1200")?.amount).toBe(-25_000);
  });
});

describe("Skrip koreksi tanggal TRX-202611-0061", () => {
  it("pratinjau tidak mengubah apa-apa; jalankan = batal + jurnal balik + catat ulang 5 Nov; aman diulang", async () => {
    const coa = await prisma.coaAccount.upsert({ where: { code: "1-1204" }, create: { code: "1-1204", name: "Saldo Penjual TikTok", type: "ASET", isCash: true }, update: {} });
    const tiktok = await prisma.bankAccount.upsert({ where: { code: "SALDO_TIKTOK" }, create: { code: "SALDO_TIKTOK", name: "Saldo Penjual TikTok", coaAccountId: coa.id, marketplace: true }, update: {} });
    const seabank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const mg = await prisma.store.findUniqueOrThrow({ where: { code: "MG" } });
    const { transaction } = await createTransaction({ direction: "TRANSFER", amount: REDATE.amount, date: jakartaDateTime("2026-11-04", "13:21"), accountId: tiktok.id, toAccountId: seabank.id, storeId: mg.id, note: "WD tiktok MG" }, "MANUAL", actor, { submit: true });
    // Nomor TRX-202611-0061 bisa sudah dipakai tes lain di DB uji: pindahkan dulu
    await prisma.financeTransaction.updateMany({ where: { number: REDATE.number }, data: { number: "TRX-UJI-0061" } });
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { number: REDATE.number } });
    await approveAndBook(transaction.id, actor);

    const day = (d: string) => ({ start: jakartaDateTime(d, "00:00"), end: jakartaDateTime(d, "23:59") });
    const sales = async (d: string) => (await profitLoss(day(d))).revenue.find((r) => r.code === "4-1000")?.amount ?? 0;
    const bal = async () => (await bankBalances()).find((b) => b.id === seabank.id)!.balance;
    const [s4, s5, b0] = [await sales("2026-11-04"), await sales("2026-11-05"), await bal()];
    const logs: string[] = [];

    expect((await koreksiWd0061(false, (s) => logs.push(s))).hasil).toBe("PRATINJAU");
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).status).toBe("DIBUKUKAN");
    expect(await sales("2026-11-04")).toBe(s4);

    const r = await koreksiWd0061(true, (s) => logs.push(s));
    expect(r.hasil).toBe("DIKOREKSI");
    const old = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(old.status).toBe("DIBATALKAN");
    const reversal = await prisma.journal.findFirstOrThrow({ where: { reversalOfId: old.journalId! } });
    expect(reversal.date.getTime()).toBe(old.date.getTime());
    const neu = await prisma.financeTransaction.findUniqueOrThrow({ where: { number: r.number! } });
    expect(neu.status).toBe("DIBUKUKAN");
    expect(neu.date.getTime()).toBe(jakartaDateTime("2026-11-05", "13:21").getTime());
    expect(neu.storeId).toBe(mg.id);
    // Pemasukan penjualan pindah dari 4 Nov ke 5 Nov, saldo Seabank tetap
    expect(await sales("2026-11-04")).toBe(s4 - REDATE.amount);
    expect(await sales("2026-11-05")).toBe(s5 + REDATE.amount);
    expect(await bal()).toBe(b0);

    expect((await koreksiWd0061(true, (s) => logs.push(s))).hasil).toBe("SUDAH");
    expect(await prisma.financeTransaction.count({ where: { amount: BigInt(REDATE.amount), status: "DIBUKUKAN" } })).toBe(1);
  });
});
