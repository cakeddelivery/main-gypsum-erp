import type { ReportTemplate } from "./shiftReport";

/** Lembar panduan per jenis laporan divisi (satu lembar A4 per divisi) */
export type GuideKind = "cetak" | "produksi" | "giftbox" | "packing" | "assembling";

export type Guide = {
  kind: GuideKind;
  /** Nama divisi di judul lembar */
  name: string;
  template: ReportTemplate;
  /** Isi tahap "Hasil kerja" di form laporan (kosong = divisi tanpa tahap hasil kerja) */
  hasil: string[];
  /** Divisi penerima hasil borongan (tombol "+ Penerimaan borongan") */
  terima: boolean;
  /** Catatan khusus divisi */
  catatan?: string;
};

export const GUIDES: Record<GuideKind, Guide> = {
  cetak: {
    kind: "cetak",
    name: "Cetak",
    template: "CETAK",
    hasil: ["Hasil cetak per karyawan: pilih nama, isi jumlah per series (Hewan, Cowok, Transportasi, Cewek)."],
    terima: false,
  },
  produksi: {
    kind: "produksi",
    name: "Produksi (Oven)",
    template: "PRODUKSI",
    hasil: ["Hasil panen per oven (Oven Besar, Oven Kecil) per series.", "Reject panen + pilih alasan reject (bila ada).", "Hasil cetak per karyawan (bila divisi ikut mencetak)."],
    terima: false,
  },
  giftbox: {
    kind: "giftbox",
    name: "Giftbox",
    template: "GIFTBOX",
    hasil: ["Resi: jumlah Shopee & Tiktok.", "Giftbox: jumlah box per jenis (Reguler, Bonus Palet, dll.).", "Jumlah patung dihitung otomatis."],
    terima: true,
  },
  packing: {
    kind: "packing",
    name: "Packing",
    template: "PACKING",
    hasil: ["Resi: jumlah Shopee & Tiktok.", "Patung mix (paket): jumlah paket per isi & series.", "Patung satuan: jumlah per series."],
    terima: false,
  },
  assembling: {
    kind: "assembling",
    name: "Assembling",
    template: "ASSEMBLING",
    hasil: [],
    terima: true,
    catatan: "Assembling tidak mengisi hasil kerja di form: hasil borongan dicatat lewat + Penerimaan borongan dan tampil otomatis di laporan.",
  },
};

export const GUIDE_LIST: Guide[] = Object.values(GUIDES);

const BY_TEMPLATE = Object.fromEntries(GUIDE_LIST.map((g) => [g.template, g.kind])) as Partial<Record<ReportTemplate, GuideKind>>;

/** Panduan yang cocok untuk format laporan divisi (null bila divisi tanpa format laporan) */
export function guideForTemplate(template: string | null | undefined): GuideKind | null {
  return (template && BY_TEMPLATE[template as ReportTemplate]) || null;
}

export function isGuideKind(v: unknown): v is GuideKind {
  return typeof v === "string" && v in GUIDES;
}

/** Tahap form laporan untuk divisi ini (urutan sama dengan form di aplikasi) */
export function reportSteps(g: Guide): string[] {
  return [...(g.hasil.length ? ["Hasil kerja"] : []), "Checklist", "Stok jadi", "Stok akhir", "Catatan & kirim"];
}
