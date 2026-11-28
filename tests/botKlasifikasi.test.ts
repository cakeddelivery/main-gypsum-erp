import { describe, expect, it } from "vitest";
import { classifyIntake, type ClassifyContext } from "@/lib/botClassify";

const ctx: ClassifyContext = {
  items: [
    { id: "i1", sku: "BB-GYP", name: "Gypsum", unit: "sak", supplierId: "s1" },
    { id: "i2", sku: "BB-KRD", name: "Kardus", unit: "pcs", supplierId: null },
  ],
  payables: [
    { id: "p1", number: "UTG-1", vendor: "Riduan", aliases: [], remaining: 3_000_000, purchaseNumber: "PBL-1", items: ["Gypsum"], installment: null },
    { id: "p2", number: "UTG-2", vendor: "Bintang Arut", aliases: [], remaining: 2_000_000, purchaseNumber: "PBL-2", items: ["Kardus"], installment: null },
  ],
  suppliers: [{ id: "s1", name: "Bintang Arut", aliases: "" }, { id: "s2", name: "Riduan", aliases: "" }],
  employees: ["Rina Lestari", "Edy"],
  managers: ["Edy", "Jojo"],
};
const c = (text: string, direction: "MASUK" | "KELUAR" | "TRANSFER" | null = null, amount: number | null = null) => classifyIntake(text, { direction, amount }, ctx);

describe("Klasifikasi pesan bebas di bot", () => {
  it("beli gypsum 20 sak 820rb bintang arut tf bca → PEMBELIAN (yakin)", () => {
    const r = c("beli gypsum 20 sak 820rb bintang arut tf bca", "KELUAR", 820000);
    expect(r.top?.kind).toBe("PEMBELIAN");
    expect(r.ambiguous).toBe(false);
    expect(r.ranked.find((x) => x.kind === "BAYAR_HUTANG")).toBeUndefined();
  });
  it("angsur gypsum riduan 1jt → BAYAR_HUTANG (bukan pembelian)", () => {
    const r = c("angsur gypsum riduan 1jt", "KELUAR", 1_000_000);
    expect(r.top?.kind).toBe("BAYAR_HUTANG");
    expect(r.ambiguous).toBe(false);
    expect(r.ranked.find((x) => x.kind === "PEMBELIAN")).toBeUndefined();
  });
  it("gaji borongan minggu ini → GAJI (borongan), tanpa nominal", () => {
    const r = c("gaji borongan minggu ini", "KELUAR", null);
    expect(r.top).toMatchObject({ kind: "GAJI", borongan: true });
    expect(r.ambiguous).toBe(false);
  });
  it("gaji nama karyawan → GAJI bukan borongan", () => {
    const r = c("gaji Rina 2jt", "KELUAR", 2_000_000);
    expect(r.top?.kind).toBe("GAJI");
    expect(r.top?.borongan).toBeFalsy();
  });
  it("kompensasi edy 500rb → KOMPENSASI", () => {
    const r = c("kompensasi edy 500rb", null, 500000);
    expect(r.top?.kind).toBe("KOMPENSASI");
    expect(r.ambiguous).toBe(false);
  });
  it("lpg 2 tabung 40rb → BEBAN (tanpa kata beli/bayar)", () => {
    const r = c("lpg 2 tabung 40rb", null, 40000);
    expect(r.top?.kind).toBe("BEBAN");
    expect(r.ambiguous).toBe(false);
  });
  it("beli lpg / konsumsi / ongkir → BEBAN menang atas kata beli", () => {
    for (const t of ["beli lpg 2 tabung 40rb", "konsumsi lembur 150rb", "ongkir gypsum 10rb", "bayar listrik 300rb"]) expect(c(t, "KELUAR", 1000).top?.kind).toBe("BEBAN");
  });
  it("pemasukan / penjualan → PENJUALAN", () => {
    expect(c("terima pembayaran dari pelanggan 1,2jt", "MASUK", 1_200_000).top?.kind).toBe("PENJUALAN");
  });
  it("ragu → ambiguous: nama supplier berutang tanpa kata jelas; beli + nama barang di utang", () => {
    const a = c("bayar riduan 500rb", "KELUAR", 500000);
    expect(a.ambiguous).toBe(true); // hanya cocok nama supplier berutang (skor rendah): tampilkan pilihan, bukan menebak
    expect(a.ranked[0].kind).toBe("BAYAR_HUTANG");
    const b = c("beli gypsum angsur riduan 1jt", "KELUAR", 1_000_000);
    expect(b.ambiguous).toBe(true);
    expect(b.ranked.slice(0, 2).map((x) => x.kind).sort()).toEqual(["BAYAR_HUTANG", "PEMBELIAN"]);
  });
  it("pesan tidak dikenali → tidak ada kandidat (alur lama)", () => {
    const r = c("halo semua", null, null);
    expect(r.top).toBeNull();
  });
});
