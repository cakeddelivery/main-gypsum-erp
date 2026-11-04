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

const TG = 777001;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = 1;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);

describe("Bot: pembelian bahan baku dari pesan", () => {
  let itemId: string;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
    const sup = await prisma.supplier.upsert({ where: { code: "SUP_UJI_PLASTIK" }, create: { code: "SUP_UJI_PLASTIK", name: "Toko Uji Plastik" }, update: {} });
    const it = await prisma.item.upsert({ where: { sku: "BB-UJI-PLASTIK" }, create: { sku: "BB-UJI-PLASTIK", name: "Plastik Uji Kemasan", type: "BAHAN_BAKU", unit: "pcs", supplierId: sup.id }, update: {} });
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
