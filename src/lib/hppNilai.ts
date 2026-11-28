import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { itemCosts, laborRate } from "./hpp";
import { INVENTORY_COA, itemQty } from "./stock";
import { bomLineCost, latestCost, recipeUnit } from "./unitcost";

/**
 * Harga pokok barang setengah jadi & jadi (bahan + upah borongan, TANPA overhead bulanan) dari resep:
 * resep barang (ItemRecipeLine + upah) bila ada, kalau tidak resep produk (BOM + upah) untuk barang jadi produk.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export type CostTarget = { mat: number; labor: number; total: number; source: "RESEP_BARANG" | "BOM_PRODUK" };

export async function costTargets(db: Db): Promise<Map<string, CostTarget>> {
  const costs = await itemCosts(db as never);
  const out = new Map<string, CostTarget>();
  for (const [id, c] of costs) {
    if (!c.fromRecipe) continue;
    const mat = Math.round(c.mat);
    const labor = Math.round(c.labor ?? 0);
    if (mat + labor > 0) out.set(id, { mat, labor, total: mat + labor, source: "RESEP_BARANG" });
  }
  const prods = await db.product.findMany({
    where: { finishedItemId: { not: null }, active: true },
    select: { finishedItemId: true, extraPackaging: true, laborCost: true, bom: { include: { item: true } }, recipeLabor: { include: { task: { select: { ratePerPcs: true } } } } },
  });
  for (const p of prods) {
    const id = p.finishedItemId!;
    if (out.has(id) || costs.get(id)?.fromRecipe) continue;
    let mat = Number(p.extraPackaging);
    let labor = p.recipeLabor.reduce((s, r) => s + laborRate(r), 0) + Number(p.laborCost);
    for (const b of p.bom) {
      const c = costs.get(b.itemId);
      mat += bomLineCost(b.qty, b.item, c?.mat ?? latestCost(b.item));
      labor += bomLineCost(b.qty, b.item, c?.labor ?? 0);
    }
    mat = Math.round(mat);
    labor = Math.round(labor);
    if (mat + labor > 0) out.set(id, { mat, labor, total: mat + labor, source: "BOM_PRODUK" });
  }
  return out;
}

// ---------------- (a) Resep dari tugas borongan ----------------

export type ResepPlan = { itemId: string; sku: string; name: string; why: string; lines: string[]; skipped?: string };

/**
 * Pasang resep barang hasil yang BELUM punya resep sama sekali (barang, maupun BOM produknya):
 * - hasil tugas borongan: bahan per pcs = bahan tugas, upah = tarif tugas (ikut tarif terbaru)
 * - Patung kering <karakter> tanpa resep: 1 Patung cetak <karakter> (upah/biaya oven belum ada → isi manual di Master data bila perlu)
 * Resep / BOM yang sudah terisi (manual atau dari setup) TIDAK ditimpa; hanya ditampilkan.
 */
export async function planResepDariTugas(db: Db): Promise<{ plan: ResepPlan[]; sudahAda: string[] }> {
  const tasks = await db.pieceTask.findMany({ where: { active: true, outputItemId: { not: null } }, include: { inputs: { include: { item: true } }, outputItem: true } });
  const plan: ResepPlan[] = [];
  const sudahAda: string[] = [];
  const seen = new Set<string>();
  const has = async (itemId: string) => (await db.itemRecipeLine.count({ where: { itemId } })) + (await db.recipeLabor.count({ where: { itemId } })) + (await db.bomLine.count({ where: { product: { finishedItemId: itemId } } })) > 0;
  for (const t of tasks) {
    const it = t.outputItem!;
    if (seen.has(it.id) || !["BARANG_DALAM_PROSES", "BARANG_JADI"].includes(it.type)) continue;
    seen.add(it.id);
    if (await has(it.id)) { sudahAda.push(`${it.sku} ${it.name}`); continue; }
    if (!t.inputs.length && !(t.workerRate + t.coordinatorRate + t.driverRate > 0n)) continue;
    plan.push({
      itemId: it.id, sku: it.sku, name: it.name, why: `tugas borongan ${t.name}`,
      lines: [
        ...t.inputs.map((i) => `${i.item.name} × ${Number(i.qty).toLocaleString("id-ID")} ${recipeUnit(i.item)}`),
        `upah ${t.name} Rp${Number(t.workerRate + t.coordinatorRate + t.driverRate).toLocaleString("id-ID")}/pcs`,
      ],
    });
  }
  const items = await db.item.findMany({ where: { active: true, sku: { startsWith: "SJ-PTG-" } } });
  for (const it of items) {
    if (seen.has(it.id)) continue;
    const v = it.sku.slice("SJ-PTG-".length);
    if (v === "BEBAS" || (await has(it.id))) continue;
    const cetak = await db.item.findUnique({ where: { sku: `SJ-CTK-${v}` } });
    if (!cetak) continue;
    plan.push({ itemId: it.id, sku: it.sku, name: it.name, why: "patung kering dari patung cetak", lines: [`${cetak.name} × 1 pcs`, "(upah/biaya oven belum ada: isi manual di Master data bila perlu)"] });
  }
  return { plan, sudahAda };
}

export async function pasangResepDariTugas(db: PrismaClient, apply: boolean) {
  const res = await planResepDariTugas(db);
  if (!apply || !res.plan.length) return res;
  await db.$transaction(async (tx) => {
    for (const p of res.plan) {
      if (p.why.startsWith("tugas borongan")) {
        const t = await tx.pieceTask.findFirstOrThrow({ where: { outputItemId: p.itemId, active: true }, include: { inputs: { include: { item: true } } } });
        for (const i of t.inputs) await tx.itemRecipeLine.create({ data: { itemId: p.itemId, componentId: i.itemId, qty: i.qty, useUnit: recipeUnit(i.item) } });
        const rate = t.workerRate + t.coordinatorRate + t.driverRate;
        if (rate > 0n) await tx.recipeLabor.create({ data: { itemId: p.itemId, taskId: t.id, name: `Upah borongan ${t.name}`, rate } });
      } else {
        const cetak = await tx.item.findUniqueOrThrow({ where: { sku: `SJ-CTK-${p.sku.slice("SJ-PTG-".length)}` } });
        await tx.itemRecipeLine.create({ data: { itemId: p.itemId, componentId: cetak.id, qty: 1, useUnit: "pcs" } });
      }
    }
    await tx.auditLog.create({ data: { actorName: "skrip hpp:resep-dari-tugas", action: "RESEP_DARI_TUGAS", entity: "Item", entityId: "massal", data: { items: res.plan.map((p) => ({ sku: p.sku, dari: p.why })) } as unknown as Prisma.InputJsonValue } });
  }, { isolationLevel: "Serializable", timeout: 60000 });
  return res;
}

// ---------------- (c) Revaluasi harga rata-rata ----------------

export type RevalRow = { itemId: string; sku: string; name: string; type: string; qty: number; old: number; target: number; delta: number; wajar: boolean; source: string };

/** Harga rata-rata 0 (atau, dengan opsi, menyimpang > 2× / < 0,5× dari resep) → harga resep (bahan + upah). */
export async function planRevaluasi(db: Db): Promise<RevalRow[]> {
  const targets = await costTargets(db);
  if (!targets.size) return [];
  const items = await db.item.findMany({ where: { id: { in: [...targets.keys()] }, active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] } }, orderBy: [{ type: "asc" }, { sku: "asc" }] });
  const rows: RevalRow[] = [];
  for (const it of items) {
    const t = targets.get(it.id)!;
    const old = Number(it.avgCost);
    const ratio = old > 0 ? old / t.total : 0;
    const zero = old <= 0;
    const odd = !zero && (ratio > 2 || ratio < 0.5);
    if (!zero && !odd) continue;
    const qty = Math.max(0, await itemQty(db as never, it.id));
    rows.push({ itemId: it.id, sku: it.sku, name: it.name, type: it.type, qty, old, target: t.total, delta: Math.round(qty * (t.total - old)), wajar: zero, source: t.source === "RESEP_BARANG" ? "resep barang" : "BOM produk" });
  }
  return rows;
}

/**
 * Terapkan: avgCost = harga resep. Selisih nilai (stok × (baru − lama)) dijurnal ke Beban Selisih Persediaan (6-1800), satu jurnal,
 * satu transaksi + audit. Idempoten: sesudah diterapkan harga = resep sehingga tidak ada kandidat lagi.
 * `tidakWajar` = ikut barang yang harganya ada tetapi menyimpang jauh dari resep.
 */
export async function revaluasiAvgCost(db: PrismaClient, apply: boolean, opts: { tidakWajar?: boolean } = {}) {
  const all = await planRevaluasi(db);
  const rows = all.filter((r) => r.wajar || opts.tidakWajar);
  if (!apply || !rows.length) return { rows, skipped: all.length - rows.length, journalId: null as string | null };
  const journalId = await db.$transaction(async (tx) => {
    const fresh = (await planRevaluasi(tx)).filter((r) => r.wajar || opts.tidakWajar);
    const net = new Map<string, number>();
    for (const r of fresh) {
      await tx.item.update({ where: { id: r.itemId }, data: { avgCost: BigInt(r.target) } });
      if (r.delta !== 0) net.set(INVENTORY_COA[r.type as keyof typeof INVENTORY_COA], (net.get(INVENTORY_COA[r.type as keyof typeof INVENTORY_COA]) ?? 0) + r.delta);
    }
    let jid: string | null = null;
    const lines = [...net].filter(([, v]) => v !== 0).map(([code, v]) => (v > 0 ? { accountCode: code, debit: v } : { accountCode: code, credit: -v }));
    const total = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    if (lines.length) {
      const j = await postJournal(tx, {
        date: new Date(), storeId: await defaultStoreId(tx), description: `Revaluasi harga pokok barang (${fresh.length} barang, harga resep: bahan + upah)`,
        source: "REVALUASI_HPP", sourceId: new Date().toISOString(), actor: { id: "system", name: "skrip hpp:revaluasi" },
        lines: [...lines, ...(total > 0 ? [{ accountCode: COA.BEBAN_SELISIH_PERSEDIAAN, credit: total }] : total < 0 ? [{ accountCode: COA.BEBAN_SELISIH_PERSEDIAAN, debit: -total }] : [])],
      });
      jid = j.id;
    }
    await tx.auditLog.create({ data: { actorName: "skrip hpp:revaluasi", action: "REVALUASI_AVGCOST", entity: "Item", entityId: "massal", data: { items: fresh.map((r) => ({ sku: r.sku, lama: r.old, baru: r.target, qty: r.qty, selisih: r.delta })) } as unknown as Prisma.InputJsonValue } });
    return jid;
  }, { isolationLevel: "Serializable", timeout: 120000 });
  return { rows, skipped: all.length - rows.length, journalId };
}
