// Sistem IDR-only: semua nominal disimpan sebagai bilangan bulat rupiah (BigInt).

export function n(v: bigint | number | null | undefined | { toString(): string }): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

export function idr(v: bigint | number | null | undefined): string {
  const x = n(v);
  const s = Math.abs(Math.round(x)).toLocaleString("id-ID");
  return (x < 0 ? "-Rp " : "Rp ") + s;
}

/** Parse "Rp 1.250.000", "1,25jt", "150rb", "1500000" -> 1250000. Null jika tidak valid. */
export function parseIDR(input: string | null | undefined): number | null {
  if (!input) return null;
  let s = String(input).toLowerCase().replace(/rp\.?/g, "").replace(/idr/g, "").trim();
  const m = s.match(/^([\d.,]+)\s*(jt|juta|rb|ribu|k)?$/);
  if (!m) return null;
  let num = m[1];
  const unit = m[2];
  if (unit) {
    num = num.replace(/\./g, "").replace(",", ".");
    const base = parseFloat(num);
    if (isNaN(base)) return null;
    const mult = unit === "jt" || unit === "juta" ? 1_000_000 : 1_000;
    return Math.round(base * mult);
  }
  // Format Indonesia: titik = pemisah ribuan, koma = desimal (sen diabaikan)
  s = num.replace(/\./g, "").split(",")[0];
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}
