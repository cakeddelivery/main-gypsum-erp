import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { dateStr } from "@/lib/time";
import { FormatError, parseMarketplaceFile, type FileKind } from "./parse";

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
  /** toko belum bisa ditentukan otomatis (file tanpa nama toko): pengguna memilih toko sekali */
  needStore?: boolean;
  error?: string;
};

/**
 * Kenali jenis tiap file. `targets[i]` (opsional) = slot tujuan "storeId|channel|kind" bila file dijatuhkan ke slot tertentu:
 * jenis/kanal/penjual harus cocok, bila tidak ditolak dengan pesan jelas. Tanpa target → disortir otomatis.
 */
export async function detectFiles(items: { name: string; buf: Buffer; target?: string }[]): Promise<Detected[]> {
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true } });
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  const settings = await prisma.setting.findMany({ where: { key: { startsWith: "marketplace_seller:" } } });
  const sellers = new Map(settings.map((s) => [s.key, s.value]));
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
      } else if (seller) {
        const hit = stores.filter((s) => sellers.get(sellerKey(s.id, d.channel!)) === seller);
        if (hit.length === 1) d.storeId = hit[0].id;
        else d.needStore = true; // username baru: pilih toko sekali; username diingat saat impor pertama
      } else {
        d.needStore = true; // file pesanan / TikTok tidak memuat nama toko
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
