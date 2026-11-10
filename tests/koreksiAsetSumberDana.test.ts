import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA, postJournal } from "@/lib/accounting";
import { jakartaDateTime } from "@/lib/time";
import { koreksiAsetSumberDana } from "../scripts/koreksi-aset-sumber-dana";

const actor = { id: "system", name: "uji" };

/** Sama seperti createAsset di menu Aset tetap dengan "Dibayar dari <rekening>" */
async function oldAsset(name: string, date: string, cost: number, life: number, bankCoaId: string) {
  return prisma.$transaction(async (tx) => {
    const acc = await tx.coaAccount.findUniqueOrThrow({ where: { code: COA.ASET_TETAP } });
    const d = jakartaDateTime(date, "12:00");
    const j = await postJournal(tx, { date: d, storeId: null, description: `Perolehan aset ${name}`, source: "ASET", actor, lines: [{ accountId: acc.id, debit: cost }, { accountId: bankCoaId, credit: cost }] });
    return tx.fixedAsset.create({ data: { name, storeId: j.storeId, acquiredAt: d, cost: BigInt(cost), usefulLifeMonths: life, residual: BigInt(0), journalId: j.id } });
  });
}

describe("Skrip koreksi sumber dana aset lama", () => {
  it("pratinjau tidak menyimpan; jalankan = balik + ulang ke Ekuitas Saldo Awal, saldo bank +32,5jt, sewa 12 bulan, penyusutan susulan tanpa dobel; aman diulang", async () => {
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const bal = async () => {
      const s = await prisma.journalLine.aggregate({ where: { accountId: bank.coaAccountId }, _sum: { debit: true, credit: true } });
      return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
    };
    const start = await bal();
    const mesin = await oldAsset("Mesin Oven Uji", "2026-05-10", 18_500_000, 48, bank.coaAccountId);
    const sewa = await oldAsset("Sewa Rumah Produksi Uji", "2026-06-01", 14_000_000, 48, bank.coaAccountId);
    const numbers = [mesin, sewa].map((a) => a.journalId!);
    const jn = (await prisma.journal.findMany({ where: { id: { in: numbers } } })).map((j) => j.number);
    expect(await bal()).toBe(start - 32_500_000);
    // Oktober sudah ditutup (seperti production): penyusutan Okt dibukukan hari ini sebagai susulan
    const oct = await prisma.accountingPeriod.findUnique({ where: { year_month: { year: 2026, month: 10 } } });
    await prisma.accountingPeriod.upsert({ where: { year_month: { year: 2026, month: 10 } }, create: { year: 2026, month: 10, status: "CLOSED" }, update: { status: "CLOSED" } });
    const now = jakartaDateTime("2026-11-10", "16:00");
    const count0 = await prisma.journal.count();
    const logs: string[] = [];

    const pre = await koreksiAsetSumberDana(false, { journals: jn, now, log: (s) => logs.push(s) });
    expect(pre.hasil).toBe("PRATINJAU");
    expect(await prisma.journal.count()).toBe(count0);
    expect(Object.values(pre.bankDelta).reduce((s, x) => s + x, 0)).toBe(32_500_000);
    expect(logs.join("\n")).toContain("umur 48 → 12 bulan");

    const r = await koreksiAsetSumberDana(true, { journals: jn, now, log: (s) => logs.push(s) });
    expect(r.hasil).toBe("DIKOREKSI");
    expect(await bal()).toBe(start);
    for (const a of [mesin, sewa]) {
      const fa = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: a.id } });
      const fj = await prisma.journal.findUniqueOrThrow({ where: { id: fa.journalId! }, include: { lines: { include: { account: true } } } });
      expect(fj.lines.find((l) => Number(l.credit) > 0)!.account.code).toBe(COA.EKUITAS_SALDO_AWAL);
      expect(await prisma.journal.count({ where: { reversalOfId: a.journalId! } })).toBe(1);
    }
    const sewaNow = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: sewa.id } });
    expect(sewaNow.usefulLifeMonths).toBe(12);
    // Mesin: Mei–Okt = 6 bulan × 385.417; Sewa: Jun–Okt = 5 bulan × 1.166.667
    const dep = async (id: string) => prisma.journal.findMany({ where: { source: "PENYUSUTAN", sourceId: { startsWith: `${id}:` } }, include: { lines: true } });
    const dm = await dep(mesin.id);
    const ds = await dep(sewa.id);
    expect(dm.length).toBe(6);
    expect(ds.length).toBe(5);
    expect(ds[0].lines.find((l) => Number(l.debit) > 0)!.debit).toBe(BigInt(1_166_667));
    // Bulan tertutup (Oktober, dan bulan lain yang ditutup tes sebelumnya) → susulan bertanggal hari ini
    const closedMonths = (await prisma.accountingPeriod.findMany({ where: { status: "CLOSED", year: 2026, month: { gte: 5, lte: 10 } } })).length;
    expect(dm.filter((j) => j.description.includes("susulan")).length).toBe(closedMonths);
    expect(dm.find((j) => j.sourceId === `${mesin.id}:2026-10`)!.description).toContain("susulan");
    expect(r.depreciation).toBe(6 * 385_417 + 5 * 1_166_667);

    // Aman diulang
    const again = await koreksiAsetSumberDana(true, { journals: jn, now, log: () => {} });
    expect(again.hasil).toBe("TIDAK_ADA");
    expect((await dep(mesin.id)).length).toBe(6);

    // Kembalikan status Oktober seperti semula untuk tes lain
    if (oct) await prisma.accountingPeriod.update({ where: { id: oct.id }, data: { status: oct.status } });
    else await prisma.accountingPeriod.delete({ where: { year_month: { year: 2026, month: 10 } } });
  });
});
