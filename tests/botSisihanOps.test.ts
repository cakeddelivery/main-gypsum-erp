import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Laporan 10 Nov: foto bukti SeaBank + caption "OPS 9 nov" jadi draft Pengeluaran dari ShopeePay (nama penerima
 * "Shopeepay Nur Anj… Hid…" terbaca sebagai rekening). Seharusnya transfer sisihan Kompensasi Pengelola
 * Seabank → ShopeePay untuk 9 Nov, menyerap "Sisihan otomatis" 9 Nov. Sama untuk "Nabung Spinjam 9 Nov".
 * Data uji memakai November 2031 ("OPS 9 nov 2031") agar tidak bercampur dengan November 2026. Jam sistem tidak
 * dipalsukan: kolom updatedAt sesi bot diisi jam database.
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
import { postReserve } from "@/lib/reserve";
import { reserveIntent } from "@/lib/reserveSync";
import { detectManagerLoan } from "@/lib/extract";
import { jakartaDateTime } from "@/lib/time";

const TG = 777110;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = 900_000;
const photo = (caption: string, receipt: unknown) => {
  read.next = receipt;
  return handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, caption, photo: [{ file_id: `f${n}` }] } } as never);
};
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const btns = () => sent.at(-1)?.buttons?.flat().map((b) => b.callback_data) ?? [];
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });
const bal = async (id: string) => {
  const b = await prisma.bankAccount.findUniqueOrThrow({ where: { id } });
  const s = await prisma.journalLine.aggregate({ where: { accountId: b.coaAccountId }, _sum: { debit: true, credit: true } });
  return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
};

let owner: { id: string; name: string };
let seabank: string;
let shopeepay: string;
let tab0006: string;
let loanFund: string;
const OPS = { amount: 200_000, date: "2031-11-09", time: "21:32", direction: "KELUAR", account: "ShopeePay", toAccount: null, counterparty: "Shopeepay Nur Anjxxx Hidxxxx" };

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true, chatId: String(TG) } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  shopeepay = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } })).id;
  const coa = await prisma.coaAccount.upsert({ where: { code: "1-1296" }, create: { code: "1-1296", name: "Seabank 0006 (uji ops)", type: "ASET", isCash: true }, update: {} });
  tab0006 = (await prisma.bankAccount.upsert({ where: { code: "UJI_OPS_0006" }, create: { code: "UJI_OPS_0006", name: "Seabank 0006 Uji", coaAccountId: coa.id, aliases: "0006" }, update: { active: true } })).id;
  const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
  await prisma.reserveFund.updateMany({ where: { kind: "LOAN_SAVING", active: true }, data: { active: false } });
  loanFund = (await prisma.reserveFund.create({ data: { name: "Nabung Bayar Hutang (uji ops)", kind: "LOAN_SAVING", dailyAmount: BigInt(300_000), fromBankId: seabank, toBankId: tab0006, storeId: store.value } })).id;
  // Sisihan otomatis 9 Nov (dicatat sistem tanpa bukti), seperti di production
  for (const f of await prisma.reserveFund.findMany({ where: { active: true } })) await postReserve(f.id, "2031-11-09", owner);
});
afterAll(async () => {
  await prisma.reserveFund.update({ where: { id: loanFund }, data: { active: false } });
  await prisma.bankAccount.update({ where: { id: tab0006 }, data: { active: false } });
});
beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
  sent.length = 0;
});

describe("Kata kunci transfer sisihan", () => {
  it("OPS = Kompensasi Pengelola; Nabung SPinjam = tabungan cicilan, bukan pinjaman pengelola", () => {
    expect(reserveIntent("OPS 9 nov")).toBe("OWNER");
    expect(reserveIntent("Nabung SPinjam 9 Nov")).toBe("LOAN_SAVING");
    expect(reserveIntent("nabung bayar hutang 9/11")).toBe("LOAN_SAVING");
    expect(reserveIntent("beli lakban")).toBeNull();
    expect(detectManagerLoan("Nabung SPinjam 9 Nov")).toBeNull();
    // Pinjaman pengelola tetap dikenali lebih dulu
    expect(detectManagerLoan("Edy pinjam dana OPS untuk pribadi")).toBe("PINJAM");
  });
});

describe("Bot: bukti transfer OPS / Nabung Spinjam", () => {
  it("OPS 9 nov → transfer sisihan Kompensasi Pengelola Seabank → ShopeePay, sisihan otomatis 9 Nov diserap", async () => {
    const auto = await prisma.financeTransaction.findMany({ where: { origin: "SISIHAN", status: "DIBUKUKAN", toAccountId: shopeepay, date: { gte: jakartaDateTime("2031-11-09", "00:00"), lt: jakartaDateTime("2031-11-10", "00:00") } } });
    expect(auto.length).toBeGreaterThan(0);
    const before = { sea: await bal(seabank), sp: await bal(shopeepay) };
    const txBefore = await prisma.financeTransaction.count();

    await photo("OPS 9 nov 2031", OPS);
    expect(await prisma.financeTransaction.count()).toBe(txBefore);
    expect(await session()).toMatchObject({ flow: "sish", step: "confirm" });
    expect(sent.at(-1)!.text).toContain("Sisihan Kompensasi Pengelola 9 Nov");
    expect(sent.at(-1)!.text).toContain("Seabank → ShopeePay");
    expect(btns()).toContain("f:ok");

    await tap("f:ok");
    expect(sent.at(-1)!.text).toContain("Sisihan tersimpan");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { origin: null, direction: "TRANSFER", toAccountId: shopeepay }, orderBy: { createdAt: "desc" }, include: { reserveEntries: true } });
    expect(t).toMatchObject({ status: "DIBUKUKAN", accountId: seabank, toAccountId: shopeepay, duplicateOfId: null });
    expect(t.date.toISOString()).toBe(jakartaDateTime("2031-11-09", "21:32").toISOString());
    expect(t.proofPath).toBeTruthy();
    expect(t.reserveEntries.map((e) => e.date.toISOString().slice(0, 10))).toEqual(["2031-11-09", "2031-11-09"]);
    expect(t.reserveEntries.every((e) => e.proofPath)).toBe(true);
    // "Sisihan otomatis" 9 Nov Dibatalkan, saldo tidak dobel
    for (const a of auto) expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("DIBATALKAN");
    expect(await bal(shopeepay)).toBe(before.sp);
    expect(await bal(seabank)).toBe(before.sea);
  });

  it("bukti OPS 9 Nov dikirim lagi → ditanyakan sebagai duplikat; OPS 8 Nov di hari yang sama bukan duplikat", async () => {
    await photo("OPS 9 nov 2031", OPS);
    await tap("f:ok");
    expect(sent.at(-1)!.text).toContain("Mirip transaksi yang sudah ada");
    await tap("f:dupno");
    expect(await session()).toBeNull();

    await photo("OPS 8 nov 2031", { ...OPS, time: "21:40" });
    expect(sent.at(-1)!.text).toContain("Sisihan Kompensasi Pengelola 8 Nov");
    await tap("f:ok");
    expect(sent.at(-1)!.text).toContain("Sisihan tersimpan");
    const e8 = await prisma.reserveEntry.findMany({ where: { date: new Date("2031-11-08T00:00:00Z"), type: "SISIH", transactionId: { not: null } } });
    expect(e8).toHaveLength(2);
  });

  it("Nabung Spinjam 9 Nov → transfer Seabank → 0006, sisihan otomatis tabungan diserap", async () => {
    const auto = await prisma.reserveEntry.findFirstOrThrow({ where: { fundId: loanFund, date: new Date("2031-11-09T00:00:00Z"), type: "SISIH" } });
    const mirror = await prisma.financeTransaction.findFirstOrThrow({ where: { journalId: auto.journalId! } });
    const before = await bal(tab0006);
    await photo("Nabung Spinjam 9 Nov 2031", { amount: 300_000, date: "2031-11-09", time: "21:35", direction: "KELUAR", account: "SeaBank", toAccount: null, counterparty: "SeaBank 0006 Hidxxxx" });
    expect(sent.at(-1)!.text).toContain("Sisihan Nabung Bayar Hutang 9 Nov");
    await tap("f:ok");
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { origin: null, toAccountId: tab0006 }, orderBy: { createdAt: "desc" } });
    expect(t).toMatchObject({ status: "DIBUKUKAN", direction: "TRANSFER", accountId: seabank });
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: mirror.id } })).status).toBe("DIBATALKAN");
    expect((await prisma.reserveEntry.findUniqueOrThrow({ where: { id: auto.id } })).transactionId).toBe(t.id);
    expect(await bal(tab0006)).toBe(before);
  });
});
