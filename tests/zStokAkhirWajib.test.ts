import { describe, expect, it } from "vitest";
import { missingStockCounts } from "@/lib/shiftResultCount";

describe("stok akhir wajib diisi (bahan, setengah jadi, jadi)", () => {
  const items = [{ id: "a", name: "Single Pack Cewek" }, { id: "b", name: "Giftbox 12" }];
  it("lengkap (0 sah) → null", () => {
    expect(missingStockCounts([{ name: "Gypsum", qty: 0 }], items, { _hasil: { a: 0, b: 5 } } as never)).toBeNull();
  });
  it("kosong → pesan menyebut barang yang belum diisi, per tipe", () => {
    const m = missingStockCounts([{ name: "Gypsum", qty: null }, { name: "Cat", qty: 3 }], items, { _hasil: { a: 2 } } as never)!;
    expect(m).toMatch(/Bahan baku: Gypsum/);
    expect(m).not.toMatch(/Cat/);
    expect(m).toMatch(/Setengah jadi \/ produk jadi: Giftbox 12/);
    expect(m).not.toMatch(/Single Pack/);
  });
  it("tanpa hitungan sama sekali → semua disebut; tanpa barang → null", () => {
    expect(missingStockCounts([], items, {} as never)).toMatch(/Single Pack Cewek, Giftbox 12/);
    expect(missingStockCounts([], [], {} as never)).toBeNull();
  });
});
