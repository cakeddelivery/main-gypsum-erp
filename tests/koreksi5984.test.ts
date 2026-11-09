import { afterAll, describe, expect, it } from "vitest";

// Dana "Nabung Bayar Hutang" uji dinonaktifkan setelah tes agar tidak ikut "sisihkan semua" di tes lain
afterAll(async () => {
  await prisma.reserveFund.updateMany({ where: { name: "Nabung Bayar Hutang" }, data: { active: false } });
});
import { prisma } from "@/lib/db";
import { approveAndBook, bankBalances, createTransaction } from "@/lib/finance";
import { postAllReserves } from "@/lib/reserve";
import { jakartaDateTime } from "@/lib/time";
import { ADJ_0006, koreksiSaldo5984, NABUNG } from "../scripts/koreksi-saldo-5984";

describe("Skrip koreksi saldo Seabank 5984 (catat transaksi terlewat/dobel)", () => {
  it("pratinjau tidak menyimpan; jalankan = bunga, batal bunga dobel, Shopee, nabung dobel = sisihan 9 Nov, penyesuaian 0006; aman diulang", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: owner.id, name: owner.name };
    const s5984 = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const coa = await prisma.coaAccount.upsert({ where: { code: "1-1290" }, create: { code: "1-1290", name: "Seabank 0006 (uji)", type: "ASET", isCash: true }, update: {} });
    const s0006 = await prisma.bankAccount.upsert({ where: { code: "SEABANK0006" }, create: { code: "SEABANK0006", name: "Seabank 0006", coaAccountId: coa.id }, update: {} });
    const fund =
      (await prisma.reserveFund.findFirst({ where: { kind: "LOAN_SAVING", fromBankId: s5984.id, toBankId: s0006.id } })) ??
      (await prisma.reserveFund.create({ data: { name: "Nabung Bayar Hutang", kind: "LOAN_SAVING", dailyAmount: BigInt(300_000), fromBankId: s5984.id, toBankId: s0006.id, storeId: (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id } }));
    // Bunga 1 Nov yang dobel
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Pendapatan Lain" } });
    const { transaction: b } = await createTransaction({ direction: "MASUK", amount: 504, date: jakartaDateTime("2026-11-01", "01:00"), accountId: s5984.id, categoryId: cat.id, note: "Bunga tabungan uji" }, "MANUAL", actor, { submit: true });
    await approveAndBook(b.id, actor);
    const cfg = { bungaNumber: b.number };

    const bal = async (coaId: string) => {
      const s = await prisma.journalLine.aggregate({ where: { accountId: coaId }, _sum: { debit: true, credit: true } });
      return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
    };
    const others = async () => (await bankBalances()).filter((x) => x.id !== s5984.id && x.id !== s0006.id).map((x) => [x.id, x.balance]);
    const [b0, z0, o0] = [await bal(s5984.coaAccountId), await bal(coa.id), await others()];
    const logs: string[] = [];

    expect((await koreksiSaldo5984(false, (s) => logs.push(s), cfg)).hasil).toBe("PRATINJAU");
    expect(await bal(s5984.coaAccountId)).toBe(b0);

    expect((await koreksiSaldo5984(true, (s) => logs.push(s), cfg)).hasil).toBe("DIKOREKSI");
    // 5984: +349 bunga −504 bunga dobel −22.800 +21.800 −300.000 nabung dobel
    expect(await bal(s5984.coaAccountId)).toBe(b0 + 349 - 504 - 1_000 - 300_000);
    // 0006: +300.000 nabung −300.000 penyesuaian saldo awal
    expect(await bal(coa.id)).toBe(z0);
    expect(await others()).toEqual(o0);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("DIBATALKAN");
    const nab = await prisma.financeTransaction.findUniqueOrThrow({ where: { idempotencyKey: NABUNG.key } });
    expect(nab.status).toBe("DIBUKUKAN");
    const e9 = await prisma.reserveEntry.findFirstOrThrow({ where: { fundId: fund.id, date: new Date("2026-11-09T00:00:00.000Z"), type: "SISIH" } });
    expect(e9.transactionId).toBe(nab.id);
    expect(await prisma.journal.count({ where: { sourceId: ADJ_0006.sourceId } })).toBe(1);
    // Sisihan otomatis 9 Nov tidak memindahkan uang lagi untuk Nabung Bayar Hutang
    const before = await bal(coa.id);
    await postAllReserves("2026-11-09", actor);
    expect(await bal(coa.id)).toBe(before);

    expect((await koreksiSaldo5984(true, (s) => logs.push(s), cfg)).hasil).toBe("SUDAH");
  });
});
