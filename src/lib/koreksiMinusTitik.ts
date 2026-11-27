import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { recordMovement, stockBalances } from "./stock";

type Actor = { id: string; name: string };
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Stok MINUS di lokasi titik borongan / driver dinolkan. Pola sama dengan opname titik (correctPointStock): satu mutasi PENYESUAIAN
 * naik per barang × lokasi, ref OPT:<kode titik> (OPT:DRV untuk lokasi driver), perlakuan jurnal mengikuti recordMovement (selisih persediaan).
 * Tidak menyentuh gudang utama (itu koreksi-stok-minus). Hanya saldo minus yang diproses; saldo plus tidak berubah.
 */
export type MinusRow = { itemId: string; sku: string; name: string; type: string; locationId: string; lokasi: string; refCode: string; qty: number; value: number };

export async function planMinusTitik(db: Db = prisma): Promise<MinusRow[]> {
  const points = await db.boronganPoint.findMany({ select: { code: true, name: true, locationId: true } });
  const drvSetting = (await db.setting.findUnique({ where: { key: "loc_borongan_driver" } }))?.value;
  const drvLoc = drvSetting ? { id: drvSetting } : await db.location.findUnique({ where: { code: "DRV" }, select: { id: true } });
  const locs = new Map<string, { code: string; name: string }>(points.map((p) => [p.locationId, { code: p.code, name: `Titik ${p.name}` }]));
  if (drvLoc) locs.set(drvLoc.id, { code: "DRV", name: "Driver (mobil)" });
  const neg = (await stockBalances(db as typeof prisma)).filter((b) => locs.has(b.locationId) && b.qty < -0.0005);
  if (!neg.length) return [];
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(neg.map((b) => b.itemId))] } }, select: { id: true, sku: true, name: true, type: true, avgCost: true } })).map((i) => [i.id, i]));
  return neg.map((b) => {
    const it = items.get(b.itemId)!;
    const l = locs.get(b.locationId)!;
    return { itemId: b.itemId, sku: it.sku, name: it.name, type: it.type, locationId: b.locationId, lokasi: l.name, refCode: l.code, qty: Math.round(b.qty * 1000) / 1000, value: Math.round(-b.qty * Number(it.avgCost)) };
  }).sort((a, b) => a.qty - b.qty);
}

/** Eksekusi (satu transaksi Serializable); setelahnya tidak boleh ada lagi saldo minus di lokasi titik/driver, bila ada → batal */
export async function applyMinusTitik(actor: Actor, opts: { alasan?: string } = {}) {
  const alasan = opts.alasan ?? "Koreksi stok minus titik (skrip): saldo dinolkan";
  return prisma.$transaction(async (tx) => {
    const rows = await planMinusTitik(tx);
    for (const r of rows) {
      await recordMovement(tx, { type: "PENYESUAIAN", itemId: r.itemId, qty: -r.qty, fromLocationId: r.locationId, increase: true, allowNegative: true, ref: `OPT:${r.refCode}`, note: `Opname ${r.lokasi} (${actor.name}): ${alasan}`.slice(0, 300) }, actor);
    }
    const left = await planMinusTitik(tx);
    if (left.length) throw new Error(`Masih ada ${left.length} saldo minus di titik/driver setelah koreksi. Dibatalkan.`);
    await audit(actor, "KOREKSI_MINUS_TITIK", "Item", null, { baris: rows.length, nilai: rows.reduce((a, r) => a + r.value, 0), barang: rows.map((r) => ({ sku: r.sku, lokasi: r.lokasi, qty: r.qty })) }, tx);
    return { rows };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}
