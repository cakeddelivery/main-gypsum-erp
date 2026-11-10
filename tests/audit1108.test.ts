import { beforeAll, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (_c: string, text: string) => (sent.push(text), { ok: true })),
    editTelegram: vi.fn(async () => ({ ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
  };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { approvePeriod, computePeriod } from "@/lib/payroll";
import { autoCloseDay, runDueJobs } from "@/lib/jobs";
import { dateOnly, jakartaDateTime, jakartaParts } from "@/lib/time";

const TG = 77001108;
const chat = { id: TG };
const from = { id: TG, first_name: "Operator" };
let n = 1;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
});

describe("Audit 8 Nov: bot", () => {
  it("/rekap ditolak untuk akun tanpa izin ringkasan keuangan", async () => {
    sent.length = 0;
    await say("/rekap");
    expect(sent.join("\n")).toMatch(/tidak berwenang/);
    expect(sent.join("\n")).not.toMatch(/Saldo rekening/);
  });

  it("pesan bebas dari akun tanpa izin input transaksi tidak menjadi draft", async () => {
    sent.length = 0;
    const before = await prisma.financeTransaction.count();
    await say("bayar listrik 350rb dari seabank");
    expect(await prisma.financeTransaction.count()).toBe(before);
    expect(sent.join("\n")).toMatch(/tidak memiliki izin mengirim transaksi/);
  });
});

describe("Audit 8 Nov: gaji & jadwal", () => {
  it("persetujuan gaji ditahan bila ada absen hadir belum divalidasi", async () => {
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: { not: "NONAKTIF" } } });
    await prisma.employee.update({ where: { id: emp.id }, data: { wageType: "HARIAN", dailyRate: BigInt(100_000) } });
    const shift = await prisma.shift.findFirstOrThrow();
    const day = "2027-03-03";
    await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: emp.id, date: dateOnly(day) } },
      create: { employeeId: emp.id, shiftId: shift.id, date: dateOnly(day), checkIn: jakartaDateTime(day, "07:00"), status: "HADIR", validated: true },
      update: { validated: true },
    });
    const p = await prisma.payrollPeriod.create({ data: { code: "AUDIT-1108", kind: "PERIODE", startDate: dateOnly("2027-03-01"), endDate: dateOnly("2027-03-07") } });
    const actor = { id: "t", name: "Tes" };
    await computePeriod(p.id, actor);
    const day2 = "2027-03-04";
    await prisma.attendance.create({ data: { employeeId: emp.id, shiftId: shift.id, date: dateOnly(day2), checkIn: jakartaDateTime(day2, "07:00"), status: "HADIR", validated: false } });
    await expect(approvePeriod(p.id, actor)).rejects.toThrow(/belum divalidasi/);
    await prisma.attendance.updateMany({ where: { employeeId: emp.id, date: dateOnly(day2) }, data: { validated: true } });
    await computePeriod(p.id, actor);
    await approvePeriod(p.id, actor);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DISETUJUI");
  });

  it("tutup buku otomatis default tanggal 10, bukan tanggal 1", async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ["auto_close_day", "job_month_close_last"] } } });
    expect(await autoCloseDay()).toBe(10);
    const r1 = await runDueJobs(jakartaDateTime("2027-02-01", "09:30"));
    expect(r1.monthClose).toBeUndefined();
    expect(await prisma.accountingPeriod.findUnique({ where: { year_month: { year: 2027, month: 1 } } })).toBeNull();
    const r10 = await runDueJobs(jakartaDateTime("2027-02-10", "09:30"));
    expect(r10.monthClose).toBeDefined();
    expect((await prisma.accountingPeriod.findUniqueOrThrow({ where: { year_month: { year: 2027, month: 1 } } })).status).toBe("CLOSED");
    // Bulan-bulan lama yang masih terbuka ikut ditutup (dari bulan jurnal pertama)
    const first = await prisma.journal.findFirst({ orderBy: { date: "asc" } });
    if (first && first.date < jakartaDateTime("2027-01-01", "00:00")) {
      const p = jakartaParts(first.date);
      expect((await prisma.accountingPeriod.findUnique({ where: { year_month: { year: p.year, month: p.month } } }))?.status).toBe("CLOSED");
    }
    // Dibuka lagi: tes lain (gaji/tunjangan Jan 2027, transaksi 2026) masih membukukan di periode ini
    await prisma.accountingPeriod.updateMany({ where: { closedBy: "Sistem (terjadwal)" }, data: { status: "OPEN" } });
  });
});
