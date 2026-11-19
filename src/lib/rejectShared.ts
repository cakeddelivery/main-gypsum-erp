/** Konstanta reject produksi yang aman dipakai di komponen klien (tanpa akses database) */
export const REJECT_STAGES = ["CETAK", "OVEN", "ASSEMBLING", "GIFTBOX", "PACKING"] as const;
export type RejectStage = (typeof REJECT_STAGES)[number];
export const REJECT_STAGE_LABEL: Record<RejectStage, string> = { CETAK: "Cetak", OVEN: "Oven", ASSEMBLING: "Assembling", GIFTBOX: "Giftbox", PACKING: "Packing" };
export const REJECT_REASONS: Record<string, string> = { RETAK: "Retak", PECAH: "Pecah", GOSONG: "Gosong", CACAT_CAT: "Cacat cat", SALAH_CETAK: "Salah cetak", RUSAK_ALAT: "Rusak/cetakan rusak", LAINNYA: "Lainnya" };
/** Tahap reject menurut format laporan divisi (Produksi = Oven/panen; Cetak sendiri = Cetak) */
export const stageOfTemplate = (t: string | null | undefined): RejectStage | null =>
  t === "CETAK" ? "CETAK" : t === "PRODUKSI" ? "OVEN" : t === "ASSEMBLING" ? "ASSEMBLING" : t === "GIFTBOX" ? "GIFTBOX" : t === "PACKING" ? "PACKING" : null;
