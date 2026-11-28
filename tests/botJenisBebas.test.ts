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

const TG = 777003;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
const tag = `JB${Date.now().toString(36).toUpperCase()}`;
const low = tag.toLowerCase();
let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });
const btns = () => (sent.at(-1)?.buttons ?? []).flat().map((b) => b.callback_data);
const base = 200_000 + (Date.now() % 600_000);
const rupiah = (x: number) => `Rp ${x.toLocaleString("id-ID")}`;
const item = `gypsum uji ${low}`;
const supplier = `bintang arut ${low}`;
let itemId: string;
let supId: string;

beforeEach(async () => {
  sent.length = 0;
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  const sup = await prisma.supplier.create({ data: { code: `SUP_${tag}`, name: `Bintang Arut ${tag}` } });
  supId = sup.id;
  const it = await prisma.item.create({ data: { sku: `${tag}-GYP`, name: `Gypsum Uji ${tag}`, type: "BAHAN_BAKU", unit: "sak", supplierId: sup.id, category: "Bahan Baku Utama" } });
  itemId = it.id;
  // Utang terbuka ke supplier (untuk "angsur ...")
  const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
  await createPurchase({ supplierId: sup.id, storeId: store.value, date: new Date(), term: "TEMPO", lines: [{ itemId, qty: 10, amount: 3_000_000 }], paidNow: 0, dueDate: new Date(Date.now() + 14 * 86_400_000) }, { id: u.id, name: u.name });
});

describe("Bot: pesan bebas tanpa menu", () => {
  it("'beli <barang> 20 sak <nominal> <supplier> tf seabank' → alur Pembelian terisi (barang, qty, harga, supplier, bank) + tombol Ubah jenis", async () => {
    await say(`beli ${item} 20 sak ${rupiah(base)} ${supplier} tf seabank`);
    const s = await session();
    expect(s?.flow).toBe("beli");
    const d = s!.data as Record<string, unknown>;
    expect(JSON.parse(String(d.lines))).toEqual([expect.objectContaining({ itemId, qty: 20, amount: base })]);
    expect(d.supId).toBe(supId);
    expect(d.bankName).toMatch(/seabank/i);
    expect(s?.step).toBe("loc"); // hanya lokasi yang ditanyakan (sisanya sudah terbaca)
    expect(btns()).toContain("f:jns");
  });

  it("'✏️ Ubah jenis' → pilihan jenis; pilih BEBAN → draft beban, bukan pembelian", async () => {
    await say(`beli ${item} 5 sak ${rupiah(base + 1)} ${supplier} dari seabank`);
    expect((await session())?.flow).toBe("beli");
    const purchasesBefore = await prisma.purchase.count();
    await tap("f:jns");
    expect((await session())?.flow).toBe("jns");
    expect(btns()).toEqual(expect.arrayContaining(["f:jns:PEMBELIAN", "f:jns:BAYAR_HUTANG", "f:jns:GAJI", "f:jns:KOMPENSASI", "f:jns:BEBAN", "f:jns:PENJUALAN", "f:jns:DRAFT"]));
    await tap("f:jns:BEBAN");
    expect(await session()).toBeNull();
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { source: "TELEGRAM", amount: BigInt(base + 1) }, orderBy: { createdAt: "desc" } });
    expect(t.direction).toBe("KELUAR");
    expect(await prisma.purchase.count()).toBe(purchasesBefore);
  });

  it("'angsur <barang> <supplier> 1jt' → alur bayar hutang supplier (bukan pembelian)", async () => {
    await say(`angsur ${item} ${supplier} ${rupiah(base + 2)} dari seabank`);
    const s = await session();
    expect(s?.flow).toBe("utang");
    expect(JSON.parse(String((s!.data as Record<string, unknown>).cands ?? "[]")).length).toBeGreaterThan(0);
  });

  it("'lpg 2 tabung 40rb' (tanpa kata beli/bayar) → draft BEBAN keluar, bukan persediaan", async () => {
    await say(`lpg 2 tabung ${rupiah(base + 3)} dari seabank`);
    expect(await session()).toBeNull();
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { source: "TELEGRAM", amount: BigInt(base + 3) }, orderBy: { createdAt: "desc" } });
    expect(t.direction).toBe("KELUAR");
    const inv = await prisma.txCategory.count({ where: { id: t.categoryId ?? "-", coaAccount: { code: { in: ["1-1401", "1-1402", "1-1403"] } } } });
    expect(inv).toBe(0);
  });

  it("'kompensasi edy 500rb' (tanpa arah) dan 'gaji borongan minggu ini' (tanpa nominal) tidak ditolak 'belum bisa membaca'", async () => {
    await say(`kompensasi edy ${rupiah(base + 4)} dari seabank`);
    expect(sent.map((m) => m.text).join("\n")).not.toMatch(/belum bisa membaca/);
    sent.length = 0;
    await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
    await say("gaji borongan minggu ini");
    expect(sent.map((m) => m.text).join("\n")).not.toMatch(/belum bisa membaca/);
    expect(sent.length).toBeGreaterThan(0);
  });

  it("ragu (nama supplier berutang tanpa kata angsur/beli) → pilihan jenis dengan tombol, tidak menebak; pilih Bayar hutang → alur utang", async () => {
    await say(`bayar ${supplier} ${rupiah(base + 5)} dari seabank`);
    expect((await session())?.flow).toBe("jns");
    expect(btns()).toEqual(expect.arrayContaining(["f:jns:BAYAR_HUTANG", "f:jns:DRAFT"]));
    expect(await prisma.financeTransaction.count({ where: { amount: BigInt(base + 5) } })).toBe(0); // belum ada yang dicatat
    await tap("f:jns:BAYAR_HUTANG");
    expect((await session())?.flow).toBe("utang");
  });
});
