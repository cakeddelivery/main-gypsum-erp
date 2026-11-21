import { describe, expect, it } from "vitest";
import { diagnoseWithdraws, pairByAmount, pairBySum, type FileWd } from "@/lib/marketplace/diagnosa";

const d = (s: string) => new Date(`${s}T10:00:00+07:00`);
describe("Diagnosa withdraw (baca saja)", () => {
  it("pairByAmount: toleransi tanggal dilebarkan menambah yang cocok; satu-satu", () => {
    const txs = [{ id: "t1", amount: 100, date: d("2043-03-12") }, { id: "t2", amount: 100, date: d("2043-03-10") }];
    const files = [{ id: "f1", amount: 100, date: d("2043-03-10") }, { id: "f2", amount: 100, date: d("2043-03-08") }];
    expect(pairByAmount(txs, files, 0).file.size).toBe(1);
    expect(pairByAmount(txs, files, 4).file.size).toBe(2);
    expect(pairByAmount(txs, files, 4).tx.size).toBe(2);
  });
  it("pairBySum: satu transaksi = jumlah beberapa penarikan satu kanal (lintas toko dikenali)", () => {
    const f = (id: string, store: string, amount: number, ch = "TTS"): FileWd => ({ id, store, ch, amount, date: d("2043-03-10") });
    const r = pairBySum([{ id: "t", amount: 300, date: d("2043-03-11") }], [f("a", "MG", 100), f("b", "DL", 200), f("c", "MG", 999)], 2);
    expect(r.usedT.has("t")).toBe(true);
    expect(r.found[0]).toMatchObject({ parts: 2, crossStore: true });
    // beda kanal tidak dijumlahkan
    expect(pairBySum([{ id: "t", amount: 300, date: d("2043-03-11") }], [f("a", "MG", 100, "SHP"), f("b", "MG", 200, "TTS")], 2).usedT.size).toBe(0);
  });
  it("diagnoseWithdraws jalan tanpa mengubah data", async () => {
    const r = await diagnoseWithdraws({ from: "2043-03-01", to: "2043-03-31" });
    expect(r.fileWithdraws).toBe(0);
    expect(r.tol).toHaveLength(6);
  });
});
