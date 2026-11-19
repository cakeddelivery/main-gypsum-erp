/** Konstanta sample affiliator yang aman dipakai di komponen klien (tanpa database) */
export const SAMPLE_KEY = "_sample";
export const SAMPLE_SOURCES: Record<string, string> = { TIKTOK: "TikTok (order sample Rp0)", SHOPEE: "Shopee (order sample Rp0)", OFFLINE: "Offline (dikirim langsung)" };
export const SAMPLE_TEMPLATES = ["PACKING", "GIFTBOX"] as const;
export const isSampleTemplate = (t: string | null | undefined) => t === "PACKING" || t === "GIFTBOX";
export type SampleEntry = { itemId: string; qty: number; source: string; affiliator: string; trackingNo?: string | null; note?: string | null };
