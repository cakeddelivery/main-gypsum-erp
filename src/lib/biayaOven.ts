import type { Prisma, PrismaClient } from "@prisma/client";
import { latestCost } from "./unitcost";
import { overheadUnitCost } from "./hpp";

/**
 * Biaya oven & gypsum per patung (HANYA MEMBACA kecuali pasangBiayaOven):
 * - Patung cetak = 30 g gypsum bubuk (+ air, alat produksi & cetakan = overhead)
 * - Patung kering = 1 patung cetak + pengeringan oven berbahan gas LPG
 * Biaya LPG per pcs = biaya LPG periode ÷ panen patung kering (laporan Oven terkirim) periode yang sama.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const GYPSUM_GRAM_PER_PCS = 30;
export const LPG_OVERHEAD_NAME = "Gas LPG oven (patung kering)";
const LPG_WORDS = /\b(lpg|elpiji|gas)\b/i;
const GYPSUM_WORDS = /gypsum|gipsum|gips/i;
const DAY = 86_400_000;
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

export type Periode = { label: string; from: Date; to: Date }; // [from, to)

/** 6 bulan kalender terakhir (WIB) + 30 hari terakhir */
export function periodes(now: Date = new Date()): Periode[] {
  const [y, m] = wib(now).split("-").map(Number);
  const out: Periode[] = [];
  for (let k = 5; k >= 0; k--) {
    const a = new Date(Date.UTC(y, m - 1 - k, 1));
    const b = new Date(Date.UTC(y, m - k, 1));
    const iso = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00+07:00`);
    out.push({ label: a.toISOString().slice(0, 7), from: iso(a), to: iso(b) });
  }
  const today = new Date(`${wib(now)}T00:00:00+07:00`);
  out.push({ label: "30 hari terakhir", from: new Date(today.getTime() - 29 * DAY), to: new Date(today.getTime() + DAY) });
  return out;
}

export type LpgSumber = { isiUlangDibayar: number; isiUlangTabungDibayar: number; isiUlangMenunggu: number; estimasiMenunggu: number; pembelianItem: number; dipakai: number; catatan: string[] };
export type PeriodeBiaya = { label: string; lpg: LpgSumber; panen: { bagus: number; laporan: number }; lpgPerPcs: number | null };

const sumPanen = (work: unknown) => {
  const rows = (work as { panen?: { v?: (number | null)[] }[] } | null)?.panen;
  return Array.isArray(rows) ? rows.reduce((a, r) => a + (r.v ?? []).reduce<number>((s, x) => s + (Number(x) || 0), 0), 0) : 0;
};

export async function biayaLpgPerPeriode(db: Db, now: Date = new Date()): Promise<PeriodeBiaya[]> {
  const refills = await db.lpgRefill.findMany();
  const paid = refills.filter((r) => r.status === "DIPASANGKAN" && r.amount != null && r.pricePerTabung != null);
  const lastPrice = paid.length ? Number([...paid].sort((a, b) => b.physicalDate.getTime() - a.physicalDate.getTime())[0].pricePerTabung) : 0;
  const lpgItems = await db.item.findMany({ where: { OR: [{ name: { contains: "lpg", mode: "insensitive" } }, { name: { contains: "elpiji", mode: "insensitive" } }, { name: { contains: "gas ", mode: "insensitive" } }] }, select: { id: true, name: true } });
  const lpgItemIds = lpgItems.filter((i) => LPG_WORDS.test(i.name)).map((i) => i.id);
  const lines = lpgItemIds.length ? await db.purchaseLine.findMany({ where: { itemId: { in: lpgItemIds } }, select: { amount: true, purchase: { select: { date: true } } } }) : [];
  const reports = await db.shiftReport.findMany({ where: { status: { in: ["TERKIRIM", "DIREVISI"] }, division: { reportTemplate: "PRODUKSI" } }, select: { date: true, work: true } });
  return periodes(now).map((p) => {
    const inP = (d: Date) => d >= p.from && d < p.to;
    const r = refills.filter((x) => inP(new Date(`${x.physicalDate.toISOString().slice(0, 10)}T00:00:00+07:00`)));
    const rp = r.filter((x) => x.status === "DIPASANGKAN" && x.amount != null);
    const waiting = r.filter((x) => !(x.status === "DIPASANGKAN" && x.amount != null));
    const isiUlangDibayar = rp.reduce((a, x) => a + Number(x.amount), 0);
    const estimasiMenunggu = waiting.reduce((a, x) => a + x.tabung * lastPrice, 0);
    const pembelianItem = lines.filter((l) => inP(l.purchase.date)).reduce((a, l) => a + Number(l.amount), 0);
    const catatan: string[] = [];
    // Hindari hitung dobel: isi ulang (transaksi Finance) dipakai bila ada; pembelian item LPG hanya bila isi ulang tidak ada
    const refillTotal = isiUlangDibayar + estimasiMenunggu;
    const dipakai = refillTotal > 0 ? refillTotal : pembelianItem;
    if (refillTotal > 0 && pembelianItem > 0) catatan.push(`pembelian barang LPG Rp${pembelianItem.toLocaleString("id-ID")} tidak dijumlahkan (kemungkinan dobel dengan isi ulang)`);
    if (waiting.length) catatan.push(`${waiting.length} isi ulang belum dipasangkan ke transaksi Finance (estimasi ${waiting.reduce((a, x) => a + x.tabung, 0)} tabung × Rp${lastPrice.toLocaleString("id-ID")})`);
    const rep = reports.filter((x) => inP(new Date(`${x.date.toISOString().slice(0, 10)}T00:00:00+07:00`)));
    const bagus = rep.reduce((a, x) => a + sumPanen(x.work), 0);
    return {
      label: p.label,
      lpg: { isiUlangDibayar, isiUlangTabungDibayar: rp.reduce((a, x) => a + x.tabung, 0), isiUlangMenunggu: waiting.length, estimasiMenunggu, pembelianItem, dipakai, catatan },
      panen: { bagus, laporan: rep.length },
      lpgPerPcs: bagus > 0 && dipakai > 0 ? Math.round((dipakai / bagus) * 100) / 100 : null,
    };
  });
}

export type GypsumInfo = { itemId: string; sku: string; name: string; unit: string; hppUnit: string; factor: number; hargaStok: number; sumber: "pembelian terakhir" | "rata-rata"; perGram: number | null; per30g: number | null };

export async function biayaGypsum(db: Db): Promise<GypsumInfo[]> {
  const items = await db.item.findMany({ where: { active: true, type: "BAHAN_BAKU" }, orderBy: { sku: "asc" } });
  return items.filter((i) => GYPSUM_WORDS.test(i.name)).map((i) => {
    const factor = Number(i.hppFactor) > 0 ? Number(i.hppFactor) : 1;
    const gram = /^(g|gr|gram)$/i.test(i.hppUnit?.trim() ?? "") ? true : /^(g|gr|gram)$/i.test(i.unit.trim()) ? true : false;
    const kg = /^kg$/i.test(i.hppUnit?.trim() ?? "") || (!i.hppUnit && /^kg$/i.test(i.unit.trim()));
    const perStock = latestCost(i);
    const perUnit = perStock / factor; // per satuan resep
    const perGram = gram ? perUnit : kg ? perUnit / 1000 : null;
    return { itemId: i.id, sku: i.sku, name: i.name, unit: i.unit, hppUnit: i.hppUnit?.trim() || i.unit, factor, hargaStok: perStock, sumber: Number(i.lastCost) > 0 ? "pembelian terakhir" : "rata-rata", perGram: perGram == null ? null : Math.round(perGram * 10000) / 10000, per30g: perGram == null ? null : Math.round(perGram * GYPSUM_GRAM_PER_PCS) };
  });
}

export type OverheadInfo = { nama: string; sumber: "Overhead" | "Aset tetap"; perBulan: number; perPcs: number | null; catatan?: string };

/** Penyusutan alat produksi, oven & cetakan + overhead terkait (OVERHEAD: tidak ikut harga persediaan) */
export async function overheadTerkait(db: Db, panen30: number): Promise<OverheadInfo[]> {
  const out: OverheadInfo[] = [];
  const cap = Number((await db.setting.findUnique({ where: { key: "overhead_capacity_pcs" } }))?.value ?? 0) || 0;
  const ohs = await db.overhead.findMany({ where: { active: true, category: { in: ["Penyusutan Oven", "Penyusutan Cetakan", "Perlengkapan Produksi", "Sewa Tempat", "Listrik", "LPG"] } }, orderBy: { category: "asc" } });
  for (const o of ohs) out.push({ nama: `${o.category}: ${o.name}`, sumber: "Overhead", perBulan: Number(o.monthlyAmount), perPcs: overheadUnitCost(o, cap) || null });
  const assets = await db.fixedAsset.findMany({ where: { active: true } });
  for (const a of assets.filter((x) => /cetakan|alat|oven|mesin|produksi/i.test(x.name))) {
    const life = a.usefulLifeMonths;
    const perBulan = life > 0 ? Math.round((Number(a.cost) - Number(a.residual)) / life) : 0;
    out.push({ nama: a.name, sumber: "Aset tetap", perBulan, perPcs: panen30 > 0 ? Math.round((perBulan / panen30) * 100) / 100 : null, catatan: "per pcs memakai panen 30 hari terakhir" });
  }
  return out;
}

// ---------------- --pasang ----------------

export type PasangPlan = { baris: string[]; ditunda: string[]; ok: boolean; rate: { total: number; panen: number; perPcs: number } | null; gypsum: GypsumInfo | null };

const VAR = (sku: string, prefix: string) => sku.slice(prefix.length);

export async function rencanaPasang(db: Db, opts: { gypsumSku?: string; now?: Date } = {}): Promise<PasangPlan & { aksi: Aksi[] }> {
  const baris: string[] = [];
  const ditunda: string[] = [];
  const aksi: Aksi[] = [];
  const per = await biayaLpgPerPeriode(db, opts.now);
  const p30 = per[per.length - 1];
  const rate = p30.lpgPerPcs != null ? { total: p30.lpg.dipakai, panen: p30.panen.bagus, perPcs: p30.lpgPerPcs } : null;
  const gy = await biayaGypsum(db);
  const g = opts.gypsumSku ? gy.find((x) => x.sku === opts.gypsumSku) : gy.length === 1 ? gy[0] : undefined;
  if (!g) ditunda.push(gy.length ? `Gypsum: ${gy.length} kandidat (${gy.map((x) => `${x.sku} "${x.name}"`).join(", ")}), pilih dengan --gypsum=<SKU>` : "Gypsum: tidak ada barang bahan baku bernama gypsum");
  else if (g.perGram == null) ditunda.push(`Gypsum ${g.sku}: satuan resep "${g.hppUnit}" bukan gram/kg, isi manual`);
  const qtyGypsum = g ? (/^kg$/i.test(g.hppUnit) ? GYPSUM_GRAM_PER_PCS / 1000 : GYPSUM_GRAM_PER_PCS) : 0;

  const cetak = (await db.item.findMany({ where: { active: true, sku: { startsWith: "SJ-CTK-" } }, orderBy: { sku: "asc" } })).filter((i) => VAR(i.sku, "SJ-CTK-") !== "BEBAS");
  const kering = (await db.item.findMany({ where: { active: true, sku: { startsWith: "SJ-PTG-" } }, orderBy: { sku: "asc" } })).filter((i) => VAR(i.sku, "SJ-PTG-") !== "BEBAS");
  if (!cetak.length) ditunda.push("Patung cetak (SJ-CTK-*): barang belum ada (dibuat otomatis saat laporan Cetak/Oven pertama diposting)");
  if (!kering.length) ditunda.push("Patung kering (SJ-PTG-*): barang belum ada");

  const desc = async (itemId: string) => {
    const [r, l, o] = await Promise.all([
      db.itemRecipeLine.findMany({ where: { itemId }, include: { component: true } }),
      db.recipeLabor.findMany({ where: { itemId } }),
      db.recipeOverhead.findMany({ where: { itemId }, include: { overhead: true } }),
    ]);
    return { r, l, o, text: [...r.map((x) => `${x.component.name} × ${Number(x.qty)}`), ...l.map((x) => `upah ${x.name}`), ...o.map((x) => `overhead ${x.overhead.name}`)].join("; ") };
  };
  if (g && g.perGram != null) {
    for (const it of cetak) {
      const d = await desc(it.id);
      if (d.r.length) { baris.push(`= ${it.sku} ${it.name}: sudah punya resep (${d.text}), TIDAK diubah`); continue; }
      aksi.push({ kind: "RESEP", itemId: it.id, componentId: g.itemId, qty: qtyGypsum, useUnit: g.hppUnit });
      baris.push(`+ ${it.sku} ${it.name}: ${g.name} × ${qtyGypsum} ${g.hppUnit} (= Rp${g.per30g?.toLocaleString("id-ID")}/pcs)${d.text ? ` · tetap: ${d.text}` : ""}`);
    }
  }
  const ohLpg = await db.overhead.findFirst({ where: { category: "LPG", active: true }, orderBy: { createdAt: "asc" } });
  let lpgOhPlanned = false;
  for (const it of kering) {
    const v = VAR(it.sku, "SJ-PTG-");
    const c = cetak.find((x) => VAR(x.sku, "SJ-CTK-") === v);
    const d = await desc(it.id);
    if (d.r.length) baris.push(`= ${it.sku} ${it.name}: sudah punya resep (${d.text}), bahan TIDAK diubah`);
    else if (c) { aksi.push({ kind: "RESEP", itemId: it.id, componentId: c.id, qty: 1, useUnit: "pcs" }); baris.push(`+ ${it.sku} ${it.name}: ${c.name} × 1 pcs`); }
    else ditunda.push(`${it.sku}: tidak ada patung cetak ${v} (SJ-CTK-${v})`);
    if (d.o.some((x) => x.overhead.category === "LPG")) { baris.push(`= ${it.sku}: overhead LPG sudah terpasang`); continue; }
    if (!ohLpg && !rate) { if (!ditunda.some((t) => t.startsWith("Biaya LPG"))) ditunda.push("Biaya LPG per pcs: belum bisa dihitung (tidak ada biaya LPG atau panen 30 hari terakhir)"); continue; }
    if (!ohLpg && !lpgOhPlanned) { lpgOhPlanned = true; aksi.push({ kind: "OVERHEAD_BARU", monthlyAmount: Math.round(rate!.total), outputPerMonth: rate!.panen }); baris.push(`+ Overhead baru "${LPG_OVERHEAD_NAME}" (LPG): Rp${Math.round(rate!.total).toLocaleString("id-ID")} / ${rate!.panen.toLocaleString("id-ID")} pcs = Rp${rate!.perPcs}/pcs (30 hari terakhir)`); }
    aksi.push({ kind: "OVERHEAD_PASANG", itemId: it.id });
    baris.push(`+ ${it.sku} ${it.name}: overhead LPG oven${ohLpg ? ` (${ohLpg.name}: Rp${Number(ohLpg.monthlyAmount).toLocaleString("id-ID")}/bln, ${ohLpg.outputPerMonth} pcs; TIDAK diubah)` : ""}`);
  }
  if (ohLpg && rate) baris.push(`i Overhead LPG yang ada "${ohLpg.name}": Rp${(overheadUnitCost(ohLpg) || 0).toLocaleString("id-ID")}/pcs; hasil hitung 30 hari: Rp${rate.perPcs}/pcs (tidak ditimpa)`);
  return { baris, ditunda, ok: aksi.length > 0, rate, gypsum: g ?? null, aksi };
}

export type Aksi =
  | { kind: "RESEP"; itemId: string; componentId: string; qty: number; useUnit: string }
  | { kind: "OVERHEAD_BARU"; monthlyAmount: number; outputPerMonth: number }
  | { kind: "OVERHEAD_PASANG"; itemId: string };

export async function pasangBiayaOven(db: PrismaClient, apply: boolean, opts: { gypsumSku?: string; now?: Date } = {}) {
  const plan = await rencanaPasang(db, opts);
  if (!apply || !plan.aksi.length) return plan;
  await db.$transaction(async (tx) => {
    let ohId = (await tx.overhead.findFirst({ where: { category: "LPG", active: true }, orderBy: { createdAt: "asc" } }))?.id ?? null;
    for (const a of plan.aksi) {
      if (a.kind === "RESEP") await tx.itemRecipeLine.upsert({ where: { itemId_componentId: { itemId: a.itemId, componentId: a.componentId } }, create: { itemId: a.itemId, componentId: a.componentId, qty: a.qty, useUnit: a.useUnit }, update: {} });
      else if (a.kind === "OVERHEAD_BARU") ohId = (await tx.overhead.create({ data: { category: "LPG", name: LPG_OVERHEAD_NAME, monthlyAmount: BigInt(a.monthlyAmount), outputPerMonth: a.outputPerMonth, note: "Dihitung npm run hitung:biaya-oven --pasang (biaya LPG ÷ panen patung kering, 30 hari terakhir); perbarui bila perlu" } })).id;
      else if (ohId) { if (!(await tx.recipeOverhead.findFirst({ where: { itemId: a.itemId, overheadId: ohId } }))) await tx.recipeOverhead.create({ data: { itemId: a.itemId, overheadId: ohId, factor: 1 } }); }
    }
    await tx.auditLog.create({ data: { actorName: "skrip hitung:biaya-oven", action: "PASANG_BIAYA_OVEN", entity: "Item", entityId: "massal", data: { baris: plan.baris } as unknown as Prisma.InputJsonValue } });
  }, { isolationLevel: "Serializable", timeout: 60000 });
  return plan;
}
