/** Pilihan penyebab reject produksi (dipakai form produksi & laporan reject) */
export const REJECT_REASONS = ["Pecah / retak", "Gelembung / bolong", "Cacat cetak", "Cat tidak rapi", "Kotor / noda", "Lainnya"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
