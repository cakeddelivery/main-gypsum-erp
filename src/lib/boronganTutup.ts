import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { shipmentViews, type ShipmentView } from "./boronganFlow";
import { claimBreakdown, claimable } from "./boronganClaim";
import { coordinatorCovers, coordinatorPointSelect, coordinatorsAt } from "./borongan";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

export type CloseCell = { shipment: string; worker: string; task: string; kirim: number; lapor: number; ambil: number; reject: number; sisa: number };
export type ClosePoint = {
  pointId: string; point: string; coordinator: string;
  shipments: string[]; cells: CloseCell[];
  /** Setoran diambil driver tetapi belum diterima divisi (upah belum dibukukan) */
  pendingPickups: string[];
  /** Upah setoran yang sudah dibukukan tapi belum diklaim — keputusan Owner: dianggap SUDAH BERES (hanya info) */
  unclaimed: { count: number; total: number };
  openClaims: { count: number; total: number };
};
export type ClosePlan = { shipments: { id: string; number: string; date: string; state: string }[]; points: ClosePoint[]; legacyHandovers: number };

/**
 * Rencana menutup administratif SEMUA kiriman borongan yang belum selesai (cut-over stok dari laporan shift).
 * Tidak mengubah apa pun. Sisa di pekerja/titik dianggap sudah tercermin di hitungan laporan shift.
 */
export async function planCloseAll(): Promise<ClosePlan> {
  const views = (await shipmentViews({ cancelledAt: null, closedAt: null }, 1000)).filter((v) => v.state !== "SELESAI");
  const taskName = new Map(views.flatMap((v) => v.tasks.map((t) => [t.id, t.short || t.name] as const)));
  const pointIds = [...new Set(views.flatMap((v) => v.points.map((p) => p.id)))];
  // Titik yang punya upah belum diklaim / klaim terbuka ikut ditampilkan walau kirimannya sudah selesai
  const extra = await prisma.boronganResult.findMany({ where: { settlementId: null, held: false, claimId: null }, select: { pointId: true }, distinct: ["pointId"] });
  const claimPts = await prisma.boronganClaim.findMany({ where: { status: "MENUNGGU" }, select: { pointId: true }, distinct: ["pointId"] });
  const allIds = [...new Set([...pointIds, ...extra.map((x) => x.pointId), ...claimPts.map((x) => x.pointId)])];
  const [points, coords] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true, code: true } }),
    prisma.boronganPerson.findMany({ where: coordinatorsAt(allIds), select: { name: true, ...coordinatorPointSelect } }),
  ]);
  const out: ClosePoint[] = [];
  for (const id of allIds) {
    const p = points.find((x) => x.id === id);
    const mine = views.filter((v) => v.points.some((x) => x.id === id));
    const cells: CloseCell[] = mine.flatMap((v) => v.cells.filter((c) => c.pointId === id && c.dibagi > 0 && !c.done).map((c) => ({
      shipment: v.number, worker: c.worker, task: taskName.get(c.taskId) ?? c.taskId,
      kirim: c.dibagi, lapor: c.good, ambil: c.diambil, reject: c.reject, sisa: Math.max(0, c.dibagi - c.diambil - c.reject),
    })));
    const pendingPickups = (await shipmentViews({ cancelledAt: null, pickups: { some: { status: { in: ["DIBAWA", "KURANG"] }, lines: { some: { pointId: id } } } } }, 1000))
      .flatMap((v: ShipmentView) => v.pickups.filter((pk) => (pk.status === "DIBAWA" || pk.status === "KURANG") && pk.lines.some((l) => l.pointId === id))
        .map((pk) => `${pk.number} (${v.number}) ${pk.status} · ${pk.lines.filter((l) => l.pointId === id).reduce((a, l) => a + l.qty, 0)} pcs`));
    const results = await prisma.boronganResult.findMany({ where: claimable(id), include: { worker: { select: { id: true, name: true } }, coordinator: { select: { id: true, name: true } }, driver: { select: { id: true, name: true } }, task: { select: { name: true } } } });
    const claims = await prisma.boronganClaim.findMany({ where: { pointId: id, status: "MENUNGGU" }, select: { total: true } });
    out.push({
      pointId: id, point: p ? `${p.code} ${p.name}` : id, coordinator: coords.filter((c) => coordinatorCovers(c, id)).map((c) => c.name).join(", ") || "(tanpa koordinator)",
      shipments: mine.map((v) => v.number), cells, pendingPickups,
      unclaimed: { count: results.length, total: claimBreakdown(results).totals.all },
      openClaims: { count: claims.length, total: claims.reduce((a, c) => a + Number(c.total), 0) },
    });
  }
  const legacyHandovers = await prisma.boronganHandover.count({ where: { status: "DIKIRIM" } });
  return { shipments: views.map((v) => ({ id: v.id, number: v.number, date: v.date, state: v.state })), points: out, legacyHandovers };
}

/**
 * Tutup administratif: kiriman ditandai SELESAI (closedAt) — TANPA mutasi stok, TANPA membuat/menghapus upah, klaim, atau jurnal.
 * Keputusan Owner (cut-over 20 Nov): setoran yang belum diklaim dianggap sudah beres, jadi tidak ada klaim baru.
 */
export async function applyCloseAll(tx: Tx, plan: ClosePlan, actor: Actor, opts: { note: string; now?: Date }) {
  const now = opts.now ?? new Date();
  let closed = 0;
  for (const s of plan.shipments) {
    const r = await tx.boronganShipment.updateMany({ where: { id: s.id, closedAt: null, cancelledAt: null }, data: { closedAt: now, closedBy: actor.name, closeNote: opts.note } });
    if (!r.count) continue;
    await audit(actor, "BORONGAN_TUTUP_ADMINISTRATIF", "BoronganShipment", s.id, { nomor: s.number, statusSebelum: s.state, statusSesudah: "SELESAI", catatan: opts.note, stok: "tidak diubah", upah: "tidak diubah" }, tx);
    closed++;
  }
  return { closed };
}

export function closeLines(plan: ClosePlan): string[] {
  const L: string[] = [`${plan.shipments.length} kiriman belum selesai akan ditandai SELESAI (administratif): ${plan.shipments.map((s) => `${s.number} [${s.state}]`).join(", ") || "-"}`];
  for (const p of plan.points) {
    L.push("", `== ${p.point} · koordinator: ${p.coordinator} ==`, `   kiriman: ${p.shipments.join(", ") || "-"}`);
    for (const c of p.cells) L.push(`   ${c.shipment} · ${c.worker} · ${c.task}: kirim ${c.kirim}, lapor bagus ${c.lapor}, diambil ${c.ambil}, reject ${c.reject}, sisa di pekerja ${c.sisa}`);
    if (p.pendingPickups.length) L.push(`   setoran diambil BELUM DITERIMA (upah belum dibukukan, tidak diubah): ${p.pendingPickups.join("; ")}`);
    L.push(`   upah setoran belum diklaim: ${p.unclaimed.count} setoran · Rp${p.unclaimed.total.toLocaleString("id-ID")}${p.unclaimed.count ? " (info saja: dianggap sudah beres, tidak diklaim)" : ""}`);
    if (p.openClaims.count) L.push(`   klaim upah menunggu persetujuan: ${p.openClaims.count} · Rp${p.openClaims.total.toLocaleString("id-ID")} (dibiarkan)`);
  }
  if (plan.legacyHandovers) L.push("", `Serah terima alur lama berstatus DIKIRIM: ${plan.legacyHandovers} (hanya dilaporkan, tidak diubah)`);
  return L;
}
