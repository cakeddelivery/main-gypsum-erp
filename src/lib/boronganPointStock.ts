import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { recordMovement, StockError } from "./stock";
import { audit } from "./audit";
import { sendPush } from "./push";
import { addDays, jakartaDateTime, jakartaParts, todayStr } from "./time";
import { pointConfig, taskKits } from "./boronganSetup";
import { FieldError } from "./fieldError";

type Actor = { id: string; name: string };

export type PointStockRow = {
  itemId: string; name: string; unit: string; stock: number; inWeek: number; usedWeek: number; low: boolean;
  /** Reject bahan minggu ini (cat tumpah, plastik klip/OPP rusak) */
  rejectWeek: number;
  /** Terakhir dihitung fisik (opname/koreksi stok titik); null = belum pernah */
  lastCounted: Date | null;
  /** Belum dihitung fisik lebih dari COUNT_ALERT_DAYS hari (atau tidak pernah) */
  stale: boolean;
};
/** Bahan titik wajib dihitung fisik paling lambat tiap berapa hari (cat cair, plastik klip, plastik OPP perlu dipantau) */
export const COUNT_ALERT_DAYS = 7;

/** Senin minggu ini (WIB) sebagai awal hitungan "minggu ini" */
export function weekStart(now: Date = new Date()) {
  const dow = jakartaParts(now).weekday; // 0 = Minggu
  const day = addDays(todayStr(now), -((dow + 6) % 7));
  return jakartaDateTime(day, "00:00");
}

/** Stok tipis: kurang dari pemakaian minggu ini, atau habis/minus untuk bahan yang pernah ada di titik */
export const isLow = (stock: number, used: number, everMoved = true) => (used > 0 && stock < used) || (everMoved && stock <= 0);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Stok bahan pendukung di lokasi titik, hanya untuk jenis pekerjaan yang dikerjakan titik itu
 * (kit bahan per tugas + bahan resep), plus bahan lain yang masih tersisa di titik.
 * Masuk = kiriman/pembagian ke titik minggu ini; terpakai = pemakaian otomatis dari setoran × resep minggu ini.
 * Semua angka dari mutasi stok (satu sumber kebenaran).
 */
export async function pointStock(pointId: string, now: Date = new Date()): Promise<PointStockRow[]> {
  const point = await prisma.boronganPoint.findUniqueOrThrow({ where: { id: pointId }, select: { locationId: true } });
  const loc = point.locationId;
  const [cfg, kits] = await Promise.all([pointConfig(prisma), taskKits(prisma)]);
  // Jenis pekerjaan titik: dari pengaturan titik; bila belum diatur, dari pekerjaan yang pernah dibagi/disetor di titik itu
  let taskIds = cfg[pointId]?.tasks ?? [];
  if (!taskIds.length) {
    const [a, r] = await Promise.all([
      prisma.boronganAllot.findMany({ where: { pointId }, distinct: ["taskId"], select: { taskId: true } }),
      prisma.boronganResult.findMany({ where: { pointId }, distinct: ["taskId"], select: { taskId: true } }),
    ]);
    taskIds = [...new Set([...a, ...r].map((x) => x.taskId))];
  }
  const tasks = await prisma.pieceTask.findMany({ where: { active: true, id: { in: taskIds } }, select: { id: true, outputItemId: true, inputs: { select: { itemId: true } } } });
  const outputs = new Set(tasks.map((t) => t.outputItemId).filter(Boolean));
  const wanted = new Set<string>([...(cfg[pointId]?.kit ?? []), ...tasks.flatMap((t) => [...(kits[t.id] ?? []), ...t.inputs.map((i) => i.itemId)])]);
  const since = weekStart(now);
  const rows = await prisma.$queryRaw<{ itemId: string; stock: Prisma.Decimal; inWeek: Prisma.Decimal; usedWeek: Prisma.Decimal; rejectWeek: Prisma.Decimal; lastCounted: Date | null }[]>`
    SELECT "itemId",
      SUM(CASE WHEN "fromLocationId" = ${loc} AND ref LIKE 'RJB:%' AND date >= ${since} THEN qty ELSE 0 END) AS "rejectWeek",
      MAX(CASE WHEN ref LIKE 'OPT:%' THEN date ELSE NULL END) AS "lastCounted",
      SUM(CASE WHEN "toLocationId" = ${loc} THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" = ${loc} THEN qty ELSE 0 END) AS stock,
      SUM(CASE WHEN "toLocationId" = ${loc} AND type = 'TRANSFER' AND date >= ${since} THEN qty ELSE 0 END) AS "inWeek",
      SUM(CASE WHEN "fromLocationId" = ${loc} AND type = 'KONSUMSI_PRODUKSI' AND date >= ${since} THEN qty ELSE 0 END) AS "usedWeek"
    FROM "StockMovement" WHERE "toLocationId" = ${loc} OR "fromLocationId" = ${loc} GROUP BY "itemId"`;
  const byItem = new Map(rows.map((r) => [r.itemId, { stock: r3(Number(r.stock)), inWeek: r3(Number(r.inWeek)), usedWeek: r3(Number(r.usedWeek)), rejectWeek: r3(Number(r.rejectWeek)), lastCounted: r.lastCounted }]));
  // Barang hasil setoran (mis. produk jadi) bukan bahan pendukung
  for (const [id, v] of byItem) if (Math.abs(v.stock) > 0.0005 && !outputs.has(id)) wanted.add(id);
  const items = await prisma.item.findMany({ where: { id: { in: [...wanted] } }, select: { id: true, name: true, unit: true } });
  return items
    .map((i) => {
      const v = byItem.get(i.id);
      const x = v ?? { stock: 0, inWeek: 0, usedWeek: 0, rejectWeek: 0, lastCounted: null };
      const stale = !x.lastCounted || now.getTime() - new Date(x.lastCounted).getTime() > COUNT_ALERT_DAYS * 86_400_000;
      return { itemId: i.id, name: i.name, unit: i.unit, ...x, low: isLow(x.stock, x.usedWeek, !!v), stale };
    })
    .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name, "id"));
}

/** "Minta bahan": push ke Supervisor & tim Assembling (Kapten), tercatat di audit */
export async function requestPointMaterials(pointId: string, itemIds: string[], note: string | null, actor: Actor) {
  const point = await prisma.boronganPoint.findUniqueOrThrow({ where: { id: pointId }, select: { name: true } });
  const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { name: true } });
  if (!items.length) throw new StockError("Pilih bahan yang diminta");
  const users = await prisma.user.findMany({
    where: { active: true, OR: [{ role: "SUPERVISOR" }, { role: "KAPTEN_DIVISI", division: { reportTemplate: "ASSEMBLING" } }] },
    select: { id: true },
  });
  const list = items.map((i) => i.name).join(", ");
  await audit(actor, "MINTA_BAHAN_TITIK", "BoronganPoint", pointId, { bahan: list, catatan: note });
  if (users.length) await sendPush(users.map((u) => u.id), { title: `Titik ${point.name} minta bahan`, body: `${list}${note ? ` · ${note}` : ""} (dari ${actor.name})`.slice(0, 300), url: "/borongan?tab=kiriman", tag: `minta-${pointId}` }).catch(() => {});
  return { count: items.length, sentTo: users.length };
}

/** Koreksi / opname stok titik: stok sistem disamakan dengan hitungan fisik, wajib alasan, tercatat di mutasi stok & audit */
export async function correctPointStock(pointId: string, itemId: string, counted: number, reason: string, actor: Actor) {
  if (!Number.isFinite(counted) || counted < 0) throw new FieldError("counted", "Isi jumlah fisik (0 atau lebih)");
  if (reason.trim().length < 3) throw new FieldError("reason", "Tulis alasan koreksi");
  const point = await prisma.boronganPoint.findUniqueOrThrow({ where: { id: pointId }, select: { name: true, code: true, locationId: true } });
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ qty: Prisma.Decimal | null }[]>`
      SELECT SUM(CASE WHEN "toLocationId" = ${point.locationId} THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" = ${point.locationId} THEN qty ELSE 0 END) AS qty
      FROM "StockMovement" WHERE "itemId" = ${itemId} AND ("toLocationId" = ${point.locationId} OR "fromLocationId" = ${point.locationId})`;
    const before = r3(Number(rows[0]?.qty ?? 0));
    const diff = r3(counted - before);
    if (diff !== 0) {
      await recordMovement(tx, { type: "PENYESUAIAN", itemId, qty: Math.abs(diff), fromLocationId: point.locationId, increase: diff > 0, allowNegative: true, ref: `OPT:${point.code}`, note: `Opname titik ${point.name} (${actor.name}): ${reason.trim()}` }, actor);
    }
    await audit(actor, "KOREKSI_STOK_TITIK", "BoronganPoint", pointId, { itemId, sebelum: before, fisik: counted, selisih: diff, alasan: reason.trim() }, tx);
    return { before, counted, diff };
  });
}

export const MATERIAL_REJECT_REASONS: Record<string, string> = { ROBEK: "Robek", RUSAK: "Rusak", TUMPAH: "Tumpah", KOTOR: "Kotor", SALAH_WARNA: "Salah warna", LAINNYA: "Lainnya" };

/**
 * Reject bahan pendukung di titik (cat cair tumpah, plastik klip rusak untuk Cat Plastik/Cat Giftbox, plastik OPP untuk Assembling):
 * stok titik berkurang, nilainya dibebankan (beban selisih persediaan), dicatat per bahan + alasan. Bahan harus bagian dari bahan titik itu.
 */
export async function reportMaterialReject(pointId: string, itemId: string, qty: number, reason: string, note: string | null, actor: Actor & { id: string }) {
  if (!Number.isFinite(qty) || !(qty > 0)) throw new FieldError("qty", "Isi jumlah reject lebih dari 0");
  if (!MATERIAL_REJECT_REASONS[reason]) throw new FieldError("reason", "Pilih alasan reject");
  const rows = await pointStock(pointId);
  if (!rows.some((x) => x.itemId === itemId)) throw new FieldError("itemId", "Bahan ini bukan bahan titik ini");
  const point = await prisma.boronganPoint.findUniqueOrThrow({ where: { id: pointId }, select: { name: true, code: true, locationId: true } });
  return prisma.$transaction(async (tx) => {
    const rec = await tx.boronganMaterialReject.create({ data: { pointId, itemId, qty: new Prisma.Decimal(Math.round(qty * 1000) / 1000), reason, note: note?.trim().slice(0, 200) || null, createdBy: actor.name, createdById: actor.id } });
    const mv = await recordMovement(tx, { type: "PENYESUAIAN", itemId, qty, fromLocationId: point.locationId, increase: false, allowNegative: true, ref: `RJB:${rec.id}`, note: `Reject bahan titik ${point.name} (${MATERIAL_REJECT_REASONS[reason]})${note ? `: ${note.trim()}` : ""}`, usage: false }, actor);
    await tx.boronganMaterialReject.update({ where: { id: rec.id }, data: { unitCost: mv.unitCost } });
    await audit(actor, "REJECT_BAHAN_TITIK", "BoronganPoint", pointId, { itemId, qty, alasan: reason, catatan: note ?? undefined }, tx);
    return rec;
  });
}
