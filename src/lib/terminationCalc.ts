import { alpaCut, runningCycle } from "./salaryProjection";
import { contractEnd } from "./contractTemplate";

/** Hitungan slip akhir saat kontrak diakhiri (murni, mudah dites). Kompensasi PKWT & ganti rugi hanya muncul di sini, bukan di slip bulanan. */
export const TERMINATION_REASONS = {
  RESIGN: "Pengunduran diri (resign)",
  PELANGGARAN_BERAT: "Pelanggaran berat",
  KONTRAK_HABIS: "Kontrak berakhir",
  DIPUTUS_PERUSAHAAN: "Diputus perusahaan tanpa kesalahan karyawan",
} as const;
export type TerminationReason = keyof typeof TERMINATION_REASONS;
export const MAX_DAMAGE_PCT = 50;

const dayDiff = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

/** Bulan penuh dari mulai kontrak sampai tanggal berakhir (inklusif): k terbesar dengan (mulai + k bulan − 1 hari) ≤ berakhir */
export function fullMonths(start: string, end: string) {
  let k = 0;
  while (k < 120 && contractEnd(start, k + 1) <= end) k++;
  return k;
}

export type Line = { key: string; label: string; amount: number; kind: "plus" | "minus" | "info"; note?: string };

export type FinalPayInput = {
  reason: TerminationReason;
  baseSalary: number;
  /** Tunjangan tetap per bulan (dasar upah kompensasi PKWT) */
  allowanceTotal: number;
  joinDate: string;
  contractStart: string;
  contractEnd: string;
  effective: string;
  alpaDays: number;
  /** Kerugian perusahaan yang terbukti (Rp), hanya untuk pelanggaran berat */
  damage?: number;
  payOffsetDays?: number;
};

/**
 * Slip akhir:
 *  - Upah hari kerja = gaji pokok ÷ 30 × hari kerja di periode berjalan (awal siklus s.d. tanggal efektif), dikurangi potongan Alpa.
 *  - Resign sebelum kontrak berakhir / sebelum gajian: ganti rugi = gaji pokok periode berjalan, DIKOMPENSASI dengan upah terutang.
 *  - Pelanggaran berat: potongan kerusakan terbukti paling banyak 50% upah.
 *  - Kontrak berakhir / diputus tanpa kesalahan: kompensasi PKWT (PP 35/2021) = masa kerja (bulan, maks 12) ÷ 12 × upah, bila masa kerja ≥ 1 bulan.
 *  - Diputus tanpa kesalahan: ditambah ganti rugi sisa kontrak (Pasal 62 UU 13/2003) = gaji pokok ÷ 30 × sisa hari kontrak.
 */
export function finalPay(i: FinalPayInput) {
  const cyc = runningCycle(i.joinDate, i.effective, i.payOffsetDays ?? 7);
  const worked = Math.min(30, Math.max(0, dayDiff(cyc.start, i.effective) + 1));
  const gross = Math.round((i.baseSalary / 30) * worked);
  const alpa = Math.min(gross, alpaCut(i.baseSalary, i.alpaDays));
  const wage = Math.max(0, gross - alpa);
  const lines: Line[] = [{ key: "upah", label: `Upah ${worked} hari kerja (periode ${cyc.start} s.d. ${i.effective})`, amount: wage + alpa, kind: "plus" }];
  if (alpa) lines.push({ key: "alpa", label: `Potongan Alpa ${i.alpaDays} hari`, amount: alpa, kind: "minus" });
  let net = wage;
  const warnings: string[] = [];

  if (i.reason === "RESIGN") {
    const early = i.effective < i.contractEnd || i.effective < cyc.payDate;
    if (early) {
      const rugi = i.baseSalary;
      const offset = Math.min(net, rugi);
      lines.push({ key: "ganti_rugi", label: "Ganti rugi resign (gaji pokok periode berjalan)", amount: rugi, kind: "info", note: "Dikompensasi dengan upah yang masih harus dibayar" });
      lines.push({ key: "kompensasi", label: "Kompensasi ganti rugi dengan upah terutang", amount: offset, kind: "minus" });
      net -= offset;
      if (rugi > offset) warnings.push(`Sisa ganti rugi Rp ${(rugi - offset).toLocaleString("id-ID")} tidak ditagih otomatis; HRD memutuskan penyelesaiannya.`);
    }
  }
  if (i.reason === "PELANGGARAN_BERAT" && (i.damage ?? 0) > 0) {
    const cap = Math.floor((net * MAX_DAMAGE_PCT) / 100);
    const applied = Math.min(i.damage!, cap);
    lines.push({ key: "kerusakan", label: `Potongan kerugian terbukti (maks ${MAX_DAMAGE_PCT}% upah)`, amount: applied, kind: "minus" });
    net -= applied;
    if (i.damage! > applied) warnings.push(`Kerugian terbukti Rp ${i.damage!.toLocaleString("id-ID")} melebihi batas ${MAX_DAMAGE_PCT}% upah; sisa Rp ${(i.damage! - applied).toLocaleString("id-ID")} diselesaikan musyawarah.`);
  }
  if (i.reason === "KONTRAK_HABIS" || i.reason === "DIPUTUS_PERUSAHAAN") {
    const months = Math.min(12, fullMonths(i.contractStart, i.effective));
    if (months >= 1) {
      const comp = Math.round((months / 12) * (i.baseSalary + i.allowanceTotal));
      lines.push({ key: "kompensasi_pkwt", label: `Kompensasi PKWT (${months} ÷ 12 × upah)`, amount: comp, kind: "plus", note: "PP 35/2021" });
      net += comp;
    }
  }
  if (i.reason === "DIPUTUS_PERUSAHAAN") {
    const left = Math.max(0, dayDiff(i.effective, i.contractEnd));
    const rugi = Math.round((i.baseSalary / 30) * left);
    if (rugi > 0) {
      lines.push({ key: "sisa_kontrak", label: `Ganti rugi sisa kontrak (${left} hari, Pasal 62)`, amount: rugi, kind: "plus" });
      net += rugi;
      warnings.push(`Ganti rugi sisa kontrak Rp ${rugi.toLocaleString("id-ID")}: periksa nilainya sebelum menerbitkan surat.`);
    }
  }
  return { lines, net: Math.max(0, net), worked, cycle: cyc, warnings };
}
