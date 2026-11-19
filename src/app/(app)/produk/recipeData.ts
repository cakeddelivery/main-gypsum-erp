import { prisma } from "@/lib/db";
import { coverageOf } from "@/lib/recipeRules";
import { overheadSummary, PACKAGING_CATEGORY, type UnitCost } from "@/lib/hpp";
import { fromRecipeQty } from "@/lib/itemCatalog";
import { costPerRecipeUnit, recipeUnit } from "@/lib/unitcost";
import type { RecipeComponent, RecipeInitial, RecipeOverheadOpt, RecipeTask } from "./RecipeEditor";

/** Pilihan master untuk RecipeEditor: komponen (harga per satuan resep), tarif borongan, overhead per pcs */
export async function recipeOptions(costs: Map<string, UnitCost>) {
  const [items, tasks, oh] = await Promise.all([
    prisma.item.findMany({ where: { active: true, type: { in: ["BAHAN_BAKU", "BARANG_DALAM_PROSES"] } }, orderBy: { name: "asc" } }),
    prisma.pieceTask.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    overheadSummary(),
  ]);
  const components: RecipeComponent[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    unit: recipeUnit(i),
    price: costPerRecipeUnit(costs.get(i.id)?.cur ?? 0, i),
    source: i.type === "BARANG_DALAM_PROSES" ? "BSJ" : "BB",
    packaging: i.category === PACKAGING_CATEGORY,
  }));
  const taskOpts: RecipeTask[] = tasks.map((t) => ({ id: t.id, name: t.name, rate: Number(t.ratePerPcs), detail: `pekerja ${Number(t.workerRate)} + koordinator ${Number(t.coordinatorRate)} + driver ${Number(t.driverRate)}` }));
  // Upah & overhead yang sudah ada di tiap setengah jadi (termasuk bersarang): tidak boleh ditambahkan lagi di resep yang memakainya
  const coverage: Record<string, { tasks: Record<string, string>; overheads: Record<string, string> }> = {};
  for (const i of items.filter((x) => x.type === "BARANG_DALAM_PROSES")) {
    const c = await coverageOf(prisma, [i.id]);
    if (c.tasks.size || c.overheads.size) coverage[i.id] = { tasks: Object.fromEntries(c.tasks), overheads: Object.fromEntries(c.overheads) };
  }
  const overheads: RecipeOverheadOpt[] = oh.rows.map((o) => ({ id: o.id, name: `${o.name}`, perPcs: o.perPcs }));
  return { components, tasks: taskOpts, overheads, overheadSummary: oh, coverage };
}

/** Nilai awal editor dari baris resep tersimpan (qty dikembalikan ke satuan pakai) */
export function recipeInitial(
  comp: { componentId: string; qty: unknown; useUnit: string | null; unit: string }[],
  labor: { taskId: string | null; name: string; rate: bigint; override?: boolean }[],
  oh: { overheadId: string; factor: unknown }[],
  extra?: { extraPackaging?: bigint; targetMargin?: unknown },
): RecipeInitial {
  return {
    comp: comp.map((c) => {
      const useUnit = c.useUnit || c.unit;
      return { itemId: c.componentId, useUnit, qty: Math.round(fromRecipeQty(Number(c.qty), useUnit, c.unit) * 10000) / 10000 };
    }),
    labor: labor.map((l) => ({ taskId: l.taskId ?? "", name: l.name, rate: Number(l.rate), override: !!l.override || !l.taskId })),
    oh: oh.map((o) => ({ overheadId: o.overheadId, factor: Number(o.factor) })),
    extraPackaging: extra?.extraPackaging ? Number(extra.extraPackaging) : 0,
    targetMargin: extra?.targetMargin !== undefined ? Number(extra.targetMargin) : undefined,
  };
}
