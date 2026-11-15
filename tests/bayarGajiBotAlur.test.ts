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
import { approvePeriod } from "@/lib/payroll";
import { dateOnly } from "@/lib/time";

const TG = 777321;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 500_000;
const say = (text: string, message_id = n++) => handleTelegramUpdate({ update_id: n++, message: { message_id, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const buttons = () => (sent.at(-1)?.buttons ?? []).flat();

beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
});

describe("Bot: bayar slip gaji dari pesan", () => {
  let slipId: string;
  let bankName: string;
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
    const div = await prisma.division.findFirstOrThrow();
    // Jalankan ulang tanpa reset database: karyawan uji lama dinonaktifkan agar nama tidak kembar
    await prisma.employee.updateMany({ where: { name: "Prayogo Wicaksono" }, data: { status: "NONAKTIF" } });
    const e = await prisma.employee.create({ data: { code: `GJBOT-${n}`, name: "Prayogo Wicaksono", divisionId: div.id, joinDate: dateOnly("2033-01-01") } });
    const p = await prisma.payrollPeriod.create({ data: { code: `UJI-BOT-${n}`, startDate: dateOnly("2033-06-01"), endDate: dateOnly("2033-06-07") } });
    slipId = (await prisma.payslip.create({ data: { periodId: p.id, employeeId: e.id, daysPresent: 5, dailyWage: BigInt(750000), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), total: BigInt(750000) } })).id;
    await approvePeriod(p.id, { id: u.id, name: u.name });
    bankName = (await prisma.bankAccount.findFirstOrThrow({ where: { active: true, code: "SEABANK" } })).name;
  });

  it("pesan → pilih slip → ringkasan → bayar; tidak ada draft transaksi; pesan sama tidak dibayar dua kali", async () => {
    sent.length = 0;
    // Draft dari pesan Telegram (baris cermin "Gaji" dari jurnal pembayaran memang dibuat, sama seperti bayar di web)
    const drafts = () => prisma.financeTransaction.count({ where: { telegramChatId: String(TG) } });
    const before = await drafts();
    const mid = n++;
    await say("gaji prayogo 750rb dari seabank", mid);
    expect(await drafts()).toBe(before);
    const pay = buttons().find((b) => b.text.startsWith("Bayar slip"));
    expect(pay).toBeTruthy();
    expect(buttons().some((b) => b.text.includes("Bukan gaji slip"))).toBe(true);
    await tap(pay!.callback_data);
    const summary = sent.at(-1)!.text;
    expect(summary).toContain("Prayogo Wicaksono");
    expect(summary).toContain(bankName);
    expect(summary).toMatch(/cocok/);
    await tap("f:ok");
    await tap("f:ok"); // klik ganda
    const slip = await prisma.payslip.findUniqueOrThrow({ where: { id: slipId } });
    expect(slip.paidMessageId).toBe(String(mid));
    expect(slip.paidJournalId).toBeTruthy();
    expect(await prisma.journal.count({ where: { source: "PAYROLL", sourceId: { startsWith: slip.periodId } } })).toBe(1);
    expect(await drafts()).toBe(before);
    // Pesan yang sama terkirim ulang (mis. webhook diulang) → tidak diproses lagi
    sent.length = 0;
    await say("gaji prayogo 750rb dari seabank", mid);
    expect(sent.some((m) => m.text.includes("sudah dipakai"))).toBe(true);
    // Pesan baru untuk karyawan yang sama: tidak ada slip tersisa
    sent.length = 0;
    await say("gaji prayogo 750rb dari seabank");
    expect(sent.at(-1)!.text).toMatch(/Tidak ada slip gaji/);
  });

  it("nominal lebih besar dari sisa slip: tombol Bayar tidak muncul", async () => {
    const { cancelPayment } = await import("@/lib/payroll");
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await cancelPayment((await prisma.payslip.findUniqueOrThrow({ where: { id: slipId } })).periodId, "uji", { id: u.id, name: u.name });
    sent.length = 0;
    await say("gaji prayogo 900rb dari seabank");
    await tap(buttons().find((b) => b.text.startsWith("Bayar slip"))!.callback_data);
    expect(sent.at(-1)!.text).toMatch(/LEBIH BESAR/);
    expect(buttons().some((b) => b.callback_data === "f:ok")).toBe(false);
  });
});
