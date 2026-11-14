import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { qtyAt, recordMovement, reverseMovementsByRef } from "./stock";
import { BoronganError, warehouseFor, type Scope } from "./borongan";
import { pointConfig } from "./boronganSetup";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/**
 * PENERIMAAN HASIL BORONGAN OLEH DIVISI (dua lapis):
 * - Koordinator titik mencatat setoran per pekerja (BoronganResult) → dasar upah, hasil masuk stok TITIK.
 * - Divisi penerima (Assembling: Single Pack per karakter & Cat Plastik per warna; Giftbox: pot Cat Giftbox) merekap
 *   TOTAL yang diterima per barang, gabungan semua titik. Barang pindah dari stok titik ke gudang; titik dibagi otomatis
 *   dari sisa stok hasil di titik (terbanyak dulu). Reject = dibuang dari stok titik (beban selisih persediaan).
 * - Upah tetap dari setoran koordinator. Selisih setoran vs penerimaan hanya ditampilkan (receiptDiff).
 * Ini satu-satunya jalan hasil borongan berdivisi masuk gudang ("Kirim hasil ke gudang" ditolak untuk barang ini),
 * laporan shift tidak memposting setoran, jadi stok tidak dobel.
 */

/** Barang hasil tugas borongan divisi (keluaran tugas aktif yang divisi pencatatnya = divisi ini) */
export async function receiptItems(divisionId: string, db: Tx | typeof prisma = prisma) {
  const tasks = await db.pieceTask.findMany({ where: { divisionId, active: true, outputItemId: { not: null } }, include: { outputItem: true }, orderBy: { name: "asc" } });
  const seen = new Map<string, { id: string; name: string; unit: string; type: string; taskIds: string[] }>();
  for (const t of tasks) {
    const it = t.outputItem!;
    const cur = seen.get(it.id) ?? { id: it.id, name: it.name, unit: it.unit, type: it.type, taskIds: [] };
    cur.taskIds.push(t.id);
    seen.set(it.id, cur);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Barang hasil borongan yang wajib masuk gudang lewat penerimaan divisi (keluaran tugas berdivisi) */
export async function divisionOutputItemIds(db: Tx | typeof prisma = prisma) {
  const t = await db.pieceTask.findMany({ where: { divisionId: { not: null }, outputItemId: { not: null } }, select: { outputItemId: true } });
  return new Set(t.map((x) => x.outputItemId!));
}

/** Titik yang mengerjakan tugas penghasil barang ini (pengaturan tugas per titik; tanpa pengaturan = semua titik aktif) */
async function pointsFor(tx: Tx, taskIds: string[]) {
  const [points, cfg] = await Promise.all([tx.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" } }), pointConfig(tx)]);
  return points.filter((p) => !cfg[p.id]?.tasks.length || cfg[p.id].tasks.some((t) => taskIds.includes(t)));
}

/** Sisa hasil per titik untuk form (stok barang hasil di lokasi titik) */
export async function pendingAtPoints(divisionId: string) {
  const items = await receiptItems(divisionId);
  return prisma.$transaction(async (tx) => {
    const out: Record<string, { pointId: string; name: string; qty: number }[]> = {};
    for (const it of items) {
      const pts = await pointsFor(tx, it.taskIds);
      out[it.id] = await Promise.all(pts.map(async (p) => ({ pointId: p.id, name: p.name, qty: Math.round((await qtyAt(tx, it.id, p.locationId)) * 1000) / 1000 })));
    }
    return out;
  });
}

/**
 * Bagi jumlah ke titik: titik dengan sisa stok terbanyak dulu; kelebihan (diterima melebihi sisa di semua titik)
 * dibebankan ke titik yang paling banyak setorannya, sehingga stok titik minus dan selisihnya terlihat.
 */
export function allocate(total: number, avail: { pointId: string; qty: number }[], fallbackPointId: string): Map<string, number> {
  const out = new Map<string, number>();
  let left = total;
  for (const a of [...avail].sort((x, y) => y.qty - x.qty)) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, a.qty));
    if (take > 0) { out.set(a.pointId, (out.get(a.pointId) ?? 0) + take); a.qty -= take; left -= take; }
  }
  if (left > 0) out.set(fallbackPointId, (out.get(fallbackPointId) ?? 0) + left);
  return out;
}

export type ReceiptInput = { divisionId: string; date: Date; note?: string | null; lines: { itemId: string; qty: number; reject?: number }[] };

/** Boleh mencatat/membatalkan penerimaan divisi ini: pengelola borongan atau anggota divisi tsb */
export function assertReceiptDivision(scope: Scope, divisionId: string) {
  if (!scope.all && scope.division?.id !== divisionId) throw new BoronganError("Penerimaan dicatat oleh anggota divisi penerima");
}

export async function recordDivisionReceipt(input: ReceiptInput, actor: Actor, scope: Scope) {
  assertReceiptDivision(scope, input.divisionId);
  const lines = input.lines.map((l) => ({ itemId: l.itemId, qty: Math.round((l.qty || 0) * 1000) / 1000, reject: Math.round((l.reject || 0) * 1000) / 1000 })).filter((l) => l.qty > 0 || l.reject > 0);
  if (lines.some((l) => l.qty < 0 || l.reject < 0)) throw new BoronganError("Jumlah tidak boleh minus");
  if (!lines.length) throw new BoronganError("Isi jumlah diterima minimal satu barang");
  return prisma.$transaction(async (tx) => {
    const items = await receiptItems(input.divisionId, tx);
    const number = await nextNumber(tx, "PND", input.date);
    const ref = `PND:${number}`;
    const rows: { itemId: string; pointId: string; qty: number; reject: number }[] = [];
    for (const l of lines) {
      const it = items.find((x) => x.id === l.itemId);
      if (!it) throw new BoronganError("Barang ini bukan hasil borongan divisi ini");
      const pts = await pointsFor(tx, it.taskIds);
      if (!pts.length) throw new BoronganError(`Belum ada titik yang mengerjakan ${it.name}`);
      const avail = await Promise.all(pts.map(async (p) => ({ pointId: p.id, qty: await qtyAt(tx, it.id, p.locationId) })));
      // Kelebihan dibebankan ke titik dengan setoran terbanyak barang ini
      const top = await tx.boronganResult.groupBy({ by: ["pointId"], where: { taskId: { in: it.taskIds }, pointId: { in: pts.map((p) => p.id) } }, _sum: { qty: true }, orderBy: { _sum: { qty: "desc" } }, take: 1 });
      const fallback = top[0]?.pointId ?? pts[0].id;
      const good = allocate(l.qty, avail, fallback);
      const bad = allocate(l.reject, avail, fallback);
      const warehouse = await warehouseFor(tx, it.type as Parameters<typeof warehouseFor>[1]);
      for (const p of pts) {
        const q = good.get(p.id) ?? 0;
        const r = bad.get(p.id) ?? 0;
        if (!q && !r) continue;
        if (q > 0) await recordMovement(tx, { type: "TRANSFER", itemId: it.id, qty: q, fromLocationId: p.locationId, toLocationId: warehouse, allowNegative: true, ref, note: `Penerimaan divisi dari ${p.name}`, date: input.date }, actor);
        // Reject saat diterima: dibuang dari stok titik (beban selisih persediaan), tidak masuk gudang
        if (r > 0) await recordMovement(tx, { type: "PENYESUAIAN", itemId: it.id, qty: r, fromLocationId: p.locationId, increase: false, allowNegative: true, ref, note: `Reject saat diterima dari ${p.name}`, date: input.date }, actor);
        rows.push({ itemId: it.id, pointId: p.id, qty: q, reject: r });
      }
    }
    const rec = await tx.boronganReceipt.create({
      data: { number, divisionId: input.divisionId, date: input.date, note: input.note ?? null, createdBy: actor.name, createdById: actor.id, lines: { create: rows.map((r) => ({ ...r, qty: new Prisma.Decimal(r.qty), reject: new Prisma.Decimal(r.reject) })) } },
      include: { lines: true },
    });
    await audit(actor, "PENERIMAAN_BORONGAN", "BoronganReceipt", rec.id, { number, lines: lines.length }, tx);
    return rec;
  }, { timeout: 30000 });
}

/** Batalkan penerimaan: stok kembali ke titik, jurnal reject dibalik. Pencatat sendiri, kapten divisi, atau pengelola */
export async function cancelDivisionReceipt(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganReceipt" WHERE id = ${id} FOR UPDATE`;
    const rec = await tx.boronganReceipt.findUniqueOrThrow({ where: { id } });
    if (rec.cancelledAt) throw new BoronganError(`${rec.number} sudah dibatalkan`);
    assertReceiptDivision(scope, rec.divisionId);
    if (!scope.all && !scope.division?.captain && rec.createdById !== actor.id) throw new BoronganError("Anda hanya bisa membatalkan penerimaan yang Anda catat sendiri. Minta kapten divisi.");
    const ref = `PND:${rec.number}`;
    const moves = await tx.stockMovement.findMany({ where: { ref }, select: { id: true } });
    await reverseMovementsByRef(tx, ref, `BATAL-${ref}`, "Penerimaan divisi dibatalkan", actor);
    const journals = await tx.journal.findMany({ where: { reversalOfId: null, source: "STOK", sourceId: { in: moves.map((m) => m.id) } } });
    for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, `batal ${rec.number}`);
    await tx.boronganReceipt.update({ where: { id }, data: { cancelledAt: new Date(), cancelBy: actor.name } });
    await audit(actor, "PENERIMAAN_BORONGAN_DIBATALKAN", "BoronganReceipt", id, { number: rec.number }, tx);
  });
}

export type DiffRow = { itemId: string; name: string; unit: string; setoran: number; setoranReject: number; diterima: number; rejectDiterima: number; selisih: number; atPoint: number; points: { pointId: string; name: string; setoran: number; diterima: number; selisih: number; atPoint: number }[] };

/**
 * Selisih setoran koordinator vs penerimaan divisi per barang (dan per titik) dalam rentang tanggal.
 * selisih = (diterima + reject saat diterima) − setoran bagus koordinator. Minus = belum/kurang diterima, plus = diterima lebih.
 * atPoint = sisa stok hasil di titik sekarang (setoran yang belum diterima, kumulatif).
 */
export async function receiptDiff(divisionId: string, from: Date, to: Date): Promise<DiffRow[]> {
  const items = await receiptItems(divisionId);
  if (!items.length) return [];
  const [results, lines, points] = await Promise.all([
    prisma.boronganResult.groupBy({ by: ["taskId", "pointId"], where: { taskId: { in: items.flatMap((i) => i.taskIds) }, date: { gte: from, lte: to } }, _sum: { qty: true, reject: true } }),
    prisma.boronganReceiptLine.groupBy({ by: ["itemId", "pointId"], where: { itemId: { in: items.map((i) => i.id) }, receipt: { divisionId, cancelledAt: null, date: { gte: from, lte: to } } }, _sum: { qty: true, reject: true } }),
    prisma.boronganPoint.findMany({ orderBy: { code: "asc" } }),
  ]);
  const rows: DiffRow[] = [];
  for (const it of items) {
    const per = await Promise.all(points.map(async (p) => {
      const s = results.filter((r) => it.taskIds.includes(r.taskId) && r.pointId === p.id).reduce((a, r) => ({ q: a.q + (r._sum.qty ?? 0), rj: a.rj + (r._sum.reject ?? 0) }), { q: 0, rj: 0 });
      const d = lines.find((l) => l.itemId === it.id && l.pointId === p.id);
      const dq = Number(d?._sum.qty ?? 0);
      const dr = Number(d?._sum.reject ?? 0);
      const atPoint = Math.round((await qtyAt(prisma, it.id, p.locationId)) * 1000) / 1000;
      return { pointId: p.id, name: p.name, setoran: s.q, setoranReject: s.rj, diterima: dq, rejectDiterima: dr, selisih: dq + dr - s.q, atPoint };
    }));
    const used = per.filter((x) => x.setoran || x.diterima || x.rejectDiterima || x.atPoint);
    const sum = (k: "setoran" | "setoranReject" | "diterima" | "rejectDiterima" | "atPoint") => used.reduce((a, x) => a + x[k], 0);
    rows.push({
      itemId: it.id, name: it.name, unit: it.unit, setoran: sum("setoran"), setoranReject: sum("setoranReject"), diterima: sum("diterima"), rejectDiterima: sum("rejectDiterima"),
      selisih: sum("diterima") + sum("rejectDiterima") - sum("setoran"), atPoint: sum("atPoint"),
      points: used.map((x) => ({ pointId: x.pointId, name: x.name, setoran: x.setoran, diterima: x.diterima + x.rejectDiterima, selisih: x.selisih, atPoint: x.atPoint })),
    });
  }
  return rows;
}

/** Teks ringkas selisih untuk laporan shift / pelunasan (hanya barang yang berselisih) */
export function diffLines(rows: DiffRow[]): string[] {
  const f = (n: number) => n.toLocaleString("id-ID");
  return rows.filter((r) => r.selisih !== 0).map((r) => `${r.name}: setoran ${f(r.setoran)} · diterima ${f(r.diterima + r.rejectDiterima)}${r.rejectDiterima ? ` (reject ${f(r.rejectDiterima)})` : ""} · selisih ${r.selisih > 0 ? "+" : ""}${f(r.selisih)} (${r.points.filter((p) => p.selisih !== 0).map((p) => `${p.name} ${p.selisih > 0 ? "+" : ""}${f(p.selisih)}`).join(", ")})`);
}

/** Baris laporan shift: penerimaan divisi di tanggal itu + selisih terhadap setoran koordinator tanggal itu */
export async function receiptReportLines(divisionId: string, date: Date): Promise<string[]> {
  const rows = (await receiptDiff(divisionId, date, date)).filter((r) => r.setoran || r.diterima || r.rejectDiterima);
  if (!rows.length) return [];
  const f = (n: number) => n.toLocaleString("id-ID");
  return [
    "PENERIMAAN HASIL BORONGAN (divisi)",
    ...rows.map((r) => `${r.name}: diterima ${f(r.diterima)}${r.rejectDiterima ? ` + reject ${f(r.rejectDiterima)}` : ""} · setoran koordinator ${f(r.setoran)}${r.selisih ? ` ⚠ selisih ${r.selisih > 0 ? "+" : ""}${f(r.selisih)}` : " ✓"}`),
  ];
}
