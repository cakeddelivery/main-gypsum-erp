import type { PrismaClient } from "@prisma/client";

/**
 * Aturan bawaan divisi penanggung jawab barang setengah jadi & produk jadi (disetujui user 13 Nov 2026):
 * Patung kering → Produksi; Cat Giftbox & semua Giftbox → Giftbox; paket (Single Pack, isi 12/24/48/96, Mix) → Packing;
 * Figur/Patung Satuan & produk jadi per karakter → Assembling. Yang tidak cocok dibiarkan.
 */
const RULES: { re: RegExp; template: string }[] = [
  { re: /patung\s*kering/i, template: "PRODUKSI" },
  { re: /giftbox/i, template: "GIFTBOX" },
  { re: /single\s*pack|paket|\bpack\b|\bisi\s*\d+|\bmix\b/i, template: "PACKING" },
  { re: /figur|satuan|cewek|cowok|hewan|transportasi/i, template: "ASSEMBLING" },
];

export function ruleTemplate(name: string): string | null {
  return RULES.find((r) => r.re.test(name))?.template ?? null;
}

/** Isi divisi barang setengah jadi / produk jadi AKTIF yang belum punya divisi. Pratinjau bila apply = false. */
export async function setupItemDivisions(db: PrismaClient, apply: boolean) {
  const divisions = await db.division.findMany({ where: { reportTemplate: { not: null } } });
  const byTpl = new Map(divisions.map((d) => [d.reportTemplate!, d]));
  const items = await db.item.findMany({ where: { active: true, type: { in: ["BARANG_DALAM_PROSES", "BARANG_JADI"] } }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  const plan: { id: string; name: string; division: string }[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  for (const it of items) {
    if (it.divisionId) { kept.push(it.name); continue; }
    const d = byTpl.get(ruleTemplate(it.name) ?? "");
    if (d) plan.push({ id: it.id, name: it.name, division: d.name });
    else skipped.push(it.name);
  }
  if (apply) {
    for (const d of divisions) {
      const ids = plan.filter((p) => p.division === d.name).map((p) => p.id);
      if (ids.length) await db.item.updateMany({ where: { id: { in: ids }, divisionId: null }, data: { divisionId: d.id } });
    }
  }
  return { plan, skipped, kept };
}
