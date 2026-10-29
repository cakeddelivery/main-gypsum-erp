"use client";
import { useState } from "react";
import { toJpeg } from "html-to-image";

/**
 * Unduh dokumen sebagai JPG. Dokumen disalin ke wadah tersembunyi selebar data-export-width (default 1000px)
 * agar hasilnya selalu tata letak lebar (kop surat lengkap) meski diunduh dari HP, versi terang, dan semua baris tabel.
 */
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
        const width = Number(el.dataset.exportWidth) || 1000;
        const host = document.createElement("div");
        host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;pointer-events:none`;
        const node = el.cloneNode(true) as HTMLElement;
        node.removeAttribute("id");
        node.classList.add("theme-light", "exporting");
        node.style.width = `${width}px`;
        host.appendChild(node);
        document.body.appendChild(host);
        try {
          await Promise.all([...node.querySelectorAll("img")].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))));
          const url = await toJpeg(node, { quality: 0.95, backgroundColor: "#ffffff", pixelRatio: 2, width, height: node.scrollHeight });
          const a = document.createElement("a");
          a.href = url;
          a.download = `${filename}.jpg`;
          a.click();
        } finally {
          host.remove();
          setBusy(false);
        }
      }}
    >
      {busy ? "Membuat JPG…" : "⬇ Unduh JPG"}
    </button>
  );
}
