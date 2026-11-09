import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Btn = { text: string; callback_data: string };
const sent: { text: string; buttons?: Btn[][] }[] = [];
const docs: { filename: string; caption: string }[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    telegramConfigured: () => true,
    sendTelegram: vi.fn(async (_c: string, text: string, o: { buttons?: Btn[][] } = {}) => (sent.push({ text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (_c: string, _m: number, text: string, buttons?: Btn[][]) => (sent.push({ text, buttons }), { ok: true })),
    sendTelegramDocument: vi.fn(async (_c: string, _f: Buffer, filename: string, caption: string) => (docs.push({ filename, caption }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
    downloadTelegramFile: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  };
});
const renders: { path: string; target: string }[] = [];
vi.mock("@/lib/render", async (orig) => {
  const real = await orig<typeof import("@/lib/render")>();
  return { ...real, renderDocJpg: vi.fn(async (_u: string, path: string, target: string) => (renders.push({ path, target }), Buffer.from("jpg"))) };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { parseDue, dueSales, receivableReminderText } from "@/lib/botSales";
import { sendReceivableReminder } from "@/lib/jobs";
import { addDays, jakartaDateTime, todayStr } from "@/lib/time";

const TG = 777301;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const photo = () => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, photo: [{ file_id: "bukti-uji" }] } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });
const buttons = () => sent.at(-1)?.buttons?.flat() ?? [];

let itemId: string;
let seabank: string;
let mgId: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true, chatId: String(TG) } });
  const it = await prisma.item.upsert({ where: { sku: "BJ-BOT-JUAL" }, create: { sku: "BJ-BOT-JUAL", name: "Gypsum Bot Uji", type: "BARANG_JADI", unit: "pcs" }, update: { active: true } });
  itemId = it.id;
  mgId = (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id;
  // Harga offline terakhir di Produk & HPP → harga otomatis di bot
  const prod = await prisma.product.upsert({ where: { sku: "PRD-BOT-JUAL" }, create: { sku: "PRD-BOT-JUAL", name: "Gypsum Bot Uji", type: "SATUAN", variant: "HEWAN", storeId: mgId, finishedItemId: it.id }, update: { finishedItemId: it.id } });
  await prisma.priceHistory.create({ data: { productId: prod.id, channel: "OFFLINE", price: BigInt(15000), hpp: BigInt(5000), createdBy: "uji" } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

beforeEach(async () => {
  sent.length = 0;
  docs.length = 0;
  renders.length = 0;
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

describe("Bot: penjualan", () => {
  it("menu menampilkan tombol 🛒 Penjualan untuk pemegang izin sales.manage", async () => {
    await say("/menu");
    expect(buttons().some((b) => b.callback_data === "f:start:jual" && b.text === "🛒 Penjualan")).toBe(true);
    await tap("f:start:jual");
    expect(buttons().map((b) => b.callback_data)).toContain("f:start:jnew");
    for (const b of sent.flatMap((m) => m.buttons?.flat() ?? [])) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it("penjualan lunas: toko, pelanggan baru, barang + harga otomatis, diskon, rekening → tersimpan + nota JPG", async () => {
    await tap("f:start:jnew");
    expect((await session())?.step).toBe("store");
    await tap(`f:${mgId}`);
    expect((await session())?.step).toBe("cust");
    await say("Bu Bot Uji Jual");
    expect(buttons().some((b) => b.callback_data === "f:new")).toBe(true);
    await tap("f:new");
    expect((await session())?.step).toBe("item");
    await say("bot uji");
    expect(buttons().some((b) => b.callback_data === `f:${itemId}`)).toBe(true);
    await tap(`f:${itemId}`);
    await say("3");
    expect(sent.at(-1)?.text).toContain("15.000");
    await tap("f:keep");
    expect((await session())?.step).toBe("more");
    await tap("f:done");
    await say("5rb");
    await tap("f:0");
    expect((await session())?.step).toBe("mode");
    await tap("f:L");
    await tap(`f:${seabank}`);
    await tap("f:skip");
    const s = await session();
    expect(s?.step).toBe("confirm");
    expect(sent.at(-1)?.text).toMatch(/Tagihan: <b>Rp\s?40\.000<\/b>/);
    await tap("f:ok");
    expect(await session()).toBeNull();
    const sale = await prisma.sale.findFirstOrThrow({ where: { customerName: "Bu Bot Uji Jual" }, include: { lines: true, payments: true } });
    expect(Number(sale.subtotal)).toBe(45000);
    expect(Number(sale.discount)).toBe(5000);
    expect(Number(sale.total)).toBe(40000);
    expect(Number(sale.paid)).toBe(40000);
    expect(sale.storeId).toBe(mgId);
    expect(sale.lines).toEqual([expect.objectContaining({ itemId, qty: expect.anything(), price: BigInt(15000) })]);
    expect(sale.payments[0].bankAccountId).toBe(seabank);
    expect(await prisma.customer.findFirst({ where: { name: "Bu Bot Uji Jual" } })).not.toBeNull();
    // Nota JPG = DocSheet "nota" di halaman detail penjualan (sama dengan Unduh JPG di web)
    expect(renders).toEqual([{ path: `/penjualan/${sale.id}`, target: "nota" }]);
    expect(docs[0].filename).toBe(`nota-${sale.number}.jpg`);
    expect(sent.at(-1)?.text).toContain(`Penjualan ${sale.number} tercatat`);
  });

  it("tempo dengan Pelanggan umum ditolak, pilih pelanggan lalu jatuh tempo → piutang tercatat", async () => {
    const cust = await prisma.customer.findFirstOrThrow({ where: { name: "Bu Bot Uji Jual" } });
    await tap("f:start:jnew");
    await tap(`f:${mgId}`);
    await tap("f:walk");
    await tap(`f:${itemId}`);
    await say("2");
    await say("20rb");
    await tap("f:done");
    await tap("f:0");
    await say("10rb");
    await tap("f:T");
    expect((await session())?.step).toBe("cust");
    expect(sent.some((m) => m.text.includes("wajib memilih pelanggan"))).toBe(true);
    await tap(`f:${cust.id}`);
    expect((await session())?.step).toBe("mode");
    await tap("f:T");
    expect((await session())?.step).toBe("due");
    await tap("f:7");
    await tap("f:skip");
    await tap("f:ok");
    const sale = await prisma.sale.findFirstOrThrow({ where: { customerId: cust.id, paid: 0 }, include: { receivable: true }, orderBy: { createdAt: "desc" } });
    expect(Number(sale.total)).toBe(50000);
    expect(Number(sale.shipping)).toBe(10000);
    expect(Number(sale.receivable?.amount)).toBe(50000);
    expect(todayStr(sale.dueDate!)).toBe(addDays(todayStr(), 7));
  });

  it("terima cicilan: pilih nota, nominal, rekening, foto bukti → dibukukan", async () => {
    const sale = await prisma.sale.findFirstOrThrow({ where: { customerName: "Bu Bot Uji Jual", paid: 0 }, orderBy: { createdAt: "desc" } });
    await tap("f:start:jcil");
    expect(buttons().some((b) => b.callback_data === `f:${sale.id}`)).toBe(true);
    await tap(`f:${sale.id}`);
    await say("20rb");
    await tap(`f:${seabank}`);
    expect((await session())?.step).toBe("proof");
    await photo();
    const s = await session();
    expect(s?.step).toBe("confirm");
    expect((s?.data as Record<string, string>).proofPath).toBeTruthy();
    await tap("f:ok");
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { payments: true, receivable: true } });
    expect(Number(after.paid)).toBe(20000);
    expect(Number(after.receivable?.paid)).toBe(20000);
    expect(after.payments.find((p) => !p.initial)?.proofPath).toBeTruthy();
    expect(sent.at(-1)?.text).toContain("Sisa piutang");
    expect(buttons().some((b) => b.callback_data === `m:nota:${sale.id}`)).toBe(true);
  });
});

describe("Pengingat piutang jatuh tempo", () => {
  it("parseDue: tombol hari & tanggal ketikan", () => {
    expect(parseDue("7", "2026-11-09")).toBe("2026-11-16");
    expect(parseDue("25/11", "2026-11-09")).toBe("2026-11-25");
    expect(parseDue("5/1", "2026-11-09")).toBe("2027-01-05");
    expect(parseDue("2026-12-01", "2026-11-09")).toBe("2026-12-01");
    expect(parseDue("31/02/2027", "2026-11-09")).toBeNull();
    expect(parseDue("2026-11-01", "2026-11-09")).toBeNull();
  });

  it("nota jatuh tempo hari ini & lewat dikirim ke Owner/Finance, sekali per nota per hari", async () => {
    const sale = await prisma.sale.findFirstOrThrow({ where: { customerName: "Bu Bot Uji Jual", paid: 20000 } });
    await prisma.sale.update({ where: { id: sale.id }, data: { dueDate: jakartaDateTime(addDays(todayStr(), -3), "12:00") } });
    const now = new Date();
    const rows = await dueSales(now);
    const mine = rows.find((r) => r.id === sale.id);
    expect(mine).toMatchObject({ today: false, lateDays: 3 });
    expect(receivableReminderText(rows)).toContain("Lewat jatuh tempo");

    const r1 = await sendReceivableReminder(now);
    expect(r1.sent).toBeGreaterThan(0);
    const msg = sent.find((m) => m.text.includes("Pengingat piutang penjualan"));
    expect(msg?.text).toContain(sale.number);
    expect(msg?.buttons?.flat().some((b) => b.callback_data === "f:start:jcil")).toBe(true);

    sent.length = 0;
    const r2 = await sendReceivableReminder(now);
    expect(r2.sent).toBe(0);
    expect(sent.some((m) => m.text.includes(sale.number))).toBe(false);

    // Sudah diingatkan hari ini: tidak masuk daftar lagi
    expect((await dueSales(now)).some((r) => r.id === sale.id)).toBe(false);
  });
});
