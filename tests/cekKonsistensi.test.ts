import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { runConsistency, consistencyText } from "@/lib/consistency";
import { activeDuplicateJournals } from "@/lib/auditChecks";
import { applyDueResignations } from "@/lib/payroll";
import { createPurchase } from "@/lib/purchase";
import { closePurchase } from "@/lib/purchaseReceive";
import { createTransaction } from "@/lib/finance";
import { sendConsistencyReport } from "@/lib/jobs";
import { dateOnly, jakartaDateTime, resignEffective } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
let bankId: string;
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const find = async (key: string) => (await runConsistency()).issues.find((i) => i.key === key);

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  bankId = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Cek konsistensi: uang", () => {
  it("jurnal tidak seimbang / kurang dari 2 baris terdeteksi dengan tautannya", async () => {
    const acc = await prisma.coaAccount.findFirstOrThrow({ where: { code: "6-9000" } });
    await prisma.journal.create({ data: { number: `JU-UJI-${tag}`, date: new Date(), storeId, description: "uji tidak seimbang", source: "MANUAL", createdBy: "uji", lines: { create: [{ accountId: acc.id, debit: BigInt(0), credit: BigInt(0) }] } } });
    const i = await find("jurnal-tidak-seimbang");
    expect(i?.level).toBe("KRITIS");
    expect(i?.items.find((x) => x.label === `JU-UJI-${tag}`)).toMatchObject({ href: `/akuntansi/jurnal?q=JU-UJI-${tag}` });
  });

  it("transaksi draft lebih dari 3 hari dianggap menggantung", async () => {
    const r = await createTransaction({ direction: "KELUAR", amount: 12_345, date: new Date(), accountId: bankId, note: `draft uji ${tag}` }, "MANUAL", actor);
    await prisma.financeTransaction.update({ where: { id: r.transaction.id }, data: { createdAt: new Date(Date.now() - 5 * 86_400_000) } });
    expect((await find("trx-menggantung"))?.items.map((x) => x.label)).toContain(r.transaction.number);
  });

  it("tutup pesanan (refund uang muka) tidak lagi terbaca sebagai jurnal ganda", async () => {
    const divisionId = (await prisma.division.findFirstOrThrow()).id;
    const it = await prisma.item.create({ data: { sku: `BB-KNS-${tag}`, name: "Bahan cek konsistensi", type: "BAHAN_BAKU", unit: "sak", divisionId } });
    const p = await createPurchase({ supplierId: null, newSupplierName: "Toko Konsistensi", note: null, storeId, date: jakartaDateTime("2027-08-01", "10:00"), term: "LUNAS", paidNow: 0, bankAccountId: bankId, inTransit: true, lines: [{ itemId: it.id, qty: 2, amount: 200_000 }] }, actor);
    await closePurchase(p.id, "tidak datang", actor, jakartaDateTime("2027-08-05", "10:00"));
    const dup = await activeDuplicateJournals(prisma, new Date(0));
    expect(dup.some((g) => g.sourceId === p.number)).toBe(false);
  });

  it("ringkasan bot hanya bila ada Kritis/Sedang, dan job mencatat hasilnya", async () => {
    const r = await runConsistency();
    const text = consistencyText(r, (s) => s, "https://erp.contoh");
    expect(text).toContain("Cek konsistensi harian");
    expect(text).toContain("/akuntansi/konsistensi");
    expect(consistencyText({ ...r, issues: r.issues.filter((i) => i.level === "INFO") }, (s) => s, "")).toBeNull();
    const res = await sendConsistencyReport();
    expect(res.kritis).toBeGreaterThan(0);
    expect(await prisma.notificationLog.count({ where: { type: "CEK_KONSISTENSI" } })).toBeGreaterThan(0);
  });
});

describe("Resign terjadwal", () => {
  it("sebelum tanggalnya akun tetap aktif; saat tiba: Nonaktif + akun dimatikan + login/bot ditolak", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const e = await prisma.employee.create({ data: { code: `RSG-${tag}`, name: `Resign Terjadwal ${tag}`, divisionId: div.id, resignDate: dateOnly("2030-01-10") } });
    const u = await prisma.user.create({ data: { username: `rsg${tag.toLowerCase()}`, name: e.name, role: "OPERATOR", employeeId: e.id, passwordHash: "x" } });
    expect(resignEffective(e.resignDate, jakartaDateTime("2030-01-09", "23:00"))).toBe(false);
    await applyDueResignations(jakartaDateTime("2030-01-09", "23:00"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).active).toBe(true);
    expect(resignEffective(e.resignDate, jakartaDateTime("2030-01-10", "00:30"))).toBe(true);
    const r = await applyDueResignations(jakartaDateTime("2030-01-10", "06:00"));
    expect(r.applied).toContain(e.name);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("NONAKTIF");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).active).toBe(false);
    // Aman diulang
    expect((await applyDueResignations(jakartaDateTime("2030-01-11", "06:00"))).applied).not.toContain(e.name);
  });

  it("karyawan resign yang akunnya masih aktif muncul di Cek konsistensi", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const e = await prisma.employee.create({ data: { code: `RSG2-${tag}`, name: `Resign Lupa ${tag}`, divisionId: div.id, status: "NONAKTIF", resignDate: dateOnly("2026-11-01") } });
    await prisma.user.create({ data: { username: `rsl${tag.toLowerCase()}`, name: e.name, role: "OPERATOR", employeeId: e.id, passwordHash: "x" } });
    expect((await find("akses-setelah-resign"))?.items.map((x) => x.label)).toContain(e.name);
  });
});

describe("Cek konsistensi: gaji", () => {
  it("dua slip yang tumpang tindih untuk satu karyawan = risiko dibayar dua kali", async () => {
    const div = await prisma.division.findFirstOrThrow();
    const e = await prisma.employee.create({ data: { code: `DBL-${tag}`, name: `Gaji Dobel ${tag}`, divisionId: div.id, wageType: "BULANAN" } });
    for (const [code, s, t] of [[`GJB-A-${tag}`, "2031-01-01", "2031-01-31"], [`GJB-B-${tag}`, "2031-01-15", "2031-02-14"]]) {
      const p = await prisma.payrollPeriod.create({ data: { code, kind: "BULANAN", startDate: dateOnly(s), endDate: dateOnly(t) } });
      await prisma.payslip.create({ data: { periodId: p.id, employeeId: e.id, daysPresent: 0, dailyWage: BigInt(0), pieceWage: BigInt(0), pieceDetail: [], transport: BigInt(0), total: BigInt(0) } });
    }
    expect((await find("gaji-dobel"))?.items.map((x) => x.label)).toContain(e.name);
  });
});
