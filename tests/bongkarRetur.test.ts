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
import { StockError, locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { bongkarPlan, bongkarRetur, cancelBongkar } from "@/lib/bongkarRetur";
import { recordWorkshop } from "@/lib/produksiWorkshop";

const tag = `BR${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
let paket: string, patung: string, opp: string, wip: string, fin: string;

const jsum = async (number: string, code: string, side: "debit" | "credit") =>
  (await prisma.journalLine.findMany({ where: { journal: { source: "BONGKAR_RETUR", sourceId: number }, account: { code } } })).reduce((a, l) => a + Number(l[side]), 0);

beforeAll(async () => {
  const locs = await locationSettings(prisma);
  wip = locs.wip!; fin = locs.finished!;
  const mk = (suffix: string, extra: object) => prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, unit: "pcs", ...extra } as never });
  patung = (await mk("PTG", { type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" })).id;
  opp = (await mk("OPP", { type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" })).id;
  paket = (await mk("PKT", { type: "BARANG_JADI", category: "Barang Jadi" })).id;
  await prisma.itemRecipeLine.create({ data: { itemId: paket, componentId: patung, qty: 2, useUnit: "pcs" } });
  await prisma.itemRecipeLine.create({ data: { itemId: paket, componentId: opp, qty: 1, useUnit: "pcs" } });
  await prisma.$transaction(async (tx) => {
    await recordMovement(tx, { type: "PENERIMAAN", itemId: patung, qty: 100, toLocationId: wip, unitCost: 1000, ref: `TES:${tag}` }, actor);
    await recordMovement(tx, { type: "PENERIMAAN", itemId: opp, qty: 100, toLocationId: wip, unitCost: 200, ref: `TES:${tag}` }, actor);
    await recordMovement(tx, { type: "PENERIMAAN", itemId: paket, qty: 10, toLocationId: fin, unitCost: 2200, ref: `TES:${tag}` }, actor);
  });
});

describe("Bongkar retur", () => {
  it("rencana isi = komponen × jumlah", async () => {
    const p = await bongkarPlan(prisma, paket, 3);
    expect(p.lines.map((l) => l.total).sort()).toEqual([3, 6]);
  });

  it("2 paket, 1 patung rusak: nilai proporsional, reject 6-1800 + catatan reject, jurnal seimbang", async () => {
    const f0 = await qtyAt(prisma, paket, fin), p0 = await qtyAt(prisma, patung, wip), o0 = await qtyAt(prisma, opp, wip);
    const r = await bongkarRetur({ itemId: paket, qty: 2, damaged: { [patung]: 1 }, reason: "PECAH", returnNumber: "RTR-X" }, actor);
    expect(r.totalValue).toBe(4400); // 2 × 2.200
    expect(r.rejectValue).toBe(1000); // 4 patung × Rp1.000 = 4.000 dari 4.400; 1 patung rusak = Rp1.000
    expect(await qtyAt(prisma, paket, fin)).toBe(f0 - 2);
    expect(await qtyAt(prisma, patung, wip)).toBe(p0 + 3);
    expect(await qtyAt(prisma, opp, wip)).toBe(o0 + 2);
    expect(await jsum(r.number, "6-1810", "debit")).toBe(r.rejectValue);
    expect(await jsum(r.number, "1-1403", "credit")).toBe(4400);
    const all = await prisma.journalLine.findMany({ where: { journal: { source: "BONGKAR_RETUR", sourceId: r.number } } });
    expect(all.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    const rej = await prisma.productionReject.findMany({ where: { reportId: r.ref } });
    expect(rej).toHaveLength(1);
    expect(rej[0].stage).toBe("RETUR");
    expect(await jsum(r.number, "6-1800", "debit")).toBe(0);
    expect(Number(rej[0].qty)).toBe(1);
    await expect(bongkarRetur({ itemId: paket, qty: 1, damaged: { [patung]: 5 } }, actor)).rejects.toBeInstanceOf(StockError);
    await expect(bongkarRetur({ itemId: paket, qty: 1000 }, actor)).rejects.toBeInstanceOf(StockError); // melebihi stok retur

    await expect(cancelBongkar(r.number, "", actor)).rejects.toThrow(/Alasan/);
    await cancelBongkar(r.number, "salah", actor);
    expect(await qtyAt(prisma, paket, fin)).toBe(f0);
    expect(await qtyAt(prisma, patung, wip)).toBe(p0);
    expect(await prisma.productionReject.count({ where: { reportId: r.ref } })).toBe(0);
    await expect(cancelBongkar(r.number, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);
  });

  it("rakit ulang (RAS): komponen layak + pengganti dipakai, barang jadi kembali, tanpa upah", async () => {
    const f0 = await qtyAt(prisma, paket, fin);
    const r = await recordWorkshop({ outputItemId: paket, qty: 2, kind: "RAS" }, actor);
    expect(r.number).toMatch(/^RAS/);
    expect(await qtyAt(prisma, paket, fin)).toBe(f0 + 2);
    const ls = await prisma.journalLine.findMany({ where: { journal: { source: "WORKSHOP", sourceId: r.number }, account: { code: "6-1100" } } });
    expect(ls).toHaveLength(0);
  });
});

describe("Bot: Bongkar retur", () => {
  const TG = 777005;
  const chat = { id: TG };
  const from = { id: TG, first_name: "Owner" };
  let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
  const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
  const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  });
  beforeEach(async () => { sent.length = 0; await prisma.botSession.deleteMany({ where: { chatId: String(TG) } }); });

  it("tombol barang → jumlah → rusak per komponen → simpan", async () => {
    await tap("f:start:brt");
    await tap(`f:${paket}`);
    await say("1");
    await tap("f:all"); // komponen pertama semua rusak
    await tap("f:0");
    expect(sent.at(-1)!.text).toMatch(/Simpan/);
    const f0 = await qtyAt(prisma, paket, fin);
    await tap("f:ok");
    expect(await qtyAt(prisma, paket, fin)).toBe(f0 - 1);
    expect(sent.at(-1)!.text).toMatch(/Bongkar retur BRT/);
  });
});
