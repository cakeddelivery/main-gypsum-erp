import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { cashFlow, cashMovements, COA, postJournal, reverseJournal } from "@/lib/accounting";
import { jakartaDateTime, monthRange } from "@/lib/time";

const actor = { id: "system", name: "uji" };
const d = (s: string) => jakartaDateTime(s, "10:00");
const post = (date: string, source: string, cashDebit: number, other: string = COA.BEBAN_LAIN) =>
  prisma.$transaction((tx) =>
    postJournal(tx, {
      date: d(date), storeId: null, description: `uji arus kas ${source}`, source, actor,
      lines: cashDebit > 0 ? [{ accountCode: COA.KAS, debit: cashDebit }, { accountCode: other, credit: cashDebit }] : [{ accountCode: other, debit: -cashDebit }, { accountCode: COA.KAS, credit: -cashDebit }],
    }),
  );

describe("Arus kas selalu klop", () => {
  it("saldo awal + operasi + investasi + pendanaan + penyesuaian = saldo akhir; pembalik ikut kelompok aslinya; pasangan batal disembunyikan", async () => {
    // Bulan sebelumnya: pengeluaran (saldo awal negatif) + penyesuaian saldo yang nanti dibalik di bulan uji
    await post("2028-02-20", "FINANCE", -3_000_000);
    const wrongAdj = await post("2028-02-25", "SALDO_AWAL", -500_000, COA.EKUITAS_SALDO_AWAL);
    // Bulan uji
    await post("2028-03-01", "SALDO_AWAL", 3_000_000, COA.EKUITAS_SALDO_AWAL);
    await post("2028-03-02", "FINANCE", 1_000_000, COA.PENJUALAN);
    const cancelled = await post("2028-03-03", "FINANCE", -200_000);
    await prisma.$transaction((tx) => reverseJournal(tx, cancelled.id, d("2028-03-03"), actor, "batal uji"));
    await prisma.$transaction((tx) => reverseJournal(tx, wrongAdj.id, d("2028-03-04"), actor, "salah saldo"));
    await post("2028-03-05", "PENYESUAIAN", -10_000);

    const { start, end } = monthRange(2028, 3);
    const cf = await cashFlow({ start, end });
    expect(cf.reconciled).toBe(true);
    expect(cf.opening + cf.operating + cf.investing + cf.financing + cf.adjustments).toBe(cf.closing);
    expect(cf.operating).toBe(1_000_000);
    expect(cf.adjustments).toBe(3_000_000 + 500_000 - 10_000);
    const ops = cf.groups.OPERASI.map((x) => x.memo).join("|");
    expect(ops).not.toContain("Pembalik");
    expect(cf.groups.OPERASI.some((x) => x.number === cancelled.number)).toBe(false);
    expect(cf.groups.PENYESUAIAN.some((x) => x.memo.startsWith(`Pembalik ${wrongAdj.number}`))).toBe(true);
    // Uang masuk/keluar nyata (dashboard/bot): tanpa penyesuaian
    expect((await cashMovements(start, end)).reduce((s, x) => s + x.amount, 0)).toBe(1_000_000);
  });
});
