import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

type DB = Prisma.TransactionClient | typeof prisma;

/**
 * ATURAN RESEP HPP (anti dobel):
 *  - Resep hanya berisi BAHAN yang diisi manusia. Upah borongan otomatis dari Tugas & Tarif; overhead dari alokasi biaya bulanan (master Overhead).
 *  - Upah/overhead yang SUDAH dihitung di tahap sebelumnya (setengah jadi di dalam resep, sampai ke dalam-dalamnya) tidak boleh ditambahkan lagi.
 */
export type Coverage = { tasks: Map<string, string>; overheads: Map<string, string> };

/** Upah (tugas) dan overhead yang sudah ada di resep setengah jadi `itemIds`, termasuk setengah jadi bersarang. Nilai = nama setengah jadi sumbernya */
export async function coverageOf(db: DB, itemIds: string[]): Promise<Coverage> {
  const cov: Coverage = { tasks: new Map(), overheads: new Map() };
  const seen = new Set<string>();
  let queue = [...new Set(itemIds)];
  while (queue.length) {
    const items = await db.item.findMany({
      where: { id: { in: queue.filter((x) => !seen.has(x)) } },
      select: { id: true, name: true, recipe: { select: { componentId: true } }, recipeLabor: { select: { taskId: true, task: { select: { name: true } }, name: true } }, recipeOverhead: { select: { overheadId: true, overhead: { select: { name: true } } } } },
    });
    for (const it of items) seen.add(it.id);
    queue = [];
    for (const it of items) {
      for (const l of it.recipeLabor) if (l.taskId && !cov.tasks.has(l.taskId)) cov.tasks.set(l.taskId, it.name);
      for (const o of it.recipeOverhead) if (!cov.overheads.has(o.overheadId)) cov.overheads.set(o.overheadId, it.name);
      queue.push(...it.recipe.map((r) => r.componentId).filter((x) => !seen.has(x)));
    }
  }
  return cov;
}

export type RecipeCheckInput = { comp: { componentId: string }[]; labor: { taskId: string | null; name: string }[]; oh: { overheadId: string }[] };

/** Daftar pesan kesalahan bila upah/overhead di resep ini dobel dengan tahap sebelumnya atau dengan baris lain di resep yang sama */
export async function recipeDuplicateErrors(db: DB, r: RecipeCheckInput): Promise<string[]> {
  const errors: string[] = [];
  const cov = await coverageOf(db, r.comp.map((c) => c.componentId));
  const tasks = new Set<string>();
  for (const l of r.labor) {
    if (!l.taskId) continue;
    const from = cov.tasks.get(l.taskId);
    if (from) errors.push(`Upah "${l.name}" sudah dihitung di setengah jadi "${from}". Hapus dari resep ini agar tidak dobel.`);
    if (tasks.has(l.taskId)) errors.push(`Upah "${l.name}" dipilih dua kali di resep ini.`);
    tasks.add(l.taskId);
  }
  const ohs = new Set<string>();
  const names = new Map((await db.overhead.findMany({ where: { id: { in: r.oh.map((o) => o.overheadId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  for (const o of r.oh) {
    const nm = names.get(o.overheadId) ?? "Overhead";
    const from = cov.overheads.get(o.overheadId);
    if (from) errors.push(`Overhead "${nm}" sudah dihitung di setengah jadi "${from}". Hapus dari resep ini agar tidak dobel.`);
    if (ohs.has(o.overheadId)) errors.push(`Overhead "${nm}" dipilih dua kali di resep ini.`);
    ohs.add(o.overheadId);
  }
  return [...new Set(errors)];
}

export type AuditFinding = { owner: "Produk" | "Setengah jadi"; ownerId: string; name: string; kind: "DOBEL_UPAH" | "DOBEL_OVERHEAD" | "UPAH_MANUAL" | "BIAYA_MANUAL_LAMA" | "FAKTOR_OVERHEAD"; detail: string; proposal: string; amount: number };

/** Audit semua resep (HANYA MEMBACA): upah/overhead dobel antar tahap, upah manual, biaya manual lama produk, faktor overhead ≠ 1 */
export async function auditRecipes(db: DB = prisma): Promise<AuditFinding[]> {
  const out: AuditFinding[] = [];
  const [products, semis] = await Promise.all([
    db.product.findMany({ where: { active: true }, include: { bom: { select: { itemId: true } }, recipeLabor: { include: { task: { select: { ratePerPcs: true } } } }, recipeOverhead: { include: { overhead: { select: { name: true, monthlyAmount: true, outputPerMonth: true } } } } } }),
    db.item.findMany({ where: { type: "BARANG_DALAM_PROSES", OR: [{ recipeLabor: { some: {} } }, { recipeOverhead: { some: {} } }, { recipe: { some: {} } }] }, include: { recipe: { select: { componentId: true } }, recipeLabor: { include: { task: { select: { ratePerPcs: true } } } }, recipeOverhead: { include: { overhead: { select: { name: true, monthlyAmount: true, outputPerMonth: true } } } } } }),
  ]);
  const check = async (owner: AuditFinding["owner"], id: string, name: string, compIds: string[], labor: typeof products[number]["recipeLabor"], oh: typeof products[number]["recipeOverhead"]) => {
    const cov = await coverageOf(db, compIds);
    for (const l of labor) {
      const from = l.taskId ? cov.tasks.get(l.taskId) : undefined;
      if (from) out.push({ owner, ownerId: id, name, kind: "DOBEL_UPAH", detail: `Upah "${l.name}" Rp${Number(l.rate).toLocaleString("id-ID")} juga ada di setengah jadi "${from}"`, proposal: "Hapus baris upah ini dari resep (sudah terhitung di setengah jadi)", amount: Number(l.rate) });
      if (l.override || !l.taskId) out.push({ owner, ownerId: id, name, kind: "UPAH_MANUAL", detail: `Upah "${l.name}" Rp${Number(l.rate).toLocaleString("id-ID")} diketik manual (bukan dari Tugas & Tarif)`, proposal: l.taskId ? "Kembalikan ke tarif Tugas & Tarif (hapus override) kecuali Owner menyetujui" : "Buat Tugas & Tarif untuk pekerjaan ini lalu pilih di resep", amount: 0 });
    }
    for (const o of oh) {
      const from = cov.overheads.get(o.overheadId);
      if (from) out.push({ owner, ownerId: id, name, kind: "DOBEL_OVERHEAD", detail: `Overhead "${o.overhead.name}" juga ada di setengah jadi "${from}"`, proposal: "Hapus overhead ini dari resep (sudah terhitung di tahap sebelumnya)", amount: 0 });
      if (Number(o.factor) !== 1) out.push({ owner, ownerId: id, name, kind: "FAKTOR_OVERHEAD", detail: `Overhead "${o.overhead.name}" faktor ${Number(o.factor)} (bukan 1)`, proposal: "Setel faktor 1 kecuali Owner menetapkan khusus", amount: 0 });
    }
  };
  for (const p of products) {
    await check("Produk", p.id, `${p.sku} ${p.name}`, p.bom.map((b) => b.itemId), p.recipeLabor, p.recipeOverhead);
    if (Number(p.laborCost) > 0 || Number(p.overheadCost) > 0) out.push({ owner: "Produk", ownerId: p.id, name: `${p.sku} ${p.name}`, kind: "BIAYA_MANUAL_LAMA", detail: `Biaya manual lama: upah Rp${Number(p.laborCost).toLocaleString("id-ID")}, overhead Rp${Number(p.overheadCost).toLocaleString("id-ID")}`, proposal: "Hapus biaya manual lama; gunakan upah otomatis & overhead dari master", amount: Number(p.laborCost) + Number(p.overheadCost) });
  }
  for (const it of semis) await check("Setengah jadi", it.id, `${it.sku} ${it.name}`, it.recipe.map((r) => r.componentId), it.recipeLabor, it.recipeOverhead);
  return out;
}
