import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { effectivePermissions } from "@/lib/rbac";
import { applyDivisionSetup } from "@/lib/divisionSetup";
import { DIVISION_SETUP, isDone, needsOrder, parseWork, summaryOf, workLines, type WorkData } from "@/lib/shiftReport";

describe("Format laporan penutup shift (sesuai contoh)", () => {
  it("Produksi: total panen per oven & total hasil cetak", () => {
    const work: WorkData = {
      panen: [{ name: "Oven Besar", v: [200, 600, null, 500] }, { name: "Oven Kecil", v: [100, null, null, null] }],
      cetak: [{ name: "YOGA", v: [864] }],
    };
    expect(summaryOf("PRODUKSI", work)).toEqual([{ label: "Total panen", unit: "pcs", value: 1400 }, { label: "Total hasil cetak", unit: "pcs", value: 864 }]);
    expect(workLines("PRODUKSI", work)).toContain("Oven Besar: Hewan 200 · Cowok 600 · Transportasi — · Cewek 500 · TOTAL 1.300 pcs");
  });
  it("Giftbox: patung = giftbox × 5", () => {
    const work: WorkData = { resi: { shopee: null, tiktok: null }, giftbox: { MIX: 14, CEW: 6, CWO: 4, HWN: 16, TRN: 2, "MIX-PLT": 1, "CEW-PLT": 2, "CWO-PLT": 1, "HWN-PLT": 2, "TRN-PLT": 1 } };
    expect(summaryOf("GIFTBOX", work).map((s) => s.value)).toEqual([0, 245]);
  });
  it("Packing: paket mix dikali isi + satuan", () => {
    const work: WorkData = { resi: { shopee: 38, tiktok: 29 }, mix: { p12: 0, p24: 18, p48: 4, p96: 0 }, satuan: { cowok: 8, cewek: 37, transportasi: 33, hewan: 0 } };
    expect(summaryOf("PACKING", work).map((s) => s.value)).toEqual([67, 702]);
  });
  it("Assembling: baca form per orang × varian", () => {
    const fd: Record<string, string> = { "w.jadi.n": "2", "w.jadi.0.name": "Eva", "w.jadi.0.0": "1", "w.jadi.1.name": "Sonna", "w.jadi.1.1": "3" };
    const work = parseWork("ASSEMBLING", (k) => fd[k] ?? null);
    expect(summaryOf("ASSEMBLING", work)[0].value).toBe(4);
    expect(workLines("ASSEMBLING", work)).toContain("TOTAL: Hewan 1 · Cowok 3 · Transportasi 0 · Cewek 0");
  });
  it("order bahan bila stok ≤ limit; tugas foto selesai bila foto ada", () => {
    expect(needsOrder({ qty: 176, limit: 700 })).toBe(true);
    expect(needsOrder({ qty: 20, limit: 20 })).toBe(true);
    expect(needsOrder({ qty: 28, limit: 15 })).toBe(false);
    expect(needsOrder({ qty: null, limit: 15 })).toBe(false);
    expect(isDone({ label: "Lantai", photo: true, done: true, photoPath: null })).toBe(false);
    expect(isDone({ label: "Lantai", photo: true, done: false, photoPath: "x.jpg" })).toBe(true);
  });
});

describe("Hak akses absensi & target produksi", () => {
  it("hanya Owner, Supervisor, Finance; override tidak bisa membuka untuk role lain", () => {
    for (const r of ["OWNER", "SUPERVISOR", "FINANCE"] as const) {
      expect(effectivePermissions(r, []).has("attendance.manage")).toBe(true);
      expect(effectivePermissions(r, []).has("production.target")).toBe(true);
    }
    for (const r of ["ADMIN", "ADMIN_PRODUKSI", "KAPTEN_DIVISI", "OPERATOR"] as const) {
      const p = effectivePermissions(r, [{ role: r, permission: "production.target", allowed: true }, { role: r, permission: "attendance.manage", allowed: true }]);
      expect(p.has("production.target")).toBe(false);
      expect(p.has("attendance.manage")).toBe(false);
    }
    expect(effectivePermissions("OPERATOR", []).has("report.create")).toBe(true);
  });
});

describe("Bahan baku per divisi", () => {
  it("seed membuat 4 divisi laporan beserta bahan & limit dari contoh", async () => {
    const prd = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" }, include: { items: true } });
    expect(prd.items.map((i) => i.name)).toEqual(expect.arrayContaining(["Bubuk gypsum", "Keranjang patung"]));
    const asm = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" }, include: { items: true } });
    expect(asm.items).toHaveLength(DIVISION_SETUP.ASSEMBLING.materials.length);
    expect(Number(asm.items.find((i) => i.name === "Piring plastik")!.minStock)).toBe(18);
  });
  it("ganti bahan lama: yang punya riwayat dinonaktifkan, sisanya dihapus, hanya sekali", async () => {
    const unused = await prisma.item.create({ data: { sku: "BB-TEST-LAMA", name: "Bahan lama", type: "BAHAN_BAKU", unit: "pcs" } });
    const r = await applyDivisionSetup(prisma, { replaceOld: true });
    expect(r.replaced).toBe(true);
    expect(await prisma.item.findUnique({ where: { id: unused.id } })).toBeNull();
    const gyp = await prisma.item.findUniqueOrThrow({ where: { sku: "BB-GYP" } });
    expect(gyp.active).toBe(false); // dipakai BOM
    expect((await applyDivisionSetup(prisma, { replaceOld: true })).replaced).toBe(false);
    expect(await prisma.item.count({ where: { divisionId: { not: null }, active: true } })).toBeGreaterThanOrEqual(47);
  });
});
