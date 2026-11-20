import { createHash } from "node:crypto";
import type { ParsedIncome, ParsedOrder, Platform } from "./parse";

/** Aturan murni impor marketplace (tanpa database): normalisasi SKU, pemetaan status, sidik isi. */

export const CHANNEL_OF: Record<Platform, "SHP" | "TTS"> = { SHOPEE: "SHP", TIKTOK: "TTS" };
export const CHANNEL_LABEL: Record<string, string> = { SHP: "Shopee", TTS: "TikTok" };
export const platformOf = (ch: string): Platform => (ch === "SHP" ? "SHOPEE" : "TIKTOK");

/** Huruf besar, tanpa spasi, awalan toko "MG-"/"DL-" diabaikan: "12 MIX" = "12MIX" = "MG-12MIX" */
export const normSku = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "").replace(/^(MG|DL)-/, "");
export const normVar = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "");

/** Kunci pemetaan "SKU|VARIASI" (format sama dengan Retur). TikTok: Seller SKU sudah spesifik → variasi diabaikan. */
export function lineKey(channel: string, sku: string | null | undefined, variation: string | null | undefined) {
  return `${normSku(sku)}|${channel === "TTS" ? "" : normVar(variation)}`;
}

export type RawStatus = "PIUTANG" | "BATAL" | "RETUR";
/** Status dasar dari data platform. CAIR ditentukan terpisah (ada di file penghasilan). */
export function mapStatus(channel: string, o: Pick<ParsedOrder, "rawStatus" | "rawReturn" | "returnQty" | "refundAmount">): RawStatus {
  const st = (o.rawStatus ?? "").toLowerCase();
  const ret = (o.rawReturn ?? "").toLowerCase();
  if (/batal|cancel/.test(st)) return "BATAL";
  if (channel === "TTS" && ret === "cancel") return "BATAL";
  if (channel === "SHP" && /pengembalian sedang diproses|permintaan disetujui|pengembalian disetujui/.test(ret)) return "RETUR";
  if (channel === "TTS" && (ret === "return" || ret === "refund" || /return|refund|pengembalian/.test(ret))) return "RETUR";
  return "PIUTANG";
}

/** Status yang ditampilkan: Batal/Retur menang; lalu Cair bila ada di file penghasilan; selain itu Piutang */
export type ShownStatus = "PIUTANG" | "CAIR" | "DITARIK" | "BATAL" | "RETUR";
export const shownStatus = (status: string, hasIncome: boolean, withdrawn = false): ShownStatus => (status === "BATAL" ? "BATAL" : status === "RETUR" ? "RETUR" : hasIncome ? (withdrawn ? "DITARIK" : "CAIR") : "PIUTANG");
export const STATUS_LABEL: Record<ShownStatus, string> = { PIUTANG: "Piutang", CAIR: "Di saldo", DITARIK: "Ditarik", BATAL: "Batal", RETUR: "Retur" };

const sha = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 20);
const t = (d: Date | null | undefined) => d?.getTime() ?? null;

/** Sidik isi pesanan: sama = impor ulang identik (dilewati) */
export function orderSig(o: ParsedOrder, status: string) {
  return sha([status, o.rawStatus, o.rawSubstatus, o.rawReturn, o.cancelReason, o.trackingNo, o.shipOption, o.city, o.province, o.subtotal, o.discount, o.shippingPaid, o.total, o.refundAmount, o.returnQty, t(o.orderedAt), t(o.paidAt), t(o.completedAt), o.lines.map((l) => [l.sku, l.variation, l.qty, l.unitPrice, l.amount, l.returnQty])]);
}
export function incomeSig(i: ParsedIncome) {
  return sha([i.released, i.productAmt, i.refundAmt, i.fees, t(i.releasedAt), t(i.orderedAt), i.feeDetail]);
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Nama kota/kab seragam antar Shopee/TikTok: "KAB. BOGOR" = "Kabupaten Bogor" → "Kab. Bogor"; "Kota Administrasi Jakarta Timur" → "Kota Jakarta Timur". Nilai mentah tetap disimpan apa adanya. */
export function regionCity(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "-";
  const u = s.toUpperCase().replace(/\./g, ". ").replace(/\s+/g, " ").trim();
  const m = /^(KABUPATEN|KAB)\s+(.+)$/.exec(u);
  if (m) return `Kab. ${titleCase(m[2])}`;
  const k = /^(KOTA ADMINISTRASI|KOTA ADM\.?|KOTAMADYA|KOTA)\s+(.+)$/.exec(u);
  if (k) return `Kota ${titleCase(k[2])}`;
  return titleCase(u);
}
