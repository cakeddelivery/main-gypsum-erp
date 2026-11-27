import { describe, expect, it } from "vitest";
import { accessibleTabs, menuTabs, pickTab, type TabContext } from "@/lib/boronganTabs";

const base: TabContext = { manage: false, canPay: false, setoranOnly: false, driver: false, coordinatorOnly: false, timKiriman: false, legacy: { handover: 0, unpaid: 0 } };
const keys = (c: TabContext) => menuTabs(c).map((t) => t.key);

describe("Tab halaman Borongan: tab lama hanya bila ada sisa data lama", () => {
  it("pengelola tanpa data lama: tidak ada tab Serah Terima / Penerimaan / Bayar Upah di menu", () => {
    const c = { ...base, manage: true, canPay: true };
    expect(keys(c)).toEqual(["kiriman", "stok", "klaim", "ringkasan", "hasil", "orang", "tugas"]);
    expect(menuTabs(c).some((t) => /lama/.test(t.label))).toBe(false);
  });
  it("ada serah terima DIKIRIM → tab Serah Terima muncul dengan jumlahnya; setoran lama belum dibayar → Penerimaan & Bayar Upah", () => {
    const m = menuTabs({ ...base, manage: true, canPay: true, legacy: { handover: 2, unpaid: 0 } });
    expect(m.find((t) => t.key === "serah")?.label).toBe("Serah Terima (sisa data lama: 2)");
    expect(m.some((t) => t.key === "upah")).toBe(false);
    const u = menuTabs({ ...base, manage: true, canPay: true, legacy: { handover: 0, unpaid: 5 } });
    expect(u.find((t) => t.key === "upah")?.label).toBe("Bayar Upah (sisa data lama: 5)");
    expect(u.find((t) => t.key === "terima")?.label).toBe("Penerimaan (sisa data lama: 5)");
    expect(u.some((t) => t.key === "serah")).toBe(false);
  });
  it("?tab= tetap bisa membuka tab lama untuk riwayat walau tidak di menu", () => {
    const c = { ...base, manage: true, canPay: true };
    for (const t of ["serah", "terima", "upah"]) expect(pickTab(t, c, false)).toBe(t);
    expect(pickTab("ngawur", c, false)).toBe("kiriman");
  });
  it("anggota divisi: Kiriman (termasuk terima setoran), Klaim, Ringkasan, Setoran Hasil; tidak ada tab lama", () => {
    const c = { ...base, setoranOnly: true };
    expect(keys(c)).toEqual(["kiriman", "klaim", "ringkasan", "hasil"]);
    expect(pickTab(undefined, c, false)).toBe("kiriman");
    // Tab Penerimaan lama tidak lagi dibuka anggota (diterima divisi dilakukan di Kiriman)
    expect(accessibleTabs(c).some((t) => t.key === "terima")).toBe(false);
  });
  it("koordinator: Kiriman, Stok, Klaim Upah, Orang; driver & tim Cetak/Oven/Packing: hanya Kiriman", () => {
    expect(keys({ ...base, coordinatorOnly: true })).toEqual(["kiriman", "stok", "klaim", "orang"]);
    expect(keys({ ...base, driver: true })).toEqual(["kiriman"]);
    expect(keys({ ...base, setoranOnly: true, timKiriman: true })).toEqual(["kiriman"]);
  });
  it("Finance (bayar upah, tanpa titik): mendarat di Klaim Upah; tab lama tidak muncul tanpa data", () => {
    const c = { ...base, canPay: true };
    expect(pickTab(undefined, c, true)).toBe("klaim");
    expect(keys(c)).toEqual(["kiriman", "klaim", "ringkasan", "hasil", "orang"]);
    // Bukan pengelola: angka setoran lama tidak dihitung → tab Bayar Upah tidak muncul
    expect(menuTabs({ ...c, legacy: { handover: 0, unpaid: 0 } }).some((t) => t.key === "upah")).toBe(false);
  });
});
