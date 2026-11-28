import type { Prisma, PrismaClient } from "@prisma/client";
import { latestCost } from "./unitcost";
import { overheadUnitCost } from "./hpp";
import { lpgShare } from "./lpgText";
import { COA } from "./accounting";

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

export type LpgFinanceBaris = { number: string; date: Date; amount: number; total: number; mode: "penuh" | "baris" | "rincian"; teks: string; /** Akun beban tempat transaksi terposting (bila sudah dibukukan) */ akun?: string | null; txId?: string; journalId?: string | null };
export type LpgSumber = { bopLpg: number; financeLpg: number; financeBaris: LpgFinanceBaris[]; isiUlangDibayar: number; isiUlangTabungDibayar: number; isiUlangMenunggu: number; estimasiMenunggu: number; pembelianItem: number; dipakai: number; catatan: string[] };
export type PeriodeBiaya = { label: string; lpg: LpgSumber; panen: { bagus: number; laporan: number }; lpgPerPcs: number | null };

const sumPanen = (work: unknown) => {
  const rows = (work as { panen?: { v?: (number | null)[] }[] } | null)?.panen;
  return Array.isArray(rows) ? rows.reduce((a, r) => a + (r.v ?? []).reduce<number>((s, x) => s + (Number(x) || 0), 0), 0) : 0;
};

/** Pembelian LPG yang tercatat sebagai transaksi Finance biasa + LPG di buku besar 6-1310 (tanpa dobel) */
export async function collectFinanceLpg(db: Db) {
  const refills = await db.lpgRefill.findMany({ select: { transactionId: true } });
  // Pembelian LPG yang dicatat sebagai transaksi Finance biasa (kategori mis. Pembelian Bahan Baku / Konsumsi): dikenali dari deskripsinya.
  // Yang sudah dipasangkan ke isi ulang tabung (LpgRefill.transactionId) tidak dihitung lagi.
  const linkedTx = new Set(refills.map((r) => r.transactionId).filter((x): x is string => !!x));
  const word = (f: string) => [{ [f]: { contains: "lpg", mode: "insensitive" as const } }, { [f]: { contains: "elpiji", mode: "insensitive" as const } }];
  const fTx = await db.financeTransaction.findMany({
    where: { direction: "KELUAR", status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, deletedAt: null, origin: null, OR: [...word("note"), ...word("rawText"), ...word("counterparty"), { splits: { some: { OR: word("note") } } }] },
    include: { splits: true }, orderBy: { date: "asc" },
  });
  // Buku besar 6-1310 Beban LPG Produksi (BOP): transaksi berkategori "LPG Oven" sudah tercatat di sini. Transaksi yang tertaut ke isi ulang
  // tabung (sudah dihitung di isi ulang dibayar) dikeluarkan agar tidak dobel; jurnal pembalik dihitung ke transaksi aslinya.
  const bopAcc = await db.coaAccount.findUnique({ where: { code: COA.BEBAN_LPG_PRODUKSI }, select: { id: true } });
  const bopLines = bopAcc ? await db.journalLine.findMany({ where: { accountId: bopAcc.id }, select: { debit: true, credit: true, journal: { select: { date: true, sourceId: true, reversalOfId: true } } } }) : [];
  const revOrig = bopLines.map((l) => l.journal.reversalOfId).filter((x): x is string => !!x);
  const origSrc = new Map((revOrig.length ? await db.journal.findMany({ where: { id: { in: revOrig } }, select: { id: true, sourceId: true } }) : []).map((j) => [j.id, j.sourceId]));
  const bopTxIds = new Set<string>(); // transaksi Finance yang jurnalnya mengenai 6-1310 (tidak dihitung lagi lewat deteksi deskripsi)
  const bopRows: { date: Date; net: number }[] = [];
  for (const l of bopLines) {
    const src = l.journal.reversalOfId ? origSrc.get(l.journal.reversalOfId) ?? null : l.journal.sourceId;
    if (src) bopTxIds.add(src);
    if (src && linkedTx.has(src)) continue;
    bopRows.push({ date: l.journal.date, net: Number(l.debit) - Number(l.credit) });
  }
  const fin: LpgFinanceBaris[] = [];
  const peringatan: string[] = [];
  for (const t of fTx) {
    if (linkedTx.has(t.id) || bopTxIds.has(t.id)) continue;
    const total = Number(t.amount);
    const teks = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ");
    const sp = t.splits.filter((x) => lpgShare(x.note, Number(x.amount)).mode !== "tidak-lpg");
    if (t.splits.length) {
      // Rincian: nominal baris rincian yang menyebut LPG
      if (sp.length) fin.push({ number: t.number, date: t.date, amount: sp.reduce((a, x) => a + Number(x.amount), 0), total, mode: "rincian", teks });
      else peringatan.push(`${t.number}: rincian tidak menyebut LPG di barisnya (${teks.slice(0, 80)}), tidak dihitung`);
      continue;
    }
    const sh = lpgShare(teks, total);
    if (sh.mode === "penuh" || sh.mode === "baris") fin.push({ number: t.number, date: t.date, amount: sh.amount, total, mode: sh.mode, teks });
    else if (sh.mode === "tidak-terparse") peringatan.push(`${t.number}: deskripsi campur dan nominal baris LPG tidak terbaca (Rp${total.toLocaleString("id-ID")}; "${sh.lines.join(" / ").slice(0, 80)}"), tidak dihitung — cek manual`);
  }
  // Akun beban tempat transaksi terposting (info: LPG yang masuk 6-1300 beban umum dapat direklas ke 6-1310)
  const jIds = fTx.filter((t) => fin.some((f) => f.number === t.number) && t.journalId).map((t) => t.journalId!);
  const dl = jIds.length ? await db.journalLine.findMany({ where: { journalId: { in: jIds }, debit: { gt: 0 }, account: { type: "BEBAN" } }, select: { journalId: true, debit: true, account: { select: { code: true } } } }) : [];
  for (const f of fin) {
    const t = fTx.find((x) => x.number === f.number);
    const lines = dl.filter((l) => l.journalId === t?.journalId);
    f.akun = lines.sort((a, c) => Number(c.debit) - Number(a.debit))[0]?.account.code ?? null;
    f.txId = t?.id;
    f.journalId = t?.journalId ?? null;
  }
  return { fin, peringatan, bopRows };
}

export async function biayaLpgPerPeriode(db: Db, now: Date = new Date()): Promise<PeriodeBiaya[]> {
  const refills = await db.lpgRefill.findMany();
  const paid = refills.filter((r) => r.status === "DIPASANGKAN" && r.amount != null && r.pricePerTabung != null);
  const lastPrice = paid.length ? Number([...paid].sort((a, b) => b.physicalDate.getTime() - a.physicalDate.getTime())[0].pricePerTabung) : 0;
  const lpgItems = await db.item.findMany({ where: { OR: [{ name: { contains: "lpg", mode: "insensitive" } }, { name: { contains: "elpiji", mode: "insensitive" } }, { name: { contains: "gas ", mode: "insensitive" } }] }, select: { id: true, name: true } });
  const lpgItemIds = lpgItems.filter((i) => LPG_WORDS.test(i.name)).map((i) => i.id);
  const lines = lpgItemIds.length ? await db.purchaseLine.findMany({ where: { itemId: { in: lpgItemIds } }, select: { amount: true, purchase: { select: { date: true } } } }) : [];
  const reports = await db.shiftReport.findMany({ where: { status: { in: ["TERKIRIM", "DIREVISI"] }, division: { reportTemplate: "PRODUKSI" } }, select: { date: true, work: true } });
  const { fin, peringatan, bopRows } = await collectFinanceLpg(db);
  return periodes(now).map((p) => {
    const inP = (d: Date) => d >= p.from && d < p.to;
    const r = refills.filter((x) => inP(new Date(`${x.physicalDate.toISOString().slice(0, 10)}T00:00:00+07:00`)));
    const rp = r.filter((x) => x.status === "DIPASANGKAN" && x.amount != null);
    const waiting = r.filter((x) => !(x.status === "DIPASANGKAN" && x.amount != null));
    const isiUlangDibayar = rp.reduce((a, x) => a + Number(x.amount), 0);
    const estimasiMenunggu = waiting.reduce((a, x) => a + x.tabung * lastPrice, 0);
    const pembelianItem = lines.filter((l) => inP(l.purchase.date)).reduce((a, l) => a + Number(l.amount), 0);
    const catatan: string[] = [];
    const financeBaris = fin.filter((x) => inP(new Date(`${x.date.toISOString().slice(0, 10)}T00:00:00+07:00`)));
    const financeLpg = financeBaris.reduce((a, x) => a + x.amount, 0);
    // Aktual dipakai bila ada (isi ulang dipasangkan + transaksi Finance LPG); estimasi isi ulang yang belum dipasangkan HANYA bila tidak ada transaksi
    // Finance LPG (transaksi itulah pembayaran isi ulang yang belum dipasangkan → tidak dobel). Pembelian barang LPG hanya bila semuanya kosong.
    const bopLpg = bopRows.filter((x) => inP(x.date)).reduce((a, x) => a + x.net, 0);
    const aktual = isiUlangDibayar + financeLpg + bopLpg;
    const refillTotal = financeLpg > 0 || bopLpg > 0 ? aktual : aktual + estimasiMenunggu;
    const dipakai = refillTotal > 0 ? refillTotal : pembelianItem;
    if ((financeLpg > 0 || bopLpg > 0) && estimasiMenunggu > 0) catatan.push(`estimasi isi ulang belum dipasangkan Rp${estimasiMenunggu.toLocaleString("id-ID")} TIDAK dijumlahkan (sudah ada aktual: transaksi Finance LPG Rp${financeLpg.toLocaleString("id-ID")} + buku besar 6-1310 Rp${bopLpg.toLocaleString("id-ID")})`);
    for (const w of peringatan) catatan.push(`⚠ ${w}`);
    if (refillTotal > 0 && pembelianItem > 0) catatan.push(`pembelian barang LPG Rp${pembelianItem.toLocaleString("id-ID")} tidak dijumlahkan (kemungkinan dobel dengan isi ulang)`);
    if (waiting.length) catatan.push(`${waiting.length} isi ulang belum dipasangkan ke transaksi Finance (estimasi ${waiting.reduce((a, x) => a + x.tabung, 0)} tabung × Rp${lastPrice.toLocaleString("id-ID")})`);
    const rep = reports.filter((x) => inP(new Date(`${x.date.toISOString().slice(0, 10)}T00:00:00+07:00`)));
    const bagus = rep.reduce((a, x) => a + sumPanen(x.work), 0);
    return {
      label: p.label,
      lpg: { bopLpg, financeLpg, financeBaris, isiUlangDibayar, isiUlangTabungDibayar: rp.reduce((a, x) => a + x.tabung, 0), isiUlangMenunggu: waiting.length, estimasiMenunggu, pembelianItem, dipakai, catatan },
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

export const ASET_ALAT_DEFAULT = /cetakan|alat|mesin|produksi/i;
/** Bukan alat/cetakan: sewa/bangunan sudah ada sebagai overhead "Sewa Tempat"; oven punya penyusutan sendiri */
export const ASET_KECUALI = /sewa|rumah|bangunan|gedung|tanah|kendaraan|oven/i;
export const ASET_NAMA_OVERHEAD = "Penyusutan alat produksi & cetakan (aset)";

export type PenyusutanAset = { aset: { id: string; nama: string; perBulan: number }[]; perBulan: number; produksiCetak: number; produksi30: number; sumberProduksi: string; bulanTerhitung: number; perPcs: number | null };

/**
 * Penyusutan bulanan aset alat produksi & cetakan (modul Aset tetap: (harga − sisa) ÷ umur bulan, oven tidak ikut) dibagi KAPASITAS NORMAL
 * = rata-rata produksi patung cetak per bulan selama 6 bulan kalender terakhir (bulan yang ada datanya; hasil cetak laporan Cetak,
 * bila kosong panen patung kering laporan Oven) = per pcs patung cetak. Produksi 30 hari terakhir hanya ditampilkan sebagai pembanding.
 */
export async function penyusutanAset(db: Db, opts: { now?: Date; pola?: RegExp } = {}): Promise<PenyusutanAset> {
  const pola = opts.pola ?? ASET_ALAT_DEFAULT;
  const assets = (await db.fixedAsset.findMany({ where: { active: true }, orderBy: { name: "asc" } })).filter((a) => pola.test(a.name) && !ASET_KECUALI.test(a.name));
  const aset = assets.map((a) => ({ id: a.id, nama: a.name, perBulan: a.usefulLifeMonths > 0 ? Math.round((Number(a.cost) - Number(a.residual)) / a.usefulLifeMonths) : 0 }));
  const perBulan = aset.reduce((s, a) => s + a.perBulan, 0);
  const per = periodes(opts.now);
  const reports = await db.shiftReport.findMany({ where: { status: { in: ["TERKIRIM", "DIREVISI"] }, division: { reportTemplate: { in: ["CETAK", "PRODUKSI"] } } }, select: { date: true, work: true } });
  const sumRows = (work: unknown, key: string) => { const rows = (work as Record<string, { v?: (number | null)[] }[] | undefined> | null)?.[key]; return Array.isArray(rows) ? rows.reduce((a, r) => a + (r.v ?? []).reduce<number>((q, x) => q + (Number(x) || 0), 0), 0) : 0; };
  const prod = (p: Periode) => {
    const inP = reports.filter((x) => { const d = new Date(`${x.date.toISOString().slice(0, 10)}T00:00:00+07:00`); return d >= p.from && d < p.to; });
    const cetak = inP.reduce((a, x) => a + sumRows(x.work, "cetakSeries"), 0);
    return { cetak, panen: inP.reduce((a, x) => a + sumRows(x.work, "panen"), 0) };
  };
  const bulan = per.slice(0, 6).map(prod);
  const useCetak = bulan.some((b) => b.cetak > 0);
  const vals = bulan.map((b) => (useCetak ? b.cetak : b.panen)).filter((v) => v > 0);
  const normal = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  const w30 = prod(per[6]);
  return {
    aset, perBulan, produksiCetak: normal, produksi30: w30.cetak > 0 ? w30.cetak : w30.panen, bulanTerhitung: vals.length,
    sumberProduksi: `kapasitas normal = rata-rata ${vals.length} bulan terakhir (${useCetak ? "hasil cetak laporan Cetak" : vals.length ? "panen patung kering laporan Oven; hasil cetak belum ada" : "tidak ada data produksi"})`,
    perPcs: perBulan > 0 && normal > 0 ? Math.round((perBulan / normal) * 100) / 100 : null,
  };
}

// ---------------- --pasang ----------------

export type PasangPlan = { baris: string[]; ditunda: string[]; ok: boolean; rate: { total: number; panen: number; perPcs: number } | null; gypsum: GypsumInfo | null };

const VAR = (sku: string, prefix: string) => sku.slice(prefix.length);

export async function rencanaPasang(db: Db, opts: { gypsumSku?: string; now?: Date; poolAset?: RegExp; gramPerUnit?: number } = {}): Promise<PasangPlan & { aksi: Aksi[] }> {
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
  // Target gypsum per patung cetak dalam SATUAN RESEP item (gram → 30; kg → 0,03; satuan lain mis. sak → 30 ÷ gram per satuan via --gram-per-unit)
  // Kolom qty resep hanya 4 desimal: dibulatkan di sini supaya angka yang ditampilkan = yang tersimpan
  const rawTarget = g ? (g.perGram != null ? qtyGypsum : opts.gramPerUnit && opts.gramPerUnit > 0 ? GYPSUM_GRAM_PER_PCS / opts.gramPerUnit : null) : null;
  const targetQty = rawTarget == null ? null : Math.round(rawTarget * 1e4) / 1e4;
  const presisi = rawTarget != null && Math.abs(targetQty! - rawTarget) / rawTarget > 0.005 ? `  ⚠ presisi resep 4 desimal: dibulatkan jadi ${targetQty} (≈ ${Math.round(targetQty! * (opts.gramPerUnit ?? 1))} g); lebih akurat bila satuan resep gypsum di Master data diset gram (satuan resep gram, 1 ${g?.unit} = ${opts.gramPerUnit ?? "N"} gram)` : "";
  const biayaPerUnitResep = g ? g.hargaStok / g.factor : 0;
  if (g && targetQty == null) ditunda.push(`Gypsum ${g.sku}: satuan resep "${g.hppUnit}" bukan gram/kg; tambahkan --gram-per-unit=<gram per ${g.hppUnit}> (mis. 18000 per sak) agar bisa dipasang/dikoreksi ke ${GYPSUM_GRAM_PER_PCS} g`);
  if (g && targetQty != null) {
    const rpPcs = (q: number) => `Rp${Math.round(q * biayaPerUnitResep).toLocaleString("id-ID")}/pcs`;
    for (const it of cetak) {
      const d = await desc(it.id);
      const gl = d.r.find((x) => x.componentId === g.itemId);
      if (gl) {
        const q = Number(gl.qty);
        if (Math.abs(q - targetQty) < 1e-9) baris.push(`= ${it.sku} ${it.name}: gypsum sudah ${GYPSUM_GRAM_PER_PCS} g (${rpPcs(q)})`);
        else {
          aksi.push({ kind: "RESEP_KOREKSI", lineId: gl.id, qty: targetQty });
          const salahSatuan = q > targetQty * 5;
          baris.push(`~ ${it.sku} ${it.name}: ${g.name} × ${q} ${g.hppUnit} (${rpPcs(q)}) → × ${targetQty} ${g.hppUnit} = ${GYPSUM_GRAM_PER_PCS} g (${rpPcs(targetQty)})${salahSatuan ? "  ⚠ qty jauh di atas 30 g: kemungkinan salah satuan (sak/kg bukan gram)" : ""}${presisi}`);
        }
        continue;
      }
      if (d.r.length) { baris.push(`= ${it.sku} ${it.name}: sudah punya resep tanpa ${g.name} (${d.text}), TIDAK diubah`); continue; }
      aksi.push({ kind: "RESEP", itemId: it.id, componentId: g.itemId, qty: targetQty, useUnit: g.hppUnit });
      baris.push(`+ ${it.sku} ${it.name}: ${g.name} × ${targetQty} ${g.hppUnit} (= ${rpPcs(targetQty)})${presisi}${d.text ? ` · tetap: ${d.text}` : ""}`);
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
  // Penyusutan alat produksi & cetakan (data aset) → overhead di resep Patung Cetak, KECUALI penyusutan sudah tercakup oleh overhead master
  // "Penyusutan Cetakan"/"Penyusutan Oven" di resep (tidak dobel). Sewa/bangunan bukan alat (sudah overhead "Sewa Tempat"). "Perlengkapan Produksi" yang sama diganti.
  const dep = await penyusutanAset(db, { now: opts.now, pola: opts.poolAset });
  const tercakup = (o: { overhead: { category: string } }) => /^penyusutan (cetakan|oven)$/i.test(o.overhead.category);
  const butuh: typeof cetak = [];
  for (const it of cetak) {
    const d = await desc(it.id);
    const t = d.o.filter(tercakup);
    if (t.length) baris.push(`i ${it.sku} ${it.name}: penyusutan sudah tercakup oleh overhead ${t.map((x) => `"${x.overhead.name}" (${x.overhead.category}) Rp${Number(x.overhead.monthlyAmount).toLocaleString("id-ID")}/bln`).join(", ")} → penyusutan aset TIDAK ditambahkan`);
    else butuh.push(it);
  }
  const ohOvenAset = (await db.fixedAsset.findMany({ where: { active: true } })).filter((a) => /oven/i.test(a.name) && !/sewa|rumah|bangunan/i.test(a.name));
  const ovenPerBulan = ohOvenAset.reduce((a, x) => a + (x.usefulLifeMonths > 0 ? Math.round((Number(x.cost) - Number(x.residual)) / x.usefulLifeMonths) : 0), 0);
  for (const it of kering) {
    const t = (await desc(it.id)).o.filter((x) => /^penyusutan oven$/i.test(x.overhead.category));
    if (t.length) baris.push(`i ${it.sku}: penyusutan oven sudah ada di resep ("${t[0].overhead.name}" Rp${Number(t[0].overhead.monthlyAmount).toLocaleString("id-ID")}/bln${ovenPerBulan ? `; aset oven ${ohOvenAset.map((a) => a.name).join(", ")} Rp${ovenPerBulan.toLocaleString("id-ID")}/bln` : ""}) → TIDAK ditambah`);
  }
  if (!dep.aset.length) baris.push(`i Aset alat produksi/cetakan: tidak ada aset tetap aktif yang cocok (sewa/bangunan/oven dikecualikan; pola bisa diubah: --aset=<regex>) → overhead penyusutan aset TIDAK dibuat/dipasang`);
  else if (dep.perPcs == null) ditunda.push("Penyusutan aset alat produksi/cetakan: tidak ada data produksi patung cetak");
  else if (!butuh.length) baris.push(`i Penyusutan aset (${dep.aset.map((a) => a.nama).join(", ")}) tidak dipasang: semua resep patung cetak sudah punya penyusutan`);
  else {
    baris.push(`i Penyusutan aset (${dep.aset.map((a) => `${a.nama} Rp${a.perBulan.toLocaleString("id-ID")}`).join(", ")}) = Rp${dep.perBulan.toLocaleString("id-ID")}/bln ÷ ${dep.produksiCetak.toLocaleString("id-ID")} pcs (${dep.sumberProduksi}) = Rp${dep.perPcs}/pcs`);
    const ohAset = await db.overhead.findFirst({ where: { name: ASET_NAMA_OVERHEAD, active: true } });
    if (!ohAset) aksi.push({ kind: "OVERHEAD_ASET_BARU", monthlyAmount: dep.perBulan, outputPerMonth: dep.produksiCetak });
    else if (ohAset.outputPerMonth !== dep.produksiCetak || Number(ohAset.monthlyAmount) !== dep.perBulan) {
      aksi.push({ kind: "OVERHEAD_ASET_PERBARUI", overheadId: ohAset.id, monthlyAmount: dep.perBulan, outputPerMonth: dep.produksiCetak });
      baris.push(`~ Overhead "${ASET_NAMA_OVERHEAD}": Rp${Number(ohAset.monthlyAmount).toLocaleString("id-ID")}/bln ÷ ${ohAset.outputPerMonth} pcs → Rp${dep.perBulan.toLocaleString("id-ID")}/bln ÷ ${dep.produksiCetak} pcs (kapasitas normal)`);
    } else baris.push(`= Overhead "${ASET_NAMA_OVERHEAD}" sudah sesuai kapasitas normal`);
    for (const it of butuh) {
      const d = await desc(it.id);
      if (!d.o.some((x) => x.overhead.name === ASET_NAMA_OVERHEAD)) { aksi.push({ kind: "OVERHEAD_ASET_PASANG", itemId: it.id }); baris.push(`+ ${it.sku} ${it.name}: overhead ${ASET_NAMA_OVERHEAD}${ohAset ? "" : ` (Rp${dep.perPcs}/pcs)`}`); }
      for (const x of d.o.filter((y) => y.overhead.category === "Perlengkapan Produksi" || /perlengkapan produksi/i.test(y.overhead.name))) {
        const m = Number(x.overhead.monthlyAmount);
        const sama = dep.perBulan > 0 && Math.abs(m - dep.perBulan) / dep.perBulan <= 0.15;
        if (sama) { aksi.push({ kind: "OVERHEAD_LEPAS", rowId: x.id }); baris.push(`- ${it.sku} ${it.name}: overhead "${x.overhead.name}" (Rp${m.toLocaleString("id-ID")}/bln) ≈ penyusutan aset Rp${dep.perBulan.toLocaleString("id-ID")}/bln → DILEPAS dari resep ini (diganti yang dari data aset)`); }
        else baris.push(`! ${it.sku} ${it.name}: overhead "${x.overhead.name}" Rp${m.toLocaleString("id-ID")}/bln TIDAK sama dengan penyusutan aset Rp${dep.perBulan.toLocaleString("id-ID")}/bln → dibiarkan (cek apakah dobel)`);
      }
    }
  }
  if (ohLpg && rate) baris.push(`i Overhead LPG yang ada "${ohLpg.name}": Rp${(overheadUnitCost(ohLpg) || 0).toLocaleString("id-ID")}/pcs; hasil hitung 30 hari: Rp${rate.perPcs}/pcs (tidak ditimpa)`);
  return { baris, ditunda, ok: aksi.length > 0, rate, gypsum: g ?? null, aksi };
}

export type Aksi =
  | { kind: "RESEP"; itemId: string; componentId: string; qty: number; useUnit: string }
  | { kind: "RESEP_KOREKSI"; lineId: string; qty: number }
  | { kind: "OVERHEAD_BARU"; monthlyAmount: number; outputPerMonth: number }
  | { kind: "OVERHEAD_PASANG"; itemId: string }
  | { kind: "OVERHEAD_ASET_BARU"; monthlyAmount: number; outputPerMonth: number }
  | { kind: "OVERHEAD_ASET_PASANG"; itemId: string }
  | { kind: "OVERHEAD_ASET_PERBARUI"; overheadId: string; monthlyAmount: number; outputPerMonth: number }
  | { kind: "OVERHEAD_LEPAS"; rowId: string };

export async function pasangBiayaOven(db: PrismaClient, apply: boolean, opts: { gypsumSku?: string; now?: Date; poolAset?: RegExp; gramPerUnit?: number } = {}) {
  const plan = await rencanaPasang(db, opts);
  if (!apply || !plan.aksi.length) return plan;
  await db.$transaction(async (tx) => {
    let ohId = (await tx.overhead.findFirst({ where: { category: "LPG", active: true }, orderBy: { createdAt: "asc" } }))?.id ?? null;
    for (const a of plan.aksi) {
      if (a.kind === "RESEP_KOREKSI") await tx.itemRecipeLine.update({ where: { id: a.lineId }, data: { qty: a.qty } });
      else if (a.kind === "RESEP") await tx.itemRecipeLine.upsert({ where: { itemId_componentId: { itemId: a.itemId, componentId: a.componentId } }, create: { itemId: a.itemId, componentId: a.componentId, qty: a.qty, useUnit: a.useUnit }, update: {} });
      else if (a.kind === "OVERHEAD_BARU") ohId = (await tx.overhead.create({ data: { category: "LPG", name: LPG_OVERHEAD_NAME, monthlyAmount: BigInt(a.monthlyAmount), outputPerMonth: a.outputPerMonth, note: "Dihitung npm run hitung:biaya-oven --pasang (biaya LPG ÷ panen patung kering, 30 hari terakhir); perbarui bila perlu" } })).id;
      else if (a.kind === "OVERHEAD_PASANG") { if (ohId && !(await tx.recipeOverhead.findFirst({ where: { itemId: a.itemId, overheadId: ohId } }))) await tx.recipeOverhead.create({ data: { itemId: a.itemId, overheadId: ohId, factor: 1 } }); }
      else if (a.kind === "OVERHEAD_ASET_BARU") await tx.overhead.create({ data: { category: "Penyusutan Cetakan", name: ASET_NAMA_OVERHEAD, monthlyAmount: BigInt(a.monthlyAmount), outputPerMonth: a.outputPerMonth, note: "Penyusutan bulanan aset alat produksi & cetakan (modul Aset tetap) ÷ produksi patung cetak 30 hari; dihitung hitung:biaya-oven --pasang, perbarui bila perlu" } });
      else if (a.kind === "OVERHEAD_ASET_PERBARUI") await tx.overhead.update({ where: { id: a.overheadId }, data: { monthlyAmount: BigInt(a.monthlyAmount), outputPerMonth: a.outputPerMonth } });
      else if (a.kind === "OVERHEAD_ASET_PASANG") {
        const o = await tx.overhead.findFirst({ where: { name: ASET_NAMA_OVERHEAD, active: true } });
        if (o && !(await tx.recipeOverhead.findFirst({ where: { itemId: a.itemId, overheadId: o.id } }))) await tx.recipeOverhead.create({ data: { itemId: a.itemId, overheadId: o.id, factor: 1 } });
      } else await tx.recipeOverhead.deleteMany({ where: { id: a.rowId } });
    }
    await tx.auditLog.create({ data: { actorName: "skrip hitung:biaya-oven", action: "PASANG_BIAYA_OVEN", entity: "Item", entityId: "massal", data: { baris: plan.baris } as unknown as Prisma.InputJsonValue } });
  }, { isolationLevel: "Serializable", timeout: 60000 });
  return plan;
}
