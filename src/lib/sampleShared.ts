/** Konstanta sample affiliator yang aman dipakai di komponen klien (tanpa database) */
export const SAMPLE_KEY = "_sample";
export const SAMPLE_PLATFORMS: Record<string, string> = { TIKTOK: "TikTok Shop", SHOPEE: "Shopee" };
export const isSampleTemplate = (t: string | null | undefined) => t === "PACKING" || t === "GIFTBOX";
export type SampleEntry = { itemId: string; qty: number; platform: string; storeId: string };

export type SampleRow = { itemId: string; qty: string; platform: string; storeId: string };

/** Baris tanpa produk dan tanpa jumlah dianggap kosong (platform/toko saja tidak dihitung): diabaikan, bukan error */
export function sampleRowEmpty(r: SampleRow) {
  const raw = (r.qty ?? "").trim().replace(/\./g, "").replace(",", ".");
  return !r.itemId && !(Number(raw) > 0);
}

/** Pesan untuk baris yang terisi sebagian (null = lengkap atau kosong). Dipakai form (di baris itu) dan server */
export function sampleRowIssue(r: SampleRow): string | null {
  if (sampleRowEmpty(r)) return null;
  const raw = (r.qty ?? "").trim().replace(/\./g, "").replace(",", ".");
  const qty = raw === "" ? 0 : Number(raw);
  if (!r.itemId) return "pilih produknya";
  if (!Number.isFinite(qty) || !(qty > 0) || !Number.isInteger(qty)) return "isi jumlah (bilangan bulat)";
  if (!SAMPLE_PLATFORMS[r.platform]) return "pilih platform (TikTok Shop / Shopee)";
  if (!r.storeId) return "pilih toko";
  return null;
}

