import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveAndBook, attachTransactionProof, cancelBookedTransaction, createTransaction, linkBookedTransfer } from "@/lib/finance";
import { postReserve } from "@/lib/reserve";
import { reserveOptions } from "@/lib/reserveSync";
import { findSupplierByName, mergeSuppliers, resolveSupplier, supplierKey } from "@/lib/suppliers";
import { createPurchase } from "@/lib/purchase";
import { extractTransaction, fixTransferTarget } from "@/lib/extract";
import { COA } from "@/lib/accounting";
import { addDays, jakartaDateTime, todayStr } from "@/lib/time";

const tag = Math.random().toString(36).slice(2, 7);
let owner: { id: string; name: string };
let seabank: string;
let shopeepay: string;
let saldoShopee: string;
let store: string;
let ownerFunds: { id: string }[];

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  shopeepay = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } })).id;
  saldoShopee = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SALDO_SHOPEE" } })).id;
  store = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  ownerFunds = await prisma.reserveFund.findMany({ where: { kind: "OWNER", active: true } });
});

// Tanggal unik di masa depan agar tidak bentrok dengan sisihan tes lain
let dayOffset = 300 + Math.floor(Math.random() * 2000);
const freshDay = () => addDays(todayStr(), (dayOffset += 3));

async function transfer(date: string, amount: number, to: string, note = "ops", proof = true) {
  const { transaction } = await createTransaction({ direction: "TRANSFER", amount, date: jakartaDateTime(date, "20:44"), accountId: seabank, toAccountId: to, note, proofPath: proof ? `uji/${tag}-${date}.jpg` : null, proofMime: proof ? "image/jpeg" : null }, "TELEGRAM", owner);
  return transaction;
}

describe("Supplier tidak dobel", () => {
  it("nama dinormalkan tanpa kata umum", () => {
    expect(supplierKey("Supplier BG Klip Label")).toBe("bg klip label");
    expect(supplierKey("Toko  Afdhol-Grafika")).toBe("afdhol grafika");
  });

  it("hutang & pembelian dengan nama mirip memakai supplier yang sama, gabung memindah semua", async () => {
    const a = await resolveSupplier(prisma, { name: `Supplier Klip ${tag}` }, owner, "uji");
    const again = await resolveSupplier(prisma, { name: `klip ${tag.toUpperCase()}` }, owner, "uji");
    expect(again!.id).toBe(a!.id);
    const b = await resolveSupplier(prisma, { name: `Grafika ${tag}` }, owner, "uji");
    const item = await prisma.item.findFirstOrThrow({ where: { type: "BAHAN_BAKU", active: true } });
    const pu = await createPurchase({ newSupplierName: `Grafika ${tag}`, storeId: store, date: new Date(), term: "TEMPO", lines: [{ itemId: item.id, qty: 1, amount: 50_000 }], paidNow: 0, dueDate: new Date() }, owner);
    expect(pu.supplierId).toBe(b!.id);
    const pay = await prisma.payable.create({ data: { number: `UJI-${tag}`, vendor: a!.name, supplierId: a!.id, storeId: store, date: new Date(), amount: BigInt(70_000) } });
    const r = await mergeSuppliers(a!.id, b!.id, owner);
    expect(r.payables).toBe(1);
    const moved = await prisma.payable.findUniqueOrThrow({ where: { id: pay.id } });
    expect(moved.supplierId).toBe(b!.id);
    expect(moved.vendor).toBe(b!.name);
    expect(await prisma.supplier.findUnique({ where: { id: a!.id } })).toBeNull();
    // Nama lama tetap dikenali sebagai nama lain
    expect((await findSupplierByName(prisma, `Supplier Klip ${tag}`))?.id).toBe(b!.id);
  });
});

describe("Transfer ↔ dana sisihan", () => {
  it("rekening tujuan bank → Saldo Penjual Shopee dibetulkan ke ShopeePay", async () => {
    const banks = await prisma.bankAccount.findMany();
    expect(fixTransferTarget(seabank, saldoShopee, banks)).toBe(shopeepay);
    expect(fixTransferTarget(saldoShopee, seabank, banks)).toBe(seabank);
    const cats = await prisma.txCategory.findMany();
    expect(extractTransaction("transfer dari seabank ke saldo shopee 200rb", banks, cats).toAccountId).toBe(shopeepay);
  });

  it("transfer Seabank → ShopeePay 200rb dibukukan = sisihan Cak Ed + Jojo, beban kompensasi, bukti ikut", async () => {
    const day = freshDay();
    const t = await transfer(day, 200_000, shopeepay);
    const { journal } = await approveAndBook(t.id, owner);
    const entries = await prisma.reserveEntry.findMany({ where: { transactionId: t.id } });
    expect(entries.length).toBe(ownerFunds.length);
    expect(entries.every((e) => e.proofPath === t.proofPath && e.journalId === journal.id)).toBe(true);
    const lines = await prisma.journalLine.findMany({ where: { journalId: journal.id }, include: { account: true } });
    expect(Number(lines.find((l) => l.account.code === COA.BEBAN_GAJI_OWNER)?.debit)).toBe(200_000);
    expect(Number(lines.find((l) => l.account.code === COA.UTANG_GAJI_OWNER)?.credit)).toBe(200_000);
    // Batal = sisihan ikut hilang
    await cancelBookedTransaction(t.id, owner, "uji");
    expect(await prisma.reserveEntry.count({ where: { transactionId: t.id } })).toBe(0);
  });

  it("sisihan tanpa bukti yang dicatat dulu memakai transfer ini (jurnal lama dibalik, tidak dobel)", async () => {
    const day = freshDay();
    for (const f of ownerFunds) await postReserve(f.id, day, owner);
    const old = await prisma.reserveEntry.findMany({ where: { fundId: { in: ownerFunds.map((f) => f.id) }, date: new Date(`${day}T00:00:00Z`) } });
    const t = await transfer(day, 200_000, shopeepay);
    await approveAndBook(t.id, owner);
    const now = await prisma.reserveEntry.findMany({ where: { id: { in: old.map((e) => e.id) } } });
    expect(now.every((e) => e.transactionId === t.id && e.proofPath)).toBe(true);
    for (const e of old) expect(await prisma.journal.count({ where: { reversalOfId: e.journalId! } })).toBe(1);
    expect(await prisma.reserveEntry.count({ where: { fundId: { in: ownerFunds.map((f) => f.id) }, date: new Date(`${day}T00:00:00Z`) } })).toBe(ownerFunds.length);
  });

  it("transfer lama ke Saldo Penjual Shopee disinkronkan: rekening tujuan dibetulkan + sisihan + bukti", async () => {
    const day = freshDay();
    const t = await transfer(day, 200_000, saldoShopee, "Ops 5 Nov 26");
    await prisma.financeTransaction.update({ where: { id: t.id }, data: { reserveLink: { skip: true } } });
    await approveAndBook(t.id, owner);
    expect(await prisma.reserveEntry.count({ where: { transactionId: t.id } })).toBe(0);
    await prisma.financeTransaction.update({ where: { id: t.id }, data: { reserveLink: undefined } });
    const r = await linkBookedTransfer(t.id, { toAccountId: shopeepay }, owner);
    expect(r.created + r.absorbed).toBe(ownerFunds.length);
    const after = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.toAccountId).toBe(shopeepay);
    const lines = await prisma.journalLine.findMany({ where: { journalId: after.journalId! }, include: { account: true } });
    expect(lines.some((l) => l.account.code === "1-1203")).toBe(false);
    expect(Number(lines.find((l) => l.account.code === "1-1202")?.debit)).toBe(200_000);
    // Bukti baru ikut ke sisihan
    await attachTransactionProof(t.id, { path: `uji/${tag}-baru.jpg`, mime: "image/jpeg" }, owner);
    expect(await prisma.reserveEntry.count({ where: { transactionId: t.id, proofPath: `uji/${tag}-baru.jpg` } })).toBe(ownerFunds.length);
  });

  it("nabung SPinjam: nominal bebas ke tabungan cicilan, pengeluaran lama diubah jadi transfer", async () => {
    const coa = await prisma.coaAccount.create({ data: { code: `1-19${Math.floor(Math.random() * 90 + 10)}${tag.slice(0, 2)}`, name: `Tabungan uji ${tag}`, type: "ASET", isCash: true } });
    const tab = await prisma.bankAccount.create({ data: { code: `TAB_${tag}`, name: `Seabank Tabungan ${tag}`, coaAccountId: coa.id } });
    const fund = await prisma.reserveFund.create({ data: { name: `Nabung Bayar Hutang ${tag}`, kind: "LOAN_SAVING", dailyAmount: BigInt(300_000), fromBankId: seabank, toBankId: tab.id, storeId: store } });
    try {
      const day = freshDay();
      const m = await reserveOptions(prisma, { amount: 450_000, fromBankId: seabank, toBankId: tab.id, date: day, text: "nabung spinjam" });
      expect(m?.sure).toBe(true);
      expect(m?.options[0].parts).toEqual([{ fundId: fund.id, date: day, amount: 450_000 }]);
      const t = await transfer(day, 450_000, tab.id, "nabung spinjam");
      await approveAndBook(t.id, owner);
      expect(Number((await prisma.reserveEntry.findFirstOrThrow({ where: { transactionId: t.id } })).amount)).toBe(450_000);
      // Pengeluaran "nabung spinjam" (salah dicatat keluar) → transfer ke tabungan + sisihan
      const day2 = freshDay();
      const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Beban Lain-lain" } });
      const { transaction: k } = await createTransaction({ direction: "KELUAR", amount: 300_000, date: jakartaDateTime(day2, "10:00"), accountId: seabank, categoryId: cat.id, note: "nabung spinjam", proofPath: `uji/${tag}-k.jpg`, proofMime: "image/jpeg" }, "TELEGRAM", owner);
      await approveAndBook(k.id, owner);
      await linkBookedTransfer(k.id, { toAccountId: tab.id }, owner);
      const k2 = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: k.id }, include: { reserveEntries: true } });
      expect(k2.direction).toBe("TRANSFER");
      expect(k2.reserveEntries[0]?.proofPath).toBe(`uji/${tag}-k.jpg`);
    } finally {
      await prisma.reserveFund.update({ where: { id: fund.id }, data: { active: false } });
    }
  });
});
