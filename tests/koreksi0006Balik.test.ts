import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA, postJournal } from "@/lib/accounting";
import { bankBalances } from "@/lib/finance";
import { jakartaDateTime } from "@/lib/time";
import { koreksiSaldo0006Balik, REST_SOURCE_ID, WRONG_SOURCE_ID } from "../scripts/koreksi-saldo-0006-balik";

describe("Skrip balik koreksi saldo Seabank 0006", () => {
  it("pratinjau tidak menyimpan; jalankan = jurnal balik + penyesuaian sisa, akhir 4 Nov Rp3.100.009; rekening lain tetap; aman diulang", async () => {
    const actor = { id: "system", name: "uji" };
    const coa = await prisma.coaAccount.upsert({ where: { code: "1-1290" }, create: { code: "1-1290", name: "Seabank 0006 (uji)", type: "ASET", isCash: true }, update: {} });
    const bank = await prisma.bankAccount.upsert({ where: { code: "SEABANK0006" }, create: { code: "SEABANK0006", name: "Seabank 0006", coaAccountId: coa.id }, update: {} });
    const d4 = jakartaDateTime("2026-11-04", "20:00");
    const post = (sourceId: string, debit0006: number, date = d4) =>
      prisma.$transaction((tx) =>
        postJournal(tx, {
          date, storeId: null, description: `uji ${sourceId}`, source: "SALDO_AWAL", sourceId, actor,
          lines: debit0006 > 0
            ? [{ accountId: coa.id, debit: debit0006 }, { accountCode: COA.EKUITAS_SALDO_AWAL, credit: debit0006 }]
            : [{ accountCode: COA.EKUITAS_SALDO_AWAL, debit: -debit0006 }, { accountId: coa.id, credit: -debit0006 }],
        }),
      );
    await post("UJI-ATUR-SALDO", 3_090_131);
    const wrong = await post(WRONG_SOURCE_ID, -1_890_131);
    await post("UJI-SISIHAN-7NOV", 300_000, jakartaDateTime("2026-11-07", "08:00"));

    const end4 = async () => {
      const s = await prisma.journalLine.aggregate({ where: { accountId: coa.id, journal: { date: { lt: jakartaDateTime("2026-11-05", "00:00") } } }, _sum: { debit: true, credit: true } });
      return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
    };
    const others = async () => (await bankBalances()).filter((b) => b.id !== bank.id).map((b) => [b.id, b.balance]);
    const before = await others();
    const count0 = await prisma.journal.count();
    const logs: string[] = [];

    expect((await koreksiSaldo0006Balik(false, (s) => logs.push(s))).hasil).toBe("PRATINJAU");
    expect(await prisma.journal.count()).toBe(count0);
    expect(logs.join("\n")).toContain("Rp1.200.000 → Rp3.100.009");

    const r = await koreksiSaldo0006Balik(true, (s) => logs.push(s));
    expect(r.hasil).toBe("DIKOREKSI");
    expect(r.journals).toHaveLength(2);
    expect(await end4()).toBe(3_100_009);
    const rev = await prisma.journal.findFirstOrThrow({ where: { reversalOfId: wrong.id } });
    expect(rev.date.getTime()).toBe(wrong.date.getTime());
    expect(await prisma.journal.count({ where: { sourceId: REST_SOURCE_ID } })).toBe(1);
    expect(await others()).toEqual(before);

    expect((await koreksiSaldo0006Balik(true, (s) => logs.push(s))).hasil).toBe("SUDAH");
    expect(await prisma.journal.count()).toBe(count0 + 2);
  });
});
