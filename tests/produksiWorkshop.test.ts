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
import { effectivePermissions } from "@/lib/rbac";
import { StockError, locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { cancelWorkshop, recordWorkshop, workshopHistory, workshopItems, workshopPlan } from "@/lib/produksiWorkshop";

const tag = `WS${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
let bahan: string, klip: string, cat: string, noRecipe: string, raw: string, wip: string, ohId: string;

const sum = async (journalSourceId: string, code: string, side: "debit" | "credit") => {
  const ls = await prisma.journalLine.findMany({ where: { journal: { source: "WORKSHOP", sourceId: journalSourceId }, account: { code } } });
  return ls.reduce((a, l) => a + Number(l[side]), 0);
};

beforeAll(async () => {
  const locs = await locationSettings(prisma);
  raw = locs.raw!;
  wip = locs.wip!;
  const mk = (suffix: string, extra: object) => prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, unit: "pcs", ...extra } as never });
  bahan = (await mk("CAT", { type: "BAHAN_BAKU", category: "Bahan Baku Utama", unit: "kg", hppUnit: "gram", hppFactor: 1000 })).id;
  klip = (await mk("KLIP", { type: "BAHAN_BAKU", category: "Bahan Pendukung" })).id;
  cat = (await mk("OUT", { type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", name: `Cat Plastik Uji ${tag}` })).id;
  noRecipe = (await mk("NR", { type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" })).id;
  await prisma.$transaction(async (tx) => {
    await recordMovement(tx, { type: "PENERIMAAN", itemId: bahan, qty: 5, toLocationId: raw, unitCost: 10_000, ref: `TES:${tag}` }, actor); // Rp10.000/kg
    await recordMovement(tx, { type: "PENERIMAAN", itemId: klip, qty: 100, toLocationId: raw, unitCost: 50, ref: `TES:${tag}` }, actor);
  });
  await prisma.itemRecipeLine.create({ data: { itemId: cat, componentId: bahan, qty: 3, useUnit: "gram" } }); // 3 gram per unit
  await prisma.itemRecipeLine.create({ data: { itemId: cat, componentId: klip, qty: 1, useUnit: "pcs" } });
  const oh = await prisma.overhead.create({ data: { category: "Sewa Tempat", name: `Sewa ${tag}`, monthlyAmount: 100_000n, outputPerMonth: 1000 } }); // Rp100/unit
  ohId = oh.id;
  await prisma.recipeOverhead.create({ data: { itemId: cat, overheadId: oh.id, factor: 1 } });
});

describe("Produksi workshop (tanpa borongan)", () => {
  it("rencana bahan otomatis dari resep (satuan stok), stok tersedia ditampilkan; hanya barang beresep", async () => {
    const p = await workshopPlan(prisma, cat, 10);
    expect(p.lines.map((l) => [l.name.endsWith("CAT"), l.planned])).toEqual(expect.arrayContaining([[true, 0.03], [false, 10]]));
    expect((await workshopItems()).some((i) => i.id === cat)).toBe(true);
    expect((await workshopItems()).some((i) => i.id === noRecipe)).toBe(false);
    await expect(workshopPlan(prisma, noRecipe, 1)).rejects.toThrow(/belum punya resep/);
  });

  it("simpan: bahan terpakai (avg), hasil bernilai bahan + overhead resep (Cr 6-1850), jurnal seimbang, tanpa upah/beban", async () => {
    const b0 = await qtyAt(prisma, bahan, raw);
    const o0 = await qtyAt(prisma, cat, wip);
    const r = await recordWorkshop({ outputItemId: cat, qty: 10, note: "uji" }, actor);
    // bahan 0,03 kg × Rp10.000 = 300; klip 10 × Rp50 = 500; overhead 10 × Rp100 = 1.000 → Rp1.800
    expect(r).toMatchObject({ bahan: 800, overhead: 1000, value: 1800, unitCost: 180 });
    expect(await qtyAt(prisma, bahan, raw)).toBeCloseTo(b0 - 0.03, 6);
    expect(await qtyAt(prisma, cat, wip)).toBe(o0 + 10);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: cat } })).avgCost)).toBe(180);
    expect(await sum(r.number, "1-1402", "debit")).toBe(1800);
    expect(await sum(r.number, "1-1401", "credit")).toBe(800);
    expect(await sum(r.number, "6-1850", "credit")).toBe(1000);
    const all = await prisma.journalLine.findMany({ where: { journal: { source: "WORKSHOP", sourceId: r.number } }, include: { account: true } });
    expect(all.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    expect(all.some((l) => l.account.code === "6-1100")).toBe(false); // tanpa upah
    const refs = await prisma.stockMovement.findMany({ where: { ref: r.ref } });
    expect(refs.map((m) => m.type).sort()).toEqual(["HASIL_PRODUKSI", "KONSUMSI_PRODUKSI", "KONSUMSI_PRODUKSI"]);
    expect((await workshopHistory(5)).some((h) => h.number === r.number && !h.cancelled)).toBe(true);
  });

  it("qty aktual bahan boleh diubah; stok kurang ditolak; batal membalik mutasi & jurnal (sekali)", async () => {
    const k0 = await qtyAt(prisma, klip, raw);
    const r = await recordWorkshop({ outputItemId: cat, qty: 5, actual: { [klip]: 7 } }, actor);
    expect(await qtyAt(prisma, klip, raw)).toBe(k0 - 7); // aktual 7, bukan 5 sesuai resep
    expect(r.bahan).toBe(Math.round(0.015 * 10_000) + 7 * 50);
    await expect(recordWorkshop({ outputItemId: cat, qty: 100_000 }, actor)).rejects.toBeInstanceOf(StockError);

    const o1 = await qtyAt(prisma, cat, wip);
    await expect(cancelWorkshop(r.number, "", actor)).rejects.toThrow(/Alasan/);
    await cancelWorkshop(r.number, "salah input", actor);
    expect(await qtyAt(prisma, klip, raw)).toBe(k0);
    expect(await qtyAt(prisma, cat, wip)).toBe(o1 - 5);
    const js = await prisma.journal.findMany({ where: { source: "WORKSHOP", sourceId: r.number } });
    expect(js).toHaveLength(1);
    expect(await prisma.journal.count({ where: { reversalOfId: js[0].id } })).toBe(1);
    await expect(cancelWorkshop(r.number, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);
    expect((await workshopHistory(10)).find((h) => h.number === r.number)?.cancelled).toBe(true);
    void ohId;
  });

  it("izin: Operator/Kapten/Supervisor/Admin/Owner boleh (stock.produce); Driver tidak", () => {
    for (const r of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "ADMIN", "OWNER"] as const) expect(effectivePermissions(r, []).has("stock.produce")).toBe(true);
    expect(effectivePermissions("DRIVER", []).has("stock.produce")).toBe(false);
  });
});

describe("Bot: Produksi workshop", () => {
  const TG = 777004;
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

  it("tombol hasil → jumlah → bahan otomatis → Simpan: produksi tercatat lewat fungsi yang sama", async () => {
    await tap("f:start:wsp");
    expect(sent.at(-1)!.buttons!.flat().map((b) => b.callback_data)).toContain(`f:${cat}`); // pilih dengan tombol, tanpa ketik kode
    await tap(`f:${cat}`);
    await say("20");
    expect(sent.at(-1)!.text).toMatch(/Bahan otomatis dari resep/);
    expect(sent.at(-1)!.text).toMatch(/0,06/);
    const o0 = await qtyAt(prisma, cat, wip);
    await tap("f:ok");
    expect(await qtyAt(prisma, cat, wip)).toBe(o0 + 20);
    expect(sent.at(-1)!.text).toMatch(/Produksi workshop WSP/);
    expect(await prisma.botSession.findUnique({ where: { chatId: String(TG) } })).toBeNull();
  });
});
