"use client";
import { useEffect, useRef, useState } from "react";
import { toJpeg } from "html-to-image";

/**
 * Tombol "Unduh JPG": membuat gambar dari dokumen ber-kop surat (DocSheet di dalam DocExport) lalu menampilkan
 * pratinjaunya dulu; gambar baru disimpan setelah tombol Unduh di popup ditekan.
 * Dokumen disalin ke wadah tersembunyi selebar data-export-width (default 1000px) agar hasilnya selalu tata letak lebar,
 * versi terang, dan memuat semua baris tabel, juga saat dibuka dari HP.
 */
export function DownloadJpg({ targetId, filename }: { targetId: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const name = `${filename}.jpg`;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (url && !d.open) d.showModal();
    if (!url && d.open) d.close();
  }, [url]);

  const render = async () => {
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
      await Promise.all([...node.querySelectorAll("img")].map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : img.decode().catch(() => {}))));
      const data = await toJpeg(node, { quality: 0.95, backgroundColor: "#ffffff", pixelRatio: 2, width, height: node.scrollHeight });
      try {
        const file = new File([await (await fetch(data)).blob()], name, { type: "image/jpeg" });
        setCanShare(typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }));
      } catch {
        setCanShare(false);
      }
      setUrl(data);
    } finally {
      host.remove();
      setBusy(false);
    }
  };

  const save = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  };
  const share = async () => {
    if (!url) return;
    const file = new File([await (await fetch(url)).blob()], name, { type: "image/jpeg" });
    await navigator.share({ files: [file], title: filename }).catch(() => {});
  };

  return (
    <>
      <button type="button" className="btn-secondary" disabled={busy} onClick={render}>
        {busy ? "Membuat JPG…" : "⬇ Unduh JPG"}
      </button>
      <dialog
        ref={ref}
        onClose={() => setUrl(null)}
        onClick={(e) => e.target === e.currentTarget && setUrl(null)}
        className="w-[calc(100%-1.5rem)] max-w-3xl rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50"
      >
        {url && (
          <div>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <h2 className="min-w-0 truncate font-semibold text-slate-900">Pratinjau JPG</h2>
              <button type="button" aria-label="Tutup" className="rounded p-1 text-slate-600 hover:bg-slate-100" onClick={() => setUrl(null)}>✕</button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto bg-slate-100 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`Pratinjau ${name}`} className="mx-auto w-full max-w-2xl rounded-lg border border-slate-200 bg-[#fff] shadow" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-5 py-3">
              <span className="min-w-0 truncate text-xs text-slate-500">{name}</span>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setUrl(null)}>Tutup</button>
                {canShare && <button type="button" className="btn-secondary" onClick={share}>Bagikan</button>}
                <button type="button" className="btn-primary" onClick={save}>⬇ Unduh</button>
              </div>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
