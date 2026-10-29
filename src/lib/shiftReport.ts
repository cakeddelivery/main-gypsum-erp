/**
 * Format Laporan Penutup Shift per divisi (Produksi, Giftbox, Packing, Assembling).
 * Modul murni (tanpa akses database) agar bisa dipakai di server, komponen klien, seed, dan skrip.
 */

export type ReportTemplate = "PRODUKSI" | "GIFTBOX" | "PACKING" | "ASSEMBLING";
export const REPORT_TEMPLATES: ReportTemplate[] = ["PRODUKSI", "GIFTBOX", "PACKING", "ASSEMBLING"];

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
};
/** Hitungan otomatis dari bagian lain × faktor (mis. 1 giftbox = 5 patung) */
export type DerivedSection = { kind: "derived"; key: string; title: string; from: string; factor: number; totalLabel: string };
export type Section = GridSection | CountSection | DerivedSection;

export type TemplateDef = {
  label: string;
  heading: string;
  sections: Section[];
  /** Ringkasan di bawah judul laporan: label + bagian yang dijumlah */
  summary: { label: string; sections: string[]; unit?: string }[];
};

const VARIANTS = ["Hewan", "Cowok", "Transportasi", "Cewek"];
const GIFTBOX_CODES = ["MIX", "CEW", "CWO", "HWN", "TRN", "MIX-PLT", "CEW-PLT", "CWO-PLT", "HWN-PLT", "TRN-PLT"];

export const TEMPLATES: Record<ReportTemplate, TemplateDef> = {
  PRODUKSI: {
    label: "Produksi",
    heading: "",
    sections: [
      { kind: "grid", key: "panen", title: "Hasil panen", rows: ["Oven Besar", "Oven Kecil"], cols: VARIANTS, totalLabel: "Total panen" },
      { kind: "grid", key: "cetak", title: "Hasil cetak", rows: "people", cols: ["pcs"], totalLabel: "Total hasil cetak" },
    ],
    summary: [{ label: "Total panen", sections: ["panen"] }, { label: "Total hasil cetak", sections: ["cetak"] }],
  },
  GIFTBOX: {
    label: "Giftbox",
    heading: "Hasil giftbox",
    sections: [
      { kind: "count", key: "resi", title: "Resi", fields: [{ key: "shopee", label: "Shopee" }, { key: "tiktok", label: "Tiktok" }], totalLabel: "Total resi", unit: "resi" },
      { kind: "count", key: "giftbox", title: "Giftbox", fields: GIFTBOX_CODES.map((c) => ({ key: c, label: c })), totalLabel: "Total giftbox", unit: "box" },
      { kind: "derived", key: "patung", title: "Patung", from: "giftbox", factor: 5, totalLabel: "Total patung" },
    ],
    summary: [{ label: "Total resi", sections: ["resi"], unit: "" }, { label: "Total patung", sections: ["patung"] }],
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
      },
      { kind: "count", key: "satuan", title: "Patung satuan", fields: ["Cowok", "Cewek", "Transportasi", "Hewan"].map((v) => ({ key: v.toLowerCase(), label: v })), totalLabel: "Total patung satuan" },
    ],
    summary: [{ label: "Total resi", sections: ["resi"], unit: "" }, { label: "Total patung", sections: ["mix", "satuan"] }],
  },
  ASSEMBLING: {
    label: "Assembling",
    heading: "Hasil produk jadi assembling",
    sections: [{ kind: "grid", key: "jadi", title: "Produk jadi per orang", rows: "people", cols: VARIANTS, totalLabel: "Total produk jadi", colTotals: true }],
    summary: [{ label: "Total produk jadi", sections: ["jadi"] }],
  },
};

export function isTemplate(v: unknown): v is ReportTemplate {
  return typeof v === "string" && (REPORT_TEMPLATES as string[]).includes(v);
}

// ---------------- Data hasil kerja ----------------

export type GridRow = { name: string; v: (number | null)[] };
/** work[sectionKey] = GridRow[] (grid) atau { fieldKey: angka } (count) */
export type WorkData = Record<string, GridRow[] | Record<string, number | null>>;

const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

export function gridRows(work: WorkData, s: GridSection): GridRow[] {
  const raw = Array.isArray(work[s.key]) ? (work[s.key] as GridRow[]) : [];
  if (s.rows === "people") return raw.filter((r) => r.name?.trim());
  return s.rows.map((name) => raw.find((r) => r.name === name) ?? { name, v: [] });
}

export function countValues(work: WorkData, key: string): Record<string, number | null> {
  const v = work[key];
  return v && !Array.isArray(v) ? v : {};
}

export function rowTotal(r: GridRow) {
  return r.v.reduce<number>((a, b) => a + n(b), 0);
}

export function colTotals(rows: GridRow[], cols: number) {
  return Array.from({ length: cols }, (_, i) => rows.reduce((a, r) => a + n(r.v[i]), 0));
}

/** Nilai per field sebuah count/derived section (derived = sumber × faktor) */
export function sectionFieldValues(t: TemplateDef, work: WorkData, s: CountSection | DerivedSection): { label: string; value: number | null; pcs: number }[] {
  if (s.kind === "count") {
    const v = countValues(work, s.key);
    return s.fields.map((f) => ({ label: f.label, value: v[f.key] ?? null, pcs: n(v[f.key]) * (f.mult ?? 1) }));
  }
  const src = t.sections.find((x) => x.key === s.from);
  if (!src || src.kind !== "count") return [];
  const v = countValues(work, src.key);
  return src.fields.map((f) => {
    const raw = v[f.key];
    const val = raw == null ? null : n(raw) * s.factor;
    return { label: f.label, value: val, pcs: n(val) };
  });
}

export function sectionTotal(t: TemplateDef, work: WorkData, key: string): number {
  const s = t.sections.find((x) => x.key === key);
  if (!s) return 0;
  if (s.kind === "grid") return gridRows(work, s).reduce((a, r) => a + rowTotal(r), 0);
  return sectionFieldValues(t, work, s).reduce((a, f) => a + f.pcs, 0);
}

export function summaryOf(template: ReportTemplate, work: WorkData) {
  const t = TEMPLATES[template];
  return t.summary.map((s) => ({ label: s.label, unit: s.unit ?? "pcs", value: s.sections.reduce((a, k) => a + sectionTotal(t, work, k), 0) }));
}

const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("id-ID"));

/** Baris teks detail hasil kerja (untuk tampilan laporan & pesan Telegram) */
export function workLines(template: ReportTemplate, work: WorkData): string[] {
  const t = TEMPLATES[template];
  const out: string[] = [];
  if (t.heading) out.push(t.heading.toUpperCase());
  for (const s of t.sections) {
    if (s.kind === "grid") {
      if (!t.heading) out.push(s.title.toUpperCase());
      const rows = gridRows(work, s);
      for (const r of rows) {
        if (s.cols.length === 1) out.push(`${r.name}: ${fmt(r.v[0] ?? null)} pcs`);
        else out.push(`${r.name}: ${s.cols.map((c, i) => `${c} ${fmt(r.v[i] ?? null)}`).join(" · ")}${s.colTotals ? "" : ` · TOTAL ${fmt(rowTotal(r))} pcs`}`);
      }
      if (s.colTotals) out.push(`TOTAL: ${colTotals(rows, s.cols.length).map((v, i) => `${s.cols[i]} ${fmt(v)}`).join(" · ")}`);
      out.push(`${s.totalLabel.toUpperCase()}: ${fmt(sectionTotal(t, work, s.key))} pcs`);
    } else {
      const vals = sectionFieldValues(t, work, s);
      out.push(`${s.title.toUpperCase()}: ${vals.map((f) => `${f.label} ${fmt(f.value)}`).join(" · ")} · TOTAL ${fmt(sectionTotal(t, work, s.key))}`);
    }
  }
  if (template === "PACKING") out.push(`TOTAL PATUNG: ${fmt(sectionTotal(t, work, "mix") + sectionTotal(t, work, "satuan"))} pcs`);
  return out;
}

/** Baca hasil kerja dari FormData: grid "w.<section>.<row>.name" & "w.<section>.<row>.<col>", count "w.<section>.<field>" */
export function parseWork(template: ReportTemplate, get: (k: string) => string | null): WorkData {
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
    }
  }
  return work;
}

// ---------------- Checklist & stok ----------------

export type ChecklistTask = { label: string; photo: boolean };
export type ChecklistEntry = ChecklistTask & { done: boolean; photoPath?: string | null };
export type StockCountRow = { itemId: string; name: string; unit: string; limit: number; qty: number | null };

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

/** SKU bahan baku divisi: BB-<kode divisi>-<NAMA> */
export function materialSku(divCode: string, name: string) {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `BB-${divCode}-${slug}`;
}
