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
import { StockError } from "@/lib/stock";
import { approveAndBook, createTransaction, submitForConfirmation } from "@/lib/finance";
import { expenseCategoryFor, isExpenseText } from "@/lib/botPurchase";

const TG = 777002;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
const tag = `PB${Date.now().toString(36).toUpperCase()}`;
let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });
const btns = () => (sent.at(-1)?.buttons ?? []).flat().map((b) => b.callback_data);

let gypsum: { id: string; name: string };
let locId: string;
let invCat: { id: string };
let seabankId: string;
const kw = `ujibahan${tag.toLowerCase()}`;
// Nominal unik per run (cek "transaksi mirip" membandingkan nominal+tanggal+rekening dengan run sebelumnya di DB uji yang sama)
const base = 100_000 + (Date.now() % 700_000);
const rupiah = (x: number) => `Rp ${x.toLocaleString("id-ID")}`;

beforeEach(async () => {
  sent.length = 0;
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  gypsum = await prisma.item.create({ data: { sku: `${tag}-GYP`, name: `Gypsum ${tag}`, type: "BAHAN_BAKU", unit: "sak", hppUnit: "gram", hppFactor: 18000, category: "Bahan Baku Utama" } });
  locId = (await prisma.location.create({ data: { code: `${tag}L`, name: `AAA Rak Uji ${tag}` } })).id;
  const acc = await prisma.coaAccount.findUniqueOrThrow({ where: { code: "1-1401" } });
  invCat = await prisma.txCategory.create({ data: { name: `Pembelian Bahan Uji ${tag}`, direction: "KELUAR", coaAccountId: acc.id, keywords: kw } });
  seabankId = (await prisma.bankAccount.findFirstOrThrow({ where: { name: { contains: "seabank", mode: "insensitive" }, active: true } })).id;
});

describe("expense vs bahan", () => {
  it("LPG / konsumsi / ongkir dikenali sebagai beban; kategori Persediaan tidak dipakai untuk teks beban", () => {
    expect(isExpenseText("Beli Lpg 2 tabung")).toBe(true);
    expect(isExpenseText("ongkir gypsum 10rb")).toBe(true);
    expect(isExpenseText("beli gypsum 5 sak")).toBe(false);
    const cats = [
      { id: "inv", name: "Pembelian Bahan Baku", direction: "KELUAR" as const, keywords: "gypsum,bahan baku" },
      { id: "ongkir", name: "Ongkir", direction: "KELUAR" as const, keywords: "ongkir,kurir" },
    ];
    expect(expenseCategoryFor("ongkir gypsum", cats, new Set(["inv"]))).toBe("ongkir");
    expect(expenseCategoryFor("gas lpg", cats, new Set(["inv"]))).toBeNull(); // tidak ada kategori beban cocok → ditanyakan, bukan persediaan
  });
});

describe("Guard: tidak ada debit persediaan tanpa stok", () => {
  it("kategori berakun Persediaan tanpa barang → Perlu Ditinjau; tidak bisa diajukan/dibukukan; dengan rincian barang atau kategori beban boleh", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: owner.id, name: owner.name };
    const { transaction: t } = await createTransaction({ direction: "KELUAR", amount: base + 3, date: new Date(), accountId: seabankId, categoryId: invCat.id, note: `beli ${kw}` }, "TELEGRAM", actor);
    expect(t.status).toBe("PERLU_DITINJAU");
    await expect(submitForConfirmation(t.id, actor)).rejects.toThrow(/barang & qty/);
    await prisma.financeTransaction.update({ where: { id: t.id }, data: { status: "MENUNGGU_KONFIRMASI" } });
    await expect(approveAndBook(t.id, actor)).rejects.toThrow(/Data belum lengkap.*barang & qty/);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).journalId).toBeNull();
    // Rincian tanpa barang berkategori Persediaan = sama
    const { transaction: s } = await createTransaction({ direction: "KELUAR", amount: base + 4, date: new Date(), accountId: seabankId, splits: [{ categoryId: invCat.id, amount: base + 4, note: "bahan" }] }, "TELEGRAM", actor);
    expect(s.status).toBe("PERLU_DITINJAU");
    // Rincian dengan barang & qty diperbolehkan (stok masuk)
    const { transaction: ok } = await createTransaction({ direction: "KELUAR", amount: base + 5, date: new Date(), accountId: seabankId, categoryId: invCat.id, splits: [{ amount: base + 5, itemId: gypsum.id, qty: 1, note: "gypsum" }] }, "TELEGRAM", actor);
    expect(ok.status).toBe("MENUNGGU_KONFIRMASI");
  });
});

describe("createPurchase: lokasi penerima", () => {
  it("stok masuk ke lokasi yang dipilih; lokasi tak dikenal ditolak", async () => {
    const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const base = { newSupplierName: `Sup ${tag}`, storeId: store.value, date: new Date(), term: "TEMPO" as const, lines: [{ itemId: gypsum.id, qty: 1, amount: 40_000 }], paidNow: 0, dueDate: new Date(Date.now() + 7 * 86_400_000) };
    await expect(createPurchase({ ...base, locationId: "tidak-ada" }, { id: owner.id, name: owner.name })).rejects.toBeInstanceOf(StockError);
    const p = await createPurchase({ ...base, locationId: locId }, { id: owner.id, name: owner.name });
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: p.number, itemId: gypsum.id } });
    expect(mv.toLocationId).toBe(locId);
  });
});

describe("Bot: pembelian bahan dengan barang & qty", () => {
  it("kategori persediaan tanpa barang dikenali → bot meminta supplier, barang, qty (konversi satuan resep), lokasi; simpan lewat fungsi Pembelian; tanpa draft ganda", async () => {
    const draftsBefore = await prisma.financeTransaction.count({ where: { origin: null, source: "TELEGRAM" } });
    await say(`beli ${kw} ${rupiah(base)} dari seabank`);
    let s = await session();
    expect(s?.flow).toBe("beli");
    expect(s?.step).toBe("sup");
    await say(`Supplier Bot ${tag}`);
    expect((await session())?.step).toBe("item");
    expect(btns()).toContain("f:unk"); // opsi "tidak tahu barangnya"
    await say(`gypsum ${tag.toLowerCase()}`);
    await tap(`f:${gypsum.id}`);
    expect((await session())?.step).toBe("qty");
    expect(sent.at(-1)!.text).toMatch(/gram/);
    await say("9000 gram"); // 9000 gram = 0,5 sak (1 sak = 18.000 gram)
    s = await session();
    const lines = JSON.parse(String((s!.data as Record<string, unknown>).lines));
    expect(lines).toEqual([expect.objectContaining({ itemId: gypsum.id, qty: 0.5, amount: base })]);
    expect(s?.step).toBe("loc");
    expect(btns()).toContain(`f:${locId}`);
    await tap(`f:${locId}`);
    expect((await session())?.step).toBe("confirm");
    expect(sent.at(-1)!.text).toContain("AAA Rak Uji");
    await tap("f:ok");
    const p = await prisma.purchase.findFirstOrThrow({ where: { lines: { some: { itemId: gypsum.id } }, note: { contains: "via Telegram" } }, orderBy: { createdAt: "desc" }, include: { lines: true } });
    expect(Number(p.total)).toBe(base);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: p.number, itemId: gypsum.id } });
    expect([mv.toLocationId, Number(mv.qty), mv.type]).toEqual([locId, 0.5, "PENERIMAAN"]);
    const j = await prisma.journal.findFirstOrThrow({ where: { sourceId: p.number }, include: { lines: { include: { account: true } } } });
    expect(j.lines.filter((l) => l.account.code === "1-1401").reduce((a, l) => a + Number(l.debit), 0)).toBe(base);
    expect(await prisma.financeTransaction.count({ where: { origin: null, source: "TELEGRAM" } })).toBe(draftsBefore); // tidak ada draft transaksi ganda
  });

  it("tidak tahu barangnya → draft perlu dilengkapi (tanpa posting); tombol Isi barang & qty → Pembelian; draft ditolak otomatis (satu dokumen)", async () => {
    await say(`beli ${kw} ${rupiah(base + 1)} dari seabank`);
    await say(`Supplier Bot ${tag}`);
    await tap("f:unk");
    expect(await session()).toBeNull();
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { source: "TELEGRAM", categoryId: invCat.id, amount: BigInt(base + 1) }, orderBy: { createdAt: "desc" } });
    expect(t.status).toBe("PERLU_DITINJAU");
    expect(t.journalId).toBeNull();
    const card = sent.at(-1)!;
    expect(card.text).toMatch(/Perlu dilengkapi: barang & qty/);
    expect(btns()).toContain(`bp:${t.id}`);
    expect(await prisma.stockMovement.count({ where: { ref: t.number } })).toBe(0);

    await tap(`bp:${t.id}`);
    expect((await session())?.flow).toBe("beli");
    expect((await session())?.step).toBe("sup");
    await say(`Supplier Bot ${tag}`);
    await tap(`f:${gypsum.id}`);
    await say("2");
    await tap("f:def");
    expect((await session())?.step).toBe("confirm"); // tidak ditanyai "mirip draft sendiri"
    await tap("f:ok");
    const after = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe("DITOLAK");
    expect(await prisma.approvalLog.count({ where: { transactionId: t.id, note: { contains: "Diganti Pembelian" } } })).toBeGreaterThan(0);
    const p = await prisma.purchase.findFirstOrThrow({ where: { lines: { some: { itemId: gypsum.id, qty: 2 } } }, orderBy: { createdAt: "desc" } });
    expect(Number(p.total)).toBe(base + 1);
  });

  it("LPG lewat bot = kategori beban (bukan persediaan), tidak masuk alur Pembelian", async () => {
    await say(`beli lpg ${kw} 2 tabung ${rupiah(base + 2)} dari seabank`);
    expect((await session())?.flow).not.toBe("beli");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { source: "TELEGRAM", amount: BigInt(base + 2) }, orderBy: { createdAt: "desc" } });
    expect(t.categoryId).not.toBe(invCat.id);
    const inv = await prisma.txCategory.count({ where: { id: t.categoryId ?? "-", coaAccount: { code: { in: ["1-1401", "1-1402", "1-1403"] } } } });
    expect(inv).toBe(0);
  });
});
