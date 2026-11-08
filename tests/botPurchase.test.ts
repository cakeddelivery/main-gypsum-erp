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
import { approveAndBook, cancelBookedTransaction, submitForConfirmation } from "@/lib/finance";
import { itemTotals } from "@/lib/stock";
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
    expect(sent.at(-1)?.text).toContain("Sisa hutang");
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

describe("Bot: draft duplikat", () => {
  it("menampilkan transaksi sebelumnya dan tombol pilihan selain Batalkan", async () => {
    const amt = 100000 + (Date.now() % 1000) * 7;
    await say(`bayar servis mesin ${amt} dari seabank`);
    const first = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    sent.length = 0;
    await say(`bayar servis mesin ${amt} dari seabank`);
    const msg = sent.at(-1)!;
    expect(msg.text).toContain("Mirip transaksi sebelumnya");
    expect(msg.text).toContain(first.number);
    const cbs = msg.buttons!.flat().map((b) => b.callback_data.split(":")[0]);
    expect(cbs).toEqual(expect.arrayContaining(["rev", "no", "chg"]));
    const second = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    sent.length = 0;
    await tap(`chg:${second.id}:acc`);
    expect(sent.at(-1)?.text).toContain("Ganti rekening");
    expect(sent.at(-1)?.buttons?.flat().some((b) => b.callback_data.startsWith(`acc:${second.id}:`))).toBe(true);
    await tap(`rev:${second.id}`);
    const after = sent.at(-1)!;
    expect(after.buttons!.flat().some((b) => b.callback_data === `ok:${second.id}`)).toBe(true);
  });
});

describe("Rincian: satu transfer untuk beberapa keperluan", () => {
  it("bot memecah caption, kategori kosong ditanyakan, jurnal dipecah & stok masuk", async () => {
    const it = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-UJI-PLASTIK" } });
    sent.length = 0;
    // Minimal 5 digit: nominal polos < 4 digit tidak dibaca sebagai rupiah
    const tag = 10000 + (Date.now() % 90000);
    await say(`plastik uji kemasan 100 pcs 50rb\nbarang zeta ${tag}\nongkir gypsum 10rb\ndari seabank`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" }, include: { splits: { orderBy: { sortOrder: "asc" } } } });
    expect(t.splits).toHaveLength(3);
    expect(Number(t.amount)).toBe(50000 + tag + 10000);
    expect(t.splits[0].itemId).toBe(it.id);
    const msg = sent.at(-1)!;
    expect(msg.text).toContain("Rincian (3)");
    // Barang zeta belum berkategori -> tombol pilihan kategori rincian 2
    const sc = msg.buttons!.flat().find((b) => b.callback_data.startsWith(`sc:${t.id}:1:`));
    expect(sc).toBeTruthy();
    await tap(sc!.callback_data);
    const t2 = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(t2.status).toBe("MENUNGGU_KONFIRMASI");
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const before = (await itemTotals()).get(it.id) ?? 0;
    const { journal } = await approveAndBook(t.id, { id: u.id, name: u.name });
    const jl = await prisma.journalLine.findMany({ where: { journalId: journal.id } });
    expect(jl.length).toBe(4);
    expect(jl.reduce((a, l) => a + Number(l.debit), 0)).toBe(Number(t.amount));
    expect((await itemTotals()).get(it.id)).toBe(before + 100);
    await cancelBookedTransaction(t.id, { id: u.id, name: u.name }, "uji");
    expect((await itemTotals()).get(it.id)).toBe(before);
    void submitForConfirmation;
  });
});

describe("Withdraw MG / DL", () => {
  it("'WD MG shopee' = withdraw dari saldo penjual Shopee untuk toko Main Gypsum; tanpa inisial toko ditanyakan", async () => {
    const mg = await prisma.store.findUniqueOrThrow({ where: { code: "MG" } });
    const seller = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SALDO_SHOPEE" } });
    const amt = 300000 + (Date.now() % 997);
    await say(`WD MG shopee ${amt} ke seabank`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(t).toMatchObject({ direction: "TRANSFER", accountId: seller.id, storeId: mg.id });
    sent.length = 0;
    await say(`wd shopee ${amt + 1} ke seabank`);
    const t2 = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(t2.storeId).toBeNull();
    expect(sent.at(-1)?.buttons?.flat().some((b) => b.callback_data.startsWith(`st:${t2.id}:`))).toBe(true);
    expect(sent.at(-1)?.text).toContain("pemasukan penjualan");
  });
});
