import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { bookPayablePayment } from "@/lib/finance";
import { createLoanRecord } from "@/lib/payables";
import { withdrawReserve, postReserve } from "@/lib/reserve";
import { jakartaDateTime } from "@/lib/time";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
const actor = { id: "u-audit", name: "uji-audit2" };
const date = jakartaDateTime("2026-11-21", "12:00");

describe("Audit Keuangan tahap 2 — klik ganda / paralel", () => {
  it("bayar hutang (web): kirim ganda berturut & paralel hanya mencatat satu", async () => {
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { active: true, marketplace: false } });
    const store = await prisma.store.findFirstOrThrow();
    const p = await prisma.payable.create({ data: { number: `UTG-UJI-${Date.now()}`, vendor: "Pemasok Uji", storeId: store.id, date, amount: BigInt(1_000_000) } });
    const pay = () => bookPayablePayment({ payableId: p.id, amount: 100_000, bankAccountId: bank.id, date }, "MANUAL", actor);
    const r = await Promise.allSettled([pay(), pay(), pay()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const msg = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(msg.reason.message)).toMatch(/sama persis.*catatan yang berbeda/);
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(100_000);
    // catatan berbeda = sengaja → sah
    await expect(bookPayablePayment({ payableId: p.id, amount: 100_000, bankAccountId: bank.id, date, note: "cicilan ke-2 sengaja" }, "MANUAL", actor)).resolves.toBeTruthy();
  });

  it("pinjaman: pencatatan ganda paralel hanya membuat satu", async () => {
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { active: true, marketplace: false } });
    const mk = () => createLoanRecord({ lender: "Bank Uji Audit", amount: 5_000_000, date, bankAccountId: bank.id }, { id: actor.id, name: actor.name });
    const r = await Promise.allSettled([mk(), mk()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.payable.count({ where: { vendor: "Bank Uji Audit" } })).toBe(1);
  });

  it("tarik dana sisihan: klik ganda paralel hanya menarik sekali", async () => {
    const [from, to] = await prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, take: 2 });
    const store = await prisma.store.findFirstOrThrow();
    const f = await prisma.reserveFund.create({ data: { name: "Dana Uji Audit", kind: "OWNER", dailyAmount: BigInt(100_000), fromBankId: from.id, toBankId: to.id, storeId: store.id } });
    await postReserve(f.id, "2026-11-21", actor, 500_000);
    const w = () => withdrawReserve(f.id, 100_000, "2026-11-22", actor, null);
    const r = await Promise.allSettled([w(), w()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.reserveEntry.count({ where: { fundId: f.id, type: "TARIK" } })).toBe(1);
  });
});
