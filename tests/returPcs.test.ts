import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { createReturn, inspectReturn } from "@/lib/returns";
import { packComponents, pieceInspection } from "@/lib/returnPieces";
import { jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let finished: string;
let wip: string;
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const d = (s: string) => jakartaDateTime(s, "10:00");

describe("Retur diperiksa per pcs (paket Single Pack)", () => {
  it("pieceInspection: validasi isi paket, kerugian per pcs, semua baik = paket utuh", () => {
    const rows = [
      { itemId: "h", perPack: 6, goodQty: 4, damagedQty: 2, unitCost: 1000 },
      { itemId: "c", perPack: 6, goodQty: 3, damagedQty: 1, unitCost: 2000 },
    ];
    const r = pieceInspection(1, rows);
    expect([r.goodPcs, r.damagedPcs, r.capPcs, r.allGood]).toEqual([7, 3, 12, false]);
    expect(r.good).toBe(4000 + 6000);
    expect(r.loss).toBe(2 * 1000 + 3 * 2000); // rusak + tidak ada di paket
    expect(() => pieceInspection(1, [{ ...rows[0], goodQty: 5, damagedQty: 2 }])).toThrow(/maks 6 pcs/);
    expect(() => pieceInspection(2, [{ ...rows[0], goodQty: 12, damagedQty: 1 }])).toThrow(/maks 12 pcs/);
    expect(() => pieceInspection(1, [{ ...rows[0], goodQty: 1.5, damagedQty: 0 }])).toThrow(/bilangan bulat/);
    expect(pieceInspection(1, [{ ...rows[0], goodQty: 6, damagedQty: 0 }]).allGood).toBe(true);
  });

  describe("di database", () => {
    const sp: Record<string, { id: string }> = {};
    let pack: { id: string };
    beforeAll(async () => {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      actor = { id: u.id, name: u.name };
      const loc = await locationSettings(prisma);
      finished = loc.finished!;
      wip = loc.wip ?? finished;
      const store = await prisma.store.findFirstOrThrow();
      for (const v of ["Hewan", "Cowok"]) {
        sp[v] = await prisma.item.create({ data: { sku: `RP-${tag}-${v}`, name: `Single Pack ${v} ${tag}`, type: "BARANG_DALAM_PROSES", unit: "pcs", avgCost: 1000 } });
      }
      pack = await prisma.item.create({ data: { sku: `RP-${tag}-P`, name: `Paket 12 Mix ${tag}`, type: "BARANG_JADI", unit: "pcs", avgCost: 15000 } });
      await prisma.product.create({ data: { sku: `RP-${tag}-PR`, name: `Paket 12 Mix ${tag}`, type: "PAKET_12", variant: "MIX", storeId: store.id, finishedItemId: pack.id, bom: { create: [{ itemId: sp.Hewan.id, qty: 6 }, { itemId: sp.Cowok.id, qty: 6 }] } } });
      await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: pack.id, qty: 5, toLocationId: finished, unitCost: 15000, date: d("2027-07-01") }, actor));
    });

    it("komponen paket terbaca dari BOM (6 + 6 = 12 pcs)", async () => {
      const cs = await packComponents(prisma, pack.id);
      expect(cs.map((c) => [c.name.replace(/ \w+$/, ""), c.perPack])).toEqual([["Single Pack Cowok", 6], ["Single Pack Hewan", 6]]);
    });

    it("sebagian rusak: pcs baik → stok Single Pack, kerugian per pcs; melebihi isi ditolak; periksa ulang paket utuh", async () => {
      const r = await createReturn({ receivedAt: d("2027-07-02"), trackingNo: `RESI${tag}001`, lines: [{ labelSku: "P12MIX", qty: 1, itemId: pack.id }] }, actor);
      const line = (await prisma.returnLine.findFirstOrThrow({ where: { returnId: r.id } })).id;
      const [cowok, hewan] = [sp.Cowok.id, sp.Hewan.id];
      await expect(inspectReturn(r.id, [{ lineId: line, goodQty: 0, damagedQty: 0, pieces: [{ itemId: hewan, goodQty: 6, damagedQty: 1 }, { itemId: cowok, goodQty: 6, damagedQty: 0 }] }], actor)).rejects.toThrow(/maks 6 pcs/);

      const before = { h: await qtyAt(prisma, hewan, wip), p: await qtyAt(prisma, pack.id, finished) };
      const out = await inspectReturn(r.id, [{ lineId: line, goodQty: 0, damagedQty: 0, pieces: [{ itemId: hewan, goodQty: 4, damagedQty: 2 }, { itemId: cowok, goodQty: 6, damagedQty: 0 }] }], actor);
      expect(Number(out.lossValue)).toBe(2 * 1000); // 2 pcs Hewan rusak × HPP pcs
      expect(Number(out.goodValue)).toBe(10 * 1000);
      expect(await qtyAt(prisma, hewan, wip)).toBe(before.h + 4);
      expect(await qtyAt(prisma, pack.id, finished)).toBe(before.p); // paket utuh tidak kembali
      const l = await prisma.returnLine.findUniqueOrThrow({ where: { id: line }, include: { pieces: true } });
      expect([l.pieceMode, l.goodQty, l.damagedQty, Number(l.lossValue)]).toEqual([true, 10, 2, 2000]);
      expect(l.pieces).toHaveLength(2);

      // Periksa ulang: semua baik → paket utuh kembali ke stok paket, pcs sebelumnya dibalik
      await inspectReturn(r.id, [{ lineId: line, goodQty: 0, damagedQty: 0, pieces: [{ itemId: hewan, goodQty: 6, damagedQty: 0 }, { itemId: cowok, goodQty: 6, damagedQty: 0 }] }], actor);
      expect(await qtyAt(prisma, hewan, wip)).toBe(before.h);
      expect(await qtyAt(prisma, pack.id, finished)).toBe(before.p + 1);
    });
  });
});
