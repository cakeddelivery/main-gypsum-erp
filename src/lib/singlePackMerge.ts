import type { Prisma, ProductVariant } from "@prisma/client";
import { SATUAN_FAMILY } from "./productFamily";
import { SINGLE_PACK_VARIANTS } from "./singlePackFix";
import { recordMovement } from "./stock";
import { skuKey } from "./returnLabel";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/** Ref mutasi penyesuaian berpasangan (keluar BJ-SAT-<series>, masuk Single Pack <series>) */
export const MERGE_REF = "SETUP:SATUKAN-SP";

const WORD: Record<string, string> = { HEWAN: "hewan", COWOK: "cowok", CEWEK: "cewek", TRANSPORTASI: "transport(asi)?" };
/** Nama barang "Single Pack <series>" (barang divisi Packing yang dipakai resep, BOM & borongan) */
export const isSinglePackItemName = (variant: string, name: string) => new RegExp(`^\\s*single\\s*pack\\s+${WORD[variant.toUpperCase()] ?? variant.toLowerCase()}\\s*$`, "i").test(name);

type Ref = { id: string; sku: string; name: string; avgCost: number };
export type MergeMove = { locationId: string; location: string; qty: number };
export type MergePlan = {
  variant: ProductVariant;
  /** ok = sudah satu barang · satukan = jalankan penyatuan · skip = perlu keputusan Owner (tidak diubah) */
  action: "ok" | "satukan" | "skip";
  note: string;
  /** Rincian pratinjau (tautan, saldo dipindah, nilai, pemetaan dialihkan, referensi historis) */
  lines: string[];
  catalog?: { id: string; sku: string; finishedItemId: string | null };
  target?: Ref;
  source?: Ref;
  moves: MergeMove[];
  /** Nilai rata-rata tercatat sama → mutasi pasangan tanpa jurnal */
  sameValue: boolean;
};

async function balances(db: Tx, itemId: string, locs: Map<string, string>): Promise<MergeMove[]> {
  const [ins, outs] = await Promise.all([
    db.stockMovement.groupBy({ by: ["toLocationId"], where: { itemId, toLocationId: { not: null } }, _sum: { qty: true } }),
    db.stockMovement.groupBy({ by: ["fromLocationId"], where: { itemId, fromLocationId: { not: null } }, _sum: { qty: true } }),
  ]);
  const q = new Map<string, number>();
  for (const r of ins) q.set(r.toLocationId!, (q.get(r.toLocationId!) ?? 0) + Number(r._sum.qty ?? 0));
  for (const r of outs) q.set(r.fromLocationId!, (q.get(r.fromLocationId!) ?? 0) - Number(r._sum.qty ?? 0));
  return [...q].filter(([, n]) => Math.abs(n) > 0.0005).map(([locationId, n]) => ({ locationId, location: locs.get(locationId) ?? locationId, qty: Math.round(n * 1000) / 1000 }));
}

const rp = (n: number) => `Rp${Math.round(n).toLocaleString("id-ID")}`;
const qty = (n: number) => n.toLocaleString("id-ID");

/**
 * Rencana penyatuan barang Single Pack per series ke SATU barang (pola Transportasi): barang "Single Pack <series>"
 * (divisi Packing; dipakai resep/BOM/borongan) menjadi barang jadi produk katalog Satuan Single Pack & flowItem laporan shift;
 * barang lama BJ-SAT-<series> dikosongkan lewat penyesuaian berpasangan lalu dinonaktifkan. Tidak mengubah apa pun.
 */
export async function planSinglePackMerge(db: Tx): Promise<MergePlan[]> {
  const locs = new Map((await db.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const pool = await db.item.findMany({ where: { active: true, name: { contains: "single", mode: "insensitive" } }, select: { id: true, sku: true, name: true, avgCost: true } });
  const out: MergePlan[] = [];
  for (const variant of SINGLE_PACK_VARIANTS) {
    const base = { variant, lines: [] as string[], moves: [] as MergeMove[], sameValue: true };
    const cats = await db.product.findMany({ where: { variant, family: { name: SATUAN_FAMILY } }, select: { id: true, sku: true, finishedItemId: true }, orderBy: { sku: "asc" } });
    if (cats.length !== 1) {
      out.push({ ...base, action: "skip", note: cats.length ? `${cats.length} produk katalog ${SATUAN_FAMILY} ${variant} (${cats.map((c) => c.sku).join(", ")}) — pilih satu` : `produk katalog ${SATUAN_FAMILY} ${variant} belum ada` });
      continue;
    }
    const catalog = cats[0];
    const targets = pool.filter((i) => isSinglePackItemName(variant, i.name));
    if (targets.length !== 1) {
      out.push({ ...base, catalog, action: "skip", note: targets.length ? `barang "Single Pack" aktif GANDA: ${targets.map((t) => `${t.sku} "${t.name}"`).join(", ")} — pilih satu` : `barang "Single Pack ${variant}" aktif tidak ditemukan` });
      continue;
    }
    const target: Ref = { ...targets[0], avgCost: Number(targets[0].avgCost) };
    const holder = await db.product.findUnique({ where: { finishedItemId: target.id }, select: { id: true, sku: true } });
    if (holder && holder.id !== catalog.id) {
      out.push({ ...base, catalog, target, action: "skip", note: `barang ${target.sku} sudah menjadi barang jadi produk lain ${holder.sku} — keputusan Owner` });
      continue;
    }
    const s = await db.item.findUnique({ where: { sku: `BJ-SAT-${variant}` }, select: { id: true, sku: true, name: true, avgCost: true, active: true } });
    const source: Ref | undefined = s && s.id !== target.id ? { id: s.id, sku: s.sku, name: s.name, avgCost: Number(s.avgCost) } : undefined;
    const moves = source ? await balances(db, source.id, locs) : [];
    const lines: string[] = [];
    const relink = catalog.finishedItemId !== target.id;
    if (relink) lines.push(`tautan: produk katalog ${catalog.sku} → barang ${target.sku} "${target.name}"${source && catalog.finishedItemId === source.id ? ` (lepas ${source.sku})` : ""}; flowItem laporan shift ikut (produk katalog dipilih lebih dulu)`);
    let pending = relink || moves.length > 0;
    let sameValue = true;
    if (source) {
      sameValue = source.avgCost === target.avgCost;
      for (const m of moves) {
        const vOut = Math.abs(m.qty) * source.avgCost;
        const vIn = Math.abs(m.qty) * target.avgCost;
        lines.push(`saldo ${m.location}: ${source.sku} ${qty(m.qty)} → 0; ${target.sku} ${m.qty > 0 ? "+" : ""}${qty(m.qty)} (penyesuaian berpasangan ${MERGE_REF}; nilai ${rp(vOut)} vs ${rp(vIn)})`);
      }
      if (moves.length) {
        lines.push(sameValue
          ? `nilai rata-rata sama (${rp(source.avgCost)}/pcs) → TANPA jurnal`
          : `nilai rata-rata BEDA: ${source.sku} ${rp(source.avgCost)}/pcs vs ${target.sku} ${rp(target.avgCost)}/pcs → tiap mutasi memakai nilai rata-rata tercatat barangnya dan dijurnal (Persediaan ↔ Beban Selisih Persediaan); selisih bersih ${rp(moves.reduce((a, m) => a + m.qty * (target.avgCost - source.avgCost), 0))} ke Beban Selisih Persediaan`);
      }
      const [prods, bom, rec, recOwn, maps, tasks, ret, kom, reps] = await Promise.all([
        db.product.findMany({ where: { finishedItemId: source.id, id: { not: catalog.id } }, select: { sku: true } }),
        db.bomLine.count({ where: { itemId: source.id } }),
        db.itemRecipeLine.count({ where: { componentId: source.id } }),
        db.itemRecipeLine.count({ where: { itemId: source.id } }),
        db.marketplaceSkuMap.count({ where: { itemId: source.id } }),
        db.pieceTask.count({ where: { outputItemId: source.id } }),
        db.returnLine.count({ where: { labelSku: { equals: source.sku, mode: "insensitive" } } }),
        db.complaintLine.count({ where: { labelSku: { equals: source.sku, mode: "insensitive" } } }),
        db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "ShiftReport" WHERE "work"::text LIKE ${"%" + source.id + "%"}`,
      ]);
      const alias = await db.marketplaceSkuMap.findUnique({ where: { key: skuKey(source.sku, "") } });
      const remap = [bom && `BOM ${bom} baris`, rec && `komponen resep ${rec} baris`, maps && `peta SKU marketplace ${maps}`, tasks && `tugas borongan ${tasks}`].filter(Boolean);
      if (remap.length) lines.push(`pemetaan dialihkan ke ${target.sku}: ${remap.join(", ")}`);
      if (!alias) lines.push(`alias peta SKU marketplace "${source.sku}" → ${target.sku} dibuat`);
      const hist = [prods.length && `produk lain ${prods.map((p) => p.sku).join(", ")} (tetap, flowItem memilih katalog)`, recOwn && `resep milik ${source.sku} ${recOwn} bahan (tetap)`, ret && `label retur ${ret}`, kom && `label komplain ${kom}`, Number(reps[0]?.n ?? 0) && `laporan shift ${Number(reps[0].n)}`].filter(Boolean);
      if (hist.length) lines.push(`referensi historis (TIDAK diubah): ${hist.join(", ")}`);
      if (s!.active || remap.length || !alias) pending = true;
      if (s!.active) lines.push(`${source.sku} "${source.name}" dinonaktifkan setelah saldo 0 (tidak dihapus; riwayat tetap)`);
    }
    out.push({ ...base, catalog, target, source, moves, sameValue, lines, action: pending ? "satukan" : "ok", note: pending ? `satukan ke ${target.sku} "${target.name}"` : `sudah satu barang: ${target.sku} "${target.name}"` });
  }
  return out;
}

/** Jalankan rencana (dalam transaksi pemanggil). Tidak menghapus barang, mutasi, atau dokumen historis. */
export async function applySinglePackMerge(tx: Tx, plans: MergePlan[], actor: Actor, date = new Date()) {
  let done = 0;
  for (const p of plans) {
    if (p.action !== "satukan" || !p.catalog || !p.target) continue;
    const T = p.target;
    if (p.catalog.finishedItemId !== T.id) await tx.product.update({ where: { id: p.catalog.id }, data: { finishedItemId: T.id } });
    const S = p.source;
    if (S) {
      const note = `Satukan Single Pack: ${S.sku} "${S.name}" → ${T.sku} "${T.name}"`;
      const noJournal = p.sameValue;
      for (const m of p.moves) {
        const q = Math.abs(m.qty);
        // Saldo positif: keluar dari barang lama, masuk ke Single Pack; saldo negatif: sebaliknya
        await recordMovement(tx, { type: "PENYESUAIAN", itemId: S.id, fromLocationId: m.locationId, qty: q, increase: m.qty < 0, allowNegative: true, noJournal, ref: MERGE_REF, note, date }, actor);
        await recordMovement(tx, { type: "PENYESUAIAN", itemId: T.id, fromLocationId: m.locationId, qty: q, increase: m.qty > 0, allowNegative: true, noJournal, ref: MERGE_REF, note, date }, actor);
      }
      // Pemetaan (bukan dokumen historis) dialihkan ke barang Single Pack
      for (const b of await tx.bomLine.findMany({ where: { itemId: S.id } })) {
        const dup = await tx.bomLine.findUnique({ where: { productId_itemId: { productId: b.productId, itemId: T.id } } });
        if (!dup) await tx.bomLine.update({ where: { id: b.id }, data: { itemId: T.id } });
      }
      for (const r of await tx.itemRecipeLine.findMany({ where: { componentId: S.id } })) {
        if (r.itemId === T.id) continue;
        const dup = await tx.itemRecipeLine.findUnique({ where: { itemId_componentId: { itemId: r.itemId, componentId: T.id } } });
        if (!dup) await tx.itemRecipeLine.update({ where: { id: r.id }, data: { componentId: T.id } });
      }
      await tx.marketplaceSkuMap.updateMany({ where: { itemId: S.id }, data: { itemId: T.id, updatedBy: actor.name } });
      await tx.pieceTask.updateMany({ where: { outputItemId: S.id }, data: { outputItemId: T.id } });
      const key = skuKey(S.sku, "");
      if (!(await tx.marketplaceSkuMap.findUnique({ where: { key } }))) await tx.marketplaceSkuMap.create({ data: { key, itemId: T.id, updatedBy: actor.name } });
      const day = date.toISOString().slice(0, 10);
      const [sItem, tItem] = await Promise.all([tx.item.findUniqueOrThrow({ where: { id: S.id } }), tx.item.findUniqueOrThrow({ where: { id: T.id } })]);
      const left = await balances(tx, S.id, new Map());
      await tx.item.update({ where: { id: S.id }, data: { active: left.length ? sItem.active : false, note: [sItem.note, `${day}: digabung ke ${T.sku} "${T.name}" (${MERGE_REF})`].filter(Boolean).join("\n") } });
      if (!(tItem.note ?? "").includes(S.sku)) await tx.item.update({ where: { id: T.id }, data: { note: [tItem.note, `Alias lama: ${S.sku} "${S.name}" (digabung ${day})`].filter(Boolean).join("\n") } });
    }
    done++;
  }
  return done;
}
