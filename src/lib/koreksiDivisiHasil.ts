import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Barang jadi yang tidak muncul di "stok akhir" laporan shift: laporan hanya memuat barang aktif yang divisinya = divisi laporan
 * (resultItems). Penyebab umum: Single Pack per karakter (produk SATUAN) kosong/terisi Assembling, dan barang jadi Giftbox
 * kosong/terisi divisi lain. Koreksi: Single Pack → Packing, Giftbox (produk GIFTBOX atau induk bernama Giftbox) → Giftbox.
 * Hanya mengubah divisi penanggung jawab barang (tanpa migrasi, tanpa mengubah stok).
 */
export type DivisiFix = { id: string; sku: string; name: string; from: string | null; to: string; why: string };

type Db = PrismaClient | Prisma.TransactionClient;

export function targetTemplate(p: { type: string; family?: { name: string } | null }): "PACKING" | "GIFTBOX" | null {
  if (p.type === "GIFTBOX" || /giftbox/i.test(p.family?.name ?? "")) return "GIFTBOX";
  if (p.type === "SATUAN") return "PACKING";
  return null;
}

export async function planDivisiHasil(db: Db): Promise<{ fixes: DivisiFix[]; ok: number; noDivision: string[] }> {
  const divs = await db.division.findMany({ where: { reportTemplate: { in: ["PACKING", "GIFTBOX"] } }, select: { id: true, name: true, reportTemplate: true } });
  const byTpl = new Map(divs.map((d) => [d.reportTemplate!, d]));
  const names = new Map((await db.division.findMany({ select: { id: true, name: true } })).map((d) => [d.id, d.name]));
  const products = await db.product.findMany({
    where: { active: true, finishedItemId: { not: null }, finishedItem: { active: true, type: "BARANG_JADI" } },
    select: { sku: true, type: true, family: { select: { name: true } }, finishedItem: { select: { id: true, sku: true, name: true, divisionId: true } } },
    orderBy: { sku: "asc" },
  });
  const fixes: DivisiFix[] = [];
  const noDivision: string[] = [];
  let ok = 0;
  const seen = new Set<string>();
  for (const p of products) {
    const it = p.finishedItem!;
    const tpl = targetTemplate(p);
    if (!tpl || seen.has(it.id)) continue;
    seen.add(it.id);
    const d = byTpl.get(tpl);
    if (!d) { if (!noDivision.includes(tpl)) noDivision.push(tpl); continue; }
    if (it.divisionId === d.id) { ok++; continue; }
    fixes.push({ id: it.id, sku: p.sku, name: it.name, from: it.divisionId ? (names.get(it.divisionId) ?? it.divisionId) : null, to: d.name, why: tpl === "GIFTBOX" ? "produk Giftbox" : "Single Pack (produk satuan)" });
  }
  return { fixes, ok, noDivision };
}

export async function koreksiDivisiHasil(db: PrismaClient, apply: boolean) {
  const plan = await planDivisiHasil(db);
  if (!apply || !plan.fixes.length) return plan;
  const divs = new Map((await db.division.findMany({ select: { id: true, name: true } })).map((d) => [d.name, d.id]));
  await db.$transaction(async (tx) => {
    for (const f of plan.fixes) await tx.item.update({ where: { id: f.id }, data: { divisionId: divs.get(f.to)! } });
    await tx.auditLog.create({ data: { actorName: "skrip koreksi:divisi-hasil", action: "KOREKSI_DIVISI_HASIL", entity: "Item", entityId: "massal", data: { fixes: plan.fixes.map((f) => ({ sku: f.sku, dari: f.from, ke: f.to })) } as unknown as Prisma.InputJsonValue } });
  }, { isolationLevel: "Serializable", timeout: 60000 });
  return plan;
}
