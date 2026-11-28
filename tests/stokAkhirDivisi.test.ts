import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { auditStokAkhirDivisi, resultItems } from "@/lib/shiftResultCount";
import { planDivisiHasil } from "@/lib/koreksiDivisiHasil";
import { locationSettings, recordMovement } from "@/lib/stock";

const tag = `SA${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
let pck: { id: string; name: string }, asm: { id: string; name: string };
let sp: { id: string }, spOther: { id: string }, orphan: { id: string }, satuanWip: { id: string };

beforeAll(async () => {
  pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
  asm = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" } });
  const mk = (suffix: string, extra: object) => prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, type: "BARANG_DALAM_PROSES", unit: "pcs", ...extra } as never });
  sp = await mk("SP", {}); // Single Pack, divisi kosong, keluaran tugas Packing
  spOther = await mk("SPO", { divisionId: asm.id }); // keluaran tugas Packing tetapi Item.divisionId = Assembling
  orphan = await mk("ORP", {}); // berstok, tanpa divisi & tanpa tugas
  satuanWip = await mk("SAT", { divisionId: asm.id }); // produk SATUAN bertipe setengah jadi di divisi salah
  const mkTask = (code: string, out: string) => prisma.pieceTask.create({ data: { code: `${tag}${code}`, name: `Tugas ${tag}${code}`, ratePerPcs: 100n, workerRate: 100n, divisionId: pck.id, outputItemId: out } });
  await mkTask("1", sp.id);
  await mkTask("2", spOther.id);
  const locs = await locationSettings(prisma);
  await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: orphan.id, qty: 7, toLocationId: locs.wip!, unitCost: 100, ref: `TES:${tag}` }, actor));
  const store = await prisma.store.findFirstOrThrow();
  await prisma.product.create({ data: { sku: `${tag}-PR`, name: `Satuan ${tag}`, type: "SATUAN", variant: "COWOK", storeId: store.id, finishedItemId: satuanWip.id } as never });
  await prisma.item.update({ where: { id: satuanWip.id }, data: { type: "BARANG_DALAM_PROSES" } });
});

describe("Stok akhir divisi: daftar barang", () => {
  it("keluaran tugas divisi dengan Item.divisionId kosong ikut daftar divisinya; yang divisinya terisi divisi lain tidak ditarik (hindari dihitung dua divisi)", async () => {
    const p = (await resultItems(pck.id)).map((i) => i.id);
    expect(p).toContain(sp.id);
    expect(p).not.toContain(spOther.id);
    expect((await resultItems(asm.id)).map((i) => i.id)).not.toContain(sp.id);
    expect((await resultItems(asm.id)).map((i) => i.id)).toContain(spOther.id);
  });

  it("audit: keluaran tugas di divisi lain & barang berstok yang tidak dihitung divisi mana pun terlihat", async () => {
    const a = await auditStokAkhirDivisi(prisma);
    const d = a.divisi.find((x) => x.id === pck.id)!;
    expect(d.lewatKeluaranTugas.some((x) => x.sku === `${tag}-SP`)).toBe(true);
    expect(d.keluaranDivisiLain.find((x) => x.sku === `${tag}-SPO`)?.divisiItem).toBe(asm.name);
    expect(a.yatim.find((x) => x.sku === `${tag}-ORP`)?.qty).toBe(7);
  });

  it("koreksi:divisi-hasil kini juga memindahkan Single Pack satuan bertipe SETENGAH JADI ke Packing (sebelumnya hanya barang jadi)", async () => {
    const plan = await planDivisiHasil(prisma);
    const packingNames = (await prisma.division.findMany({ where: { reportTemplate: "PACKING" }, select: { name: true } })).map((d) => d.name);
    const fix = plan.fixes.find((f) => f.id === satuanWip.id)!;
    expect(packingNames).toContain(fix.to); // beberapa divisi bertemplate Packing: yang pertama menurut nama
    expect(fix.why).toBe("Single Pack (produk satuan)");
  });
});
