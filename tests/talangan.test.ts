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
import { repayTalangan, talanganSummary, talanganReminderText } from "@/lib/talangan";
import { jakartaDateTime, todayStr } from "@/lib/time";

const TG = 777031;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 700_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);

let owner: { id: string; name: string };
let seabank: string;
let shopeepay: string;
const wallet = async () => (await talanganSummary()).find((w) => w.bank.id === shopeepay)!;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  shopeepay = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } })).id;
  await prisma.setting.upsert({ where: { key: "talangan_mulai" }, create: { key: "talangan_mulai", value: "2026-11-01" }, update: { value: "2026-11-01" } });
});

describe("Dana talangan", () => {
  it("pengeluaran dari ShopeePay = talangan; pengembalian dari Seabank menutupnya; batal = tidak dihitung", async () => {
    const before = await wallet();
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Beban Lain-lain" } });
    const amt = 37_000 + (Date.now() % 900);
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: amt, date: jakartaDateTime(todayStr(), "09:00"), accountId: shopeepay, categoryId: cat.id, note: "beli galon talangan uji" }, "TELEGRAM", owner);
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { status: "MENUNGGU_KONFIRMASI" } });
    await approveAndBook(transaction.id, owner);
    const w = await wallet();
    expect(w.total - before.total).toBe(amt);
    expect(w.open.some((i) => i.ref === transaction.number)).toBe(true);
    expect(talanganReminderText([w], (s) => s)).toContain(transaction.number);
    await expect(repayTalangan({ walletId: shopeepay, amount: w.outstanding + 1, date: todayStr() }, "MANUAL", owner)).rejects.toThrow("melebihi");
    const r = await repayTalangan({ walletId: shopeepay, amount: amt, date: todayStr(), proofPath: "uji/talangan.jpg", proofMime: "image/jpeg" }, "MANUAL", owner);
    expect(r.transaction.bailoutRepay).toBe(true);
    if (r.booked) {
      const after = await wallet();
      expect(after.repaid - w.repaid).toBe(amt);
      // Pengembalian bukan sisihan
      expect(await prisma.reserveEntry.count({ where: { transactionId: r.transaction.id } })).toBe(0);
      await cancelBookedTransaction(r.transaction.id, owner, "uji");
    }
    await cancelBookedTransaction(transaction.id, owner, "uji");
    expect((await wallet()).items.some((i) => i.ref === transaction.number)).toBe(false);
  });

  it("bot: transfer ke ShopeePay berketerangan talangan → konfirmasi pengembalian → dibukukan", async () => {
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Beban Lain-lain" } });
    const amt = 41_000 + (Date.now() % 700);
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: amt, date: jakartaDateTime(todayStr(), "09:30"), accountId: shopeepay, categoryId: cat.id, note: "uji talangan bot" }, "TELEGRAM", owner);
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { status: "MENUNGGU_KONFIRMASI" } });
    await approveAndBook(transaction.id, owner);
    await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
    sent.length = 0;
    await say(`transfer dari seabank ke shopeepay ${amt} kembalikan talangan`);
    const s = await prisma.botSession.findUnique({ where: { chatId: String(TG) } });
    expect(s?.flow).toBe("tlg");
    expect(s?.step).toBe("confirm");
    expect(sent.at(-1)?.text).toContain("Pengembalian dana talangan");
    await tap("f:ok");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { bailoutRepay: true }, orderBy: { createdAt: "desc" } });
    expect(Number(t.amount)).toBe(amt);
    expect(t.accountId).toBe(seabank);
    expect(sent.at(-1)?.text).toMatch(/dibukukan|ditinjau/);
    // Menu & pengingat: tombol mulai isian pengembalian
    sent.length = 0;
    await tap("f:start:tlg");
    expect(sent.at(-1)?.text).toMatch(/talangan/i);
  });
});
