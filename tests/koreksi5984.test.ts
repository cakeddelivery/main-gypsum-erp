import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA, postJournal } from "@/lib/accounting";
import { bankBalances } from "@/lib/finance";
import { jakartaDateTime } from "@/lib/time";
import { ADJ_AMOUNT, ADJ_SOURCE_ID, koreksiSaldo5984 } from "../scripts/koreksi-saldo-5984";

describe("Skrip koreksi saldo Seabank 5984", () => {
  it("pratinjau tidak menyimpan; jalankan = 4 bunga + penyesuaian −301.504; rekening lain tetap; aman diulang", async () => {
    const actor = { id: "system", name: "uji" };
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const bal = async (until?: Date) => {
      const s = await prisma.journalLine.aggregate({ where: { accountId: bank.coaAccountId, ...(until ? { journal: { date: { lt: until } } } : {}) }, _sum: { debit: true, credit: true } });
      return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
    };
    const adj = await prisma.$transaction((tx) =>
      postJournal(tx, { date: jakartaDateTime("2026-11-04", "12:00"), storeId: null, description: "uji atur saldo 4 Nov", source: "SALDO_AWAL", sourceId: "UJI-ATUR-5984", actor, lines: [{ accountId: bank.coaAccountId, debit: 240_000 }, { accountCode: COA.EKUITAS_SALDO_AWAL, credit: 240_000 }] }),
    );
    const cfg = { adjNumber: adj.number, opening: await bal(jakartaDateTime("2026-11-04", "00:00")) };
    const others = async () => (await bankBalances()).filter((b) => b.id !== bank.id).map((b) => [b.id, b.balance]);
    const o0 = await others();
    const b0 = await bal();
    const logs: string[] = [];
    expect((await koreksiSaldo5984(false, (s) => logs.push(s), cfg)).hasil).toBe("PRATINJAU");
    expect(await bal()).toBe(b0);
    expect(logs.join("\n")).toContain("bunga tabungan 2026-11-09 01:39 Rp65");

    expect((await koreksiSaldo5984(true, (s) => logs.push(s), cfg)).hasil).toBe("DIKOREKSI");
    expect(await bal()).toBe(b0 + 349 - ADJ_AMOUNT);
    expect(await prisma.journal.count({ where: { sourceId: ADJ_SOURCE_ID } })).toBe(1);
    expect(await others()).toEqual(o0);

    expect((await koreksiSaldo5984(true, (s) => logs.push(s), cfg)).hasil).toBe("SUDAH");
    expect(await bal()).toBe(b0 + 349 - ADJ_AMOUNT);
  });
});
