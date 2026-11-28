import type { Prisma, PrismaClient } from "@prisma/client";
import { auditRecipes } from "./recipeRules";

type Db = PrismaClient | Prisma.TransactionClient;
export type DobelRow = { row: "labor" | "overhead"; rowId: string; owner: string; name: string; kind: string; detail: string };

/** Baris upah / overhead dobel antar tahap persis seperti yang dilaporkan cek:resep-hpp (DOBEL_UPAH, DOBEL_OVERHEAD) */
export async function rencanaResepDobel(db: Db): Promise<DobelRow[]> {
  const list = await auditRecipes(db as never);
  const seen = new Set<string>();
  const out: DobelRow[] = [];
  for (const f of list) {
    if ((f.kind !== "DOBEL_UPAH" && f.kind !== "DOBEL_OVERHEAD") || !f.rowId || !f.row || seen.has(f.rowId)) continue;
    seen.add(f.rowId);
    out.push({ row: f.row, rowId: f.rowId, owner: f.owner, name: f.name, kind: f.kind, detail: f.detail });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Hapus baris dobel (satu transaksi, satu audit). Idempoten: sesudahnya temuan dobel 0. */
export async function perbaikiResepDobel(db: PrismaClient, apply: boolean) {
  const rows = await rencanaResepDobel(db);
  if (!apply || !rows.length) return { rows, sisa: apply ? 0 : rows.length };
  await db.$transaction(async (tx) => {
    const fresh = await rencanaResepDobel(tx);
    await tx.recipeLabor.deleteMany({ where: { id: { in: fresh.filter((r) => r.row === "labor").map((r) => r.rowId) } } });
    await tx.recipeOverhead.deleteMany({ where: { id: { in: fresh.filter((r) => r.row === "overhead").map((r) => r.rowId) } } });
    await tx.auditLog.create({ data: { actorName: "skrip perbaiki:resep-dobel", action: "RESEP_DOBEL_DIHAPUS", entity: "Item", entityId: "massal", data: { baris: fresh.map((r) => ({ jenis: r.row, id: r.rowId, pemilik: r.name, detail: r.detail })) } as unknown as Prisma.InputJsonValue } });
  }, { isolationLevel: "Serializable", timeout: 60000 });
  return { rows, sisa: (await rencanaResepDobel(db)).length };
}
