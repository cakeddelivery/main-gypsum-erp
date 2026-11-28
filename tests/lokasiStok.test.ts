import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { koreksiLokasiStok, planLokasiStok } from "@/lib/lokasiStok";
import { locationOfType, locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { resultCountStatus, resultItems } from "@/lib/shiftResultCount";
import { dateOnly } from "@/lib/time";

const tag = `LK${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };

describe("Satu lokasi per jenis barang", () => {
  it("locationOfType: bahan → raw, setengah jadi → wip, jadi → finished", async () => {
    const l = { raw: "R", wip: "W", finished: "F" };
    expect([locationOfType("BAHAN_BAKU", l), locationOfType("BARANG_DALAM_PROSES", l), locationOfType("BARANG_JADI", l)]).toEqual(["R", "W", "F"]);
  });

  it("Single Pack setengah jadi dipakai dari gudang barang jadi → minus di sana; usulan TRANSFER dari gudang setengah jadi (nilai tak berubah, tanpa jurnal); barang jadi nyasar di WIP dipindah; idempoten", async () => {
    const locs = await locationSettings(prisma);
    const mk = (suffix: string, type: string) => prisma.item.create({ data: { sku: `${tag}-${suffix}`, name: `Uji ${tag} ${suffix}`, type, unit: "pcs", avgCost: 605n } as never });
    const sp = await mk("SP", "BARANG_DALAM_PROSES");
    const jd = await mk("JD", "BARANG_JADI");
    await prisma.$transaction(async (tx) => {
      await recordMovement(tx, { type: "PENERIMAAN", itemId: sp.id, qty: 100, toLocationId: locs.wip!, unitCost: 605, ref: `TES:${tag}` }, actor);
      await recordMovement(tx, { type: "PENGELUARAN", itemId: sp.id, qty: 40, fromLocationId: locs.finished!, allowNegative: true, noJournal: true, ref: `TES:${tag}` }, actor);
      await recordMovement(tx, { type: "PENERIMAAN", itemId: jd.id, qty: 10, toLocationId: locs.wip!, unitCost: 100, ref: `TES:${tag}` }, actor);
    });
    const plan = (await planLokasiStok(prisma)).filter((r) => r.sku.startsWith(`${tag}-`));
    const rsp = plan.find((r) => r.sku === `${tag}-SP`)!;
    expect(rsp.negatif).toBe(true);
    expect(rsp.usulan).toHaveLength(1);
    expect(rsp.usulan[0]).toMatchObject({ fromId: locs.wip, toId: locs.finished, qty: 40 });
    expect(plan.find((r) => r.sku === `${tag}-JD`)!.usulan[0]).toMatchObject({ fromId: locs.wip, toId: locs.finished, qty: 10 });

    const pre = await koreksiLokasiStok(prisma, false, { onlySku: (s) => s.startsWith(`${tag}-`) });
    expect(pre.transfers).toBe(0);
    expect(await qtyAt(prisma, sp.id, locs.finished!)).toBe(-40); // pratinjau tidak mengubah
    const j0 = await prisma.journal.count();
    const done = await koreksiLokasiStok(prisma, true, { onlySku: (s) => s.startsWith(`${tag}-`) });
    expect(done.transfers).toBe(2);
    expect(await qtyAt(prisma, sp.id, locs.finished!)).toBe(0);
    expect(await qtyAt(prisma, sp.id, locs.wip!)).toBe(60); // total tetap 60
    expect(await qtyAt(prisma, jd.id, locs.finished!)).toBe(10);
    expect(await qtyAt(prisma, jd.id, locs.wip!)).toBe(0);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: sp.id } })).avgCost)).toBe(605); // nilai tidak berubah
    expect(await prisma.journal.count()).toBe(j0); // TRANSFER tanpa jurnal
    expect(await prisma.stockMovement.count({ where: { ref: `REKON:LOKASI:${tag}-SP` } })).toBe(1);
    expect((await planLokasiStok(prisma)).filter((r) => r.sku.startsWith(`${tag}-`) && r.usulan.length)).toHaveLength(0);
  });

  it("laporan: barang divisi yang tidak ada di hitungan tampil 'belum dihitung' dengan stok sistemnya (termasuk minus), tidak hilang", async () => {
    const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    const locs = await locationSettings(prisma);
    const counted = await prisma.item.create({ data: { sku: `${tag}-C`, name: `Dihitung ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: pck.id } as never });
    const minus = await prisma.item.create({ data: { sku: `${tag}-M`, name: `Minus ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: pck.id } as never });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENGELUARAN", itemId: minus.id, qty: 692, fromLocationId: locs.finished!, allowNegative: true, noJournal: true, ref: `TES:${tag}` }, actor));
    const year = 3500 + Math.floor(Math.random() * 60);
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly(`${year}-01-02`), shiftId: s1, divisionId: pck.id, createdBy: "uji", work: { _hasil: { [counted.id]: 0 } } } });
    expect((await resultItems(pck.id)).map((i) => i.id)).toContain(minus.id);
    const st = await resultCountStatus(rep.id);
    const m = st!.rows.find((r) => r.itemId === minus.id)!;
    expect(m).toMatchObject({ notCounted: true, system: -692 });
    expect(st!.rows.find((r) => r.itemId === counted.id)?.notCounted).toBeUndefined();
  });
});
