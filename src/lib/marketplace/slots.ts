import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { dateStr } from "@/lib/time";
import { FormatError, parseMarketplaceFile, type FileKind, type ParsedFile } from "./parse";
import { lineKey } from "./rules";

export type SlotDef = { key: FileKind; label: string; example: string; steps: string[]; /** fakta unduhan (per bulan / multi-bulan / nama ganda) */ note: string };
export type ChannelCode = "SHP" | "TTS";

/** Slot impor per kanal (nama slot & petunjuk unduh dari Seller Center) */
export const SLOTS: Record<ChannelCode, SlotDef[]> = {
  SHP: [
    { key: "ORDER", label: "Pesanan", example: "Order.all.20261101_20261130.xlsx", steps: ["Seller Centre → Pesanan Saya → Semua", "Atur tanggal pesanan → Ekspor", "Unduh file Order.all…xlsx"], note: "Shopee hanya bisa mengunduh PER BULAN. Boleh pilih beberapa bulan sekaligus (Agu, Sep, Okt, Nov): urutan otomatis dari yang lama ke baru, periode dibaca dari isi file." },
    { key: "INCOME", label: "Penghasilan", example: "Income.sudah_dilepas.<toko>.20261101_20261130.xlsx", steps: ["Seller Centre → Penghasilan Saya → Sudah Dilepas", "Atur periode → Unduh (Laporan Penghasilan)", "Unduh file Income.sudah_dilepas…xlsx"], note: "Per bulan. Beberapa bulan boleh sekaligus; periode yang tumpang tindih aman (tidak dobel)." },
    { key: "BALANCE", label: "Saldo Penjual", example: "my_balance_transaction_report.<toko>.20261101_20261130.xlsx", steps: ["Seller Centre → Penghasilan Saya → Saldo Penjual", "Atur periode → Unduh Laporan Transaksi", "Unduh file my_balance_transaction_report…xlsx"], note: "Per bulan. Beberapa bulan boleh sekaligus; periode yang tumpang tindih aman." },
    { key: "ADSBILL", label: "Saldo Iklan", example: "<toko>_adwords_bill_20261101_20261130.csv", steps: ["Seller Centre → Iklan Shopee → Saldo / Isi Saldo Iklan", "Buka Riwayat transaksi → atur periode → Unduh", "Unduh file …_adwords_bill_….csv"], note: "Diunduh per tanggal unduh; nama file bisa berakhiran “(1)”, “(2)” untuk unduhan yang sama. File berisi sama persis otomatis dilewati dengan pesan “sudah diunggah”." },
  ],
  TTS: [
    { key: "ORDER", label: "Semua pesanan", example: "Semua pesanan-2026-11-30-10_15.xlsx", steps: ["Seller Center TikTok Shop → Pesanan → Semua pesanan", "Atur rentang tanggal → Ekspor pesanan", "Unduh file Semua pesanan…xlsx"], note: "Boleh lebih dari 1 bulan dalam satu file. Periode dibaca dari isi file, bukan dari nama; beberapa file sekaligus juga boleh." },
    { key: "INCOME", label: "Penghasilan", example: "income_20261130123000(UTC).xlsx", steps: ["Seller Center TikTok Shop → Keuangan → Penghasilan", "Pilih periode / sudah diselesaikan → Ekspor", "Unduh file income_…xlsx"], note: "Penghasilan TikTok efektif per 2 bulan: satu file bisa memuat 2 bulan. Periode dibaca dari isi file; tumpang tindih aman." },
  ],
};

export const CHANNEL_BY_PLATFORM = { SHOPEE: "SHP", TIKTOK: "TTS" } as const;
const sellerKey = (storeId: string, channel: string) => `marketplace_seller:${storeId}:${channel}`;
const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, "");

export type Detected = {
  fileName: string;
  channel?: ChannelCode;
  kind?: FileKind;
  seller?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  /** sidik isi file; file identik (mis. unduhan "(1)", "(2)") dikenali dari sini */
  hash?: string;
  /** sudah pernah diunggah (isi identik) → dilewati, bukan galat */
  duplicate?: string;
  /** toko tujuan (dari slot yang dipilih, atau ditebak dari username penjual) */
  storeId?: string;
  /** cara toko ditentukan & tingkat yakin (USERNAME/PESANAN tinggi · MEREK sedang · SKU rendah) */
  via?: "USERNAME" | "PESANAN" | "MEREK" | "SKU" | "MANUAL";
  confidence?: "TINGGI" | "SEDANG" | "RENDAH";
  /** periode beririsan dengan impor sebelumnya (aman, tidak dobel) */
  overlap?: string;
  /** alasan toko ditentukan otomatis dari isi (mis. nomor pesanan sudah tercatat di toko itu) */
  reason?: string;
  /** toko belum bisa ditentukan otomatis (file tanpa nama toko): pengguna memilih toko sekali */
  needStore?: boolean;
  error?: string;
};

export const BRAND_KEY = "marketplace_brand_map";
const normBrand = (x: string) => x.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Merek per toko: bawaan nama toko; bisa diatur (Setting marketplace_brand_map = {storeId: ["MAIN GYPSUM", ...]}) */
export async function loadBrands(stores: { id: string; name: string }[]): Promise<Map<string, string[]>> {
  let saved: Record<string, string[]> = {};
  try { saved = JSON.parse((await prisma.setting.findUnique({ where: { key: BRAND_KEY } }))?.value ?? "{}"); } catch { saved = {}; }
  return new Map(stores.map((s) => [s.id, (saved[s.id]?.length ? saved[s.id] : [s.name]).map(normBrand).filter(Boolean)]));
}

type Inferred = { storeId?: string; via?: Detected["via"]; confidence?: Detected["confidence"]; reason?: string };
/**
 * Tebak toko dari ISI file tanpa nama toko. Urutan: (a) username tersimpan → (b) nomor pesanan yang sudah tercatat di toko
 * (TikTok income: ID pesanan) → (c) merek di nama produk (≥80% baris) → (d) SKU yang sudah dikenal di toko → (e) ragu: pilih manual.
 */
export async function inferStore(p: ParsedFile, channel: ChannelCode, stores: { id: string; name: string }[], sellers: Map<string, string>, brands: Map<string, string[]>): Promise<Inferred> {
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  // a) username
  const seller = p.info.seller ? norm(p.info.seller) : null;
  const hit = seller ? stores.filter((s) => sellers.get(sellerKey(s.id, channel)) === seller) : [];
  if (hit.length === 1) return { storeId: hit[0].id, via: "USERNAME", confidence: "TINGGI", reason: `username “${p.info.seller}” = ${hit[0].name}` };
  // b) nomor pesanan yang sudah tercatat
  const nos = (p.kind === "ORDER" ? p.orders.map((o) => o.orderNo) : p.incomes.filter((i) => i.kind === "ORDER").map((i) => i.refNo)).slice(0, 800);
  if (nos.length) {
    const found = await prisma.marketplaceOrder.groupBy({ by: ["storeId"], where: { channel, orderNo: { in: nos } }, _count: true });
    const total = found.reduce((a, f) => a + f._count, 0);
    const top = [...found].sort((a, b) => b._count - a._count)[0];
    if (top && top._count / total >= 0.8) return { storeId: top.storeId, via: "PESANAN", confidence: "TINGGI", reason: `${top._count} dari ${nos.length} nomor pesanan sudah tercatat di ${sn.get(top.storeId) ?? "toko itu"}` };
    if (found.length > 1) return { reason: `nomor pesanan ada di lebih dari satu toko (${found.map((f) => `${sn.get(f.storeId)}: ${f._count}`).join(", ")}) — pilih toko` };
  }
  // c) merek di nama produk
  if (p.kind === "ORDER") {
    const names = p.orders.flatMap((o) => o.lines.map((l) => normBrand(l.name ?? ""))).filter(Boolean);
    if (names.length) {
      const share = new Map<string, number>();
      for (const [id, bs] of brands) share.set(id, names.filter((n) => bs.some((b) => n === b || n.startsWith(`${b} `))).length / names.length);
      const best = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 0.8) return { storeId: best[0], via: "MEREK", confidence: best[1] >= 0.95 ? "TINGGI" : "SEDANG", reason: `${Math.round(best[1] * 100)}% nama produk berawalan merek “${brands.get(best[0])![0]}” (${sn.get(best[0])})` };
    }
    // d) SKU yang sudah dikenal di pesanan toko
    const keys = [...new Set(p.orders.flatMap((o) => o.lines.map((l) => lineKey(channel, l.sku, l.variation))))].slice(0, 400);
    if (keys.length) {
      const rows = await prisma.$queryRaw<{ storeId: string; n: bigint }[]>`SELECT o."storeId", COUNT(*) AS n FROM "MarketplaceOrderLine" l JOIN "MarketplaceOrder" o ON o."id" = l."orderId" WHERE o."channel" = ${channel} AND l."skuKey" = ANY(${keys}) GROUP BY o."storeId"`;
      if (rows.length === 1) return { storeId: rows[0].storeId, via: "SKU", confidence: "RENDAH", reason: `SKU di file ini sudah pernah muncul di pesanan ${sn.get(rows[0].storeId)} (tingkat yakin rendah — periksa)` };
    }
  }
  return { reason: "toko belum bisa ditentukan dari isi file — pilih toko" };
}

/**
 * Kenali jenis tiap file. `targets[i]` (opsional) = slot tujuan "storeId|channel|kind" bila file dijatuhkan ke slot tertentu:
 * jenis/kanal/penjual harus cocok, bila tidak ditolak dengan pesan jelas. Tanpa target → disortir otomatis.
 */
export async function detectFiles(items: { name: string; buf: Buffer; target?: string }[]): Promise<Detected[]> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true } });
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  const settings = await prisma.setting.findMany({ where: { key: { startsWith: "marketplace_seller:" } } });
  const sellers = new Map(settings.map((s) => [s.key, s.value]));
  const brands = await loadBrands(stores);
  const out: Detected[] = [];
  for (const it of items) {
    const d: Detected = { fileName: it.name, hash: createHash("sha1").update(it.buf).digest("hex") };
    const done = await prisma.marketplaceImport.findFirst({ where: { undoneAt: null, stats: { path: ["fileHash"], equals: d.hash } }, select: { fileName: true, createdAt: true } });
    if (done) d.duplicate = `Sudah diunggah (isi sama persis dengan “${done.fileName}”, ${dateStr(done.createdAt)}). Dilewati.`;
    try {
      const p = await parseMarketplaceFile(it.buf);
      d.channel = CHANNEL_BY_PLATFORM[p.platform];
      d.kind = p.kind;
      d.seller = p.info.seller;
      d.periodFrom = p.periodFrom ? dateStr(p.periodFrom) : null;
      d.periodTo = p.periodTo ? dateStr(p.periodTo) : null;
      const label = (c: ChannelCode, k: FileKind) => `${c === "SHP" ? "Shopee" : "TikTok"} · ${SLOTS[c].find((s) => s.key === k)?.label ?? k}`;
      const seller = p.info.seller ? norm(p.info.seller) : null;
      if (it.target) {
        const [storeId, ch, kind] = it.target.split("|") as [string, ChannelCode, FileKind];
        d.storeId = storeId;
        if (d.channel !== ch) d.error = `Ini file ${label(d.channel, d.kind)}, tapi slot ini untuk ${ch === "SHP" ? "Shopee" : "TikTok"}. Pindahkan ke kartu ${d.channel === "SHP" ? "Shopee" : "TikTok"}.`;
        else if (d.kind !== kind) d.error = `Ini file “${label(d.channel, d.kind)}”, bukan “${label(ch, kind)}”. Taruh di slot ${label(d.channel, d.kind)}.`;
        else if (seller) {
          const stored = sellers.get(sellerKey(storeId, ch));
          if (stored && stored !== seller) d.error = `Penjual di file (“${p.info.seller}”) berbeda dengan toko ${sn.get(storeId) ?? ""} (“${stored}”). Kemungkinan salah toko — taruh di kartu toko yang benar.`;
        }
      } else {
        const inf = await inferStore(p, d.channel, stores, sellers, brands);
        if (inf.storeId) { d.storeId = inf.storeId; d.via = inf.via; d.confidence = inf.confidence; d.reason = inf.reason; }
        else { d.needStore = true; d.reason = inf.reason; }
      }
      if (d.storeId && !d.error && d.kind && d.periodFrom && d.periodTo) {
        if (it.target) d.via ??= "MANUAL";
        const ov = await prisma.marketplaceImport.findFirst({ where: { storeId: d.storeId, channel: d.channel, kind: d.kind, undoneAt: null, periodFrom: { lte: new Date(`${d.periodTo}T00:00:00Z`) }, periodTo: { gte: new Date(`${d.periodFrom}T00:00:00Z`) } }, select: { fileName: true } });
        if (ov) d.overlap = `Periode beririsan dengan “${ov.fileName}” — aman, baris yang sama dilewati (tidak dobel)`;
      }
    } catch (e) {
      d.error = e instanceof FormatError ? e.message : "File tidak bisa dibaca. Pastikan ini file asli dari Seller Center.";
    }
    out.push(d);
  }
  return out;
}

export type SlotStatus = { lastAt: string | null; fileName: string | null; periodFrom: string | null; periodTo: string | null };

/** Impor terakhir (yang belum dibatalkan) per toko × kanal × jenis slot */
export async function slotStatus(): Promise<Record<string, SlotStatus>> {
  const rows = await prisma.marketplaceImport.findMany({ where: { undoneAt: null }, orderBy: { createdAt: "desc" }, take: 400 });
  const out: Record<string, SlotStatus> = {};
  for (const r of rows) {
    const k = `${r.storeId}|${r.channel}|${r.kind}`;
    if (out[k]) continue;
    out[k] = { lastAt: r.createdAt.toISOString(), fileName: r.fileName, periodFrom: r.periodFrom ? dateStr(r.periodFrom) : null, periodTo: r.periodTo ? dateStr(r.periodTo) : null };
  }
  return out;
}
