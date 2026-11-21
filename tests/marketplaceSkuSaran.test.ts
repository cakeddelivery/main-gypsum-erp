import { describe, expect, it } from "vitest";
import { defaultExtraVariant } from "@/lib/marketplace/sku";
import { groupOf, suggestProducts, type SuggestOption } from "@/lib/marketplace/skuSuggest";

const opt = (id: string, name: string, storeCode: string | null, words: string[] = []): SuggestOption => ({ id, name, group: groupOf(name), storeCode, words });
const OPTS = [
  opt("mg24mix", "Giftbox Paket 24 Mix MG", "MG", ["MG-24-MIX"]),
  opt("dl24mix", "Giftbox Paket 24 Mix DL", "DL", ["DL-24-MIX"]),
  opt("dl24hwn", "Giftbox Paket 24 Hewan DL", "DL", ["HEWAN"]),
  opt("dl12mix", "Giftbox Paket 12 Mix DL", "DL"),
  opt("dlsatcew", "Lukis Satuan Cewek", "DL", ["CEWEK"]),
];

describe("Saran produk untuk SKU belum dipetakan", () => {
  it("varian dari SKU/variasi dicocokkan; produk di toko yang benar jadi pilihan teratas", () => {
    const dl = suggestProducts({ sku: "24-MIX", variation: null, name: "Giftbox Lukis 24 Mix", storeCodes: ["DL"] }, OPTS);
    expect(dl[0].id).toBe("dl24mix"); // DL, bukan MG
    expect(dl.map((o) => o.id)).toContain("mg24mix");
    const mg = suggestProducts({ sku: "24-MIX", variation: null, name: "x", storeCodes: ["MG"] }, OPTS);
    expect(mg[0].id).toBe("mg24mix");
    // singkatan varian: 24-HWN → HEWAN
    expect(suggestProducts({ sku: "24-HWN", variation: null, name: null, storeCodes: ["DL"] }, OPTS)[0].id).toBe("dl24hwn");
    expect(suggestProducts({ sku: "24-CEW", variation: "CEWEK", name: null, storeCodes: ["DL"] }, OPTS).map((o) => o.id)).toContain("dlsatcew");
    // tanpa petunjuk sama sekali → tidak menebak
    expect(suggestProducts({ sku: "ZZZ", variation: null, name: "barang", storeCodes: ["DL"] }, OPTS)).toEqual([]);
  });
  it("kelompok produk induk untuk header dropdown", () => {
    expect(groupOf("Giftbox Custom Series A")).toBe("Giftbox Custom");
    expect(groupOf("Paket 24 Mix (jadi)")).toBe("Paket 24");
    expect(groupOf("Figur Satuan Cowok (jadi)")).toBe("Satuan / Single Pack");
    expect(groupOf("Apa saja", "Keluarga X")).toBe("Keluarga X");
  });
  it("Extra Packing otomatis: BWPK, BBWP + nama variasi", () => {
    expect(defaultExtraVariant("BWPK|")).toBe("Extra Dus + Bubble Wrap");
    expect(defaultExtraVariant("BBWP|BUBBLE + DUS")).toBe("Extra Dus + Bubble Wrap");
    expect(defaultExtraVariant("BBWP|BUBBLE WRAP")).toBe("Bubble Wrap");
    expect(defaultExtraVariant("BBWP|DUS")).toBe("Extra Dus");
    expect(defaultExtraVariant("24MIX|")).toBeNull();
  });
});
