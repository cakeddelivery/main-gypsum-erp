import type { PrismaClient } from "@prisma/client";
import { DIVISION_SETUP, REPORT_TEMPLATES } from "./shiftReport";
import { autoCode } from "./codes";

const REPLACED_FLAG = "bahan_baku_divisi_v1";

/**
 * Siapkan 4 divisi laporan shift (Produksi, Giftbox, Packing, Assembling) beserta checklist dan
 * bahan bakunya (sesuai contoh laporan). Aman dijalankan berulang: data yang sudah ada tidak ditimpa.
 *
 * replaceOld = true: bahan baku lama (tanpa divisi) diganti total — yang belum pernah dipakai dihapus,
 * yang sudah punya riwayat (mutasi/BOM/pembelian/permintaan) dinonaktifkan agar jejak & jurnal tetap utuh.
 * Penggantian hanya dilakukan sekali (ditandai di Setting).
 */
export async function applyDivisionSetup(db: PrismaClient, opts: { replaceOld?: boolean } = {}) {
  const res = { divisionsCreated: 0, materialsCreated: 0, archived: 0, deleted: 0, replaced: false };
  const all = await db.division.findMany();
  for (const t of REPORT_TEMPLATES) {
    const setup = DIVISION_SETUP[t];
    let div =
      all.find((d) => d.reportTemplate === t) ??
      all.find((d) => d.code === setup.code && !d.reportTemplate) ??
      all.find((d) => d.name.toLowerCase().includes(setup.name.toLowerCase()) && !d.reportTemplate);
    // Divisi Cetak hanya diberi format bila divisinya sudah ada (tidak dibuat otomatis)
    if (!div && t === "CETAK") continue;
    if (!div) {
      div = await db.division.create({ data: { code: setup.code, name: `Divisi ${setup.name}`, reportTemplate: t, shiftCount: setup.shiftCount, checklist: setup.checklist } });
      all.push(div);
      res.divisionsCreated++;
    } else {
      const empty = !Array.isArray(div.checklist) || div.checklist.length === 0;
      div = await db.division.update({ where: { id: div.id }, data: { reportTemplate: t, active: true, ...(empty ? { checklist: setup.checklist } : {}) } });
    }
    for (const [i, [name, unit, limit]] of setup.materials.entries()) {
      const ex = await db.item.findFirst({ where: { divisionId: div.id, name: { equals: name, mode: "insensitive" } } });
      if (ex) continue;
      const sku = await autoCode.divisionMaterial(db, div.code);
      await db.item.create({ data: { sku, name, unit, type: "BAHAN_BAKU", minStock: limit, divisionId: div.id, sortOrder: i } });
      res.materialsCreated++;
    }
  }

  if (opts.replaceOld && !(await db.setting.findUnique({ where: { key: REPLACED_FLAG } }))) {
    const old = await db.item.findMany({
      where: { type: "BAHAN_BAKU", divisionId: null },
      include: { _count: { select: { movements: true, bomLines: true, requests: true, purchaseLines: true, usedInRecipes: true, recipe: true, pieceInputs: true, pieceOutputs: true, handoverLines: true } } },
    });
    for (const it of old) {
      const used = Object.values(it._count).some((n) => n > 0);
      if (used) {
        await db.item.update({ where: { id: it.id }, data: { active: false } });
        res.archived++;
      } else {
        await db.item.delete({ where: { id: it.id } });
        res.deleted++;
      }
    }
    await db.setting.create({ data: { key: REPLACED_FLAG, value: new Date().toISOString() } });
    res.replaced = true;
  }
  return res;
}
