import { Prisma, type Item, type PrismaClient, type ProductVariant } from "@prisma/client";
import { autoCode } from "./codes";
import { locationSettings, qtyAt, recordMovement } from "./stock";
import { recipeUnit } from "./unitcost";

type Tx = Prisma.TransactionClient;

/** Hasil pratinjau / penerapan data master produk & HPP */
export type ProdukHppPlan = { dibuat: string[]; diubah: string[]; resep: string[]; bentrok: string[]; menunggu: string[] };

const VARIANTS = ["Hewan", "Cowok", "Cewek", "Transportasi"] as const;
const VARIANT_ENUM: Record<(typeof VARIANTS)[number], ProductVariant> = { Hewan: "HEWAN", Cowok: "COWOK", Cewek: "CEWEK", Transportasi: "TRANSPORTASI" };
const CP_COLORS = ["Merah", "Biru", "Kuning"] as const;
const GB_COLORS = ["merah", "kuning", "biru", "hitam", "putih"] as const;
const PAKET_VARIANTS: { key: ProductVariant; label: string }[] = [
  { key: "MIX", label: "Mix" }, { key: "HEWAN", label: "Hewan" }, { key: "TRANSPORTASI", label: "Transport" }, { key: "COWOK", label: "Cowok" }, { key: "CEWEK", label: "Cewek" },
];
const SYSTEM_ACTOR = { id: "system", name: "Setup produk & HPP" };

class Rollback extends Error {}

/**
 * Konversi satuan stok (mis. 1 gendel = 200 pcs): stok tiap lokasi dikali `k` lewat penyesuaian TANPA jurnal,
 * harga per unit dibagi `k`, batas minimum & jumlah order dikali `k` → nilai persediaan (qty × harga) tetap.
 */
export async function scaleStockUnit(tx: Tx, it: Item, k: number, unit: string) {
  const notes: string[] = [];
  const bal = await tx.$queryRaw<{ loc: string; qty: Prisma.Decimal }[]>`
    SELECT l.id AS loc, COALESCE(SUM(CASE WHEN m."toLocationId" = l.id THEN m.qty ELSE 0 END) - SUM(CASE WHEN m."fromLocationId" = l.id THEN m.qty ELSE 0 END), 0) AS qty
    FROM "Location" l JOIN "StockMovement" m ON m."itemId" = ${it.id} AND (m."toLocationId" = l.id OR m."fromLocationId" = l.id) GROUP BY l.id`;
  for (const b of bal) {
    const q = Number(b.qty);
    if (Math.abs(q) < 0.0005) continue;
    // Selisih stok = q × (k − 1): faktor > 1 menambah, faktor < 1 (mis. boks → slop 0,5) mengurangi
    const delta = Math.round(q * (k - 1) * 1000) / 1000;
    if (delta === 0) continue;
    await recordMovement(tx, { type: "PENYESUAIAN", itemId: it.id, qty: Math.abs(delta), fromLocationId: b.loc, increase: delta > 0, allowNegative: true, noJournal: true, ref: "SETUP:PRODUK-HPP", note: `Konversi satuan ${it.unit} → ${unit} (1 ${it.unit} = ${k} ${unit}); nilai persediaan tetap` }, SYSTEM_ACTOR);
    notes.push(`stok ${q.toLocaleString("id-ID")} ${it.unit} → ${(q * k).toLocaleString("id-ID")} ${unit}`);
  }
  const div = (x: bigint) => BigInt(Math.round(Number(x) / k));
  notes.push(`harga per ${unit} = harga lama ÷ ${k}, batas minimum & jumlah order ×${k}`);
  return {
    notes,
    data: { avgCost: div(it.avgCost), lastCost: div(it.lastCost), prevCost: div(it.prevCost), buyQty: Number(it.buyQty) * k, minStock: Number(it.minStock) * k, orderQty: Number(it.orderQty) * k } satisfies Prisma.ItemUpdateInput,
  };
}

/** Satuan resep "pcs" (unit stok pcs, atau satuan resep pcs dengan isi per kemasan) */
export const isPcs = (i: Pick<Item, "unit" | "hppUnit">) => /^(pcs|buah|biji)$/i.test(recipeUnit(i).trim());
/** Satuan resep gram */
export const isGram = (i: Pick<Item, "unit" | "hppUnit">) => /^(g|gr|gram)$/i.test(recipeUnit(i).trim());

/** Kata-kata nama barang untuk mendeteksi nama mirip (tanpa kata umum) */
const STOP = new Set(["jadi", "pcs", "set", "dan", "untuk", "the", "x", "satuan"]);
export function nameTokens(name: string) {
  return new Set(name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}
/** Kata pembeda varian/warna/ukuran: nama yang hanya berbeda di kata ini adalah saudara (bukan dobel) */
const SIBLING = /^(paket|hewan|cowok|cewek|transportasi|transport|mix|merah|biru|kuning|hitam|putih|besar|kecil|sedang|standard|standar|palet|pallet|magnet|bonus|reguler|custom|\d+(x\d+)*)$/;
/** Nama mirip: sebagian besar kata sama (Jaccard ≥ 0,6), dan bedanya bukan sekadar varian/warna/ukuran */
export function similarNames(a: string, b: string) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.size || !y.size) return false;
  const diff = [...x].filter((w) => !y.has(w)).concat([...y].filter((w) => !x.has(w)));
  if (diff.length && diff.every((w) => SIBLING.test(w))) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / new Set([...x, ...y]).size >= 0.6;
}

/**
 * Data master produk & HPP (struktur dari Owner): setengah jadi hasil borongan (Cat Plastik, Cat Giftbox, Single Pack),
 * produk jadi Paket 12/24 & Giftbox, resep + upah borongan, konversi satuan (kg→g, strip→pcs).
 * Tidak menghapus / menggabung apa pun: yang bentrok atau belum jelas hanya dilaporkan.
 * apply=false → semua perubahan dibatalkan di akhir (pratinjau).
 */
/** Faktor konversi stok lama (satuan lama → satuan beli baru), mis. 1 boks lama = 0,5 slop */
export type KonversiOpts = { klip?: number; cottonbud?: number; piring?: number };

export async function setupProdukHpp(db: PrismaClient, apply: boolean, konversi: KonversiOpts = {}): Promise<ProdukHppPlan> {
  const plan: ProdukHppPlan = { dibuat: [], diubah: [], resep: [], bentrok: [], menunggu: [] };
  try {
    await db.$transaction(async (tx) => {
      await run(tx, plan, konversi);
      if (!apply) throw new Rollback();
    }, { timeout: 120000, maxWait: 20000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  for (const k of Object.keys(plan) as (keyof ProdukHppPlan)[]) plan[k] = [...new Set(plan[k])];
  return plan;
}

type DivisionRow = { id: string; code: string; name: string; reportTemplate: string | null; active: boolean };
const DIVISION_RULES = {
  asm: { label: "Assembling", template: "ASSEMBLING", name: /\bassembl/i, code: "ASM" },
  gft: { label: "Giftbox", template: "GIFTBOX", name: /\bgift\s*box\b/i, code: "GFT" },
  qcp: { label: "Packing", template: "PACKING", name: /\bpacking\b/i, code: "QCP" },
} as const;

/**
 * Cari divisi Assembling / Giftbox / Packing: jenis laporan (reportTemplate) dulu, lalu nama (tanpa beda huruf besar),
 * lalu kode lama (ASM/GFT/QCP). Kode divisi di production bisa berbeda. Bila tidak ketemu, pesan error memuat
 * daftar divisi yang ada (kode + nama) agar bisa dipetakan.
 */
export function pickDivision(list: DivisionRow[], rule: { template: string; name: RegExp; code: string }) {
  const act = list.filter((d) => d.active);
  return act.find((d) => d.reportTemplate === rule.template) ?? act.find((d) => rule.name.test(d.name)) ?? act.find((d) => d.code.toUpperCase() === rule.code) ?? null;
}

export async function setupDivisions(db: Tx | PrismaClient) {
  const list = await db.division.findMany({ select: { id: true, code: true, name: true, reportTemplate: true, active: true }, orderBy: { code: "asc" } });
  const out = Object.fromEntries(Object.entries(DIVISION_RULES).map(([k, r]) => [k, pickDivision(list, r)])) as Record<keyof typeof DIVISION_RULES, DivisionRow | null>;
  const missing = (Object.keys(DIVISION_RULES) as (keyof typeof DIVISION_RULES)[]).filter((k) => !out[k]);
  if (missing.length) {
    const ada = list.filter((d) => d.active).map((d) => `${d.code} "${d.name}"${d.reportTemplate ? ` (laporan ${d.reportTemplate})` : ""}`).join(", ");
    throw new Error(`Divisi ${missing.map((k) => DIVISION_RULES[k].label).join(" / ")} tidak ditemukan (dicari dari jenis laporan, nama, lalu kode). Divisi yang ada: ${ada || "—"}`);
  }
  return out as Record<keyof typeof DIVISION_RULES, DivisionRow>;
}

/** Kata varian di nama barang (Transportasi juga "Transport") */
export const variantWord = (v: string) => (v === "Transportasi" ? /\btransport(asi)?\b/i : new RegExp(`\\b${v}\\b`, "i"));

/** Kandidat barang lama "Single Pack <varian>": SKU BJ-SAT-*, nama satuan/single pack/figur + varian, hasil tugas Assembling, produk isi 1 */
export function singlePackCandidates<T extends Pick<Item, "id" | "sku" | "name">>(v: string, items: T[], extraIds: string[] = []): T[] {
  const w = variantWord(v);
  const hit = items.filter((i) => {
    if (/\bpaket\b/i.test(i.name)) return false;
    if (i.sku.toUpperCase().startsWith("BJ-SAT-") && (w.test(i.sku.replace(/-/g, " ")) || w.test(i.name))) return true;
    return /(satuan|single\s*pack|figur)/i.test(i.name) && w.test(i.name);
  });
  const ids = new Set([...hit.map((i) => i.id), ...extraIds]);
  return items.filter((i) => ids.has(i.id));
}

/** Kandidat Background / Klip per varian (nama longgar: "Background", "BG", "Klip"; bukan plastik klip) */
export function variantMaterial<T extends Pick<Item, "id" | "name" | "unit">>(kind: "Background" | "Klip", v: string, items: T[]): T[] {
  const w = variantWord(v);
  const k = kind === "Background" ? /\b(background|bg)\b/i : /\bklip\b/i;
  const xs = items.filter((i) => k.test(i.name) && w.test(i.name) && !/plastik|2\s*x\s*3/i.test(i.name));
  return xs.sort((a, b) => Number(/^gendel$/i.test(b.unit.trim())) - Number(/^gendel$/i.test(a.unit.trim())));
}

async function run(tx: Tx, plan: ProdukHppPlan, konversi: KonversiOpts = {}) {
  // Resep diringkas: satu baris per barang / produk
  const rec = new Map<string, string[]>();
  const note = (target: string, text: string) => rec.set(target, [...(rec.get(target) ?? []), text]);
  const { asm, gft, qcp } = await setupDivisions(tx);
  const locs = await locationSettings(tx);
  const allItems = await tx.item.findMany({ where: { active: true } });
  const everyItem = await tx.item.findMany();
  const find = (name: string) => allItems.filter((i) => i.name.trim().toLowerCase() === name.toLowerCase()).sort((a, b) => a.sku.localeCompare(b.sku));
  const one = (name: string) => {
    const xs = find(name);
    if (xs.length > 1) plan.bentrok.push(`DOBEL nama "${name}": ${xs.map((x) => x.sku).join(", ")} (dipakai ${xs[0].sku})`);
    return xs[0] ?? null;
  };

  // ---------- 1. Konversi satuan bahan ----------
  const unitFix = async (it: Item | null, label: string, want: { unit?: string; hppUnit: string; factor: number }) => {
    if (!it) return null;
    const data: Prisma.ItemUpdateInput = {};
    if (want.unit && it.unit.toLowerCase() !== want.unit.toLowerCase()) data.unit = want.unit;
    if ((it.hppUnit ?? "").toLowerCase() !== want.hppUnit.toLowerCase() || Number(it.hppFactor) !== want.factor) {
      data.hppUnit = want.hppUnit;
      data.hppFactor = want.factor;
    }
    if (!Object.keys(data).length) return it;
    const next = await tx.item.update({ where: { id: it.id }, data });
    plan.diubah.push(`~ ${it.sku} ${it.name}: ${label}`);
    return next;
  };
  const cats = new Map<string, Item>();
  for (const c of GB_COLORS) {
    const it = one(`Cat ${c}`);
    if (!it) {
      plan.menunggu.push(`Bahan "Cat ${c}" belum ada di Master data`);
      continue;
    }
    if (isGram(it)) cats.set(c, it);
    else if (/^kg$/i.test(it.unit.trim())) cats.set(c, (await unitFix(it, "satuan resep gram (1 kg = 1.000 g)", { hppUnit: "gram", factor: 1000 }))!);
    else plan.menunggu.push(`Cat ${c}: satuan stok "${it.unit}" belum bisa dikonversi ke gram — isi Satuan resep & isi per ${it.unit} di Master data`);
  }

  // Pot cat plastik: satuan beli strip isi 6 pcs, stok hanya di titik BMR
  let pot = one("Pot cat plastik");
  if (!pot) {
    pot = await tx.item.create({ data: { sku: await autoCode.divisionMaterial(tx, gft.code), name: "Pot cat plastik", unit: "strip", hppUnit: "pcs", hppFactor: 6, type: "BAHAN_BAKU", divisionId: gft.id, note: "Stok hanya di lokasi titik BMR (koordinator)" } });
    plan.dibuat.push(`+ ${pot.sku} Pot cat plastik · bahan baku · Giftbox · beli per strip (1 strip = 6 pcs), stok awal 0`);
  } else pot = (await unitFix(pot, "satuan beli strip, resep pcs (1 strip = 6 pcs)", { unit: "strip", hppUnit: "pcs", factor: 6 }))!;
  plan.menunggu.push("Pot cat plastik: stok hanya di lokasi titik BMR — catat stok awal lewat Borongan › Stok › Koreksi stok di titik BMR");

  /**
   * Ubah satuan stok / satuan resep. `scale` > 1 = satuan stok lama dikonversi (mis. 1 gendel = 200 pcs):
   * stok tiap lokasi dikali `scale` lewat penyesuaian TANPA jurnal, harga per unit dibagi `scale` → nilai persediaan tetap.
   */
  const setUnit = async (it: Item | null, label: string, want: { unit: string; hppUnit: string | null; factor: number; scale?: number }) => {
    if (!it) {
      plan.menunggu.push(`Bahan "${label}" belum ada di Master data`);
      return null;
    }
    const changes: string[] = [];
    const data: Prisma.ItemUpdateInput = {};
    if (it.unit.toLowerCase() !== want.unit.toLowerCase()) {
      data.unit = want.unit;
      changes.push(`satuan stok ${it.unit} → ${want.unit}`);
    }
    if ((it.hppUnit ?? null) !== want.hppUnit || Math.abs(Number(it.hppFactor) - want.factor) > 0.00005) {
      data.hppUnit = want.hppUnit;
      data.hppFactor = want.factor;
      if (want.hppUnit) changes.push(`resep per ${want.hppUnit} (1 ${want.unit} = ${want.factor.toLocaleString("id-ID", { maximumFractionDigits: 4 })} ${want.hppUnit})`);
    }
    const k = want.scale ?? 1;
    if (k !== 1 && data.unit) {
      const r = await scaleStockUnit(tx, it, k, want.unit);
      changes.push(...r.notes);
      Object.assign(data, r.data);
    } else if (data.unit) {
      const total = Number((await tx.$queryRaw<{ q: Prisma.Decimal | null }[]>`SELECT SUM(CASE WHEN "toLocationId" IS NOT NULL THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" IS NOT NULL THEN qty ELSE 0 END) AS q FROM "StockMovement" WHERE "itemId" = ${it.id}`)[0]?.q ?? 0);
      if (Math.abs(total) > 0.0005) plan.bentrok.push(`${it.sku} ${it.name}: stok sekarang ${total.toLocaleString("id-ID")} ${it.unit} akan dibaca ${total.toLocaleString("id-ID")} ${want.unit} — benar, atau perlu dikonversi?`);
    }
    if (!changes.length) return it;
    plan.diubah.push(`~ ${it.sku} ${it.name}: ${changes.join("; ")}`);
    return tx.item.update({ where: { id: it.id }, data });
  };
  // Isi kemasan (Owner)
  // Stok lama boks → satuan beli baru: hanya bila faktornya diberikan (--konversi-klip / --konversi-cottonbud / --konversi-piring)
  const klip2x3 = await setUnit(one("Plastik klip 2x3"), "Plastik klip 2x3", { unit: "slop", hppUnit: "pcs", factor: 1000, scale: konversi.klip });
  const oppItem = await setUnit(one("Plastik OPP"), "Plastik OPP", { unit: "pack", hppUnit: "pcs", factor: 250 });
  const cottonItem = await setUnit(one("Cotton bud"), "Cotton bud", { unit: "ball", hppUnit: "pcs", factor: 5000, scale: konversi.cottonbud });
  // Piring plastik: beli per kg; 1.000 pcs = 850 g → 1 kg ≈ 1.176,4706 pcs
  const piringItem = await setUnit(one("Piring plastik"), "Piring plastik", { unit: "kg", hppUnit: "pcs", factor: 1176.4706, scale: konversi.piring });
  // Background & Klip per varian: satuan stok gendel → pcs (1 gendel = 200 pcs)
  const perVariant = new Map<string, Item | null>();
  const used = new Set<string>();
  for (const v of VARIANTS) {
    for (const kind of ["Background", "Klip"] as const) {
      const exact = one(`${kind} ${v.toLowerCase()}`);
      const cands = exact ? [exact] : variantMaterial(kind, v, allItems);
      if (cands.length > 1 && !exact) plan.bentrok.push(`${kind} ${v}: lebih dari satu barang cocok (${cands.map((c) => `${c.sku} "${c.name}" ${c.unit}`).join(", ")}) — dipakai ${cands[0].sku}`);
      const it = cands[0] ?? null;
      if (!it) plan.bentrok.push(`TIDAK DITEMUKAN: ${kind.toLowerCase()} ${v.toLowerCase()} (cari nama "${kind}/${kind === "Background" ? "BG" : "Klip"} + ${v}")`);
      else used.add(it.id);
      perVariant.set(`${kind} ${v}`, await setUnit(it, `${kind} ${v.toLowerCase()}`, it && /^gendel$/i.test(it.unit.trim()) ? { unit: "pcs", hppUnit: null, factor: 1, scale: 200 } : { unit: "pcs", hppUnit: null, factor: 1 }));
    }
  }

  const pcsOnly = (it: Item | null, label: string) => {
    if (!it) {
      plan.menunggu.push(`Bahan "${label}" belum ada di Master data`);
      return null;
    }
    if (isPcs(it)) return it;
    plan.menunggu.push(`${it.sku} ${it.name}: satuan "${it.unit}" — isi berapa pcs per ${it.unit}? Isi Satuan resep "pcs" & isinya di Master data, lalu jalankan skrip lagi (baris resep dilewati dulu)`);
    return null;
  };

  // ---------- 2. Barang setengah jadi hasil borongan ----------
  const raw = locs.raw;
  const wip = locs.wip;
  const semi = async (name: string, sku: string, divisionId: string, divLabel: string, existing?: Item, rename?: string) => {
    const it = existing ?? one(name);
    if (!it) {
      const created = await tx.item.create({ data: { sku, name, unit: "pcs", type: "BARANG_DALAM_PROSES", divisionId } });
      plan.dibuat.push(`+ ${sku} ${name} · setengah jadi · ${divLabel}`);
      return created;
    }
    const changes: string[] = [];
    const data: Prisma.ItemUpdateInput = {};
    if (rename && it.name !== rename) {
      data.name = rename;
      changes.push(`ganti nama → "${rename}" (stok & riwayat tetap)`);
    }
    if (it.type !== "BARANG_DALAM_PROSES") {
      data.type = "BARANG_DALAM_PROSES";
      changes.push(`tipe ${it.type === "BAHAN_BAKU" ? "bahan baku" : "produk jadi"} → setengah jadi`);
    }
    if (it.divisionId !== divisionId) {
      data.division = { connect: { id: divisionId } };
      changes.push(`divisi → ${divLabel}`);
    }
    if (!changes.length) return it;
    const next = await tx.item.update({ where: { id: it.id }, data });
    plan.diubah.push(`~ ${it.sku} ${it.name}: ${changes.join(", ")}`);
    // Tipe berubah → gudang asalnya berubah (bahan baku → setengah jadi): stok yang ada ikut dipindah
    const fromLoc = it.type === "BAHAN_BAKU" ? raw : it.type === "BARANG_JADI" ? locs.finished : null;
    if (fromLoc && wip && fromLoc !== wip) {
      const q = await qtyAt(tx, it.id, fromLoc);
      if (q > 0.0005) {
        const label = it.type === "BAHAN_BAKU" ? "bahan baku" : "barang jadi";
        await recordMovement(tx, { type: "TRANSFER", itemId: it.id, qty: q, fromLocationId: fromLoc, toLocationId: wip, ref: "SETUP:PRODUK-HPP", note: `Pindah gudang: ${label} → setengah jadi` }, SYSTEM_ACTOR);
        plan.diubah.push(`~ ${it.sku} ${it.name}: stok ${q.toLocaleString("id-ID")} pindah gudang ${label} → gudang setengah jadi`);
      }
    }
    return next;
  };

  // Resep & upah borongan
  const recipe = async (target: Item, comp: Item | null, qty: number, useUnit: string, label: string) => {
    if (!comp) return;
    const ex = await tx.itemRecipeLine.findUnique({ where: { itemId_componentId: { itemId: target.id, componentId: comp.id } } });
    if (ex && Number(ex.qty) === qty) return;
    await tx.itemRecipeLine.upsert({ where: { itemId_componentId: { itemId: target.id, componentId: comp.id } }, create: { itemId: target.id, componentId: comp.id, qty, useUnit }, update: { qty, useUnit } });
    note(target.name, `${label} ${qty.toLocaleString("id-ID")} ${useUnit}${ex ? ` (dulu ${Number(ex.qty).toLocaleString("id-ID")})` : ""}`);
  };
  const tasks = await tx.pieceTask.findMany({ where: { active: true } });
  const taskOf = (re: RegExp) => tasks.find((t) => re.test(t.name)) ?? null;
  const labor = async (target: Item, re: RegExp, label: string) => {
    const t = taskOf(re);
    if (!t) {
      plan.menunggu.push(`${target.name}: tugas borongan "${label}" belum ada — upah borongan belum masuk HPP`);
      return;
    }
    const rate = t.workerRate + t.coordinatorRate + t.driverRate;
    const ex = await tx.recipeLabor.findFirst({ where: { itemId: target.id, taskId: t.id } });
    if (ex && ex.rate === rate) return;
    if (ex) await tx.recipeLabor.update({ where: { id: ex.id }, data: { rate, name: `Upah borongan ${t.name}` } });
    else await tx.recipeLabor.create({ data: { itemId: target.id, taskId: t.id, name: `Upah borongan ${t.name}`, rate } });
    note(target.name, `upah borongan ${t.name} Rp${Number(rate).toLocaleString("id-ID")}/pcs (${t.workerRate}+${t.coordinatorRate}+${t.driverRate})`);
  };

  // A. Cat Plastik (Assembling): cat warna 3 g + plastik klip 2x3 1 pcs
  const klip = pcsOnly(klip2x3, "Plastik klip 2x3");
  const cp = new Map<string, Item>();
  for (const c of CP_COLORS) {
    const it = await semi(`Cat plastik ${c.toLowerCase()}`, `SJ-CP-${c.toUpperCase()}`, asm.id, "Assembling");
    cp.set(c, it);
    await recipe(it, cats.get(c.toLowerCase()) ?? null, 3, "gram", `Cat ${c.toLowerCase()}`);
    await recipe(it, klip, 1, "pcs", "Plastik klip 2x3");
    await labor(it, new RegExp(`^cat plastik ${c}$`, "i"), `Cat plastik ${c.toLowerCase()}`);
  }

  // B. Cat Giftbox (Giftbox): cat 5 warna @9 g + pot cat plastik 5 pcs
  const cg = await semi("Cat Giftbox", "SJ-CAT-GIFTBOX", gft.id, "Giftbox");
  for (const c of GB_COLORS) await recipe(cg, cats.get(c) ?? null, 9, "gram", `Cat ${c}`);
  await recipe(cg, pot, 5, "pcs", "Pot cat plastik");
  // "Pot cat giftbox" barang berbeda (Owner): dilepas dari resep Cat Giftbox bila pernah terpasang
  for (const old of allItems.filter((i) => /^pot cat giftbox$/i.test(i.name.trim()))) {
    const del = await tx.itemRecipeLine.deleteMany({ where: { itemId: cg.id, componentId: old.id } });
    if (del.count) plan.resep.push(`Cat Giftbox: baris lama ${old.name} dilepas (diganti Pot cat plastik)`);
  }
  await labor(cg, /^cat giftbox$/i, "Cat giftbox");

  // Barang lain bersatuan gendel yang belum terkonversi: tampilkan agar bisa dicek
  for (const i of allItems.filter((x) => /^gendel$/i.test(x.unit.trim()) && !used.has(x.id))) plan.bentrok.push(`Satuan gendel tidak terkonversi: ${i.sku} "${i.name}" — Background/Klip? (1 gendel = 200 pcs)`);

  // C. Single Pack (Packing): bahan per varian + 3 Cat Plastik
  const common = { opp: pcsOnly(oppItem, "Plastik OPP"), cotton: pcsOnly(cottonItem, "Cotton bud"), piring: pcsOnly(piringItem, "Piring plastik") };
  const sp = new Map<string, Item>();
  for (const v of VARIANTS) {
    let it = one(`Single Pack ${v}`);
    if (!it) {
      // Barang lama yang sama arti (disetujui Owner) diganti nama — JANGAN membuat baru bila ada kandidat lama:
      // SKU BJ-SAT-*, nama satuan/single pack/figur + varian, hasil tugas Assembling <varian>, barang jadi produk isi 1
      const task = taskOf(new RegExp(`^assembling ${v}$`, "i"));
      const prods = await tx.product.findMany({ where: { variant: VARIANT_ENUM[v], packQty: 1, finishedItemId: { not: null }, type: { notIn: ["GIFTBOX"] } }, select: { finishedItemId: true } });
      const extra = [task?.outputItemId, ...prods.map((p) => p.finishedItemId)].filter((x): x is string => !!x);
      const cands = singlePackCandidates(v, everyItem, extra).filter((c) => !/\bpaket\b/i.test(c.name));
      if (cands.length > 1) {
        plan.bentrok.push(`Single Pack ${v}: ${cands.length} kandidat barang lama (${cands.map((c) => `${c.sku} "${c.name}"${c.active ? "" : " nonaktif"}`).join(", ")}) — pilih satu; Single Pack ${v} TIDAK dibuat / dipasang dulu`);
        continue;
      }
      const old = cands[0];
      it = old
        ? await semi(old.name, old.sku, qcp.id, "Packing", old, `Single Pack ${v}`)
        : await semi(`Single Pack ${v}`, `SJ-SP-${v.toUpperCase()}`, qcp.id, "Packing");
      if (old && !old.active) plan.bentrok.push(`Single Pack ${v}: barang lama ${old.sku} nonaktif — aktifkan di Master data bila dipakai`);
    } else it = await semi(it.name, it.sku, qcp.id, "Packing", it);
    sp.set(v, it);
    await recipe(it, common.opp, 1, "pcs", "Plastik OPP");
    await recipe(it, pcsOnly(perVariant.get(`Background ${v}`) ?? null, `Background ${v.toLowerCase()}`), 1, "pcs", `Background ${v.toLowerCase()}`);
    await recipe(it, pcsOnly(perVariant.get(`Klip ${v}`) ?? null, `Klip ${v.toLowerCase()}`), 1, "pcs", `Klip ${v.toLowerCase()}`);
    await recipe(it, pcsOnly(one(`Patung kering ${v}`), `Patung kering ${v}`), 1, "pcs", `Patung kering ${v}`);
    await recipe(it, common.cotton, 2, "pcs", "Cotton bud");
    await recipe(it, common.piring, 1, "pcs", "Piring plastik");
    for (const c of CP_COLORS) await recipe(it, cp.get(c)!, 1, "pcs", `Cat plastik ${c.toLowerCase()}`);
    await labor(it, new RegExp(`^assembling ${v}$`, "i"), `Assembling ${v}`);
  }

  // ---------- 3. Produk jadi ----------
  const bom = async (productId: string, productName: string, comp: Item | null, qty: number, label: string) => {
    if (!comp) return;
    const ex = await tx.bomLine.findUnique({ where: { productId_itemId: { productId, itemId: comp.id } } });
    if (ex && Number(ex.qty) === qty) return;
    await tx.bomLine.upsert({ where: { productId_itemId: { productId, itemId: comp.id } }, create: { productId, itemId: comp.id, qty, useUnit: recipeUnit(comp) }, update: { qty } });
    note(productName, `${label} ×${qty.toLocaleString("id-ID")}${ex ? ` (dulu ${Number(ex.qty).toLocaleString("id-ID")})` : ""}`);
  };
  const finishedDivision = async (p: { finishedItemId: string | null; name: string }, divisionId: string, label: string) => {
    if (!p.finishedItemId) return;
    const it = await tx.item.findUnique({ where: { id: p.finishedItemId } });
    if (it && it.divisionId !== divisionId) {
      await tx.item.update({ where: { id: it.id }, data: { divisionId } });
      plan.diubah.push(`~ ${it.sku} ${it.name}: divisi pemilik stok → ${label}`);
    }
  };

  // Bahan kemas & konversi satuan beli → satuan pakai (Owner): cari nama persis, lalu nama lama yang mirip; buat bila belum ada
  const material = async (want: { name: string; alias?: RegExp; unit: string; hppUnit: string; factor: number; divisionId: string; divLabel: string; create?: boolean; /** Barang lama sudah dikonfirmasi Owner */ confirmed?: boolean; /** Ganti nama barang lama */ rename?: boolean }) => {
    let it = one(want.name);
    if (!it && want.alias) {
      const xs = allItems.filter((i) => want.alias!.test(i.name)).sort((a, b) => Number(b.divisionId === want.divisionId) - Number(a.divisionId === want.divisionId) || a.sku.localeCompare(b.sku));
      if (xs[0]) {
        it = xs[0];
        if (!want.confirmed) plan.bentrok.push(`DIPAKAI barang lama ${it.sku} "${it.name}" untuk "${want.name}"${xs.length > 1 ? ` (calon lain: ${xs.slice(1).map((x) => `${x.sku} "${x.name}"`).join(", ")})` : ""} — benar?`);
      }
    }
    if (!it) {
      if (!want.create) {
        plan.menunggu.push(`Bahan "${want.name}" belum ada di Master data`);
        return null;
      }
      it = await tx.item.create({ data: { sku: await autoCode.divisionMaterial(tx, want.divisionId === qcp.id ? qcp.code : want.divisionId === gft.id ? gft.code : asm.code), name: want.name, unit: want.unit, hppUnit: want.hppUnit === want.unit ? null : want.hppUnit, hppFactor: want.factor, type: "BAHAN_BAKU", divisionId: want.divisionId } });
      plan.dibuat.push(`+ ${it.sku} ${want.name} · bahan baku · ${want.divLabel} · beli per ${want.unit}${want.factor !== 1 ? ` (1 ${want.unit} = ${want.factor.toLocaleString("id-ID")} ${want.hppUnit})` : ""}, stok awal 0`);
      return it;
    }
    const data: Prisma.ItemUpdateInput = {};
    const changes: string[] = [];
    if (want.rename && it.name !== want.name) {
      data.name = want.name;
      changes.push(`ganti nama → "${want.name}"`);
    }
    if (it.unit.toLowerCase() !== want.unit.toLowerCase()) {
      data.unit = want.unit;
      changes.push(`satuan beli ${it.unit} → ${want.unit} (angka stok tetap, memang jumlah ${want.unit})`);
    }
    const hu = want.hppUnit === want.unit ? null : want.hppUnit;
    if ((it.hppUnit ?? null) !== hu || Number(it.hppFactor) !== want.factor) {
      data.hppUnit = hu;
      data.hppFactor = want.factor;
      if (want.factor !== 1) changes.push(`resep per ${want.hppUnit} (1 ${want.unit} = ${want.factor.toLocaleString("id-ID")} ${want.hppUnit})`);
    }
    if (it.divisionId !== want.divisionId) {
      data.division = { connect: { id: want.divisionId } };
      changes.push(`divisi → ${want.divLabel}`);
    }
    if (!changes.length) return it;
    plan.diubah.push(`~ ${it.sku} ${it.name}: ${changes.join(", ")}`);
    return tx.item.update({ where: { id: it.id }, data });
  };
  const P = { divisionId: qcp.id, divLabel: "Packing" };
  const kemas = {
    dus12: await material({ name: "Dus 12", unit: "pcs", hppUnit: "pcs", factor: 1, ...P }),
    dus24: await material({ name: "Dus 24", unit: "pcs", hppUnit: "pcs", factor: 1, ...P }),
    bening: await material({ name: "Solasi bening", unit: "roll", hppUnit: "yard", factor: 500, ...P }),
    fragile: await material({ name: "Solasi fragile 48mm", alias: /^solasi fragile/i, unit: "roll", hppUnit: "yard", factor: 300, ...P, confirmed: true }),
    bubble: await material({ name: "Bubblewrap hitam", alias: /^bubble ?wrap hitam/i, unit: "roll", hppUnit: "cm", factor: 5000, ...P, confirmed: true }),
    wrap: await material({ name: "Plastik wrap bening", alias: /^plastik wrap/i, unit: "roll", hppUnit: "cm", factor: 20000, ...P, confirmed: true, rename: true }),
    stiker: await material({ name: "Stiker unboxing", unit: "pack", hppUnit: "pcs", factor: 1000, ...P, create: true }),
    thermal: await material({ name: "Print thermal", alias: /^label (termal|thermal) 100/i, unit: "roll", hppUnit: "pcs", factor: 500, ...P, confirmed: true }),
  };
  /** Bahan kemas per 1 paket (Owner) */
  const KEMAS: Record<12 | 24 | 48 | 96, [keyof typeof kemas, number][]> = {
    12: [["dus12", 1], ["bening", 0.3], ["fragile", 1.37], ["bubble", 160], ["stiker", 1], ["thermal", 1]],
    24: [["dus24", 1], ["bening", 1.31], ["fragile", 1.31], ["wrap", 75], ["bubble", 80], ["stiker", 1], ["thermal", 1]],
    48: [["dus24", 2], ["bening", 1.75], ["fragile", 1.75], ["wrap", 100], ["bubble", 160], ["thermal", 1]],
    96: [["dus24", 4], ["bening", 3.5], ["fragile", 3.5], ["wrap", 200], ["bubble", 400], ["thermal", 1]],
  };

  // A. Paket 12/24/48/96 (Packing): Single Pack × isi (Mix = isi ÷ 4 per varian) + bahan kemas
  for (const n of [12, 24, 48, 96] as const) {
    for (const pv of PAKET_VARIANTS) {
      const list = await tx.product.findMany({ where: { active: true, type: `PAKET_${n}`, variant: pv.key }, orderBy: { sku: "asc" } });
      if (!list.length) {
        plan.menunggu.push(`Produk Paket ${n} pcs · ${pv.label} belum ada — buat lewat Produk & HPP › Produk Induk (Paket Single Pack), lalu jalankan skrip lagi`);
        continue;
      }
      if (list.length > 1) plan.bentrok.push(`DOBEL produk Paket ${n} · ${pv.label}: ${list.map((p) => `${p.sku} "${p.name}"`).join(", ")} (resep dipasang di semuanya)`);
      for (const p of list) {
        await finishedDivision(p, qcp.id, "Packing");
        if (pv.key === "MIX") for (const v of VARIANTS) await bom(p.id, p.name, sp.get(v) ?? null, n / 4, `Single Pack ${v}`);
        else {
          const v = VARIANTS.find((x) => VARIANT_ENUM[x] === pv.key)!;
          await bom(p.id, p.name, sp.get(v) ?? null, n, `Single Pack ${v}`);
        }
        for (const [k, q] of KEMAS[n]) await bom(p.id, p.name, kemas[k], q, kemas[k]?.name ?? k);
        const known = new Set([...sp.values(), ...Object.values(kemas)].filter(Boolean).map((x) => x!.id));
        const others = (await tx.bomLine.findMany({ where: { productId: p.id }, include: { item: true } })).filter((o) => !known.has(o.itemId));
        if (others.length) {
          await tx.bomLine.deleteMany({ where: { id: { in: others.map((o) => o.id) } } });
          plan.resep.push(`${p.name}: resep lama diganti (dihapus: ${others.map((o) => `${o.item.name} ${Number(o.qty)}`).join(", ")})`);
        }
      }
    }
  }

  // B. Giftbox (Giftbox): resep default per varian + bubble wrap 12 cm; add-on Magnet 1 / Pallet 1
  const G = { divisionId: gft.id, divLabel: "Giftbox" };
  const dus = pcsOnly(one("Dus giftbox 16x16x5"), "Dus giftbox 16x16x5");
  const guide = pcsOnly(one("Color guide"), "Color guide");
  const kuas = pcsOnly(one("Kuas lancip"), "Kuas lancip");
  const sabuk = pcsOnly(one("Sabuk label giftbox"), "Sabuk label giftbox");
  const gBubble = allItems.find((i) => /^bubble ?wrap/i.test(i.name) && i.divisionId === gft.id) ?? null;
  // 1 roll besar dipotong 5 roll kecil @50 m → 1 roll = 25.000 cm
  const gBubbleCm = gBubble ? await material({ name: gBubble.name, unit: "roll", hppUnit: "cm", factor: 25000, ...G }) : kemas.bubble;
  const magnet = await material({ name: "Magnet", unit: "pcs", hppUnit: "pcs", factor: 1, ...G, create: true });
  const pallet = pcsOnly(one("Pallet cat"), "Pallet cat");
  // Giftbox Mix: 1 patung tiap karakter + 1 "varian bebas" (dipilih di laporan); HPP varian bebas = rata-rata 4 karakter
  const keringH = one("Patung kering Hewan");
  // Nonaktif: tidak muncul di stok / laporan; HPP tetap dihitung dari resepnya
  let bebas = await tx.item.findUnique({ where: { sku: "SJ-PTG-BEBAS" } });
  if (!bebas) {
    bebas = await tx.item.create({ data: { sku: "SJ-PTG-BEBAS", name: "Patung kering varian bebas", unit: "pcs", type: "BARANG_DALAM_PROSES", active: false, divisionId: keringH?.divisionId ?? null, note: "Hanya untuk HPP Giftbox Mix (rata-rata 4 karakter); tidak distok" } });
    plan.dibuat.push(`+ SJ-PTG-BEBAS Patung kering varian bebas · setengah jadi (hanya HPP Giftbox Mix: rata-rata 4 karakter, tidak distok)`);
  }
  for (const v of VARIANTS) await recipe(bebas, pcsOnly(one(`Patung kering ${v}`), `Patung kering ${v}`), 0.25, "pcs", `Patung kering ${v}`);
  const mixGiftbox: string[] = [];
  const giftboxes = await tx.product.findMany({ where: { active: true, type: "GIFTBOX" }, orderBy: { sku: "asc" } });
  for (const p of giftboxes) {
    await finishedDivision(p, gft.id, "Giftbox");
    await bom(p.id, p.name, dus, 1, "Dus giftbox 16x16x5");
    await bom(p.id, p.name, guide, 1, "Color guide");
    await bom(p.id, p.name, kuas, 1, "Kuas lancip");
    await bom(p.id, p.name, cg, 1, "Cat Giftbox");
    await bom(p.id, p.name, sabuk, 1, "Sabuk label giftbox");
    await bom(p.id, p.name, gBubbleCm, 60, `${gBubbleCm?.name ?? "Bubble wrap"} (cm, 12 cm × 5 patung)`);
    if (/magnet/i.test(p.name)) await bom(p.id, p.name, magnet, 1, "Magnet");
    if (/palet|pallet/i.test(p.name)) await bom(p.id, p.name, pallet, 1, "Pallet cat");
    const v = VARIANTS.find((x) => VARIANT_ENUM[x] === p.variant);
    if (v) await bom(p.id, p.name, pcsOnly(one(`Patung kering ${v}`), `Patung kering ${v}`), 5, `Patung kering ${v}`);
    else {
      for (const vv of VARIANTS) await bom(p.id, p.name, pcsOnly(one(`Patung kering ${vv}`), `Patung kering ${vv}`), 1, `Patung kering ${vv}`);
      await bom(p.id, p.name, bebas, 1, "Patung kering varian bebas");
      mixGiftbox.push(p.name);
    }
  }
  if (!mixGiftbox.length) plan.menunggu.push("Produk Giftbox Mix belum ada — tambahkan pilihan Series Mix di Produk Induk Giftbox (add-on sama), lalu jalankan skrip lagi");
  plan.menunggu.push("Pot cat plastik: HPP 5 pcs per Cat Giftbox (strip 6 dipotong: isi 3 untuk merah/kuning/biru, isi 2 untuk hitam/putih)");

  for (const [target, xs] of rec) plan.resep.push(`${target}: ${xs.join(" · ")}`);

  // ---------- 4. Nama mirip / item lama yang sama arti ----------
  const active = await tx.item.findMany({ where: { active: true }, select: { sku: true, name: true, type: true } });
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      // Sudah dijawab Owner: barang berbeda
      const pair = `${a.name}|${b.name}`.toLowerCase();
      if (/cat plastik/.test(pair) && /\|?cat (merah|biru|kuning)\b/.test(pair.replace(/cat plastik \w+/g, ""))) continue;
      if (/pot cat giftbox/.test(pair)) continue;
      if (a.name.toLowerCase() !== b.name.toLowerCase() && similarNames(a.name, b.name)) plan.bentrok.push(`MIRIP ${a.sku} "${a.name}" vs ${b.sku} "${b.name}" — sama arti? (tidak digabung otomatis)`);
    }
  }
}
