import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Laporan 10 Nov 21.08: resi SeaBank "Bunga Rp 218" (dari SeaBank ke rekening sendiri ****5984) dengan caption
 * "Bunga Bank seabank 5984 tanggal 10 november" jadi PENGELUARAN tanpa kategori. Seharusnya pemasukan
 * kategori Bunga Bank, rekening Seabank, 10 Nov 01:32.
 */
const sent: { text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
const read = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (_c: string, text: string, o: { buttons?: { text: string; callback_data: string }[][] } = {}) => (sent.push({ text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (_c: string, _m: number, text: string, buttons?: { text: string; callback_data: string }[][]) => (sent.push({ text, buttons }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
    downloadTelegramFile: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])),
  };
});
vi.mock("@/lib/receipt", () => ({ readReceipt: vi.fn(async () => read.next), receiptReaderConfigured: () => true }));
vi.mock("@/lib/ocrReceipt", () => ({ ocrReceipt: vi.fn(async () => null) }));

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { extractTransaction, interestKind, mergeReceipt } from "@/lib/extract";
import { receiptFromOcrText } from "@/lib/ocrReceiptText";
import { suggestCategories } from "@/lib/categorySuggest";
import { jakartaDateTime } from "@/lib/time";

const TG = 777120;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = 1_300_000;
const RESI = { amount: 218, date: "2032-11-10", time: "01:32", direction: "KELUAR", account: "SeaBank", toAccount: null, counterparty: "(eo) Nur Anjola Hidayat Diharjo Putra" };
const OCR = "SeaBank\nTransaksi Berhasil\nBunga\nRp 218\nDari\nSeaBank\nKe\nNur Anjola Hidayat Diharjo Putra\nSeaBank ****5984\nNo. Transaksi 2611100132000218\nWaktu Transaksi 10 Nov 2026 01:32";

let banks: Awaited<ReturnType<typeof prisma.bankAccount.findMany>>;
let cats: Awaited<ReturnType<typeof prisma.txCategory.findMany>>;
let seabank: string;
let bunga: { id: string; coaAccountId: string };
let pajak: { id: string };

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  banks = await prisma.bankAccount.findMany({ where: { active: true } });
  cats = await prisma.txCategory.findMany({ where: { active: true } });
  seabank = banks.find((b) => b.code === "SEABANK")!.id;
  bunga = cats.find((c) => c.name === "Bunga Bank")!;
  pajak = cats.find((c) => c.name === "Pajak Bunga Bank")!;
});
beforeEach(() => {
  sent.length = 0;
});

describe("Kategori Bunga Bank", () => {
  it("tersedia: Bunga Bank (MASUK) → 4-9100 sub-akun 4-9000; Pajak Bunga Bank (KELUAR) → beban", async () => {
    const coa = await prisma.coaAccount.findUniqueOrThrow({ where: { id: bunga.coaAccountId } });
    expect([coa.code, coa.type]).toEqual(["4-9100", "PENDAPATAN"]);
    expect(pajak).toBeTruthy();
    expect(cats.find((c) => c.name === "Pendapatan Lain")!.keywords).not.toContain("bunga");
  });

  it("kata kunci: bunga → MASUK; pajak bunga → KELUAR; bunga pinjaman bukan bunga bank", () => {
    expect(interestKind("Bunga Bank seabank 5984 tanggal 10 november")).toBe("BUNGA");
    expect(interestKind("bunga tabungan")).toBe("BUNGA");
    expect(interestKind("interest")).toBe("BUNGA");
    expect(interestKind("pajak bunga seabank")).toBe("PAJAK");
    expect(interestKind("bayar bunga pinjaman spinjam")).toBeNull();
    expect(extractTransaction("pajak bunga seabank 44", banks, cats).direction).toBe("KELUAR");
  });

  it("caption + resi SeaBank → MASUK Rp218, Bunga Bank, Seabank, 10 Nov 01:32, tanpa nama pemilik di catatan", () => {
    const text = "Bunga Bank seabank 5984 tanggal 10 november";
    const now = jakartaDateTime("2026-11-10", "21:08");
    const ex = mergeReceipt(extractTransaction(text, banks, cats, now), text, { ...RESI, date: "2026-11-10" } as never, banks, cats, now);
    expect(ex).toMatchObject({ direction: "MASUK", amount: 218, accountId: seabank, categoryId: bunga.id, date: "2026-11-10", time: "01:32" });
    expect(ex.note).not.toContain("(eo)");
    expect(ex.note).not.toContain("Nur Anjola");
  });

  it("teks OCR resi bunga → MASUK", () => {
    expect(receiptFromOcrText(OCR, banks, jakartaDateTime("2026-11-10", "21:08"))?.direction).toBe("MASUK");
  });

  it("saran kategori memprioritaskan Bunga Bank / Pajak Bunga Bank", async () => {
    expect((await suggestCategories(prisma, { direction: "MASUK", text: "bunga tabungan seabank" })).picks[0]?.id).toBe(bunga.id);
    expect((await suggestCategories(prisma, { direction: "KELUAR", text: "pajak bunga seabank" })).picks[0]?.id).toBe(pajak.id);
  });

  it("bot: foto resi + caption → draft pemasukan Bunga Bank siap dikonfirmasi", async () => {
    read.next = RESI;
    await handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, caption: "Bunga Bank seabank 5984 tanggal 10 november 2032", photo: [{ file_id: "f1" }] } } as never);
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { amount: BigInt(218), accountId: seabank }, orderBy: { createdAt: "desc" } });
    expect(t).toMatchObject({ direction: "MASUK", categoryId: bunga.id, status: "MENUNGGU_KONFIRMASI" });
    expect(t.date.toISOString()).toBe(jakartaDateTime("2032-11-10", "01:32").toISOString());
    expect(sent.at(-1)!.text).toContain("Pemasukan");
    expect(sent.at(-1)!.text).toContain("Bunga Bank");
    expect(sent.at(-1)!.buttons!.flat().some((b) => b.callback_data === `ok:${t.id}`)).toBe(true);
  });
});
