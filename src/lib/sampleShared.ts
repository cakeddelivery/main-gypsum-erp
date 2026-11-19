/** Konstanta sample affiliator yang aman dipakai di komponen klien (tanpa database) */
export const SAMPLE_KEY = "_sample";
export const SAMPLE_PLATFORMS: Record<string, string> = { TIKTOK: "TikTok Shop", SHOPEE: "Shopee" };
export const isSampleTemplate = (t: string | null | undefined) => t === "PACKING" || t === "GIFTBOX";
export type SampleEntry = { itemId: string; qty: number; platform: string; storeId: string };
