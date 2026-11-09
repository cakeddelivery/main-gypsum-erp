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
import { approveAndBook, bankBalances, createTransaction } from "@/lib/finance";
import { profitLoss } from "@/lib/accounting";
import { addDays, jakartaDateTime, todayStr } from "@/lib/time";
import { koreksiTanggalWd } from "../scripts/koreksi-tanggal-wd";

const TG = 777055;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 900_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const btns = () => sent.at(-1)?.buttons?.flat() ?? [];

let owner: { id: string; name: string };
let tiktok: string;
let seabank: string;
beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG), canConfirm: true }, update: { active: true, canConfirm: true } });
  const coa = await prisma.coaAccount.upsert({ where: { code: "1-1204" }, create: { code: "1-1204", name: "Saldo Penjual TikTok", type: "ASET", isCash: true }, update: {} });
  tiktok = (await prisma.bankAccount.upsert({ where: { code: "SALDO_TIKTOK" }, create: { code: "SALDO_TIKTOK", name: "Saldo Penjual TikTok", coaAccountId: coa.id, marketplace: true, aliases: "saldo tiktok,penjual tiktok" }, update: {} })).id;
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Bot: WD tanpa tanggal wajib dipastikan tanggalnya", () => {
  it("draft WD TikTok tanpa tanggal: tombol bukukan disembunyikan sampai tanggal dipilih", async () => {
    const amt = 450_000 + (Date.now() % 997);
    sent.length = 0;
    await say(`WD tiktok MG ${amt} ke seabank`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { telegramChatId: String(TG) }, orderBy: { createdAt: "desc" } });
    expect(t).toMatchObject({ direction: "TRANSFER", accountId: tiktok });
    expect(sent.at(-1)?.text).toContain("tidak mencantumkan tanggal");
    expect(btns().some((b) => b.callback_data.startsWith("ok:"))).toBe(false);
    await tap(`ok:${t.id}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).not.toBe("DIBUKUKAN");
    const kemarin = addDays(todayStr(), -1);
    const pickBtn = btns().find((b) => b.callback_data === `dt:${t.id}:${kemarin.replace(/-/g, "")}`);
    expect(pickBtn?.text).toContain("Kemarin");
    await tap(pickBtn!.callback_data);
    const t2 = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(t2.date.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })).toBe(kemarin);
    expect(btns().some((b) => b.callback_data === `ok:${t.id}`)).toBe(true);
    await tap(`ok:${t.id}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DIBUKUKAN");
  });

  it("WD dengan tanggal di keterangan tidak ditanya lagi; semua draft punya tombol 📅 Tanggal", async () => {
    sent.length = 0;
    await say(`WD tiktok DL ${310_000 + (Date.now() % 991)} ke seabank tgl ${addDays(todayStr(), -2).split("-").reverse().join("/")}`);
    expect(sent.at(-1)?.text).not.toContain("tidak mencantumkan tanggal");
    expect(btns().some((b) => b.text.includes("Tanggal"))).toBe(true);
  });
});

describe("Skrip koreksi tanggal WD", () => {
  it("pratinjau tidak mengubah; jalankan = batal + catat ulang di tanggal benar, saldo tetap, penjualan pindah tanggal; aman diulang", async () => {
    const mg = await prisma.store.findUniqueOrThrow({ where: { code: "MG" } });
    const amt = 463_000 + (Date.now() % 251);
    const { transaction } = await createTransaction({ direction: "TRANSFER", amount: amt, date: jakartaDateTime("2026-11-08", "22:49"), accountId: tiktok, toAccountId: seabank, storeId: mg.id, note: "WD tiktok MG" }, "MANUAL", owner, { submit: true });
    await prisma.financeTransaction.update({ where: { id: transaction.id }, data: { number: `TRX-UJI-WD-${amt}` } });
    await approveAndBook(transaction.id, owner);
    const list = [{ number: `TRX-UJI-WD-${amt}`, amount: amt, at: "2026-11-06T19:49", label: "WD TikTok MG" }];
    const day = (d: string) => ({ start: jakartaDateTime(d, "00:00"), end: jakartaDateTime(d, "23:59") });
    const sales = async (d: string) => (await profitLoss(day(d))).revenue.find((r) => r.code === "4-1000")?.amount ?? 0;
    const bal = async () => (await bankBalances()).find((b) => b.id === seabank)!.balance;
    const [s6, s8, b0] = [await sales("2026-11-06"), await sales("2026-11-08"), await bal()];
    const logs: string[] = [];

    expect((await koreksiTanggalWd(list, false, (s) => logs.push(s))).planned).toBe(1);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).status).toBe("DIBUKUKAN");
    expect(logs.join("\n")).toContain("2026-11-08 22:49 → 2026-11-06 19:49");

    const r = await koreksiTanggalWd(list, true, (s) => logs.push(s));
    expect(r.changed).toHaveLength(1);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).status).toBe("DIBATALKAN");
    const neu = await prisma.financeTransaction.findUniqueOrThrow({ where: { number: r.changed[0] } });
    expect(neu.date.getTime()).toBe(jakartaDateTime("2026-11-06", "19:49").getTime());
    expect(neu.storeId).toBe(mg.id);
    expect(await sales("2026-11-06")).toBe(s6 + amt);
    expect(await sales("2026-11-08")).toBe(s8 - amt);
    expect(await bal()).toBe(b0);

    const again = await koreksiTanggalWd(list, true, (s) => logs.push(s));
    expect([again.done, again.planned]).toEqual([1, 0]);
  });
});
