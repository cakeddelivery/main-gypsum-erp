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

/**
 * Angka rupiah dengan pemisah apa saja (titik/koma) → angka.
 *  - Dua jenis pemisah: yang terakhir = desimal bila diikuti 1–2 angka ("1.250.000,00", "1,250,000.50"), selain itu ribuan
 *  - Satu jenis pemisah, muncul > 1 kali: ribuan ("1,250,000", "1.250.000")
 *  - Satu pemisah: diikuti tepat 3 angka = ribuan ("1250.000", "1,250", "1.250rb"); 1–2 angka = desimal ("1,5jt",
 *    "1.5jt", "12,50"); ≥ 4 angka = salah ketik ribuan ("1.250000")
 * Sen dibuang (IDR-only).
 */
export function looseNumber(raw: string): number | null {
  const s = raw.replace(/[.,]+$/, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const seps = s.match(/[.,]/g) ?? [];
  if (!seps.length) return Number(s);
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  const tail = s.slice(last + 1);
  const twoKinds = new Set(seps).size === 2;
  const decimal = tail.length >= 1 && tail.length <= 2 && (twoKinds || seps.length === 1);
  return decimal ? Number(`${s.slice(0, last).replace(/[.,]/g, "")}.${tail}`) : Number(s.replace(/[.,]/g, ""));
}

/** Parse "Rp 1.250.000", "1,25jt", "150rb", "1500000", "1250.000", "1,250,000" -> bilangan bulat. Null jika tidak valid. */
export function parseIDR(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = String(input).toLowerCase().replace(/rp\.?/g, "").replace(/idr/g, "").trim();
  const m = s.match(/^([\d.,]+)\s*(jt|juta|rb|ribu|k)?$/);
  if (!m) return null;
  const unit = m[2];
  const base = looseNumber(m[1]);
  if (base == null || isNaN(base)) return null;
  const mult = !unit ? 1 : unit === "jt" || unit === "juta" ? 1_000_000 : 1_000;
  return Math.floor(Math.round(base * mult * 100) / 100);
}
