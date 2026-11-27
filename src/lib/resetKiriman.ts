import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { stockBalances } from "./stock";
import { claimBreakdown } from "./boronganClaim";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/**
 * RESET riwayat Kirim Assembling / Kirim Cat / penerimaan, TANPA mengubah stok.
 * Dihapus: kiriman borongan (+tugas/bahan/pembagian/laporan hasil/pengambilan AMB + hitungan), penerimaan divisi (BoronganReceipt),
 * barang masuk laporan shift yang belum tertaut ke Pembelian (ShiftReceipt), setoran upah BELUM dibayar dari pengambilan itu, klaim upah
 * menunggu yang isinya habis, dan mutasi stok ber-ref dokumen-dokumen itu (KRM/BGI/AMB/HSB/PND + pembalik BATAL-…).
 * Tetap: setoran yang sudah dibayar/settlement (hanya dilepas dari pengambilan: pickupId = null), SEMUA jurnal, ShiftReceipt yang tertaut Pembelian.
 * Stok: saldo per barang × lokasi sebelum dihapus disimpan, lalu selisihnya ditutup 1 mutasi PENYESUAIAN per barang × lokasi
 * (ref SALDO_AWAL_REF, tanpa jurnal) sehingga saldo sesudah == saldo sebelum untuk SEMUA barang × lokasi; bila tidak, seluruh transaksi dibatalkan.
 */
export const SALDO_AWAL_REF = "SALDO-AWAL-2026-11-27";
/** Mutasi sesudah batas ini (27 Nov 02:00 WIB) = bukan lagi "stok tadi malam"; ditampilkan sebagai peringatan */
export const MALAM_BATAS = new Date("2026-11-27T02:00:00+07:00");

export type ResetOptions = {
  /** Hanya dokumen bertanggal ≤ ini yang dihapus (kosong = semua) */
  sampai?: Date | null;
  ref?: string;
};

type Plan = {
  shipments: { id: string; number: string; date: string }[];
  pickups: { id: string; number: string }[];
  resultsDelete: number;
  resultsDetach: number;
  claimsDelete: number;
  claimsUpdate: number;
  receipts: { id: string; number: string }[];
  shiftReceipts: number;
  shiftReceiptsSkipped: { number: string; purchaseId: string }[];
  refs: string[];
  movements: number;
  movementsByPrefix: Record<string, number>;
  lateMovements: number;
  lateDocs: string[];
  /** Hasil untuk eksekusi */
  _ids: { shipments: string[]; pickups: string[]; resultsDelete: string[]; resultsDetach: string[]; receipts: string[]; shiftReceipts: string[]; movementIds: string[] };
};

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/** Kumpulkan apa yang akan dihapus (hanya membaca) */
export async function collectReset(db: Tx | typeof prisma, opts: ResetOptions = {}): Promise<Plan> {
  const until = opts.sampai ?? null;
  const dateWhere = until ? { lte: new Date(`${new Date(until.getTime() + 7 * 3600_000).toISOString().slice(0, 10)}T00:00:00.000Z`) } : undefined;
  const shipments = await db.boronganShipment.findMany({ where: dateWhere ? { date: dateWhere } : {}, select: { id: true, number: true, date: true, createdAt: true, pickups: { select: { id: true, number: true, createdAt: true } } }, orderBy: { number: "asc" } });
  const pickups = shipments.flatMap((s) => s.pickups);
  const results = pickups.length ? await db.boronganResult.findMany({ where: { pickupId: { in: pickups.map((p) => p.id) } }, select: { id: true, settlementId: true } }) : [];
  const resultsDelete = results.filter((r) => !r.settlementId);
  const resultsDetach = results.filter((r) => r.settlementId);
  const receipts = await db.boronganReceipt.findMany({ where: dateWhere ? { date: dateWhere } : {}, select: { id: true, number: true, createdAt: true }, orderBy: { number: "asc" } });
  const sr = await db.shiftReceipt.findMany({ where: until ? { receivedAt: { lte: until } } : {}, select: { id: true, number: true, purchaseId: true, createdAt: true } });
  const srDelete = sr.filter((x) => !x.purchaseId);
  const srSkipped = sr.filter((x) => x.purchaseId).map((x) => ({ number: x.number, purchaseId: x.purchaseId! }));

  const bases = [
    ...shipments.flatMap((s) => [`KRM:${s.number}`, `BGI:${s.number}`]),
    ...pickups.map((p) => `AMB:${p.number}`),
    ...resultsDelete.map((r) => `HSB:${r.id}`),
    ...receipts.map((r) => `PND:${r.number}`),
  ];
  const refs = [...bases, ...bases.map((r) => `BATAL-${r}`)];
  const movements = refs.length ? await db.stockMovement.findMany({ where: { ref: { in: refs } }, select: { id: true, ref: true, date: true } }) : [];
  const byPrefix: Record<string, number> = {};
  for (const m of movements) {
    const k = (m.ref ?? "").replace(/^BATAL-/, "").split(":")[0];
    byPrefix[k] = (byPrefix[k] ?? 0) + 1;
  }
  const late = movements.filter((m) => m.date > MALAM_BATAS);
  const lateDocs = [
    ...shipments.filter((s) => s.createdAt > MALAM_BATAS).map((s) => `kiriman ${s.number}`),
    ...pickups.filter((p) => p.createdAt > MALAM_BATAS).map((p) => `pengambilan ${p.number}`),
    ...receipts.filter((r) => r.createdAt > MALAM_BATAS).map((r) => `penerimaan ${r.number}`),
    ...srDelete.filter((x) => x.createdAt > MALAM_BATAS).map((x) => `barang masuk ${x.number}`),
  ];

  // Klaim: yang memuat setoran terhapus
  const claimIds = resultsDelete.length ? [...new Set((await db.boronganResult.findMany({ where: { id: { in: resultsDelete.map((r) => r.id) }, claimId: { not: null } }, select: { claimId: true } })).map((r) => r.claimId!))] : [];
  let claimsDelete = 0;
  let claimsUpdate = 0;
  const delIds = new Set(resultsDelete.map((r) => r.id));
  for (const id of claimIds) {
    const rest = await db.boronganResult.count({ where: { claimId: id, id: { notIn: [...delIds] } } });
    if (rest === 0) claimsDelete++;
    else claimsUpdate++;
  }
  return {
    shipments: shipments.map((s) => ({ id: s.id, number: s.number, date: dayStr(s.date) })),
    pickups: pickups.map((p) => ({ id: p.id, number: p.number })),
    resultsDelete: resultsDelete.length,
    resultsDetach: resultsDetach.length,
    claimsDelete,
    claimsUpdate,
    receipts: receipts.map((r) => ({ id: r.id, number: r.number })),
    shiftReceipts: srDelete.length,
    shiftReceiptsSkipped: srSkipped,
    refs,
    movements: movements.length,
    movementsByPrefix: byPrefix,
    lateMovements: late.length,
    lateDocs,
    _ids: {
      shipments: shipments.map((s) => s.id),
      pickups: pickups.map((p) => p.id),
      resultsDelete: resultsDelete.map((r) => r.id),
      resultsDetach: resultsDetach.map((r) => r.id),
      receipts: receipts.map((r) => r.id),
      shiftReceipts: srDelete.map((x) => x.id),
      movementIds: movements.map((m) => m.id),
    },
  };
}

export type ResetResult = Omit<Plan, "_ids"> & { adjustments: number; snapshotRows: number; claimsDeleted: number; claimsUpdated: number };

const key = (itemId: string, locationId: string) => `${itemId}|${locationId}`;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Jalankan reset dalam SATU transaksi Serializable. Saldo semua barang × lokasi sesudah == sebelum (dicek; bila tidak, rollback).
 */
export async function runReset(opts: ResetOptions, actor: Actor): Promise<ResetResult> {
  const ref = opts.ref ?? SALDO_AWAL_REF;
  return prisma.$transaction(async (tx) => {
    // 1. Snapshot saldo sebelum menghapus apa pun
    const before = new Map((await stockBalances(tx)).map((b) => [key(b.itemId, b.locationId), b.qty]));
    const plan = await collectReset(tx, opts);
    const ids = plan._ids;

    // 2. Hapus (urutan mengikuti kunci asing)
    const claimIds = ids.resultsDelete.length ? [...new Set((await tx.boronganResult.findMany({ where: { id: { in: ids.resultsDelete }, claimId: { not: null } }, select: { claimId: true } })).map((r) => r.claimId!))] : [];
    if (ids.resultsDelete.length) await tx.boronganResult.deleteMany({ where: { id: { in: ids.resultsDelete } } });
    if (ids.resultsDetach.length) await tx.boronganResult.updateMany({ where: { id: { in: ids.resultsDetach } }, data: { pickupId: null } });
    let claimsDeleted = 0;
    let claimsUpdated = 0;
    for (const id of claimIds) {
      const claim = await tx.boronganClaim.findUnique({ where: { id } });
      if (!claim || claim.settlementId) continue; // klaim yang sudah dibayar tidak disentuh
      const rest = await tx.boronganResult.findMany({ where: { claimId: id }, include: { worker: { select: { id: true, name: true } }, coordinator: { select: { id: true, name: true } }, driver: { select: { id: true, name: true } }, task: { select: { name: true } } } });
      if (!rest.length) {
        await tx.boronganClaim.delete({ where: { id } });
        claimsDeleted++;
      } else {
        await tx.boronganClaim.update({ where: { id }, data: { total: BigInt(claimBreakdown(rest).totals.all) } });
        claimsUpdated++;
      }
    }
    if (ids.pickups.length) await tx.boronganPickup.deleteMany({ where: { id: { in: ids.pickups } } }); // baris & hitungan ikut (cascade)
    if (ids.shipments.length) await tx.boronganShipment.deleteMany({ where: { id: { in: ids.shipments } } }); // tugas, bahan, pembagian, laporan hasil ikut (cascade)
    if (ids.receipts.length) await tx.boronganReceipt.deleteMany({ where: { id: { in: ids.receipts } } }); // baris ikut (cascade)
    if (ids.shiftReceipts.length) await tx.shiftReceipt.deleteMany({ where: { id: { in: ids.shiftReceipts } } });
    if (ids.movementIds.length) await tx.stockMovement.deleteMany({ where: { id: { in: ids.movementIds } } });

    // 3. Samakan saldo dengan snapshot: 1 mutasi PENYESUAIAN per barang × lokasi yang berubah (tanpa jurnal)
    const after = new Map((await stockBalances(tx)).map((b) => [key(b.itemId, b.locationId), b.qty]));
    const keys = new Set([...before.keys(), ...after.keys()]);
    const items = new Map((await tx.item.findMany({ select: { id: true, avgCost: true } })).map((i) => [i.id, i.avgCost]));
    const now = new Date();
    let adjustments = 0;
    for (const k of keys) {
      const delta = round3((before.get(k) ?? 0) - (after.get(k) ?? 0));
      if (Math.abs(delta) < 0.0005) continue;
      const [itemId, locationId] = k.split("|");
      await tx.stockMovement.create({
        data: {
          date: now, type: "PENYESUAIAN", itemId, qty: new Prisma.Decimal(Math.abs(delta)), unitCost: items.get(itemId) ?? 0n, ref,
          fromLocationId: delta < 0 ? locationId : null, toLocationId: delta > 0 ? locationId : null,
          note: "Saldo awal final setelah reset riwayat kiriman & penerimaan (tanpa jurnal, nilai persediaan tidak berubah)", createdBy: actor.name,
        },
      });
      adjustments++;
    }

    // 4. Pastikan sama persis; bila tidak, batalkan semuanya
    const verify = new Map((await stockBalances(tx)).map((b) => [key(b.itemId, b.locationId), b.qty]));
    for (const k of new Set([...before.keys(), ...verify.keys()])) {
      if (Math.abs((before.get(k) ?? 0) - (verify.get(k) ?? 0)) >= 0.0005) throw new Error(`Saldo tidak sama dengan snapshot (${k}): sebelum ${before.get(k) ?? 0}, sesudah ${verify.get(k) ?? 0}. Dibatalkan.`);
    }
    const { _ids, ...summary } = plan;
    void _ids;
    const result: ResetResult = { ...summary, adjustments, snapshotRows: before.size, claimsDeleted, claimsUpdated };
    await audit(actor, "RESET_KIRIMAN_PENERIMAAN", "System", null, {
      kiriman: plan.shipments.length, pengambilan: plan.pickups.length, setoranDihapus: plan.resultsDelete, setoranDilepas: plan.resultsDetach,
      klaimDihapus: claimsDeleted, klaimDiubah: claimsUpdated, penerimaanDivisi: plan.receipts.length, barangMasukDihapus: plan.shiftReceipts,
      barangMasukDilewati: plan.shiftReceiptsSkipped.length, mutasiDihapus: plan.movements, penyesuaian: adjustments, ref, sampai: opts.sampai?.toISOString() ?? null,
    }, tx);
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 600_000, maxWait: 60_000 });
}
