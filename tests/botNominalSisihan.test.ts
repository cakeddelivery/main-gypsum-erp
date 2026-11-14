import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Laporan grup "Laporan Magy" 14 Nov 2026:
 * 1. "Gaji Rico periode oktober 1250.000 pada tanggal 12 november 2026" → bot tidak membaca nominal (pemisah tidak standar).
 * 2. Bukti SeaBank 5984 → 0006 Rp300.000, caption "Dana sisihan bayar hutang 11 november", catatan bukti
 *    "Nabung Spinjam 11 Nov 26" → bot tidak mengenali sisihan (caption dibaca sebagai bayar hutang).
 * Data uji memakai tahun 2032 agar tidak bercampur dengan tes lain.
 */
const sent: { text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
const read = vi.hoisted(() => ({ next: null as unknown, ocr: "" }));
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
vi.mock("@/lib/ocrReceipt", () => ({ ocrReceipt: vi.fn(async () => null), ocrImageText: vi.fn(async () => read.ocr) }));

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { parseIDR } from "@/lib/money";
import { extractAmount, extractTransaction } from "@/lib/extract";
import { reserveIntent } from "@/lib/reserveSync";
import { dateOnly } from "@/lib/time";

const TG = 777140;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = 1_400_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const photo = (caption: string, receipt: unknown, ocr = "") => {
  read.next = receipt;
  read.ocr = ocr;
  return handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, caption, photo: [{ file_id: `f${n}` }] } } as never);
};
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });

let seabank: string;
let tab0006: string;
let loanFund: string;
const oldLoanFunds: string[] = [];

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true, chatId: String(TG) } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  const coa = await prisma.coaAccount.upsert({ where: { code: "1-1297" }, create: { code: "1-1297", name: "Seabank 0006 (uji nominal)", type: "ASET", isCash: true }, update: {} });
  tab0006 = (await prisma.bankAccount.upsert({ where: { code: "UJI_NOM_0006" }, create: { code: "UJI_NOM_0006", name: "Seabank 0006 Nom", coaAccountId: coa.id, aliases: "0006" }, update: { active: true } })).id;
  const store = await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } });
  for (const f of await prisma.reserveFund.findMany({ where: { kind: "LOAN_SAVING", active: true } })) oldLoanFunds.push(f.id);
  await prisma.reserveFund.updateMany({ where: { id: { in: oldLoanFunds } }, data: { active: false } });
  loanFund = (await prisma.reserveFund.create({ data: { name: "Nabung Bayar Hutang (uji nominal)", kind: "LOAN_SAVING", dailyAmount: BigInt(300_000), fromBankId: seabank, toBankId: tab0006, storeId: store.value } })).id;
});
afterAll(async () => {
  await prisma.reserveFund.update({ where: { id: loanFund }, data: { active: false } });
  await prisma.reserveFund.updateMany({ where: { id: { in: oldLoanFunds } }, data: { active: true } });
  await prisma.bankAccount.update({ where: { id: tab0006 }, data: { active: false } });
});
beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
  sent.length = 0;
});

describe("Nominal dengan pemisah tidak standar", () => {
  it("1250.000, 1.250000, 1,250,000, 1.250.000,00, 1250rb, 1,25jt → 1.250.000", () => {
    for (const x of ["1250.000", "1.250000", "1,250,000", "1.250.000,00", "1,250,000.00", "1250rb", "1,25jt", "1.250rb", "Rp 1.250.000", "1250000"]) expect(parseIDR(x), x).toBe(1_250_000);
    expect(parseIDR("1,5jt")).toBe(1_500_000);
    expect(parseIDR("150rb")).toBe(150_000);
  });

  it("tanggal, jam, kuantitas, dan angka kecil tidak terbaca sebagai nominal", () => {
    expect(extractAmount("Gaji Rico periode oktober 1250.000 pada tanggal 12 november 2026")).toBe(1_250_000);
    expect(extractAmount("Pembayaran Gaji Rico periode oktober senilai 1250.000 pada tanggal 12 november 2026")).toBe(1_250_000);
    expect(extractAmount("gaji rico 1.250000 tgl 12/11/2026")).toBe(1_250_000);
    expect(extractAmount("gaji rico 1,250,000")).toBe(1_250_000);
    expect(extractAmount("beli 2000 pcs plastik 150rb")).toBe(150_000);
    expect(extractAmount("jam 12.30 bayar 50.000")).toBe(50_000);
    expect(extractAmount("nabung spinjam 11 nov 26")).toBeNull();
    expect(extractAmount("bayar 2.5 kg gula")).toBeNull();
    expect(extractAmount("gaji periode oktober tanggal 12 november 2026")).toBeNull();
  });

  it("pesan gaji lengkap: keluar, kategori Gaji & Upah, tanggal 12 Nov", async () => {
    const banks = await prisma.bankAccount.findMany({ where: { active: true } });
    const cats = await prisma.txCategory.findMany({ where: { active: true } });
    const ex = extractTransaction("Pembayaran Gaji Rico periode oktober senilai 1250.000 pada tanggal 12 november 2026", banks, cats);
    expect(ex).toMatchObject({ amount: 1_250_000, direction: "KELUAR", date: "2026-11-12" });
    expect(cats.find((c) => c.id === ex.categoryId)?.name).toBe("Gaji & Upah");
  });
});

describe("Bot: pesan gaji", () => {
  it("nominal terbaca → draft; gaji yang sudah disetujui di Penggajian diberi peringatan agar tidak dobel", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const emp = await prisma.employee.create({ data: { code: "UJI-RICO", name: "Rico Ujinominal", nickname: "Rico", divisionId: div.id, wageType: "BULANAN", monthlySalary: BigInt(1_250_000) } });
    await say("Gaji Rico periode oktober 1250.000 pada tanggal 12 november 2026");
    let last = sent.map((s) => s.text).join("\n");
    expect(last).not.toContain("belum bisa membaca");
    expect(last).toContain("1.250.000");
    expect(last).toContain("Gaji karyawan: Rico Ujinominal");

    const p = await prisma.payrollPeriod.create({ data: { code: "GJB-UJI-RICO", kind: "BULANAN", status: "DISETUJUI", startDate: dateOnly("2032-09-29"), endDate: dateOnly("2032-10-28") } });
    await prisma.payslip.create({ data: { periodId: p.id, employeeId: emp.id, daysPresent: 26, dailyWage: BigInt(0), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), total: BigInt(1_250_000) } });
    sent.length = 0;
    await say("Pembayaran Gaji Rico periode oktober senilai 1.300.000 pada tanggal 20 november 2026");
    last = sent.map((s) => s.text).join("\n");
    expect(last).toContain("sudah tercatat di Penggajian");
    expect(last).toContain("GJB-UJI-RICO");
  });
});

describe("Kata kunci sisihan", () => {
  it("sinonim tabungan cicilan & OPS", () => {
    expect(reserveIntent("Dana sisihan bayar hutang 11 november")).toBe("LOAN_SAVING");
    expect(reserveIntent("sisihan hutang 11 nov")).toBe("LOAN_SAVING");
    expect(reserveIntent("dana sisihan cicilan")).toBe("LOAN_SAVING");
    expect(reserveIntent("Nabung Spinjam 11 Nov 26")).toBe("LOAN_SAVING");
    expect(reserveIntent("dana ops 11 nov")).toBe("OWNER");
    expect(reserveIntent("sisihan ops 11 nov")).toBe("OWNER");
    expect(reserveIntent("bayar hutang kardus afdhol")).toBeNull();
  });
});

describe("Bot: bukti transfer nabung bayar hutang", () => {
  const proof = { amount: 300_000, date: "2032-11-11", time: "20:15", direction: "KELUAR", account: "SeaBank", toAccount: null, counterparty: "SeaBank 0006 Hidxxxx" };

  it("caption 'Dana sisihan bayar hutang 11 november 2032' → kartu sisihan Nabung Bayar Hutang, bukan bayar hutang", async () => {
    await photo("Dana sisihan bayar hutang 11 november 2032", proof);
    expect(await session()).toMatchObject({ flow: "sish", step: "confirm" });
    expect(sent.at(-1)!.text).toContain("Sisihan Nabung Bayar Hutang 11 Nov");
  });

  it("caption tidak jelas, berita transfer di bukti 'Nabung Spinjam 12 Nov 32' → tetap dikenali", async () => {
    await photo("transfer", { ...proof, date: "2032-11-12" }, "Transfer Berhasil\nRp300.000\nCatatan\nNabung Spinjam 12 Nov 32\nSeaBank 0006");
    expect(await session()).toMatchObject({ flow: "sish", step: "confirm" });
    expect(sent.at(-1)!.text).toContain("Sisihan Nabung Bayar Hutang 12 Nov");
  });

  it("caption hanya 'sisihan' + bukti 5984 → 0006 = tabungan cicilan dari alur rekening", async () => {
    await photo("sisihan 13 nov 2032", { ...proof, date: "2032-11-13", direction: "TRANSFER", toAccount: "Seabank 0006 Nom" });
    expect(await session()).toMatchObject({ flow: "sish", step: "confirm" });
    expect(sent.at(-1)!.text).toContain("Sisihan Nabung Bayar Hutang 13 Nov");
  });
});
