import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createPurchase, cancelPurchase } from "@/lib/purchase";
import { closePurchase, receivePurchase } from "@/lib/purchaseReceive";
import { addShiftReceipt } from "@/lib/shiftReceipt";
import { locationSettings, qtyAt } from "@/lib/stock";
import { approveAndBook, createTransaction } from "@/lib/finance";
import { bpjsAmount } from "@/lib/payroll";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
let raw: string;
let bankId: string;
let divisionId: string;
const at = (d: string, t = "10:00") => jakartaDateTime(d, t);
/** Saldo akun dari jurnal pesanan ini (debit − kredit) */
const net = async (code: string, ref: string) => {
  const ls = await prisma.journalLine.findMany({ where: { account: { code }, journal: { OR: [{ sourceId: ref }, { description: { contains: ref } }] } } });
  return ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
};

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  raw = (await locationSettings(prisma)).raw!;
  bankId = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  divisionId = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } })).id;
});

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const mkItem = (sku: string) => prisma.item.create({ data: { sku: `${sku}-${tag}`, name: `Bahan ${sku}`, type: "BAHAN_BAKU", unit: "sak", divisionId } });
const base = { supplierId: null, newSupplierName: "Toko Online Uji", note: null };

describe("Pesanan dalam pengiriman", () => {
  it("bayar di muka: uang muka dulu, stok masuk saat diterima (sebagian), sisa tidak datang jadi piutang refund", async () => {
    const it = await mkItem("BB-KRM-UJI-1");
    const p = await createPurchase({ ...base, storeId, date: at("2027-07-01"), term: "LUNAS", paidNow: 0, bankAccountId: bankId, inTransit: true, lines: [{ itemId: it.id, qty: 10, amount: 1_000_000 }] }, actor);
    expect(p.delivery).toBe("MENUNGGU");
    expect(await qtyAt(prisma, it.id, raw)).toBe(0);
    expect(await net("1-1510", p.number)).toBe(1_000_000);
    expect(await net("1-1401", p.number)).toBe(0);

    const line = await prisma.purchaseLine.findFirstOrThrow({ where: { purchaseId: p.id } });
    const r1 = await receivePurchase({ purchaseId: p.id, date: at("2027-07-03"), lines: [{ lineId: line.id, qty: 6 }] }, actor);
    expect(r1.done).toBe(false);
    expect(r1.value).toBe(600_000);
    expect(r1.payable).toBeNull();
    expect(await qtyAt(prisma, it.id, raw)).toBe(6);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: p.id } })).delivery).toBe("SEBAGIAN");
    await expect(receivePurchase({ purchaseId: p.id, date: at("2027-07-04"), lines: [{ lineId: line.id, qty: 5 }] }, actor)).rejects.toThrow(/melebihi sisa/);
    await expect(cancelPurchase(p.id, "salah", actor)).rejects.toThrow(/Tutup pesanan/);

    const c = await closePurchase(p.id, "stok penjual habis", actor, at("2027-07-05"));
    expect(c.refund).toBe(400_000);
    expect(c.receivable).not.toBeNull();
    const after = await prisma.purchase.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.delivery).toBe("DITUTUP");
    expect(Number(after.paidNow - after.prepaidUsed)).toBe(0);
  });

  it("COD: tanpa jurnal di awal, dibayar dari rekening saat barang datang", async () => {
    const it = await mkItem("BB-KRM-UJI-2");
    const p = await createPurchase({ ...base, storeId, date: at("2027-07-01"), term: "TEMPO", paidNow: 0, inTransit: true, cod: true, lines: [{ itemId: it.id, qty: 4, amount: 200_000 }] }, actor);
    expect(p.journalId).toBeNull();
    const line = await prisma.purchaseLine.findFirstOrThrow({ where: { purchaseId: p.id } });
    await expect(receivePurchase({ purchaseId: p.id, date: at("2027-07-02"), lines: [{ lineId: line.id, qty: 4 }] }, actor)).rejects.toThrow(/COD/);
    const r = await receivePurchase({ purchaseId: p.id, date: at("2027-07-02"), lines: [{ lineId: line.id, qty: 4 }], bankAccountId: bankId }, actor);
    expect(r.done).toBe(true);
    expect(Number(r.receipt.codPaid)).toBe(200_000);
    expect(Number((await prisma.purchase.findUniqueOrThrow({ where: { id: p.id } })).codPaid)).toBe(200_000);
    expect(await qtyAt(prisma, it.id, raw)).toBe(4);
    // Sudah ada penerimaan: tidak bisa dibatalkan begitu saja (jurnal penerimaan tidak ikut terbalik)
    await expect(cancelPurchase(p.id, "salah", actor)).rejects.toThrow(/sudah ada barang yang diterima/);
  });

  it("belum dibayar: nilai barang yang datang jadi hutang supplier; bisa divalidasi dari barang masuk laporan shift", async () => {
    const it = await mkItem("BB-KRM-UJI-3");
    const p = await createPurchase({ ...base, storeId, date: at("2027-07-01"), term: "TEMPO", paidNow: 0, inTransit: true, dueDate: at("2027-08-01"), lines: [{ itemId: it.id, qty: 5, amount: 250_000 }] }, actor);
    const line = await prisma.purchaseLine.findFirstOrThrow({ where: { purchaseId: p.id } });
    const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-07-06"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [] } });
    const x = await addShiftReceipt(rep.id, { itemId: it.id, qty: 5, purchaseLineId: line.id }, actor, at("2027-07-06", "11:00"));
    const sr = await prisma.shiftReceipt.findUniqueOrThrow({ where: { id: x.id } });
    expect(sr.purchaseId).toBe(p.id);
    const rc = await prisma.purchaseReceipt.findFirstOrThrow({ where: { purchaseId: p.id } });
    expect(rc.shiftReceiptId).toBe(x.id);
    expect(Number(rc.toPayable)).toBe(250_000);
    const pay = await prisma.payable.findUniqueOrThrow({ where: { id: rc.payableId! } });
    expect(Number(pay.amount)).toBe(250_000);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: p.id } })).delivery).toBe("DITERIMA");
    expect(await qtyAt(prisma, it.id, raw)).toBe(5);
  });
});

describe("BPJS Ketenagakerjaan", () => {
  it("nominal per karyawan / bawaan, dan setoran wajib menyebut karyawan", async () => {
    expect(bpjsAmount({ bpjsTk: false, bpjsTkAmount: null }, 28400)).toBe(0);
    expect(bpjsAmount({ bpjsTk: true, bpjsTkAmount: null }, 28400)).toBe(28400);
    expect(bpjsAmount({ bpjsTk: true, bpjsTkAmount: BigInt(30000) }, 28400)).toBe(30000);
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "BPJS Ketenagakerjaan" } });
    const emp = await prisma.employee.findFirstOrThrow();
    const date = at("2027-07-10");
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: 28_400, date, accountId: bankId, categoryId: cat.id, storeId }, "TELEGRAM", actor);
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { status: "MENUNGGU_KONFIRMASI" } });
    await expect(approveAndBook(transaction.id, actor)).rejects.toThrow(/BPJS/);
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { bpjsEmployeeIds: [emp.id] } });
    const ok = await approveAndBook(transaction.id, actor);
    expect(ok.transaction.status).toBe("DIBUKUKAN");
  });
});
