import { createHash } from "node:crypto";
import { addDays } from "./time";

/** Bagian murni (tanpa database) dari kontrak kerja digital: nomor, tanggal, template pasal, hash */

export type Clause = { title: string; body: string };

export const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/** {urut 3 digit}/MG-HRD/{PKWT|ADD}/{bulan romawi}/{tahun}; urut ≥ 1000 tetap utuh */
export function contractNumber(seq: number, kind: "PKWT" | "ADD", date: string) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${String(seq).padStart(3, "0")}/MG-HRD/${kind}/${ROMAN[m]}/${y}`;
}

/** Tambah bulan ke tanggal YYYY-MM-DD (hari dipotong ke akhir bulan bila perlu) */
export function addMonths(date: string, months: number) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const d = Math.min(Number(date.slice(8, 10)), last);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Tanggal selesai kontrak: mulai + n bulan − 1 hari (1 Des 2026 + 6 bln → 31 Mei 2027) */
export const contractEnd = (start: string, months: number) => addDays(addMonths(start, months), -1);

export const DEFAULT_DURATIONS = [2, 6, 12];
export const DEFAULT_RESIGN_DAYS = 30;
export const DEFAULT_HRD = { name: "Nur Anjola Hidayat Diharjo Putra", title: "HRD" };
export const DEFAULT_BPJS_SINCE = "2026-11";

/**
 * Template pasal bawaan. Penanda {nama}, {masa}, {mulai}, {selesai}, {jadwal}, {toleransi}, {siklus}, {resign_hari}, {bpjs_mulai}
 * diisi otomatis dari data karyawan/pengaturan saat kontrak dibuat; {{tabel_upah}} menampilkan tabel upah & tunjangan.
 * Baris berawalan "1. " menjadi daftar bernomor. Pasal Pengunduran Diri = DRAF (menunggu konfirmasi akhir Owner / ahli hukum).
 */
export const DEFAULT_CLAUSES: Clause[] = [
  { title: "Pasal 1 · Masa Kerja", body: "Perjanjian berlaku {masa}, mulai {mulai} sampai {selesai}, dan dapat diperpanjang dengan perjanjian baru." },
  { title: "Pasal 2 · Waktu Kerja", body: "Waktu kerja mengikuti jadwal shift yang diatur Supervisor: {jadwal}, toleransi terlambat {toleransi}. Kehadiran dibuktikan dengan absensi di aplikasi." },
  {
    title: "Pasal 3 · Upah dan Hak",
    body: "{{tabel_upah}}\nKetidakhadiran tanpa keterangan (Alpa) mengurangi gaji pokok sebesar gaji pokok ÷ 30 × jumlah hari Alpa pada periode berjalan. Izin dan sakit yang disetujui tidak dipotong.",
  },
  {
    title: "Pasal 4 · Kewajiban Pihak Kedua",
    body: "1. Melakukan absensi masuk dan pulang di aplikasi sesuai jadwal shift.\n2. Mengisi laporan shift divisinya dengan jujur dan lengkap sebelum pulang.\n3. Menjaga bahan, alat, dan produk perusahaan, serta melaporkan reject dan kerusakan.\n4. Menjaga kerahasiaan data dan resep perusahaan.",
  },
  {
    title: "Pasal 5 · Pengunduran Diri",
    body: "1. Pihak Kedua yang mengundurkan diri wajib memberi tahu secara tertulis paling lambat {resign_hari} hari sebelumnya.\n2. Pihak Kedua yang mengundurkan diri sebelum masa kontrak berakhir atau sebelum tanggal gajian wajib membayar ganti rugi kepada Pihak Pertama sebesar gaji pokok yang seharusnya diterima pada periode berjalan; ganti rugi ini diperhitungkan (dikompensasi) dengan upah yang masih harus dibayarkan kepada Pihak Kedua.\n3. Pengecualian atau keputusan lain hanya dapat ditetapkan oleh HRD secara tertulis dan tercatat.",
  },
  {
    title: "Pasal 6 · Pelanggaran Berat dan Pemutusan Hubungan Kerja",
    body: "1. Pelanggaran berat yang dapat mengakibatkan pemutusan hubungan kerja seketika: (a) mencuri, menggelapkan, atau menyalahgunakan bahan, produk, uang, atau data perusahaan; (b) memalsukan absensi, laporan shift, atau data stok; (c) merusak alat, bahan, atau produk dengan sengaja; (d) mabuk, memakai narkotika, atau berjudi di tempat kerja; (e) kekerasan, ancaman, atau pelecehan terhadap sesama pekerja; (f) membocorkan resep, harga pokok, atau rahasia perusahaan.\n2. Pelanggaran dibuktikan dengan catatan absensi, laporan shift, catatan stok, rekaman, keterangan saksi, atau bukti lain, dan Pihak Kedua diberi kesempatan menjelaskan sebelum HRD memutuskan.\n3. Keputusan pemutusan hubungan kerja dibuat tertulis oleh HRD dan tercatat. Upah atas hari kerja yang sudah dijalani tetap dibayarkan; kerugian perusahaan yang terbukti dapat diperhitungkan dengan upah paling banyak 50% dari upah yang akan dibayarkan, dan sisanya diselesaikan secara musyawarah.",
  },
  { title: "Pasal 7 · Penutup", body: "Perjanjian ini dibuat dan ditandatangani secara elektronik, dan mempunyai kekuatan yang sama dengan perjanjian bertanda tangan basah." },
];

export function fillPlaceholders(text: string, vars: Record<string, string>) {
  return text.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function fillClauses(clauses: Clause[], vars: Record<string, string>): Clause[] {
  return clauses.map((c) => ({ title: fillPlaceholders(c.title, vars), body: fillPlaceholders(c.body, vars) }));
}

/** Validasi template dari pengaturan: daftar pasal berjudul + berisi */
export function parseClauses(raw: unknown): Clause[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: Clause[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") return null;
    const { title, body } = c as Record<string, unknown>;
    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) return null;
    out.push({ title: title.trim().slice(0, 120), body: body.trim().slice(0, 4000) });
  }
  return out.length <= 30 ? out : null;
}

/** JSON dengan urutan kunci tetap, agar hash stabil */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Hash isi dokumen: nomor + jenis + periode + snapshot */
export function documentHash(d: { number: string; kind: string; startDate: string; endDate: string; snapshot: unknown }) {
  return sha256(canonical({ number: d.number, kind: d.kind, start: d.startDate, end: d.endDate, snapshot: d.snapshot }));
}

/** Hash akhir saat terkunci: isi + tanda tangan karyawan + waktu */
export const finalDocumentHash = (contentHash: string, signature: string, signedAt: string) => sha256(`${contentHash}|${sha256(signature)}|${signedAt}`);

/** Kode verifikasi pendek mudah dibaca: MG-XXXX-XXXX (tanpa huruf mirip) */
export function newVerifyCode(rand: (n: number) => Uint8Array) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = rand(8);
  const ch = (i: number) => abc[b[i] % abc.length];
  return `MG-${ch(0)}${ch(1)}${ch(2)}${ch(3)}-${ch(4)}${ch(5)}${ch(6)}${ch(7)}`;
}
