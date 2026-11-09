import { beforeAll, describe, expect, it, vi } from "vitest";

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
import { approveAndBook, cancelBookedTransaction, createTransaction } from "@/lib/finance";
import { detectManagerLoan, matchAccount } from "@/lib/extract";
import { receiptFromOcrText } from "@/lib/ocrReceiptText";
import { talanganReminderText, talanganSummary } from "@/lib/talangan";
import { jakartaDateTime, todayStr } from "@/lib/time";

describe("Pinjaman pengelola: pengenalan teks", () => {
  it("kata kerja pinjam + nama pengelola = PINJAM; kembali = KEMBALI; cicilan pinjaman bukan", () => {
    expect(detectManagerLoan("Edy pinjam Dana OPS untuk pribadi")).toBe("PINJAM");
    expect(detectManagerLoan("Pinjam ops mas Edy")).toBe("PINJAM");
    expect(detectManagerLoan("dipinjam jojo 200rb")).toBe("PINJAM");
    expect(detectManagerLoan("jojo kembalikan pinjaman 500rb")).toBe("KEMBALI");
    expect(detectManagerLoan("Edy balikin pinjam ops")).toBe("KEMBALI");
    expect(detectManagerLoan("bayar cicilan spinjam ke-4")).toBeNull();
    expect(detectManagerLoan("bayar pinjaman mas rizal")).toBeNull();
    expect(detectManagerLoan("pinjam uang mas rizal")).toBeNull();
    expect(detectManagerLoan("jojo beli galon")).toBeNull();
    expect(detectManagerLoan("budi pinjam", ["budi"])).toBe("PINJAM");
  });
  it("ShopeePay tidak tertukar dengan Saldo Penjual Shopee", () => {
    const accounts = [
      { id: "sp", code: "SHOPEEPAY", name: "ShopeePay", aliases: "shopeepay,spay,shopee pay" },
      { id: "ss", code: "SALDO_SHOPEE", name: "Saldo Penjual Shopee", aliases: "saldo penjual,saldo shopee,penjual shopee", marketplace: true },
      { id: "sb", code: "SEABANK", name: "Seabank - 5984", aliases: "seabank,sea bank,bank" },
    ];
    expect(matchAccount("Saldo ShopeePay", accounts)).toBe("sp");
    expect(matchAccount("saldo shopee", accounts)).toBe("ss");
    expect(matchAccount("wd saldo shopee ke seabank", accounts)).toBe("ss");
    const ocr = receiptFromOcrText("ShopeePay\nRp 1.250.000\nBerhasil\nWaktu Selesai: 08 Nov 2026, 11:30\nDikirim Dari NUR\nKirim Ke EDY TRI JUNIANTO SeaBank\nSumber Dana Saldo ShopeePay", accounts, jakartaDateTime("2026-11-09", "10:00"));
    expect(ocr?.account).toBe("ShopeePay");
  });
});

const TG = 777044;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 800_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);

describe("Pinjaman pengelola: bot, kategori & dana talangan", () => {
  let owner: { id: string; name: string };
  let shopeepay: string;
  const wallet = async () => (await talanganSummary()).find((w) => w.bank.id === shopeepay)!;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    owner = { id: u.id, name: u.name };
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
    shopeepay = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } })).id;
    await prisma.setting.upsert({ where: { key: "talangan_mulai" }, create: { key: "talangan_mulai", value: "2026-11-01" }, update: { value: "2026-11-01" } });
  });

  it("kategori & akun 1-1320 tersedia", async () => {
    const out = await prisma.txCategory.findFirstOrThrow({ where: { name: "Pinjaman Pengelola" }, include: { coaAccount: true } });
    const back = await prisma.txCategory.findFirstOrThrow({ where: { name: "Pengembalian Pinjaman Pengelola" }, include: { coaAccount: true } });
    expect([out.direction, out.coaAccount.code, out.coaAccount.type]).toEqual(["KELUAR", "1-1320", "ASET"]);
    expect([back.direction, back.coaAccount.code]).toEqual(["MASUK", "1-1320"]);
  });

  it("pesan bot 'Edy pinjam dana OPS' = draft Pinjaman Pengelola dari ShopeePay, bukan isian bayar hutang", async () => {
    sent.length = 0;
    await say("Edy pinjam Dana OPS untuk pribadi 1.250.000 dari shopeepay");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { rawText: { contains: "Edy pinjam Dana OPS" } }, orderBy: { createdAt: "desc" } });
    expect(t.direction).toBe("KELUAR");
    expect(Number(t.amount)).toBe(1_250_000);
    expect(t.accountId).toBe(shopeepay);
    expect((await prisma.txCategory.findUniqueOrThrow({ where: { id: t.categoryId! } })).name).toBe("Pinjaman Pengelola");
    expect(t.payableId).toBeNull();
    expect(sent.some((m) => m.text.includes("Bayar hutang / cicilan pinjaman"))).toBe(false);
  });

  it("pinjaman pengelola dari ShopeePay masuk dana talangan; pengembalian pengelola menutupnya, bukan talangan operasional", async () => {
    const out = await prisma.txCategory.findFirstOrThrow({ where: { name: "Pinjaman Pengelola" } });
    const back = await prisma.txCategory.findFirstOrThrow({ where: { name: "Pengembalian Pinjaman Pengelola" } });
    const other = await prisma.txCategory.findFirstOrThrow({ where: { name: "Beban Lain-lain" } });
    const book = async (direction: "MASUK" | "KELUAR", amount: number, categoryId: string, note: string) => {
      const { transaction } = await createTransaction({ direction, amount, date: jakartaDateTime(todayStr(), "09:00"), accountId: shopeepay, categoryId, note }, "MANUAL", owner, { submit: true });
      return (await approveAndBook(transaction.id, owner)).transaction;
    };
    const u = Date.now() % 900;
    const w0 = await wallet();
    const ops = await book("KELUAR", 41_000 + u, other.id, "galon talangan uji pengelola");
    const loan = await book("KELUAR", 300_000 + u, out.id, "Pinjam ops mas Edy");
    let w = await wallet();
    expect(w.total - w0.total).toBe(341_000 + 2 * u);
    expect(w.open.find((i) => i.ref === loan.number)?.label).toBe("Pinjaman pengelola");
    expect(w.managerOutstanding - w0.managerOutstanding).toBe(300_000 + u);
    const text = talanganReminderText([w], (s) => s)!;
    expect(text).toContain("Pengembalian Pinjaman Pengelola");
    expect(text).toContain(loan.number);

    const opsOpen = w.outstanding - w.managerOutstanding;
    // Edy mengembalikan 300rb langsung ke ShopeePay: hanya pinjaman pengelola yang tertutup
    await book("MASUK", 300_000 + u, back.id, "Edy kembalikan pinjam ops");
    w = await wallet();
    expect(w.repaid - w0.repaid).toBe(300_000 + u);
    expect(w.open.some((i) => i.ref === loan.number)).toBe(false);
    expect(w.outstanding - w.managerOutstanding).toBe(opsOpen);
    // Bersihkan: saldo ShopeePay kembali seperti semula untuk tes lain
    await cancelBookedTransaction(ops.id, owner, "uji selesai");
    expect(w.managerOutstanding).toBe(w0.managerOutstanding);
  });
});
