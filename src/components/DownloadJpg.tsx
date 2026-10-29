"use client";
import { useState } from "react";
import { toJpeg } from "html-to-image";

/** Unduh elemen laporan sebagai gambar JPG */
export function DownloadJpg({ targetId, filename }: { targetId: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={busy}
      onClick={async () => {
        const el = document.getElementById(targetId);
        if (!el) return;
        setBusy(true);
        // JPG selalu versi terang (latar putih) dan semua baris tabel (tanpa pagination), juga saat mode malam
        el.classList.add("theme-light", "exporting");
        try {
          const url = await toJpeg(el, { quality: 0.95, backgroundColor: "#ffffff", pixelRatio: 2 });
          const a = document.createElement("a");
          a.href = url;
          a.download = `${filename}.jpg`;
          a.click();
        } finally {
          el.classList.remove("theme-light", "exporting");
          setBusy(false);
        }
      }}
    >
      {busy ? "Membuat JPG…" : "⬇ Unduh JPG"}
    </button>
  );
}
