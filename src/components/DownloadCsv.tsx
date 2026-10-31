"use client";
import { toCsv, type Cell } from "@/lib/csv";

/** Tombol "Unduh Excel": menyimpan data tabel sebagai CSV (terbuka langsung di Excel / Google Sheets). */
export function DownloadCsv({ rows, filename, label = "Unduh Excel" }: { rows: Cell[][]; filename: string; label?: string }) {
  const save = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button type="button" onClick={save} className="btn-secondary" disabled={rows.length <= 1} title="Simpan sebagai file CSV yang bisa dibuka di Excel">
      {label}
    </button>
  );
}
