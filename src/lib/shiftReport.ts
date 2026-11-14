import { REJECT_REASONS } from "./reject";
/**
 * Format Laporan Penutup Shift per divisi (Produksi, Giftbox, Packing, Assembling).
 * Modul murni (tanpa akses database) agar bisa dipakai di server, komponen klien, seed, dan skrip.
 */

export type ReportTemplate = "PRODUKSI" | "CETAK" | "GIFTBOX" | "PACKING" | "ASSEMBLING";
export const REPORT_TEMPLATES: ReportTemplate[] = ["PRODUKSI", "CETAK", "GIFTBOX", "PACKING", "ASSEMBLING"];

/** Tabel angka: baris (oven / nama orang) × kolom (varian) */
export type GridSection = {
  kind: "grid";
  key: string;
  title: string;
  /** Baris tetap, atau "people" = nama orang (diisi dari karyawan divisi, bisa ditambah) */
  rows: string[] | "people";
  cols: string[];
  totalLabel: string;
  /** Tampilkan baris TOTAL per kolom (mis. assembling) */
  colTotals?: boolean;
  /** Bagian lama: hanya tampil di laporan lama yang sudah terisi (tidak diisi lagi di form) */
  legacy?: boolean;
};
/** Daftar hitungan; mult = pengali ke pcs (mis. paket isi 12) */
export type CountSection = {
  kind: "count";
  key: string;
  title: string;
  fields: { key: string; label: string; formLabel?: string; mult?: number }[];
  totalLabel: string;
  /** Satuan total (default pcs) */
  unit?: string;
  /** Isian lama yang diganti bagian katalog `replacedBy`: hanya tampil di laporan lama yang terisi, atau bila katalog belum ada */
  replacedBy?: string;
};
/**
 * Isian mengikuti katalog produk induk di ERP (Produk & HPP → Produk Induk), tabel baris × kolom (kolom = Series).
 * Disimpan sebagai salinan baris (SKU, label, karakter, jumlah patung) agar laporan lama tetap terbaca walau katalog berubah.
 * total = "qty" (jumlah box/paket) atau "patung" (qty × jumlah patung per SKU)
 */
export type CatalogSection = { kind: "catalog"; key: string; title: string; family: string; totalLabel: string; unit: string; total: "qty" | "patung"; qtyLabel: string };
/** Hitungan otomatis dari bagian lain × faktor (mis. 1 giftbox = 5 patung) */
export type DerivedSection = { kind: "derived"; key: string; title: string; from: string | string[]; factor: number; totalLabel: string };
/** Satu pilihan teks (mis. alasan reject); hanya ditampilkan bila `showIf` (bagian lain) berisi angka > 0 */
export type ChoiceSection = { kind: "choice"; key: string; title: string; options: readonly string[]; showIf?: string };
export type Section = GridSection | CountSection | DerivedSection | ChoiceSection | CatalogSection;

export type TemplateDef = {
  label: string;
  heading: string;
  sections: Section[];
  /** Ringkasan di bawah judul laporan: label + bagian yang dijumlah; ifFilled = hanya tampil bila ada angka yang diisi */
  summary: { label: string; sections: string[]; unit?: string; ifFilled?: boolean }[];
  /** Angka yang dibandingkan dengan target per shift divisi */
  target: { label: string; sections: string[]; unit: string };
};

export const VARIANTS: string[] = ["Hewan", "Cowok", "Transportasi", "Cewek"];
/** Bagian laporan Packing yang dijumlah sebagai total patung (isian lama + isian katalog) */
const PACKING_PATUNG = ["mix", "satuan", "pk", "st"];
const GIFTBOX_CODES = ["MIX", "CEW", "CWO", "HWN", "TRN", "MIX-PLT", "CEW-PLT", "CWO-PLT", "HWN-PLT", "TRN-PLT"];

export const TEMPLATES: Record<ReportTemplate, TemplateDef> = {
  PRODUKSI: {
    label: "Produksi",
    heading: "",
    sections: [
      { kind: "grid", key: "panen", title: "Hasil panen", rows: ["Oven Besar", "Oven Kecil"], cols: VARIANTS, totalLabel: "Total panen" },
      { kind: "grid", key: "reject", title: "Reject panen", rows: ["Oven Besar", "Oven Kecil"], cols: VARIANTS, totalLabel: "Total reject" },
      { kind: "choice", key: "rejectReason", title: "Alasan reject", options: REJECT_REASONS, showIf: "reject" },
      // Hasil cetak per karyawan per series (baris = karyawan yang absen hadir di divisi & shift ini, bisa ditambah)
      { kind: "grid", key: "cetakSeries", title: "Hasil cetak per karyawan", rows: "people", cols: VARIANTS, totalLabel: "Total hasil cetak", colTotals: true },
      { kind: "grid", key: "cetak", title: "Hasil cetak (format lama)", rows: "people", cols: ["pcs"], totalLabel: "Total hasil cetak", legacy: true },
    ],
    summary: [{ label: "Total panen", sections: ["panen"] }, { label: "Total reject", sections: ["reject"], ifFilled: true }, { label: "Total hasil cetak", sections: ["cetakSeries", "cetak"] }],
    target: { label: "panen", sections: ["panen"], unit: "pcs" },
  },
  // Divisi Cetak (terpisah dari Oven): hasil cetak per karyawan per series → stok patung cetak (basah)
  CETAK: {
    label: "Cetak",
    heading: "",
    sections: [{ kind: "grid", key: "cetakSeries", title: "Hasil cetak per karyawan", rows: "people", cols: VARIANTS, totalLabel: "Total hasil cetak", colTotals: true }],
    summary: [{ label: "Total hasil cetak", sections: ["cetakSeries"] }],
    target: { label: "hasil cetak", sections: ["cetakSeries"], unit: "pcs" },
  },
  GIFTBOX: {
    label: "Giftbox",
    heading: "Hasil giftbox",
    sections: [
      { kind: "count", key: "resi", title: "Resi", fields: [{ key: "shopee", label: "Shopee" }, { key: "tiktok", label: "Tiktok" }], totalLabel: "Total resi", unit: "resi" },
      { kind: "count", key: "giftbox", title: "Giftbox", fields: GIFTBOX_CODES.map((c) => ({ key: c, label: c })), totalLabel: "Total giftbox", unit: "box", replacedBy: "gb" },
      { kind: "catalog", key: "gb", title: "Giftbox", family: "Giftbox", totalLabel: "Total giftbox", unit: "box", total: "qty", qtyLabel: "box" },
      { kind: "derived", key: "patung", title: "Patung", from: ["giftbox", "gb"], factor: 5, totalLabel: "Total patung" },
    ],
    summary: [{ label: "Total resi", sections: ["resi"], unit: "", ifFilled: true }, { label: "Total giftbox", sections: ["giftbox", "gb"], unit: "box" }, { label: "Total patung", sections: ["patung"] }],
    target: { label: "giftbox", sections: ["giftbox", "gb"], unit: "box" },
  },
  PACKING: {
    label: "Packing",
    heading: "Hasil packing",
    sections: [
      { kind: "count", key: "resi", title: "Resi", fields: [{ key: "shopee", label: "Shopee" }, { key: "tiktok", label: "Tiktok" }], totalLabel: "Total resi", unit: "resi" },
      {
        kind: "count",
        key: "mix",
        title: "Patung mix",
        fields: [12, 24, 48, 96].map((n) => ({ key: `p${n}`, label: String(n), formLabel: `Paket isi ${n}`, mult: n })),
        totalLabel: "Total patung mix",
        replacedBy: "pk",
      },
      { kind: "count", key: "satuan", title: "Patung satuan", fields: ["Cowok", "Cewek", "Transportasi", "Hewan"].map((v) => ({ key: v.toLowerCase(), label: v })), totalLabel: "Total patung satuan", replacedBy: "st" },
      { kind: "catalog", key: "pk", title: "Patung mix (paket)", family: "Paket Single Pack", totalLabel: "Total patung mix", unit: "pcs", total: "patung", qtyLabel: "paket" },
      { kind: "catalog", key: "st", title: "Patung satuan", family: "Satuan Single Pack", totalLabel: "Total patung satuan", unit: "pcs", total: "patung", qtyLabel: "pcs" },
    ],
    summary: [{ label: "Total resi", sections: ["resi"], unit: "" }, { label: "Total patung", sections: PACKING_PATUNG }],
    target: { label: "patung", sections: PACKING_PATUNG, unit: "pcs" },
  },
  // Assembling tidak berproduksi di workshop (dikerjakan borongan BMR/Mastrip): laporannya = setoran borongan (dari menu
  // Borongan) + stok akhir bahan baku + stok akhir produk jadi per karakter. "Produk jadi per orang" hanya untuk laporan lama.
  ASSEMBLING: {
    label: "Assembling",
    heading: "",
    sections: [{ kind: "grid", key: "jadi", title: "Produk jadi per orang (format lama)", rows: "people", cols: VARIANTS, totalLabel: "Total produk jadi", colTotals: true, legacy: true }],
    summary: [{ label: "Total produk jadi", sections: ["jadi"], ifFilled: true }],
    target: { label: "produk jadi", sections: ["jadi"], unit: "pcs" },
  },
};

export function isTemplate(v: unknown): v is ReportTemplate {
  return typeof v === "string" && (REPORT_TEMPLATES as string[]).includes(v);
}

// ---------------- Data hasil kerja ----------------

export type GridRow = { name: string; v: (number | null)[] };
/** work[sectionKey] = GridRow[] (grid), { fieldKey: angka } (count), atau teks (choice) */
type WorkDataBase = Record<string, GridRow[] | CatalogLine[] | Record<string, number | null> | string>;

const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Satu baris isian katalog (salinan data SKU saat laporan disimpan) */
export type CatalogLine = { productId: string; sku: string; label: string; col: string; variant: string; patung: number; qty: number };
export type WorkData = WorkDataBase;

export function catalogLines(work: WorkData, key: string): CatalogLine[] {
  const v = work[key];
  return Array.isArray(v) ? (v as unknown as CatalogLine[]).filter((l) => l && typeof l.productId === "string" && n(l.qty) > 0) : [];
}

export function gridRows(work: WorkData, s: GridSection): GridRow[] {
  const raw = Array.isArray(work[s.key]) ? (work[s.key] as GridRow[]).filter((r) => r && Array.isArray(r.v)) : [];
  if (s.rows === "people") return raw.filter((r) => r.name?.trim());
  return s.rows.map((name) => raw.find((r) => r.name === name) ?? { name, v: [] });
}

export function countValues(work: WorkData, key: string): Record<string, number | null> {
  const v = work[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function rowTotal(r: GridRow) {
  return r.v.reduce<number>((a, b) => a + n(b), 0);
}

export function colTotals(rows: GridRow[], cols: number) {
  return Array.from({ length: cols }, (_, i) => rows.reduce((a, r) => a + n(r.v[i]), 0));
}

/**
 * Nilai per field sebuah count/derived/catalog section (derived = sumber × faktor; sumber katalog = qty × patung per SKU).
 * Katalog: value = jumlah yang diisi (box/paket/pcs), pcs = angka yang dijumlah (qty atau patung, sesuai `total`).
 */
export function sectionFieldValues(t: TemplateDef, work: WorkData, s: CountSection | DerivedSection | CatalogSection): { label: string; value: number | null; pcs: number }[] {
  if (s.kind === "count") {
    const v = countValues(work, s.key);
    return s.fields.map((f) => ({ label: f.label, value: v[f.key] ?? null, pcs: n(v[f.key]) * (f.mult ?? 1) }));
  }
  if (s.kind === "catalog") return catalogLines(work, s.key).map((l) => ({ label: l.label, value: l.qty, pcs: s.total === "patung" ? l.qty * Math.max(1, n(l.patung)) : l.qty }));
  return (Array.isArray(s.from) ? s.from : [s.from]).flatMap((key) => {
    const src = t.sections.find((x) => x.key === key);
    if (src?.kind === "catalog") return catalogLines(work, src.key).map((l) => ({ label: l.label, value: l.qty * Math.max(1, n(l.patung)), pcs: l.qty * Math.max(1, n(l.patung)) }));
    if (!src || src.kind !== "count") return [];
    const v = countValues(work, src.key);
    // Isian lama yang sudah diganti katalog hanya ikut bila terisi
    if (src.replacedBy && !src.fields.some((f) => v[f.key] != null)) return [];
    return src.fields.map((f) => {
      const raw = v[f.key];
      const val = raw == null ? null : n(raw) * s.factor;
      return { label: f.label, value: val, pcs: n(val) };
    });
  });
}

export function sectionTotal(t: TemplateDef, work: WorkData, key: string): number {
  const s = t.sections.find((x) => x.key === key);
  if (!s || s.kind === "choice") return 0;
  if (s.kind === "grid") return gridRows(work, s).reduce((a, r) => a + rowTotal(r), 0);
  return sectionFieldValues(t, work, s).reduce((a, f) => a + f.pcs, 0);
}

/** Ada angka yang diisi (bukan kosong) di bagian ini */
export function sectionFilled(t: TemplateDef, work: WorkData, key: string): boolean {
  const s = t.sections.find((x) => x.key === key);
  if (!s) return false;
  if (s.kind === "choice") return typeof work[s.key] === "string" && !!work[s.key];
  if (s.kind === "grid") return gridRows(work, s).some((r) => r.v.some((v) => v != null));
  return sectionFieldValues(t, work, s).some((f) => f.value != null);
}

/** Teks pilihan (mis. alasan reject); kosong bila bagian syaratnya tidak berisi angka */
export function choiceValue(t: TemplateDef, work: WorkData, s: ChoiceSection): string | null {
  const v = work[s.key];
  if (typeof v !== "string" || !v) return null;
  if (s.showIf && sectionTotal(t, work, s.showIf) <= 0) return null;
  return v;
}

/** Capaian target per shift: angka hasil vs target divisi (null bila divisi tanpa target) */
export function targetOf(template: ReportTemplate, work: WorkData, target: number | null | undefined) {
  if (!target || target <= 0) return null;
  const t = TEMPLATES[template];
  const value = t.target.sections.reduce((a, k) => a + sectionTotal(t, work, k), 0);
  return { label: t.target.label, unit: t.target.unit, target, value, pct: Math.round((value / target) * 100), reached: value >= target };
}

/** Teks satu baris capaian target, mis. "Target panen 2.400 pcs · tercapai 2.300 (96%) ⚠ di bawah target" */
export function targetLine(x: NonNullable<ReturnType<typeof targetOf>>) {
  const f = (v: number) => v.toLocaleString("id-ID");
  return `Target ${x.label} ${f(x.target)} ${x.unit} · hasil ${f(x.value)} (${x.pct}%)${x.reached ? " ✓" : " ⚠ di bawah target"}`;
}

export function summaryOf(template: ReportTemplate, work: WorkData) {
  const t = TEMPLATES[template];
  return t.summary
    .filter((s) => !s.ifFilled || s.sections.some((k) => sectionFilled(t, work, k)))
    .map((s) => ({ label: s.label, unit: s.unit ?? "pcs", value: s.sections.reduce((a, k) => a + sectionTotal(t, work, k), 0) }));
}

const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("id-ID"));

/** Baris teks detail hasil kerja (untuk tampilan laporan & pesan Telegram) */
export function workLines(template: ReportTemplate, work: WorkData): string[] {
  const t = TEMPLATES[template];
  const out: string[] = [];
  if (t.heading) out.push(t.heading.toUpperCase());
  for (const s of t.sections) {
    if (s.kind === "choice") {
      const v = choiceValue(t, work, s);
      if (v) out.push(`${s.title.toUpperCase()}: ${v}`);
      continue;
    }
    if (s.kind === "grid") {
      // Bagian opsional (mis. reject) / format lama yang tidak diisi tidak ditampilkan
      if ((s.key === "reject" || s.legacy) && !sectionFilled(t, work, s.key)) continue;
      if (!t.heading) out.push(s.title.toUpperCase());
      const rows = gridRows(work, s);
      for (const r of rows) {
        if (s.cols.length === 1) out.push(`${r.name}: ${fmt(r.v[0] ?? null)} pcs`);
        else out.push(`${r.name}: ${s.cols.map((c, i) => `${c} ${fmt(r.v[i] ?? null)}`).join(" · ")}${s.colTotals ? "" : ` · TOTAL ${fmt(rowTotal(r))} pcs`}`);
      }
      if (s.colTotals) out.push(`TOTAL: ${colTotals(rows, s.cols.length).map((v, i) => `${s.cols[i]} ${fmt(v)}`).join(" · ")}`);
      out.push(`${s.totalLabel.toUpperCase()}: ${fmt(sectionTotal(t, work, s.key))} pcs`);
    } else {
      if (s.kind === "count" && s.replacedBy && !sectionFilled(t, work, s.key)) continue;
      const vals = sectionFieldValues(t, work, s);
      if (s.kind === "catalog") {
        const per = s.total === "patung" ? (l: (typeof vals)[number]) => `${l.label} ${fmt(l.value)} ${s.qtyLabel}${l.pcs !== l.value ? ` (${fmt(l.pcs)} patung)` : ""}` : (l: (typeof vals)[number]) => `${l.label} ${fmt(l.value)}`;
        out.push(`${s.title.toUpperCase()}: ${vals.length ? vals.map(per).join(" · ") : "—"} · TOTAL ${fmt(sectionTotal(t, work, s.key))} ${s.unit}`);
        continue;
      }
      out.push(`${s.title.toUpperCase()}: ${vals.map((f) => `${f.label} ${fmt(f.value)}`).join(" · ")} · TOTAL ${fmt(sectionTotal(t, work, s.key))}`);
    }
  }
  if (template === "PACKING") out.push(`TOTAL PATUNG: ${fmt(PACKING_PATUNG.reduce((a, k) => a + sectionTotal(t, work, k), 0))} pcs`);
  return out;
}

/** Katalog SKU per bagian katalog (diambil dari DB oleh pemanggil, lihat reportCatalogs di productFamily.ts) */
export type CatalogCellView = { productId: string; sku: string; name: string; patung: number; variant: string };
export type CatalogGridView = { family: string; cols: string[]; rows: { label: string; cells: (CatalogCellView | null)[] }[] };
export type ReportCatalogs = Record<string, CatalogGridView | null>;

/**
 * Baca hasil kerja dari FormData: grid "w.<section>.<row>.name" & "w.<section>.<row>.<col>", count "w.<section>.<field>",
 * katalog "w.<section>.<productId>" (hanya SKU yang ada di katalog `catalogs`)
 */
export function parseWork(template: ReportTemplate, get: (k: string) => string | null, catalogs: ReportCatalogs = {}): WorkData {
  const t = TEMPLATES[template];
  const num = (k: string) => {
    const s = (get(k) ?? "").trim().replace(/\./g, "").replace(/,/g, ".");
    if (!s) return null;
    const x = Number(s);
    if (!Number.isFinite(x) || x < 0) throw new Error("Angka hasil kerja tidak valid");
    return Math.round(x);
  };
  const work: WorkData = {};
  for (const s of t.sections) {
    if (s.kind === "grid") {
      const rows: GridRow[] = [];
      const count = s.rows === "people" ? Math.min(Number(get(`w.${s.key}.n`) ?? 0) || 0, 50) : s.rows.length;
      for (let i = 0; i < count; i++) {
        const name = s.rows === "people" ? (get(`w.${s.key}.${i}.name`) ?? "").trim().slice(0, 60) : s.rows[i];
        if (!name) continue;
        rows.push({ name, v: s.cols.map((_, c) => num(`w.${s.key}.${i}.${c}`)) });
      }
      work[s.key] = rows;
    } else if (s.kind === "count") {
      work[s.key] = Object.fromEntries(s.fields.map((f) => [f.key, num(`w.${s.key}.${f.key}`)]));
    } else if (s.kind === "catalog") {
      const g = catalogs[s.key];
      const lines: CatalogLine[] = [];
      for (const r of g?.rows ?? []) {
        r.cells.forEach((c, ci) => {
          if (!c) return;
          const qty = num(`w.${s.key}.${c.productId}`);
          if (qty) lines.push({ productId: c.productId, sku: c.sku, label: [r.label, g!.cols[ci]].filter(Boolean).join(" · "), col: g!.cols[ci], variant: c.variant, patung: c.patung, qty });
        });
      }
      work[s.key] = lines;
    } else if (s.kind === "choice") {
      const v = (get(`w.${s.key}`) ?? "").trim();
      if (v) {
        if (!s.options.includes(v)) throw new Error(`${s.title} tidak valid`);
        work[s.key] = v;
      }
    }
  }
  return work;
}

// ---------------- Waktu shift & kelengkapan laporan ----------------

/**
 * Waktu stok akhir shift (WIB): tanggal laporan + jam selesai shift. Shift yang melewati tengah malam selesai esok hari.
 * Tidak pernah di masa depan (laporan yang dikirim sebelum jam selesai memakai waktu kirim).
 */
export function shiftEndAt(date: Date, shift: { startTime: string; endTime: string }, now: Date = new Date()): Date {
  const hm = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(s ?? "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = hm(shift.startTime);
  const end = hm(shift.endTime) ?? 24 * 60 - 1;
  const day = date.toISOString().slice(0, 10);
  const nextDay = start != null && end <= start;
  // WIB = UTC+7
  const at = new Date(Date.parse(`${day}T00:00:00.000Z`) + (nextDay ? 86_400_000 : 0) + (end - 7 * 60) * 60_000);
  return at > now ? now : at;
}

/** Jumlah laporan shift yang seharusnya ada per hari: tiap divisi berformat laporan × jumlah shift-nya */
export function expectedReportCount(divisions: { shiftCount: number }[], activeShifts: number): number {
  return divisions.reduce((a, d) => a + Math.min(Math.max(1, d.shiftCount), Math.max(0, activeShifts)), 0);
}

// ---------------- Checklist & stok ----------------

export type ChecklistTask = { label: string; photo: boolean };
export type ChecklistEntry = ChecklistTask & { done: boolean; photoPath?: string | null };
/** rcpt = id barang masuk yang sudah diperhitungkan saat hitungan ini diterapkan (hanya di snapshot stockAppliedCount) */
export type StockCountRow = { itemId: string; name: string; unit: string; limit: number; qty: number | null; rcpt?: string[] };

/** Bahan perlu diorder bila stok akhir ≤ limit */
export function needsOrder(r: { qty: number | null; limit: number }) {
  return r.qty != null && r.qty <= r.limit;
}

/** Tugas dianggap selesai bila dicentang; tugas wajib foto selesai bila fotonya ada */
export function isDone(c: ChecklistEntry) {
  return c.photo ? !!c.photoPath : c.done;
}

/** Checklist laporan baru dari checklist divisi (format lama berupa string juga diterima) */
export function toEntries(tasks: unknown): ChecklistEntry[] {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((t) => (typeof t === "string" ? { label: t, photo: false } : (t as Partial<ChecklistEntry>)))
    .filter((t) => typeof t.label === "string" && t.label.trim())
    .map((t) => ({ label: t.label!.trim(), photo: !!t.photo, done: !!t.done, photoPath: t.photoPath ?? null }));
}

// ---------------- Data awal dari contoh laporan ----------------

type Mat = [name: string, unit: string, limit: number];
export type DivisionSetup = { code: string; name: string; shiftCount: number; checklist: ChecklistTask[]; materials: Mat[] };

const photo = (label: string): ChecklistTask => ({ label, photo: true });
const plain = (label: string): ChecklistTask => ({ label, photo: false });

export const DIVISION_SETUP: Record<ReportTemplate, DivisionSetup> = {
  CETAK: {
    code: "CTK",
    name: "Cetak",
    shiftCount: 2,
    checklist: ["Area cetak bersih", "Cetakan dicuci & ditata", "Lantai sudah dipel", "Patung cetak tertata di rak"].map(photo),
    materials: [],
  },
  PRODUKSI: {
    code: "PRD",
    name: "Produksi",
    shiftCount: 2,
    checklist: ["Area cetak bersih", "Area oven bersih", "Area stok patung kering bersih", "Lantai sudah dipel", "Oven berfungsi selama jam operasional", "Serah terima oven sudah dilakukan", "Stok LPG sudah diperiksa"].map(photo),
    materials: [
      ["Bubuk gypsum", "sak", 15],
      ["Keranjang patung", "pcs", 700],
      ["Cetakan hewan", "pcs", 100],
      ["Cetakan transportasi", "pcs", 100],
      ["Cetakan cewek", "pcs", 100],
      ["Cetakan cowok", "pcs", 100],
    ],
  },
  GIFTBOX: {
    code: "GFT",
    name: "Giftbox",
    shiftCount: 1,
    checklist: [
      ...["Area kerja bersih", "Lantai sudah dipel", "Bahan tersusun rapi"].map(photo),
      ...["Jumlah pesanan sesuai resi", "Varian sesuai pesanan", "Catatan pelanggan sudah diperiksa", "Tidak ada resi yang terlewat"].map(plain),
    ],
    materials: [
      ["Cat Giftbox", "pcs", 300],
      ["Kuas lancip", "pcs", 1000],
      ["Dus giftbox 16x16x5", "pcs", 1500],
      ["Pallet cat", "pcs", 500],
      ["Color guide", "pcs", 1500],
      ["Sabuk label giftbox", "pcs", 1500],
      ["Bubblewrap putih", "roll", 2],
      ["Solasi kecil", "pcs", 2],
      ["Double tape", "pcs", 5],
    ],
  },
  PACKING: {
    code: "PCK",
    name: "Packing",
    shiftCount: 1,
    checklist: [
      ...["Area packing bersih", "Lantai sudah dipel", "Alat dan bahan tersusun rapi"].map(photo),
      ...["Jumlah produk sesuai", "Varian sesuai", "Catatan pelanggan sudah diperiksa", "Tidak ada salah kirim", "Tidak ada kekurangan jumlah", "Seluruh resi selesai di hari yang sama", "Stok dus sudah diperiksa"].map(plain),
    ],
    materials: [
      ["Dus 12", "pcs", 1000],
      ["Dus 24", "pcs", 1000],
      ["Bubblewrap hitam", "roll", 30],
      ["Solasi bening", "pcs", 24],
      ["Solasi fragile", "pcs", 12],
      ["Plastik wrap", "roll", 5],
      ["Label termal 100 x 150 (Besar)", "roll", 3],
      ["Label thermal 78 x 100 (Kecil)", "roll", 5],
    ],
  },
  ASSEMBLING: {
    code: "ASM",
    name: "Assembling",
    shiftCount: 1,
    checklist: ["Area assembling bersih", "Area stok bahan bersih", "Area stok patung bersih", "Lantai sudah dipel", "Alat dan bahan tersusun rapi", "Supply assembling luar"].map(photo),
    materials: [
      ["Background cowok", "gendel", 20],
      ["Background cewek", "gendel", 20],
      ["Background hewan", "gendel", 20],
      ["Background transportasi", "gendel", 20],
      ["Klip cowok", "gendel", 20],
      ["Klip cewek", "gendel", 20],
      ["Klip hewan", "gendel", 20],
      ["Klip transportasi", "gendel", 20],
      ["Plastik OPP", "pack", 80],
      ["Piring plastik", "boks", 18],
      ["Cotton bud", "boks", 3],
      ["Isi staples", "pack", 30],
      ["Staples", "pcs", 2],
      ["Kresek putih sedang", "pack / ikat", 1],
      ["Kresek putih besar", "pack / ikat", 1],
      ["Plastik klip 2x3", "boks", 70],
      ["Tisu", "pcs", 10],
      ["Botol cat", "pcs", 1],
      ["Pompa cat", "pcs", 1],
      ["Cat putih", "kg", 5],
      ["Cat hitam", "kg", 5],
      ["Cat merah", "kg", 5],
      ["Cat kuning", "kg", 5],
      ["Cat biru", "kg", 5],
    ],
  },
};

// ---------------- Hasil kerja → stok (setengah jadi / barang jadi) ----------------

/**
 * Langkah stok dari hasil kerja laporan:
 * - kering = patung kering polos per varian (setengah jadi), jadi = produk jadi satuan per varian, giftbox = giftbox per kode
 * - dir "in" = masuk stok, "out" = keluar stok
 */
export type FlowStep = { kind: "basah" | "kering" | "jadi" | "giftbox" | "produk"; key: string; qty: number; dir: "in" | "out"; label?: string };

/** Isi patung per giftbox */
export const GIFTBOX_PATUNG = 5;
const GIFTBOX_VARIANT: Record<string, string | null> = { MIX: null, CEW: "Cewek", CWO: "Cowok", HWN: "Hewan", TRN: "Transportasi" };
/** Varian produk (enum) → nama karakter patung; MIX = null (dibagi rata) */
const VARIANT_OF: Record<string, string | null> = { MIX: null, CEWEK: "Cewek", COWOK: "Cowok", HEWAN: "Hewan", TRANSPORTASI: "Transportasi" };

/** Bagi rata ke 4 varian; sisa pembagian diberikan berurutan Hewan, Cowok, Transportasi, Cewek */
export function splitEven(total: number): Record<string, number> {
  const base = Math.floor(total / VARIANTS.length);
  const rest = total - base * VARIANTS.length;
  return Object.fromEntries(VARIANTS.map((v, i) => [v, base + (i < rest ? 1 : 0)]));
}

export function plannedFlow(template: ReportTemplate, work: WorkData): FlowStep[] {
  const t = TEMPLATES[template];
  const acc = new Map<string, FlowStep>();
  const add = (kind: FlowStep["kind"], key: string, qty: number, dir: FlowStep["dir"], label?: string) => {
    if (!(qty > 0)) return;
    const k = `${kind}|${key}|${dir}`;
    const cur = acc.get(k);
    if (cur) cur.qty += qty;
    else acc.set(k, { kind, key, qty, dir, ...(label ? { label } : {}) });
  };
  /** Patung keluar per karakter: Mix dibagi rata ke 4 karakter */
  const byVariant = (variant: string, total: number, emit: (v: string, q: number) => void) => {
    const v = VARIANT_OF[variant];
    if (v) emit(v, total);
    else for (const [vv, q] of Object.entries(splitEven(total))) emit(vv, q);
  };
  const grid = (key: string) => {
    const s = t.sections.find((x) => x.key === key);
    return s && s.kind === "grid" ? colTotals(gridRows(work, s), s.cols.length) : [];
  };
  if (template === "PRODUKSI" || template === "CETAK") {
    // Cetak → + patung cetak (basah); panen oven: patung cetak (bagus + reject) keluar, patung kering masuk
    grid("cetakSeries").forEach((q, i) => add("basah", VARIANTS[i], q, "in"));
    if (template === "PRODUKSI") {
      const rej = grid("reject");
      grid("panen").forEach((q, i) => {
        add("kering", VARIANTS[i], q, "in");
        add("basah", VARIANTS[i], q + (rej[i] ?? 0), "out");
      });
    }
  } else if (template === "GIFTBOX") {
    const v = countValues(work, "giftbox");
    for (const code of GIFTBOX_CODES) {
      const box = n(v[code]);
      if (!box) continue;
      const variant = GIFTBOX_VARIANT[code.replace(/-PLT$/, "")] ?? null;
      const patung = box * GIFTBOX_PATUNG;
      if (variant) add("kering", variant, patung, "out");
      else for (const [vv, q] of Object.entries(splitEven(patung))) add("kering", vv, q, "out");
      // Giftbox dibuat lalu dikirim dari divisi Giftbox sendiri (keluar = HPP)
      add("giftbox", code, box, "in");
      add("giftbox", code, box, "out");
    }
    // Giftbox dari katalog: patung kering keluar sesuai Series × jumlah patung per SKU, item barang jadi SKU masuk lalu keluar
    for (const l of catalogLines(work, "gb")) {
      byVariant(l.variant, l.qty * Math.max(1, n(l.patung)), (vv, q) => add("kering", vv, q, "out"));
      add("produk", l.productId, l.qty, "in", l.label);
      add("produk", l.productId, l.qty, "out", l.label);
    }
  } else if (template === "PACKING") {
    // Packing dari katalog: produk jadi satuan per karakter keluar (paket Mix dibagi rata ke 4 karakter)
    for (const key of ["pk", "st"]) for (const l of catalogLines(work, key)) byVariant(l.variant, l.qty * Math.max(1, n(l.patung)), (vv, q) => add("jadi", vv, q, "out"));
    const sat = countValues(work, "satuan");
    for (const vv of VARIANTS) add("jadi", vv, n(sat[vv.toLowerCase()]), "out");
    const mix = countValues(work, "mix");
    for (const size of [12, 24, 48, 96]) {
      const paket = n(mix[`p${size}`]);
      if (!paket) continue;
      for (const [vv, q] of Object.entries(splitEven(size))) add("jadi", vv, q * paket, "out");
    }
  }
  const order = { in: 0, out: 1 };
  return [...acc.values()].sort((a, b) => order[a.dir] - order[b.dir]);
}

const FLOW_LABEL = { basah: "Patung cetak", kering: "Patung kering", jadi: "Produk jadi", giftbox: "Giftbox", produk: "Giftbox" } as const;

/** Teks ringkas langkah stok, mis. "+ Patung kering Hewan 300" */
export function flowLines(steps: FlowStep[]): string[] {
  return steps.map((s) => `${s.dir === "in" ? "+" : "−"} ${FLOW_LABEL[s.kind]} ${s.label ?? s.key} ${s.qty.toLocaleString("id-ID")}`);
}

// ---------------- Rekap laporan shift (harian/mingguan/bulanan) ----------------

export type RecapInput = { date: Date; shift: string; division: string; template: string | null; target: number | null; work: WorkData };
export type RecapMetric = { label: string; unit: string; value: number };
export type RecapDivision = { division: string; reports: number; metrics: RecapMetric[]; target: { value: number; target: number; pct: number; label: string; unit: string } | null };

function addMetrics(into: RecapMetric[], add: RecapMetric[]) {
  for (const m of add) {
    const cur = into.find((x) => x.label === m.label);
    if (cur) cur.value += m.value;
    else into.push({ ...m });
  }
}

/** Jumlahkan ringkasan laporan shift per divisi (urutan label mengikuti format divisi) + capaian target gabungan */
export function recapByDivision(rows: RecapInput[]): RecapDivision[] {
  const out = new Map<string, RecapDivision & { _t: number; _v: number; _tl?: { label: string; unit: string } }>();
  for (const r of rows) {
    if (!isTemplate(r.template)) continue;
    const d = out.get(r.division) ?? { division: r.division, reports: 0, metrics: [], target: null, _t: 0, _v: 0 };
    d.reports++;
    addMetrics(d.metrics, summaryOf(r.template, r.work).map((s) => ({ label: s.label, unit: s.unit, value: s.value })));
    const tg = targetOf(r.template, r.work, r.target);
    if (tg) { d._t += tg.target; d._v += tg.value; d._tl = { label: tg.label, unit: tg.unit }; }
    out.set(r.division, d);
  }
  return [...out.values()].map(({ _t, _v, _tl, ...d }) => ({ ...d, target: _t > 0 && _tl ? { value: _v, target: _t, pct: Math.round((_v / _t) * 100), ..._tl } : null }));
}

export type PersonRecap = { name: string; division: string; cols: string[]; values: number[]; total: number; reports: number };

/**
 * Hasil kerja per karyawan dari bagian "per orang" (baris = nama) di laporan shift: dijumlah per nama & divisi.
 * Bagian dengan kolom series (Cowok/Cewek/…) dirinci per series; bagian lama satu kolom masuk "pcs".
 */
export function personRecap(rows: RecapInput[]): PersonRecap[] {
  const out = new Map<string, PersonRecap>();
  for (const r of rows) {
    if (!isTemplate(r.template)) continue;
    const t = TEMPLATES[r.template];
    for (const s of t.sections) {
      if (s.kind !== "grid" || s.rows !== "people") continue;
      const cols = s.cols.length > 1 ? s.cols : ["pcs"];
      for (const row of gridRows(r.work, s)) {
        const key = `${r.division}|${row.name.trim().toLowerCase()}|${cols.join(",")}`;
        const cur = out.get(key) ?? { name: row.name.trim(), division: r.division, cols, values: cols.map(() => 0), total: 0, reports: 0 };
        cols.forEach((_, i) => (cur.values[i] += n(row.v[i])));
        cur.total = cur.values.reduce((a, b) => a + b, 0);
        cur.reports++;
        out.set(key, cur);
      }
    }
  }
  return [...out.values()].filter((p) => p.total > 0).sort((a, b) => a.division.localeCompare(b.division) || b.total - a.total);
}

/** Ringkasan satu laporan untuk tabel rekap harian */
export function recapLine(r: RecapInput): { text: string; pct: number | null } {
  if (!isTemplate(r.template)) return { text: "—", pct: null };
  const text = summaryOf(r.template, r.work).map((s) => `${s.label}: ${s.value.toLocaleString("id-ID")}${s.unit ? ` ${s.unit}` : ""}`).join(" · ");
  return { text, pct: targetOf(r.template, r.work, r.target)?.pct ?? null };
}

export const metricText = (m: RecapMetric) => `${m.label}: ${m.value.toLocaleString("id-ID")}${m.unit ? ` ${m.unit}` : ""}`;

/** Angka utama laporan (yang dibandingkan dengan target): panen / produk jadi / giftbox / patung packing */
export function mainMetric(template: ReportTemplate, work: WorkData) {
  const t = TEMPLATES[template];
  return { label: t.target.label, unit: t.target.unit, value: t.target.sections.reduce((a, k) => a + sectionTotal(t, work, k), 0) };
}

// ---------------- Monitoring resi & patung (Packing + Giftbox) ----------------

/** Divisi yang mengirim pesanan marketplace: resi = jumlah order, patung = jumlah patung keluar */
export const MONITOR_TEMPLATES: ReportTemplate[] = ["PACKING", "GIFTBOX"];

export type MonitorMetrics = { shopee: number; tiktok: number; resi: number; patung: number; byVariant: Record<string, number> };

/** Resi (Shopee, TikTok) dan patung keluar satu laporan; karakter dari langkah stok (Mix dibagi rata) */
export function monitorOf(template: string | null | undefined, work: WorkData): MonitorMetrics | null {
  if (!isTemplate(template) || !MONITOR_TEMPLATES.includes(template)) return null;
  const t = TEMPLATES[template];
  const r = countValues(work, "resi");
  const shopee = n(r.shopee);
  const tiktok = n(r.tiktok);
  const patung = template === "PACKING" ? PACKING_PATUNG.reduce((a, k) => a + sectionTotal(t, work, k), 0) : sectionTotal(t, work, "patung");
  const byVariant: Record<string, number> = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
  const kind = template === "PACKING" ? "jadi" : "kering";
  for (const s of plannedFlow(template, work)) if (s.kind === kind && s.dir === "out") byVariant[s.key] = (byVariant[s.key] ?? 0) + s.qty;
  return { shopee, tiktok, resi: shopee + tiktok, patung, byVariant };
}

export type MonitorDay = { date: string; total: MonitorMetrics; byDivision: Record<string, MonitorMetrics> };

const emptyMetrics = (): MonitorMetrics => ({ shopee: 0, tiktok: 0, resi: 0, patung: 0, byVariant: Object.fromEntries(VARIANTS.map((v) => [v, 0])) });
function addInto(a: MonitorMetrics, b: MonitorMetrics) {
  a.shopee += b.shopee;
  a.tiktok += b.tiktok;
  a.resi += b.resi;
  a.patung += b.patung;
  for (const [k, v] of Object.entries(b.byVariant)) a.byVariant[k] = (a.byVariant[k] ?? 0) + v;
}

/** Rekap harian resi & patung per divisi + gabungan, setiap tanggal dalam [start, end] (tanggal tanpa laporan = 0) */
export function monitorDaily(rows: { date: Date; division: string; template: string | null; work: WorkData }[], start: string, end: string, divisions: string[]): MonitorDay[] {
  const days = new Map<string, MonitorDay>();
  const mk = (date: string): MonitorDay => ({ date, total: emptyMetrics(), byDivision: Object.fromEntries(divisions.map((d) => [d, emptyMetrics()])) });
  for (let d = start; d <= end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.set(d, mk(d));
  for (const r of rows) {
    const m = monitorOf(r.template, r.work);
    if (!m) continue;
    const day = days.get(r.date.toISOString().slice(0, 10));
    if (!day) continue;
    day.byDivision[r.division] ??= emptyMetrics();
    addInto(day.byDivision[r.division], m);
    addInto(day.total, m);
  }
  return [...days.values()];
}

/** Jumlah seluruh hari (gabungan & per divisi) */
export function monitorSum(days: MonitorDay[]): { total: MonitorMetrics; byDivision: Record<string, MonitorMetrics> } {
  const total = emptyMetrics();
  const byDivision: Record<string, MonitorMetrics> = {};
  for (const d of days) {
    addInto(total, d.total);
    for (const [k, v] of Object.entries(d.byDivision)) addInto((byDivision[k] ??= emptyMetrics()), v);
  }
  return { total, byDivision };
}
