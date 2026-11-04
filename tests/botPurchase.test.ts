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
import { createPurchase } from "@/lib/purchase";
import { todayStr, jakartaDateTime } from "@/lib/time";

const TG = 777001;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);

beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

describe("Bot: pembelian bahan baku dari pesan", () => {
  let itemId: string;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
    const sup = await prisma.supplier.upsert({ where: { code: "SUP_UJI_PLASTIK" }, create: { code: "SUP_UJI_PLASTIK", name: "Toko Uji Plastik" }, update: {} });
    const it = await prisma.item.upsert({ where: { sku: "BB-UJI-PLASTIK" }, create: { sku: "BB-UJI-PLASTIK", name: "Plastik Uji Kemasan", type: "BAHAN_BAKU", unit: "pcs", supplierId: sup.id }, update: { active: true, supplierId: sup.id } });
    itemId = it.id;
  });

  it("pesan pembelian sesuai master bahan baku langsung jadi isian pembelian, qty tidak jadi nominal", async () => {
    sent.length = 0;
    const before = await prisma.financeTransaction.count();
    await say("beli plastik uji kemasan 2000 pcs 450rb dari seabank");
    expect(await prisma.financeTransaction.count()).toBe(before);
    const s = await prisma.botSession.findUniqueOrThrow({ where: { chatId: String(TG) } });
    expect(s.flow).toBe("beli");
    expect(s.step).toBe("confirm");
    const d = s.data as Record<string, string>;
    expect(JSON.parse(d.lines)).toEqual([expect.objectContaining({ itemId, qty: 2000, amount: 450000 })]);
    expect(d.supName).toBe("Toko Uji Plastik");
    expect(sent.at(-1)?.text).toContain("Pembelian bahan baku");

    const stockBefore = await prisma.stockMovement.count({ where: { itemId } });
    await tap("f:ok");
    expect(await prisma.stockMovement.count({ where: { itemId } })).toBe(stockBefore + 1);
    const p = await prisma.purchase.findFirstOrThrow({ where: { lines: { some: { itemId } } }, orderBy: { createdAt: "desc" } });
    expect(Number(p.total)).toBe(450000);
    expect(p.term).toBe("LUNAS");
  });

  it("tombol 'Bukan pembelian' mencatat draft transaksi biasa", async () => {
    sent.length = 0;
    await say("beli plastik uji kemasan 100 pcs 50rb dari seabank");
    expect(sent.at(-1)?.buttons?.flat().some((b) => b.callback_data === "f:plain")).toBe(true);
    const before = await prisma.financeTransaction.count();
    await tap("f:plain");
    expect(await prisma.financeTransaction.count()).toBe(before + 1);
    const t = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(Number(t.amount)).toBe(50000);
    expect(await prisma.botSession.findUnique({ where: { chatId: String(TG) } })).toBeNull();
  });

  it("pesan biasa tetap jadi draft transaksi", async () => {
    const before = await prisma.financeTransaction.count();
    await say("bayar listrik 350rb dari seabank");
    expect(await prisma.financeTransaction.count()).toBe(before + 1);
  });
});

describe("Bot: angsuran utang supplier", () => {
  it("'angsur kardus' dikenali dan mengurangi sisa utang", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
    const it = await prisma.item.upsert({ where: { sku: "BB-UJI-KARDUS" }, create: { sku: "BB-UJI-KARDUS", name: "Kardus Uji", type: "BAHAN_BAKU", unit: "pcs" }, update: { active: true } });
    const sup = await prisma.supplier.findFirst({ where: { name: "Hendra Uji" } });
    const p = await createPurchase({ supplierId: sup?.id ?? null, newSupplierName: sup ? null : "Hendra Uji", storeId: store.value, date: jakartaDateTime(todayStr(), "10:00"), term: "TEMPO", lines: [{ itemId: it.id, qty: 100, amount: 600000 }], paidNow: 0, bankAccountId: null, dueDate: jakartaDateTime(todayStr(), "12:00"), note: null }, { id: u.id, name: u.name });
    // Utang uji dari jalankan tes sebelumnya dianggap lunas agar yang cocok hanya satu
    await prisma.$executeRaw`UPDATE "Payable" SET paid = amount WHERE vendor = 'Hendra Uji' AND id <> ${p.payableId}`;
    await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
    sent.length = 0;
    await say("angsur kardus uji 200rb dari seabank");
    const s = await prisma.botSession.findUniqueOrThrow({ where: { chatId: String(TG) } });
    expect(s.flow).toBe("utang");
    expect(s.step).toBe("confirm");
    expect((s.data as Record<string, string>).payId).toBe(p.payableId);
    await tap("f:ok");
    const pay = await prisma.payable.findUniqueOrThrow({ where: { id: p.payableId! } });
    expect(Number(pay.paid)).toBe(200000);
    expect(sent.at(-1)?.text).toContain("Sisa utang");
  });
});

describe("Bot: dana sisihan dari bukti transfer", () => {
  it("nominal = gabungan kompensasi Cak Ed + Jojo dikenali, dicatat untuk hari ini", async () => {
    const funds = await prisma.reserveFund.findMany({ where: { active: true, kind: "OWNER" } });
    const perDay = funds.reduce((t, f) => t + Number(f.dailyAmount), 0);
    await prisma.reserveEntry.deleteMany({ where: { fundId: { in: funds.map((f) => f.id) }, date: new Date(`${todayStr()}T00:00:00Z`), journalId: null } });
    await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
    sent.length = 0;
    const before = await prisma.financeTransaction.count();
    await say(`transfer dari seabank ke shopeepay ${perDay / 1000}rb`);
    const s = await prisma.botSession.findUnique({ where: { chatId: String(TG) } });
    expect(s?.flow).toBe("sish");
    const opts = JSON.parse(String((s!.data as Record<string, string>).opts));
    expect(opts[0].fundIds.sort()).toEqual(funds.map((f) => f.id).sort());
    await tap(s!.step === "pick" ? "f:o0" : "f:ok");
    if ((await prisma.botSession.findUnique({ where: { chatId: String(TG) } }))?.step === "confirm") await tap("f:ok");
    for (const f of funds) expect(await prisma.reserveEntry.count({ where: { fundId: f.id, type: "SISIH", date: { in: opts[0].dates.map((d: string) => new Date(`${d}T00:00:00Z`)) } } })).toBe(opts[0].dates.length);
    expect(await prisma.financeTransaction.count()).toBe(before);
  });
});
