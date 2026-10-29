import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createTransaction, approveAndBook, submitForConfirmation, rejectTransaction, updateTransaction, bankBalances } from "@/lib/finance";
import { profitLoss, balanceSheet, closePeriod, postJournal, cashFlow, COA, reverseJournal } from "@/lib/accounting";
import { recordMovement, postProductionStock, itemTotals, inventoryValuation, locationSettings } from "@/lib/stock";
import { computePeriod, approvePeriod, payPeriod } from "@/lib/payroll";
import { jakartaDateTime, dateOnly, monthRange } from "@/lib/time";

let actor: { id: string; name: string };
let bank: Record<string, string>;
let cat: Record<string, string>;
let storeId: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
  actor = { id: u.id, name: u.name };
  bank = Object.fromEntries((await prisma.bankAccount.findMany()).map((b) => [b.code, b.id]));
  cat = Object.fromEntries((await prisma.txCategory.findMany()).map((c) => [c.name, c.id]));
  storeId = (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id;
});

const d = (s: string) => jakartaDateTime(s, "10:00");

describe("Finance Inbox → pembukuan", () => {
  it("draft manual tidak membuat jurnal sampai disetujui", async () => {
    const { transaction: t } = await createTransaction({ direction: "MASUK", amount: 1_000_000, date: d("2026-09-02"), accountId: bank.SEABANK, categoryId: cat["Penjualan Produk"], storeId }, "MANUAL", actor);
    expect(t.status).toBe("DRAFT");
    expect(await prisma.journal.count({ where: { sourceId: t.id } })).toBe(0);
    await expect(approveAndBook(t.id, actor)).rejects.toThrow(/Menunggu Konfirmasi/);
    await submitForConfirmation(t.id, actor);
    const { journal } = await approveAndBook(t.id, actor);
    const lines = await prisma.journalLine.findMany({ where: { journalId: journal.id } });
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(1_000_000);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(1_000_000);
    await expect(approveAndBook(t.id, actor)).rejects.toThrow(/sudah dibukukan/);
    const logs = await prisma.approvalLog.findMany({ where: { transactionId: t.id } });
    expect(logs.map((l) => l.action)).toEqual(["DIBUAT", "DIAJUKAN", "DISETUJUI_DIBUKUKAN"]);
  });

  it("deteksi duplikat → Perlu Ditinjau", async () => {
    const input = { direction: "KELUAR" as const, amount: 350_000, date: d("2026-09-03"), accountId: bank.SEABANK, categoryId: cat["Listrik, Air & Gas"], storeId };
    const a = await createTransaction(input, "AI", actor);
    expect(a.transaction.status).toBe("MENUNGGU_KONFIRMASI");
    const b = await createTransaction({ ...input, date: d("2026-09-04") }, "AI", actor);
    expect(b.transaction.status).toBe("PERLU_DITINJAU");
    expect(b.transaction.duplicateOfId).toBe(a.transaction.id);
    await rejectTransaction(b.transaction.id, actor, "duplikat");
    await expect(updateTransaction(b.transaction.id, { amount: 1 }, actor)).rejects.toThrow();
  });

  it("idempotency key mencegah draft ganda", async () => {
    const input = { direction: "KELUAR" as const, amount: 77_000, date: d("2026-09-05"), accountId: bank.KAS, categoryId: cat["Transport"], idempotencyKey: "hermes-abc-123" };
    const a = await createTransaction(input, "AI", actor);
    const b = await createTransaction(input, "AI", actor);
    expect(b.replayed).toBe(true);
    expect(b.transaction.id).toBe(a.transaction.id);
  });

  it("transfer internal bukan pendapatan atau beban", async () => {
    const before = await profitLoss({});
    const { transaction: t } = await createTransaction({ direction: "TRANSFER", amount: 400_000, date: d("2026-09-06"), accountId: bank.SEABANK, toAccountId: bank.SHOPEEPAY, categoryId: cat["Penjualan Produk"], storeId }, "MANUAL", actor, { submit: true });
    expect(t.categoryId).toBeNull();
    await approveAndBook(t.id, actor);
    const after = await profitLoss({});
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.totalRevenue).toBe(before.totalRevenue);
    const bal = await bankBalances();
    expect(bal.find((b) => b.code === "SHOPEEPAY")!.balance).toBe(400_000);
    const cf = await cashFlow({ start: d("2026-09-06"), end: d("2026-09-07") });
    expect(cf.operating + cf.investing + cf.financing).toBe(0);
  });

  it("transfer ke rekening yang sama ditolak saat dibukukan", async () => {
    const { transaction: t } = await createTransaction({ direction: "TRANSFER", amount: 1000, date: d("2026-09-06"), accountId: bank.KAS, toAccountId: bank.KAS, storeId }, "MANUAL", actor);
    await expect(submitForConfirmation(t.id, actor)).rejects.toThrow(/berbeda/);
  });

  it("neraca seimbang", async () => {
    const bs = await balanceSheet(new Date("2027-01-01"));
    expect(bs.balanced).toBe(true);
  });
});

describe("Tutup buku & audit", () => {
  it("periode tertutup menolak pembukuan", async () => {
    await closePeriod(2026, 8, actor);
    await expect(
      postJournalTx(new Date("2026-08-15T03:00:00Z")),
    ).rejects.toThrow(/sudah ditutup/);
    const again = await closePeriod(2026, 8, actor);
    expect(again.alreadyClosed).toBe(true);
  });

  it("penyusutan aset diposting saat tutup buku", async () => {
    await prisma.fixedAsset.create({ data: { name: "Oven", storeId, acquiredAt: new Date("2026-06-01"), cost: BigInt(2_400_000), usefulLifeMonths: 24 } });
    const r = await closePeriod(2026, 7, actor);
    expect(r.depreciation).toBe(100_000);
  });

  it("audit log append-only & jurnal tidak bisa diubah", async () => {
    const log = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: log.id }, data: { action: "X" } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
    const j = await prisma.journal.findFirstOrThrow();
    await expect(prisma.journal.update({ where: { id: j.id }, data: { description: "ubah" } })).rejects.toThrow();
  });

  it("koreksi lewat jurnal pembalik", async () => {
    const j = await prisma.$transaction((tx) => postJournal(tx, { date: d("2026-09-10"), storeId, description: "uji", source: "MANUAL", actor, lines: [{ accountCode: COA.BEBAN_TRANSPORT, debit: 5000 }, { accountCode: COA.KAS, credit: 5000 }] }));
    const r = await prisma.$transaction((tx) => reverseJournal(tx, j.id, d("2026-09-10"), actor, "salah input"));
    expect(r.reversalOfId).toBe(j.id);
    await expect(prisma.$transaction((tx) => reverseJournal(tx, j.id, d("2026-09-10"), actor, "lagi"))).rejects.toThrow(/sudah pernah/);
  });
});

function postJournalTx(date: Date) {
  return prisma.$transaction((tx) => postJournal(tx, { date, storeId, description: "uji", source: "MANUAL", actor, lines: [{ accountCode: COA.KAS, debit: 1000 }, { accountCode: COA.MODAL, credit: 1000 }] }));
}

describe("Stok & produksi terintegrasi", () => {
  it("cetak mengonsumsi bahan sesuai BOM, barang jadi masuk gudang", async () => {
    const locs = await locationSettings(prisma);
    const gyp = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-GYP" } });
    const pls = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-PLS" } });
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: gyp.id, qty: 100, toLocationId: locs.raw, unitCost: 5000 }, actor);
      await recordMovement(tx, { type: "PENERIMAAN", itemId: pls.id, qty: 1000, toLocationId: locs.raw, unitCost: 150 }, actor);
    });
    await expect(prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: gyp.id, qty: 99999, fromLocationId: locs.raw }, actor))).rejects.toThrow(/tidak cukup/);

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const base = { date: dateOnly("2026-09-15"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: product.id, createdBy: "uji" };
    const e1 = await prisma.productionEntry.create({ data: { ...base, stage: "CETAK", qtyGood: 90, qtyReject: 10 } });
    await prisma.$transaction((tx) => postProductionStock(tx, e1.id, actor));
    const totals = await itemTotals();
    expect(totals.get(gyp.id)).toBeCloseTo(100 - 0.08 * 100, 5);
    expect(totals.get(pls.id)).toBe(1000 - 100);
    const e2 = await prisma.productionEntry.create({ data: { ...base, stage: "BARANG_JADI", qtyGood: 80, qtyReject: 0 } });
    await prisma.$transaction((tx) => postProductionStock(tx, e2.id, actor));
    const fin = await prisma.item.findUniqueOrThrow({ where: { sku: "BJ-SAT-COWOK" } });
    expect((await itemTotals()).get(fin.id)).toBe(80);
    // posting ulang tidak menggandakan
    await prisma.$transaction((tx) => postProductionStock(tx, e2.id, actor));
    expect((await itemTotals()).get(fin.id)).toBe(80);
    const val = await inventoryValuation();
    expect(val.byType.BARANG_JADI).toBeGreaterThan(0);
    const bs = await balanceSheet(new Date("2027-01-01"));
    expect(bs.balanced).toBe(true);
  });
});

describe("Penggajian → keuangan", () => {
  it("hitung, setujui, bayar membuat jurnal beban gaji", async () => {
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K004" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    for (const day of ["2026-09-21", "2026-09-22"]) {
      await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly(day), status: "HADIR", validated: true } });
    }
    await prisma.productionEntry.create({ data: { date: dateOnly("2026-09-21"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: product.id, stage: "ASSEMBLING", qtyGood: 100, createdBy: "uji" } });
    await prisma.transportTrip.create({ data: { employeeId: emp.id, date: dateOnly("2026-09-22"), amount: BigInt(20000) } });
    const p = await prisma.payrollPeriod.create({ data: { code: "UJI-2026-09", startDate: dateOnly("2026-09-21"), endDate: dateOnly("2026-09-27") } });
    await computePeriod(p.id, actor);
    const slip = await prisma.payslip.findUniqueOrThrow({ where: { periodId_employeeId: { periodId: p.id, employeeId: emp.id } } });
    expect(Number(slip.total)).toBe(2 * 50000 + 100 * 200 + 20000);
    await expect(payPeriod(p.id, bank.KAS, storeId, actor)).rejects.toThrow(/disetujui/);
    await approvePeriod(p.id, actor);
    const j = await payPeriod(p.id, bank.KAS, storeId, actor, d("2026-09-28"));
    const pl = await profitLoss({ start: monthRange(2026, 9).start, end: monthRange(2026, 9).end });
    expect(pl.expenses.find((e) => e.code === COA.BEBAN_TRANSPORT)?.amount).toBeGreaterThanOrEqual(20000);
    expect(j.number).toMatch(/^JU-/);
  });
});

describe("Aturan bisnis: gaji bulanan, kasbon, borongan, pembelian, sisihan", () => {
  it("slip bulanan otomatis H+7, kasbon dipotong, resign = Rp0", async () => {
    const { generateMonthlyPayroll, giveAdvance } = await import("@/lib/payroll");
    await prisma.setting.upsert({ where: { key: "go_live_date" }, create: { key: "go_live_date", value: "" }, update: { value: "" } });
    const div = await prisma.division.findFirstOrThrow();
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const a = await prisma.employee.create({ data: { code: "B001", name: "Bulanan A", divisionId: div.id, position: "Staf", wageType: "BULANAN", monthlySalary: BigInt(2_600_000), joinDate: dateOnly("2026-05-10") } });
    const b = await prisma.employee.create({ data: { code: "B002", name: "Bulanan B", divisionId: div.id, position: "Staf", wageType: "BULANAN", monthlySalary: BigInt(2_600_000), joinDate: dateOnly("2026-05-10"), resignDate: dateOnly("2026-11-12") } });
    // A hadir semua kecuali 2 hari di minggu pertama (1 libur + 1 bolos)
    for (let i = 0; i < 31; i++) {
      const day = new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10);
      if (i === 1 || i === 2) continue;
      await prisma.attendance.create({ data: { employeeId: a.id, shiftId: shift.id, date: dateOnly(day), status: "HADIR", validated: true } });
    }
    await giveAdvance({ employeeId: a.id, amount: 500_000, installment: 200_000, bankAccountId: bank.SEABANK, storeId, date: "2026-10-20" }, actor);
    const r = await generateMonthlyPayroll(actor, d("2026-11-10"));
    expect(r.created).toEqual(["GJB-20261109"]);
    expect((await generateMonthlyPayroll(actor, d("2026-11-11"))).created).toEqual([]);
    const p = await prisma.payrollPeriod.findUniqueOrThrow({ where: { code: "GJB-20261109" }, include: { payslips: true } });
    expect(p.payDate?.toISOString().slice(0, 10)).toBe("2026-11-17");
    const sa = p.payslips.find((x) => x.employeeId === a.id)!;
    expect(sa).toMatchObject({ offDays: 1, absentDays: 1 });
    expect(Number(sa.deduction)).toBe(100_000);
    expect(Number(sa.advanceDeduction)).toBe(200_000);
    expect(Number(sa.total)).toBe(2_600_000 - 100_000 - 200_000);
    expect(Number(p.payslips.find((x) => x.employeeId === b.id)!.total)).toBe(0);
    await approvePeriod(p.id, actor);
    await payPeriod(p.id, bank.SEABANK, storeId, actor, d("2026-11-17"));
    const adv = await prisma.cashAdvance.findFirstOrThrow({ where: { employeeId: a.id } });
    expect(Number(adv.repaid)).toBe(200_000);
    const bs = await balanceSheet(new Date("2027-01-01"));
    expect(bs.balanced).toBe(true);
  });

  it("klaim borongan per piece", async () => {
    const { createPieceClaim } = await import("@/lib/payroll");
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K003" } });
    const task = await prisma.pieceTask.findUniqueOrThrow({ where: { code: "CAT_GIFTBOX" } });
    const plastik = await prisma.pieceTask.findUniqueOrThrow({ where: { code: "CAT_PLASTIK" } });
    await prisma.pieceWork.create({ data: { employeeId: emp.id, taskId: task.id, date: dateOnly("2026-10-05"), qty: 300, rate: task.ratePerPcs, amount: task.ratePerPcs * BigInt(300), createdBy: "uji" } });
    await prisma.pieceWork.create({ data: { employeeId: emp.id, taskId: plastik.id, date: dateOnly("2026-10-06"), qty: 1000, rate: plastik.ratePerPcs, amount: plastik.ratePerPcs * BigInt(1000), createdBy: "uji" } });
    const p = await createPieceClaim(emp.id, "2026-10-06", actor);
    const slip = await prisma.payslip.findFirstOrThrow({ where: { periodId: p.id } });
    expect(Number(slip.total)).toBe(300 * 100 + 1000 * 15);
    await expect(createPieceClaim(emp.id, "2026-10-06", actor)).rejects.toThrow(/belum diklaim/);
  });

  it("pembelian bertahap: stok masuk, DP keluar, sisa jadi utang", async () => {
    const { createPurchase } = await import("@/lib/purchase");
    const item = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-GYP" } });
    const p = await createPurchase({ storeId, vendor: "Supplier Uji", date: d("2026-10-07"), term: "BERTAHAP", paidNow: 100_000, bankAccountId: bank.SEABANK, dueDate: d("2026-11-07"), lines: [{ itemId: item.id, qty: 100, unitCost: 4500 }] }, actor);
    expect(Number(p.total)).toBe(450_000);
    const pay = await prisma.payable.findUniqueOrThrow({ where: { id: p.payableId! } });
    expect(Number(pay.amount)).toBe(350_000);
    expect(await prisma.stockMovement.count({ where: { ref: p.number } })).toBe(1);
  });

  it("sisihan owner harian & analitik", async () => {
    const { postAllReserves, withdrawReserve, fundBalance } = await import("@/lib/reserve");
    const { businessSnapshot, ruleInsights } = await import("@/lib/analytics");
    const r = await postAllReserves("2026-10-08", actor);
    expect(r).toEqual({ count: 2, total: 200_000 });
    expect((await postAllReserves("2026-10-08", actor)).count).toBe(0);
    const fund = await prisma.reserveFund.findFirstOrThrow({ where: { kind: "OWNER" } });
    await withdrawReserve(fund.id, 100_000, "2026-10-09", actor);
    expect(await fundBalance(prisma, fund.id)).toBe(0);
    const pl = await profitLoss({ start: monthRange(2026, 10).start, end: monthRange(2026, 10).end });
    expect(pl.expenses.find((e) => e.code === COA.BEBAN_GAJI_OWNER)?.amount).toBe(200_000);
    const s = await businessSnapshot(d("2026-10-15"));
    expect(s.series).toHaveLength(12);
    expect(ruleInsights(s).length).toBeGreaterThan(0);
  });
});

describe("Tunjangan, go-live, saldo rekening, HPP realtime", () => {
  it("go-live: siklus pertama tanpa data absen dibayar penuh", async () => {
    const { generateMonthlyPayroll } = await import("@/lib/payroll");
    await prisma.setting.upsert({ where: { key: "go_live_date" }, create: { key: "go_live_date", value: "2026-12-20" }, update: { value: "2026-12-20" } });
    const div = await prisma.division.findFirstOrThrow();
    const e = await prisma.employee.create({ data: { code: "G001", name: "Go Live", divisionId: div.id, position: "Staf", wageType: "BULANAN", monthlySalary: BigInt(3_000_000), joinDate: dateOnly("2026-06-03") } });
    const r = await generateMonthlyPayroll(actor, d("2026-12-03"));
    expect(r.created).toContain("GJB-20261202");
    const slip = await prisma.payslip.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(slip).toMatchObject({ absentDays: 0 });
    expect(Number(slip.total)).toBe(3_000_000);
    expect(slip.note).toMatch(/go-live/);
    await prisma.setting.update({ where: { key: "go_live_date" }, data: { value: "" } });
  });

  it("tunjangan karyawan tertentu dibayar tiap tanggal 15", async () => {
    const { generateAllowancePayroll } = await import("@/lib/payroll");
    const a = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const b = await prisma.employee.findUniqueOrThrow({ where: { code: "K003" } });
    await prisma.employeeAllowance.createMany({ data: [{ employeeId: a.id, name: "Tunjangan jabatan", amount: BigInt(300_000) }, { employeeId: a.id, name: "Tunjangan makan", amount: BigInt(200_000) }, { employeeId: b.id, name: "Nonaktif", amount: BigInt(100_000), active: false }] });
    expect((await generateAllowancePayroll(actor, d("2027-01-14"))).created).toBeNull();
    expect((await generateAllowancePayroll(actor, d("2027-01-15"))).created).toBe("TNJ-202701");
    expect((await generateAllowancePayroll(actor, d("2027-01-20"))).created).toBeNull();
    const p = await prisma.payrollPeriod.findUniqueOrThrow({ where: { code: "TNJ-202701" }, include: { payslips: true } });
    expect(p.kind).toBe("TUNJANGAN");
    expect(p.payslips).toHaveLength(1);
    expect(Number(p.payslips[0].total)).toBe(500_000);
    expect(p.payslips[0].allowanceDetail).toHaveLength(2);
    await approvePeriod(p.id, actor);
    const j = await payPeriod(p.id, bank.SEABANK, storeId, actor, d("2027-01-15"));
    const lines = await prisma.journalLine.findMany({ where: { journalId: (j as unknown as { id: string }).id } });
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(500_000);
  });

  it("atur saldo rekening: selisih dibukukan ke ekuitas saldo awal", async () => {
    const { bankBalancesAt, balanceAdjustmentLines } = await import("@/lib/finance");
    const before = await bankBalancesAt("2027-01-31");
    const sp = before.find((b) => b.code === "SHOPEEPAY")!;
    const lines = balanceAdjustmentLines([{ coaAccountId: sp.coaAccountId, name: sp.name, book: sp.balance, actual: sp.balance + 1_234_000 }]);
    await prisma.$transaction((tx) => postJournal(tx, { date: d("2027-01-31"), storeId, description: "Penyesuaian saldo rekening", source: "SALDO_AWAL", actor, lines }));
    const after = await bankBalancesAt("2027-01-31");
    expect(after.find((b) => b.code === "SHOPEEPAY")!.balance).toBe(sp.balance + 1_234_000);
    const cf = await cashFlow({ start: monthRange(2027, 1).start, end: monthRange(2027, 1).end });
    expect([...cf.groups.OPERASI, ...cf.groups.INVESTASI, ...cf.groups.PENDANAAN].some((x) => x.amount === 1_234_000)).toBe(false);
    expect((await balanceSheet(new Date("2027-02-01"))).balanced).toBe(true);
  });

  it("HPP realtime: beli per sak, resep per gram, harga terbaru & tren", async () => {
    const { createPurchase } = await import("@/lib/purchase");
    const { productCosting } = await import("@/lib/hpp");
    const item = await prisma.item.create({ data: { sku: "BB-UJI-SAK", name: "Gypsum uji", type: "BAHAN_BAKU", unit: "sak", hppUnit: "gram", hppFactor: 18000 } });
    const prod = await prisma.product.findUniqueOrThrow({ where: { sku: "MG-SAT-COWOK" } });
    await prisma.bomLine.create({ data: { productId: prod.id, itemId: item.id, qty: 90 } });
    await createPurchase({ storeId, vendor: "Supplier Sak", date: d("2027-02-01"), term: "LUNAS", paidNow: 430_000, bankAccountId: bank.SEABANK, lines: [{ itemId: item.id, qty: 10, unitCost: 43_000 }] }, actor);
    let it1 = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(it1.lastCost)).toBe(43_000);
    let c = await productCosting(prod.id);
    let line = c.lines.find((l) => l.item.id === item.id)!;
    expect(line.unit).toBe("gram");
    expect(line.cost).toBeCloseTo((90 / 18000) * 43_000, 6);
    expect(line.trend.dir).toBe("TETAP");
    await createPurchase({ storeId, vendor: "Supplier Sak", date: d("2027-02-10"), term: "LUNAS", paidNow: 450_000, bankAccountId: bank.SEABANK, lines: [{ itemId: item.id, qty: 10, unitCost: 45_000 }] }, actor);
    it1 = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([Number(it1.prevCost), Number(it1.lastCost)]).toEqual([43_000, 45_000]);
    c = await productCosting(prod.id);
    line = c.lines.find((l) => l.item.id === item.id)!;
    expect(line.cost).toBeCloseTo(225, 6);
    expect(line.trend.dir).toBe("NAIK");
    expect(c.trend.dir).toBe("NAIK");
    // pembelian mundur tanggal tidak menimpa harga terbaru
    await createPurchase({ storeId, vendor: "Supplier Sak", date: d("2027-02-05"), term: "LUNAS", paidNow: 40_000, bankAccountId: bank.SEABANK, lines: [{ itemId: item.id, qty: 1, unitCost: 40_000 }] }, actor);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).lastCost)).toBe(45_000);
    // konsumsi produksi: 90 gram × 10 unit = 900 gram = 0,05 sak
    const locs = await locationSettings(prisma);
    const before = (await itemTotals()).get(item.id)!;
    const emp = await prisma.employee.findUniqueOrThrow({ where: { code: "K002" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const e = await prisma.productionEntry.create({ data: { date: dateOnly("2027-02-11"), shiftId: shift.id, divisionId: emp.divisionId, employeeId: emp.id, productId: prod.id, stage: "CETAK", qtyGood: 10, qtyReject: 0, createdBy: "uji" } });
    await prisma.$transaction((tx) => postProductionStock(tx, e.id, actor));
    expect(before - (await itemTotals()).get(item.id)!).toBeCloseTo(0.05, 6);
    expect(locs.raw).toBeTruthy();
  });
});
