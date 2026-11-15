import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { matchEmployees, wordScore } from "@/lib/employeeMatch";
import { approvePeriod, cancelPayment, payPeriod, paySlip } from "@/lib/payroll";
import { checkAmount, prefilledGaji } from "@/lib/botGaji";
import { COA } from "@/lib/accounting";
import { approveAndBook, createTransaction, submitForConfirmation } from "@/lib/finance";
import { runConsistency } from "@/lib/consistency";
import { dateOnly, jakartaDateTime } from "@/lib/time";
import type { BotIdent } from "@/lib/botMenu";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
let actor: { id: string; name: string };
let bankId: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  bankId = (await prisma.bankAccount.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } })).id;
});

describe("Pencocokan nama karyawan", () => {
  const emps = [
    { id: "1", name: "Rico Febrianto", nickname: null },
    { id: "2", name: "Rico Saputra", nickname: null },
    { id: "3", name: "Dewi Kartika", nickname: "Wiwik" },
    { id: "4", name: "Bagus Mulyo Prasetyo", nickname: null },
  ];
  it("yakin: satu cocok (nama, panggilan, dua kata, salah ketik ringan)", () => {
    expect(matchEmployees("gaji bagus oktober 1.250.000", emps).sure?.id).toBe("4");
    expect(matchEmployees("bayaran wiwik", emps).sure?.id).toBe("3");
    expect(matchEmployees("gaji rico febri", emps).sure?.id).toBe("1");
    expect(matchEmployees("upah dewi kartka", emps).sure?.id).toBe("3");
    expect(matchEmployees("gaji mas bgus", emps).sure).toBeNull(); // terlalu jauh untuk yakin
  });
  it("ragu: lebih dari satu mirip → daftar mirip; tidak ada → kosong", () => {
    const r = matchEmployees("gaji rico nov", emps);
    expect(r.sure).toBeNull();
    expect(r.similar.map((e) => e.id).sort()).toEqual(["1", "2"]);
    expect(matchEmployees("gaji xyzab", emps)).toEqual({ sure: null, similar: [] });
    expect(wordScore("ric", "rico")).toBeGreaterThan(0.6);
  });
});

describe("Cek nominal bukti vs sisa slip", () => {
  it("sama / tidak terbaca = boleh; lebih besar atau sebagian = ditolak", () => {
    expect(checkAmount(1_000_000, 1_000_000).ok).toBe(true);
    expect(checkAmount(null, 1_000_000).ok).toBe(true);
    expect(checkAmount(1_100_000, 1_000_000).ok).toBe(false);
    expect(checkAmount(500_000, 1_000_000).ok).toBe(false);
    expect(checkAmount(0, 0).ok).toBe(false);
  });
});

describe("Bayar slip per karyawan (bot) = fungsi yang sama dengan web", () => {
  const SURNAMES = ["Kenanga", "Melati", "Anggrek", "Mawar", "Teratai"];
  let call = 0;
  async function period(code: string) {
    const surname = SURNAMES[call++ % SURNAMES.length];
    const div = await prisma.division.findFirstOrThrow();
    const mk = (n: string) => prisma.employee.create({ data: { code: `GJ-${n}-${code}`, name: `${n === "A" ? "Andika" : "Bambang"} ${surname}`, divisionId: div.id, joinDate: dateOnly("2033-01-01") } });
    const a = await mk("A");
    const b = await mk("B");
    const p = await prisma.payrollPeriod.create({ data: { code: `UJI-GJ-${code}`, startDate: dateOnly("2033-05-01"), endDate: dateOnly("2033-05-07") } });
    const slip = (employeeId: string, total: number) => prisma.payslip.create({ data: { periodId: p.id, employeeId, daysPresent: 5, dailyWage: BigInt(total), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), total: BigInt(total) } });
    const sa = await slip(a.id, 1_000_000);
    const sb = await slip(b.id, 500_000);
    await approvePeriod(p.id, actor);
    return { p, a, b, sa, sb };
  }
  const linesOf = (journalId: string) => prisma.journalLine.findMany({ where: { journalId }, include: { account: true } });

  it("jurnal pelunasan Hutang Gaji (bukan beban); slip lunas tidak bisa dibayar lagi; pesan sama ditolak; periode lunas saat semua slip dibayar", async () => {
    const { p, sa, sb } = await period(`${tag}A`);
    const r = await paySlip(sa.id, bankId, null, actor, jakartaDateTime("2033-05-10", "10:00"), { messageId: `m1-${tag}`, proofPath: "2033/05/bukti.jpg" });
    expect(r.done).toBe(false);
    const lines = await linesOf(r.journal!.id);
    expect(lines.find((l) => l.account.code === COA.UTANG_GAJI)?.debit).toBe(BigInt(1_000_000));
    expect(lines.some((l) => l.account.code === COA.BEBAN_GAJI_PRODUKSI)).toBe(false);
    expect(lines.reduce((t, l) => t + Number(l.credit), 0)).toBe(1_000_000);
    const paid = await prisma.payslip.findUniqueOrThrow({ where: { id: sa.id } });
    expect([!!paid.paidAt, paid.paidMessageId, paid.paidProofPath]).toEqual([true, `m1-${tag}`, "2033/05/bukti.jpg"]);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DISETUJUI");
    await expect(paySlip(sa.id, bankId, null, actor)).rejects.toThrow(/sudah dibayar/);
    await expect(paySlip(sb.id, bankId, null, actor, new Date(), { messageId: `m1-${tag}` })).rejects.toThrow(/sudah dipakai/);
    const r2 = await paySlip(sb.id, bankId, null, actor, jakartaDateTime("2033-05-10", "11:00"), { messageId: `m2-${tag}` });
    expect(r2.done).toBe(true);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DIBAYAR");
    await expect(payPeriod(p.id, bankId, null, actor)).rejects.toThrow(/lunas/);
    // Batal bayar: kedua jurnal per slip dibalik, slip kembali belum dibayar
    await cancelPayment(p.id, "uji batal", actor);
    expect(await prisma.journal.count({ where: { reversalOfId: { in: [r.journal!.id, r2.journal!.id] } } })).toBe(2);
    expect(await prisma.payslip.count({ where: { periodId: p.id, paidAt: { not: null } } })).toBe(0);
  });

  it("klik ganda bersamaan: hanya satu pembayaran; web Bayar melunasi sisa slip saja", async () => {
    const { p, sa } = await period(`${tag}B`);
    const res = await Promise.allSettled([paySlip(sa.id, bankId, null, actor, new Date(), { messageId: `d1-${tag}` }), paySlip(sa.id, bankId, null, actor, new Date(), { messageId: `d1-${tag}` })]);
    expect(res.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(await prisma.journal.count({ where: { source: "PAYROLL", sourceId: { startsWith: p.id } } })).toBe(1);
    const j = await payPeriod(p.id, bankId, null, actor, jakartaDateTime("2033-05-11", "10:00"));
    const lines = await linesOf((j as unknown as { id: string }).id);
    expect(lines.find((l) => l.account.code === COA.UTANG_GAJI)?.debit).toBe(BigInt(500_000));
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DIBAYAR");
  });

  it("bot: nama yakin langsung ke pilihan slip; bukti yang sudah dipakai tidak diproses lagi", async () => {
    const { a, sa } = await period(`${tag}C`);
    const i = { userId: actor.id, canSubmit: true, perms: new Set(["payroll.approve"]), user: { name: actor.name, role: "OWNER", divisionId: null, employeeId: null } } as unknown as BotIdent;
    const ctx = { i, chatId: "1" };
    const s = await prefilledGaji(ctx, { text: `gaji ${a.name}`, amount: 1_000_000, bankId, date: "2033-05-12", time: "10:00", proofPath: null, messageId: `b1-${tag}`, tx: null });
    expect([s?.step, s?.data.empId]).toEqual(["slip", a.id]);
    await paySlip(sa.id, bankId, null, actor, new Date(), { messageId: `b1-${tag}` });
    const again = await prefilledGaji(ctx, { text: `gaji ${a.name}`, amount: 1_000_000, bankId, date: "2033-05-12", time: "10:00", proofPath: null, messageId: `b1-${tag}`, tx: null });
    expect(again?.step).toBe("used");
    // Tanpa hak bayar gaji: tidak masuk isian ini
    const noPerm = { ...ctx, i: { ...i, perms: new Set() } as unknown as BotIdent };
    expect(await prefilledGaji(noPerm, { text: `gaji ${a.name}`, amount: null, bankId: null, date: null, time: null, proofPath: null, messageId: `b2-${tag}`, tx: null })).toBeNull();
  });

  it("Cek Konsistensi: beban gaji dicatat manual padahal slip disetujui", async () => {
    const { a } = await period(`${tag}D`);
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Gaji & Upah" } });
    const store = await prisma.store.findFirst();
    const { transaction: t } = await createTransaction({ direction: "KELUAR", amount: 1_000_000, date: jakartaDateTime("2033-05-09", "10:00"), accountId: bankId, categoryId: cat.id, note: `gaji ${a.name}`, storeId: store?.id ?? null }, "MANUAL", actor);
    await submitForConfirmation(t.id, actor);
    await approveAndBook(t.id, actor);
    const issue = (await runConsistency(jakartaDateTime("2033-05-20", "10:00"))).issues.find((x) => x.key === "gaji-beban-manual");
    expect(issue?.items.some((x) => x.label.includes(a.name))).toBe(true);
  });
});
