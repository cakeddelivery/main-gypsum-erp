import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { LPG_KEY, applyLpg, lpgFlow, lpgSummary, pairLpgRefills, parseLpg, storedLpg } from "@/lib/lpg";
import { addDays, dateOnly, todayStr } from "@/lib/time";

const g = (o: Record<string, string>) => (k: string) => o[k] ?? null;
const tag = Date.now().toString(36).slice(-5).toUpperCase();

describe("LPG tabung 5 kg", () => {
  it("parseLpg: kosong semua = tidak dilaporkan; sebagian = error; angka valid", () => {
    expect(parseLpg(g({}))).toBeNull();
    expect(parseLpg(g({ "lpg.penuh": "1", "lpg.aktif": "2", "lpg.kosong": "0" }))).toEqual({ penuh: 1, aktif: 2, kosong: 0, isiUlang: 0 });
    expect(() => parseLpg(g({ "lpg.penuh": "1" }))).toThrow(/penuh, aktif, dan kosong/);
    expect(() => parseLpg(g({ "lpg.penuh": "1.5", "lpg.aktif": "1", "lpg.kosong": "1" }))).toThrow(/bilangan bulat/);
    expect(storedLpg({ [LPG_KEY]: { penuh: 1, aktif: 2, kosong: 0 } })).toEqual({ penuh: 1, aktif: 2, kosong: 0, isiUlang: 0 });
  });

  it("lpgFlow: 1 penuh/2 aktif/0 kosong → pasang 1 & habis 1; isi ulang 2 padahal 1 kosong tetap wajar; angka ngawur ditandai", () => {
    const prev = { penuh: 1, aktif: 2, kosong: 0 };
    // satu aktif habis, cadangan dipasang: penuh 0, aktif 2, kosong 1
    expect(lpgFlow(prev, { penuh: 0, aktif: 2, kosong: 1, isiUlang: 0 })).toEqual({ dipasang: 1, habis: 1, valid: true });
    // isi ulang 2 tabung diterima: kosong 1 → … penuh kembali 2, aktif 1? (penuh 2, aktif 1, kosong 0)
    expect(lpgFlow({ penuh: 0, aktif: 2, kosong: 1 }, { penuh: 2, aktif: 1, kosong: 0, isiUlang: 2 }).valid).toBe(true);
    expect(lpgFlow(prev, { penuh: 3, aktif: 0, kosong: 0, isiUlang: 0 }).valid).toBe(false); // penuh bertambah tanpa isi ulang
    expect(lpgFlow(null, { penuh: 1, aktif: 2, kosong: 0, isiUlang: 0 })).toEqual({ dipasang: 0, habis: 0, valid: true });
  });

  describe("di database", () => {
    const made: string[] = [];
    afterAll(async () => {
      await prisma.lpgRefill.deleteMany({ where: { reportId: { in: made } } });
      await prisma.lpgState.deleteMany({ where: { reportId: { in: made } } });
    });
    it("simpan status tabung, turunan habis, isi ulang menunggu lalu dipasangkan ke transaksi Finance (tanggal & harga per tabung)", async () => {
      const div = await prisma.division.create({ data: { code: `LG${tag}`, name: `Oven LPG ${tag}`, shiftCount: 2, reportTemplate: "PRODUKSI" } });
      const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, take: 2 });
      const d1 = addDays(todayStr(), -10), d2 = addDays(todayStr(), -9);
      const mk = (date: string, shiftId: string, lpg: object) => prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId, divisionId: div.id, createdBy: "t", picName: "oven", work: { [LPG_KEY]: lpg } } });
      const r1 = await mk(d1, shifts[0].id, { penuh: 1, aktif: 2, kosong: 0, isiUlang: 0 });
      const r2 = await mk(d2, shifts[0].id, { penuh: 2, aktif: 1, kosong: 0, isiUlang: 2 });
      made.push(r1.id, r2.id);
      const a1 = await applyLpg(r1.id, "oven");
      expect([a1!.habis, a1!.total]).toEqual([0, 3]);
      // r2: sebelumnya P1 A2 K0; sekarang P2 A1 K0, isi ulang 2 → dipasang 1+... = 1−2+2=1; habis = 2+1−1 = 2
      const a2 = await applyLpg(r2.id, "oven");
      expect([a2!.dipasang, a2!.habis]).toEqual([1, 2]);
      const refill = await prisma.lpgRefill.findUniqueOrThrow({ where: { reportId: r2.id } });
      expect([refill.status, refill.tabung]).toEqual(["MENUNGGU", 2]);

      // Finance mencatat keesokan harinya (bukan real-time): dipasangkan otomatis
      const cat = await prisma.txCategory.findFirstOrThrow({ where: { direction: "KELUAR" } });
      const tx = await prisma.financeTransaction.create({ data: { number: `TX-LPG-${tag}`, source: "MANUAL", direction: "KELUAR", amount: BigInt(360_000), date: new Date(`${addDays(d2, 1)}T05:00:00Z`), categoryId: cat.id, note: "Isi ulang LPG 5kg 2 tabung", status: "DIBUKUKAN", fingerprint: `fp-lpg-${tag}`, createdBy: "t" } });
      expect(await pairLpgRefills()).toBeGreaterThanOrEqual(1);
      const paired = await prisma.lpgRefill.findUniqueOrThrow({ where: { reportId: r2.id } });
      expect([paired.status, paired.transactionId, Number(paired.pricePerTabung)]).toEqual(["DIPASANGKAN", tx.id, 180_000]);
      const sum = await lpgSummary(30);
      expect(sum.habis).toBeGreaterThanOrEqual(2);
      expect(sum.pricePerTabung).toBe(180_000);
      await prisma.lpgRefill.update({ where: { reportId: r2.id }, data: { transactionId: null } });
      await prisma.financeTransaction.delete({ where: { id: tx.id } });
    });
  });
});
