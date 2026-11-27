"use client";

/** Cetak / simpan PDF daftar order & produksi (satu dokumen: bahan baku diorder + setengah jadi/jadi diproduksi) */
export function PrintOrder() {
  return <button type="button" className="btn-secondary no-print" onClick={() => window.print()}>🖨 Cetak / PDF</button>;
}
