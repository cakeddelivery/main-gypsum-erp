import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ASET_NAMA_OVERHEAD, pasangBiayaOven, penyusutanAset, rencanaPasang } from "@/lib/biayaOven";
import { overheadBulanan } from "@/lib/overheadFullCost";

const tag = `BP${Date.now().toString(36).toUpperCase()}`;
const year = 2035 + Math.floor(Math.random() * 4); // lebih awal dari tes lain: harga tabung terakhir (LPG) milik tes lain tetap yang terbaru
const now = new Date(`${year}-06-20T05:00:00Z`);
const created: string[] = [];
afterAll(async () => { await prisma.item.updateMany({ where: { id: { in: created } }, data: { active: false } }); });
const mk = async (sku: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES", extra: object = {}) => {
  const it = await prisma.item.create({ data: { sku, name: `Uji ${sku}`, unit: "pcs", type, category: type === "BAHAN_BAKU" ? "Bahan Baku Utama" : "Barang Setengah Jadi", ...extra } });
  created.push(it.id);
  return it;
};

describe("Perbaikan --pasang: aset, penyusutan tercakup, gypsum", () => {
  it("aset sewa/rumah/bangunan/oven tidak dihitung sebagai alat/cetakan", async () => {
    const store = await prisma.store.findFirstOrThrow();
    const asset = (name: string, cost: bigint) => prisma.fixedAsset.create({ data: { name: `${name} ${tag}`, storeId: store.id, acquiredAt: new Date(`${year}-01-01T00:00:00Z`), cost, usefulLifeMonths: 12 } });
    await asset("Sewa Rumah Produksi", 14_000_000n);
    await asset("Mesin Oven", 4_620_000n);
    await asset("Cetakan silikon", 1_200_000n);
    const dep = await penyusutanAset(prisma, { now, pola: new RegExp(tag) });
    expect(dep.aset.map((a) => a.nama)).toEqual([`Cetakan silikon ${tag}`]);
    expect(dep.perBulan).toBe(100_000);
  });

  it("tanpa aset cocok → overhead (aset) tidak dibuat; penyusutan sudah tercakup (Penyusutan Cetakan/Oven) → tidak ditambah; info dobel", async () => {
    const v = `P${tag}`;
    const cetak = await mk(`SJ-CTK-${v}`, "BARANG_DALAM_PROSES");
    const kering = await mk(`SJ-PTG-${v}`, "BARANG_DALAM_PROSES");
    const pc = await prisma.overhead.create({ data: { category: "Penyusutan Cetakan", name: `Penyusutan Cetakan ${tag}`, monthlyAmount: 208_333n, outputPerMonth: 1000 } });
    const po = await prisma.overhead.create({ data: { category: "Penyusutan Oven", name: `Penyusutan Oven ${tag}`, monthlyAmount: 416_667n, outputPerMonth: 1000 } });
    await prisma.recipeOverhead.create({ data: { itemId: cetak.id, overheadId: pc.id, factor: 1 } });
    await prisma.recipeOverhead.create({ data: { itemId: kering.id, overheadId: po.id, factor: 1 } });
    const plan = await rencanaPasang(prisma, { now, poolAset: new RegExp(`^zzz-tidak-ada-${tag}$`) });
    const text = plan.baris.join("\n");
    expect(text).toMatch(new RegExp(`SJ-CTK-${v}.*penyusutan sudah tercakup.*Penyusutan Cetakan.*TIDAK ditambahkan`));
    expect(text).toMatch(new RegExp(`SJ-PTG-${v}: penyusutan oven sudah ada.*TIDAK ditambah`));
    expect(plan.aksi.some((a) => a.kind === "OVERHEAD_ASET_BARU" || (a.kind === "OVERHEAD_ASET_PASANG" && a.itemId === cetak.id))).toBe(false);
  });

  it("gypsum: resep 25 → koreksi ke 30 g dengan pratinjau; satuan sak butuh --gram-per-unit; idempoten", async () => {
    const v = `G${tag}`;
    const cetak = await mk(`SJ-CTK-${v}`, "BARANG_DALAM_PROSES");
    const gyp = await mk(`${tag}-GYP`, "BAHAN_BAKU", { name: `Bubuk Gypsum ${tag}`, unit: "sak", hppUnit: "gram", hppFactor: 18000, lastCost: 40000n });
    const line = await prisma.itemRecipeLine.create({ data: { itemId: cetak.id, componentId: gyp.id, qty: 25, useUnit: "gram" } });
    const opts = { gypsumSku: gyp.sku, now, poolAset: new RegExp(`^zzz-${tag}$`) };
    const prev = await pasangBiayaOven(prisma, false, opts);
    expect(prev.baris.join("\n")).toMatch(new RegExp(`SJ-CTK-${v}.*× 25 gram \\(Rp56/pcs\\) → × 30 gram = 30 g \\(Rp67/pcs\\)`));
    expect(Number((await prisma.itemRecipeLine.findUniqueOrThrow({ where: { id: line.id } })).qty)).toBe(25);
    await pasangBiayaOven(prisma, true, opts);
    expect(Number((await prisma.itemRecipeLine.findUniqueOrThrow({ where: { id: line.id } })).qty)).toBe(30);
    expect((await rencanaPasang(prisma, opts)).aksi.some((a) => a.kind === "RESEP_KOREKSI" && a.lineId === line.id)).toBe(false);

    // Satuan resep sak (tanpa konversi gram): qty 25 = 25 sak → ditandai salah satuan, koreksi hanya dengan --gram-per-unit
    const sak = await mk(`${tag}-SAK`, "BAHAN_BAKU", { name: `Gypsum sak ${tag}`, unit: "sak", lastCost: 40000n });
    const c2 = await mk(`SJ-CTK-H${tag}`, "BARANG_DALAM_PROSES");
    const l2 = await prisma.itemRecipeLine.create({ data: { itemId: c2.id, componentId: sak.id, qty: 25, useUnit: "sak" } });
    const o2 = { gypsumSku: sak.sku, now, poolAset: new RegExp(`^zzz-${tag}$`) };
    expect((await rencanaPasang(prisma, o2)).ditunda.join("\n")).toMatch(/--gram-per-unit/);
    const p2 = await rencanaPasang(prisma, { ...o2, gramPerUnit: 18000 });
    expect(p2.baris.join("\n")).toMatch(new RegExp(`SJ-CTK-H${tag}.*× 25 sak \\(Rp1\\.000\\.000/pcs\\).*salah satuan.*presisi resep 4 desimal.*0\\.0017`));
    await pasangBiayaOven(prisma, true, { ...o2, gramPerUnit: 18000 });
    expect(Number((await prisma.itemRecipeLine.findUniqueOrThrow({ where: { id: l2.id } })).qty)).toBe(0.0017); // presisi kolom 4 desimal
  });
});

describe("cek:overhead-bulanan memuat LPG (aktual = isi ulang dibayar + estimasi)", () => {
  it("overhead kategori LPG di resep → aktual dari isi ulang bulan itu, bukan nilai master", async () => {
    const it = await mk(`SJ-PTG-L${tag}`, "BARANG_DALAM_PROSES");
    const oh = await prisma.overhead.create({ data: { category: "LPG", name: `Gas LPG ${tag}`, monthlyAmount: 1n, outputPerMonth: 100 } });
    await prisma.recipeOverhead.create({ data: { itemId: it.id, overheadId: oh.id, factor: 1 } });
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-R1`, physicalDate: new Date(`${year}-06-05T00:00:00Z`), tabung: 2, status: "DIPASANGKAN", amount: 360_000n, pricePerTabung: 180_000n } });
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-R2`, physicalDate: new Date(`${year}-06-08T00:00:00Z`), tabung: 1 } });
    const bln = (await overheadBulanan(prisma, now))[5];
    const row = bln.rows.find((r) => r.overheadId === oh.id)!;
    const last = Number((await prisma.lpgRefill.findFirstOrThrow({ where: { status: "DIPASANGKAN", pricePerTabung: { not: null } }, orderBy: { physicalDate: "desc" } })).pricePerTabung);
    expect(row.aktual).toBe(360_000 + last); // dibayar + estimasi 1 tabung × harga tabung terakhir
    expect(row.dibebankan).toBe(0);
    expect(row.selisih).toBe(360_000 + last);
    expect(ASET_NAMA_OVERHEAD).toMatch(/aset/);
  });
});
