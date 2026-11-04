import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (_c: string, text: string, o: { buttons?: { text: string; callback_data: string }[][] } = {}) => (sent.push({ text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (_c: string, _m: number, text: string, buttons?: { text: string; callback_data: string }[][]) => (sent.push({ text, buttons }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
  };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { approveAndBook, bookPayablePayment, cancelBookedTransaction, createTransaction, reclassifyBooked, submitForConfirmation } from "@/lib/finance";
import { createLoanRecord, nextInstallment, splitPayment } from "@/lib/payables";
import { detectPayablePayment } from "@/lib/botPurchase";
import { COA } from "@/lib/accounting";
import { jakartaDateTime, todayStr } from "@/lib/time";

const TG = 777002;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 500_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const tag = Math.random().toString(36).slice(2, 7);

let owner: { id: string; name: string };
let seabank: string;
let bebanLain: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  bebanLain = (await prisma.txCategory.findFirstOrThrow({ where: { name: "Beban Lain-lain" } })).id;
  // Hutang uji dari jalankan sebelumnya dianggap lunas agar tidak ikut tertebak bot
  await prisma.$executeRaw`UPDATE "Payable" SET paid = amount WHERE note = 'uji-hutang'`;
});
beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

const spinjam = { amount: 20_000_000, paid: 0, installments: 6, interestTotal: 2_639_943 };

describe("Jadwal cicilan pinjaman", () => {
  it("pokok & bunga dibagi rata, sisa pembulatan di cicilan terakhir (contoh SPinjam)", () => {
    expect(nextInstallment(spinjam)).toEqual({ no: 1, principal: 3_333_333, interest: 439_990, total: 3_773_323 });
    const after4 = { ...spinjam, paid: 4 * 3_333_333 };
    expect(nextInstallment(after4)?.no).toBe(5);
    const last = nextInstallment({ ...spinjam, paid: 5 * 3_333_333 })!;
    expect(last.no).toBe(6);
    expect(last.principal).toBe(3_333_335);
    expect(last.interest).toBe(2_639_943 - 439_990 * 5);
    // Nominal cicilan di aplikasi (3.773.324) dikenali walau beda pembulatan 1 rupiah
    expect(splitPayment(after4, 3_773_324)).toEqual({ principal: 3_333_334, interest: 439_990 });
    expect(splitPayment(after4, 1_000_000)).toEqual({ principal: 1_000_000, interest: 0 });
    expect(splitPayment(after4, 1_000_000, 50_000)).toEqual({ principal: 950_000, interest: 50_000 });
    expect(nextInstallment({ amount: 5_000_000, paid: 0, installments: null, interestTotal: null })).toBeNull();
  });

  it("bot mengenali cicilan dari nama pemberi pinjaman atau nominal cicilan", () => {
    const cands = [
      { id: "a", number: "PJM-1", vendor: "Mas Budi Uji", remaining: 9_000_000, purchaseNumber: null, items: [], kind: "PINJAMAN", installment: null },
      { id: "b", number: "PJM-2", vendor: "SPinjam", remaining: 10_000_001, purchaseNumber: null, items: [], kind: "PINJAMAN", installment: 3_773_324 },
    ];
    expect(detectPayablePayment("Bayar hutang mas budi uji (e) Penerima", cands, "KELUAR", 3_000_000)?.matches.map((m) => m.id)).toEqual(["a"]);
    expect(detectPayablePayment("Bayar Cicilan Hutang Spinjam", cands, "KELUAR", 3_773_324)?.matches.map((m) => m.id)).toEqual(["b"]);
    expect(detectPayablePayment("transfer ke rekening tujuan", cands, "KELUAR", 3_773_324)?.matches.map((m) => m.id)).toEqual(["b"]);
    expect(detectPayablePayment("bayar listrik", cands, "KELUAR", 350_000)).toBeNull();
  });
});

describe("Pinjaman modal", () => {
  it("pinjaman lama: sisa pokok jadi hutang dengan lawan Ekuitas Saldo Awal", async () => {
    const p = await createLoanRecord({ lender: `Mbak Uji ${tag}`, amount: 5_000_000, paidBefore: 4_000_000, date: jakartaDateTime("2026-08-01", "12:00"), note: "uji-hutang" }, owner);
    expect(Number(p.amount - p.paid)).toBe(1_000_000);
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: p.journalId! }, include: { lines: { include: { account: true } } } });
    expect(j.lines.map((l) => [l.account.code, Number(l.debit), Number(l.credit)])).toEqual(expect.arrayContaining([[COA.EKUITAS_SALDO_AWAL, 1_000_000, 0], [COA.UTANG_PINJAMAN, 0, 1_000_000]]));
  });

  it("pinjaman baru dipotong biaya pencairan: selisih ke Beban Bunga & Biaya Pinjaman", async () => {
    const p = await createLoanRecord({ lender: `Pinjol Uji ${tag}`, amount: 20_000_000, received: 19_400_000, bankAccountId: seabank, installments: 6, interestTotal: 2_639_943, date: jakartaDateTime(todayStr(), "12:00"), note: "uji-hutang" }, owner);
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: p.journalId! }, include: { lines: { include: { account: true } } } });
    expect(j.lines.find((l) => l.account.code === COA.BEBAN_BUNGA)?.debit).toEqual(BigInt(600_000));
    expect(j.lines.find((l) => l.account.code === COA.UTANG_PINJAMAN)?.credit).toEqual(BigInt(20_000_000));
    // Bayar cicilan lewat menu Akuntansi: tercatat di Transaksi, pokok & bunga terpisah
    const r = await bookPayablePayment({ payableId: p.id, amount: 3_773_323, bankAccountId: seabank, date: jakartaDateTime(todayStr(), "13:00") }, "MANUAL", owner);
    expect(r.interest).toBe(439_990);
    expect(r.transaction.status).toBe("DIBUKUKAN");
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(3_333_333);
    await cancelBookedTransaction(r.transaction.id, owner, "uji batal");
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(0);
  });
});

describe("Bot: cicilan pinjaman berjalan", () => {
  it("pesan 'bayar cicilan <pemberi>' → isian bayar hutang, pokok + bunga otomatis, tercatat di Transaksi", async () => {
    const p = await createLoanRecord({ lender: `Kredit${tag}`, amount: 12_000_000, paidBefore: 6_000_000, installments: 6, interestTotal: 600_000, date: jakartaDateTime("2026-07-08", "12:00"), note: "uji-hutang" }, owner);
    sent.length = 0;
    await say(`bayar cicilan kredit${tag} 2.100.000 dari seabank`);
    const s = await prisma.botSession.findUniqueOrThrow({ where: { chatId: String(TG) } });
    expect(s.flow).toBe("utang");
    expect(s.step).toBe("confirm");
    expect(sent.at(-1)?.text).toContain("bunga/biaya");
    await tap("f:ok");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { payableId: p.id } });
    expect(t.status).toBe("DIBUKUKAN");
    expect(Number(t.payInterest)).toBe(100_000);
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(8_000_000);
    expect(sent.at(-1)?.text).toContain("Sisa hutang");
  });
});

describe("Ubah kategori transaksi dibukukan", () => {
  it("Beban Lain-lain → cicilan pinjaman lalu → kategori lain, sisa hutang mengikuti", async () => {
    const p = await createLoanRecord({ lender: `Mas Uji ${tag}`, amount: 15_000_000, paidBefore: 3_000_000, date: jakartaDateTime("2026-05-01", "12:00"), note: "uji-hutang" }, owner);
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: 3_000_000, date: jakartaDateTime(todayStr(), "09:00"), accountId: seabank, categoryId: bebanLain, note: `Bayar hutang mas uji ${tag}` }, "MANUAL", owner);
    await submitForConfirmation(transaction.id, owner);
    await approveAndBook(transaction.id, owner);
    const before = await prisma.journalLine.aggregate({ where: { account: { code: COA.BEBAN_LAIN } }, _sum: { debit: true, credit: true } });

    await reclassifyBooked(transaction.id, { payableId: p.id }, owner);
    let pay = await prisma.payable.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(pay.amount - pay.paid)).toBe(9_000_000);
    const after = await prisma.journalLine.aggregate({ where: { account: { code: COA.BEBAN_LAIN } }, _sum: { debit: true, credit: true } });
    // Beban lain-lain berkurang 3jt (jurnal pembalik), hutang yang berkurang
    expect(Number(after._sum.debit) - Number(after._sum.credit)).toBe(Number(before._sum.debit) - Number(before._sum.credit) - 3_000_000);
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id }, include: { payable: true } });
    expect(t.payableId).toBe(p.id);
    expect(t.categoryId).toBeNull();

    const iuran = await prisma.txCategory.findFirstOrThrow({ where: { name: "Iuran Lingkungan & Kebersihan" } });
    await reclassifyBooked(transaction.id, { categoryId: iuran.id }, owner);
    pay = await prisma.payable.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(pay.amount - pay.paid)).toBe(12_000_000);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).categoryId).toBe(iuran.id);
    await expect(reclassifyBooked(transaction.id, { categoryId: iuran.id }, owner)).rejects.toThrow("sudah sama");

    // Salah pilih rekening: pindah dari Seabank ke Kas Tunai, kategori & hutang tetap
    const kas = await prisma.bankAccount.findFirstOrThrow({ where: { active: true, id: { not: seabank } }, include: { coaAccount: true } });
    const cashBal = async (code: string) => {
      const a = await prisma.journalLine.aggregate({ where: { account: { code } }, _sum: { debit: true, credit: true } });
      return Number(a._sum.debit) - Number(a._sum.credit);
    };
    const sea = await prisma.bankAccount.findUniqueOrThrow({ where: { id: seabank }, include: { coaAccount: true } });
    const [s0, k0] = [await cashBal(sea.coaAccount.code), await cashBal(kas.coaAccount.code)];
    await reclassifyBooked(transaction.id, { accountId: kas.id }, owner);
    const moved = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(moved.accountId).toBe(kas.id);
    expect(moved.categoryId).toBe(iuran.id);
    expect(await cashBal(sea.coaAccount.code)).toBe(s0 + 3_000_000);
    expect(await cashBal(kas.coaAccount.code)).toBe(k0 - 3_000_000);
    await expect(reclassifyBooked(transaction.id, { accountId: kas.id }, owner)).rejects.toThrow("sudah sama");
  });
});

describe("Satu tabungan cicilan untuk beberapa pinjaman", () => {
  it("pinjaman dipilih saat membayar dari tabungan", async () => {
    const { postReserve, withdrawReserve, fundBalance } = await import("@/lib/reserve");
    const a = await createLoanRecord({ lender: `Tab A ${tag}`, amount: 2_000_000, paidBefore: 0, date: jakartaDateTime(todayStr(), "12:00"), note: "uji-hutang" }, owner);
    const b = await createLoanRecord({ lender: `Tab B ${tag}`, amount: 3_000_000, paidBefore: 0, date: jakartaDateTime(todayStr(), "12:00"), note: "uji-hutang" }, owner);
    const sp = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } });
    const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
    const fund = await prisma.reserveFund.create({ data: { name: `Tabungan uji ${tag}`, kind: "LOAN_SAVING", dailyAmount: BigInt(300_000), fromBankId: seabank, toBankId: sp.id, storeId: store.value } });
    await postReserve(fund.id, todayStr(), owner);
    await withdrawReserve(fund.id, 100_000, todayStr(), owner, null, null, { payableId: a.id });
    await withdrawReserve(fund.id, 150_000, todayStr(), owner, null, null, { payableId: b.id });
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: a.id } })).paid)).toBe(100_000);
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: b.id } })).paid)).toBe(150_000);
    expect(await fundBalance(prisma, fund.id)).toBe(50_000);
    await expect(withdrawReserve(fund.id, 10_000, todayStr(), owner)).rejects.toThrow("Pilih pinjaman");
    // Bayar cicilan langsung dari rekening simpanan (mis. lewat bot): saldo tabungan ikut berkurang, batal = kembali
    const r = await bookPayablePayment({ payableId: a.id, amount: 30_000, bankAccountId: sp.id, date: jakartaDateTime(todayStr(), "14:00") }, "TELEGRAM", owner);
    expect(await fundBalance(prisma, fund.id)).toBe(20_000);
    await cancelBookedTransaction(r.transaction.id, owner, "uji");
    expect(await fundBalance(prisma, fund.id)).toBe(50_000);
    await prisma.reserveFund.update({ where: { id: fund.id }, data: { active: false } });
  });
});

