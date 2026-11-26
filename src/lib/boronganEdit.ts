import { prisma } from "./db";
import { pointConfig, taskKits } from "./boronganSetup";
import { stockBalances } from "./stock";
import { bomStockQty } from "./unitcost";
import type { ShipmentView } from "./boronganFlow";

export type EditOptions = {
  points: { id: string; name: string; viaDriver: boolean }[];
  drivers: { id: string; name: string }[];
  /** Bahan yang boleh dikirim: resep jenis pekerjaan + kit + yang sudah ada di kiriman; per = takaran resep per pcs per jenis */
  items: { id: string; name: string; unit: string; stock: number; qty: number; per: Record<string, number> }[];
  /** Kunci perubahan struktur: ada pembagian/laporan/pengambilan (titik tetap) atau upah sudah masuk klaim/dibayar (titik/cara kirim/driver tetap) */
  pointsLocked: string | null;
  routeLocked: string | null;
  /** Batas minimal jumlah per jenis = yang sudah dibagi ke pekerja */
  minQty: Record<string, number>;
};

/** Pilihan form "Ubah kiriman" untuk satu kiriman (hanya dipanggil untuk Owner/Supervisor) */
export async function shipmentEditOptions(v: ShipmentView): Promise<EditOptions> {
  const s = await prisma.boronganShipment.findUniqueOrThrow({
    where: { id: v.id },
    select: { reports: { select: { id: true } }, allots: { select: { taskId: true, qty: true } }, pickups: { where: { status: { not: "DIBATALKAN" } }, select: { id: true } }, lines: { select: { itemId: true, qty: true } }, tasks: { select: { taskId: true, task: { select: { inputs: { select: { itemId: true, qty: true, item: true } } } } } } },
  });
  const [points, drivers, cfg, kits, balances, claimed] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.boronganPerson.findMany({ where: { role: "DRIVER", active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    pointConfig(prisma),
    taskKits(prisma),
    stockBalances(prisma),
    prisma.boronganResult.count({ where: { pickup: { shipmentId: v.id }, OR: [{ claimId: { not: null } }, { settlementId: { not: null } }] } }),
  ]);
  const taskIds = s.tasks.map((t) => t.taskId);
  const pts = points.filter((p) => !cfg[p.id]?.tasks.length || cfg[p.id].tasks.some((id) => taskIds.includes(id)));
  const pointLocs = new Set(points.map((p) => p.locationId));
  const stock = new Map<string, number>();
  for (const b of balances) if (!pointLocs.has(b.locationId)) stock.set(b.itemId, (stock.get(b.itemId) ?? 0) + b.qty);
  const per = new Map<string, Record<string, number>>();
  for (const t of s.tasks) for (const i of t.task.inputs) per.set(i.itemId, { ...(per.get(i.itemId) ?? {}), [t.taskId]: bomStockQty(i.qty, i.item) });
  const ids = new Set<string>([...per.keys(), ...taskIds.flatMap((id) => kits[id] ?? []), ...s.lines.map((l) => l.itemId)]);
  const rows = await prisma.item.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, unit: true } });
  const cur = new Map(s.lines.map((l) => [l.itemId, Number(l.qty)]));
  const minQty: Record<string, number> = {};
  for (const a of s.allots) minQty[a.taskId] = (minQty[a.taskId] ?? 0) + a.qty;
  return {
    points: pts.map((p) => ({ id: p.id, name: p.name, viaDriver: p.viaDriver })),
    drivers,
    items: rows.map((i) => ({ ...i, stock: Math.round((stock.get(i.id) ?? 0) * 1000) / 1000, qty: cur.get(i.id) ?? 0, per: per.get(i.id) ?? {} })).sort((a, b) => Number(b.qty > 0) - Number(a.qty > 0) || a.name.localeCompare(b.name, "id")),
    pointsLocked: s.allots.length || s.reports.length || s.pickups.length ? "Titik tidak bisa diganti: kiriman sudah dibagi / dilaporkan / diambil setorannya" : null,
    routeLocked: claimed ? "Titik, cara kirim, dan driver terkunci: upah kiriman ini sudah masuk klaim / dibayar" : null,
    minQty,
  };
}
