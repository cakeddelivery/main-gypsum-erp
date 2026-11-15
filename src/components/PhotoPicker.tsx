"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action";
import { toast } from "./Toaster";
import { Avatar } from "./Avatar";
import { useCloseModal } from "./Modal";

const VIEW = 240; // ukuran lingkaran potong di layar (px)
const OUT = 512; // hasil potongan dikirim ke server (server memperkecil lagi ke 400 px)

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/**
 * Pilih foto profil dari kamera / galeri → geser & perbesar di lingkaran → simpan.
 * Potongan dibuat di HP (canvas, otomatis tanpa EXIF/GPS) lalu server mengompres lagi.
 */
export function PhotoPicker({ name, src, save, remove, onDone }: { name: string; src: string | null; save: Action; remove: Action; onDone?: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const close = useCloseModal();
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const cam = useRef<HTMLInputElement>(null);
  const gal = useRef<HTMLInputElement>(null);

  // Skala dasar: sisi terpendek foto memenuhi lingkaran
  const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;
  const clamp = (p: { x: number; y: number }) => ({ x: Math.min(0, Math.max(VIEW - w, p.x)), y: Math.min(0, Math.max(VIEW - h, p.y)) });

  useEffect(() => {
    if (img) setPos((p) => clamp(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError("File harus berupa foto");
    const url = URL.createObjectURL(f);
    const el = new Image();
    el.onload = () => {
      const b = VIEW / Math.min(el.naturalWidth, el.naturalHeight);
      setImg(el);
      setZoom(1);
      setPos({ x: (VIEW - el.naturalWidth * b) / 2, y: (VIEW - el.naturalHeight * b) / 2 });
    };
    el.onerror = () => setError("Foto tidak bisa dibaca. Coba foto lain.");
    el.src = url;
  }

  function submit() {
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = OUT;
    c.height = OUT;
    const k = OUT / VIEW;
    c.getContext("2d")!.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
    c.toBlob(
      (blob) => {
        if (!blob) return setError("Gagal memproses foto");
        const fd = new FormData();
        fd.set("photo", new File([blob], "profil.jpg", { type: "image/jpeg" }));
        start(async () => {
          const r = await save(null, fd);
          if (!r.ok) return setError(r.error ?? "Gagal menyimpan");
          toast(r.message ?? "Foto tersimpan");
          setImg(null);
          (onDone ?? close)();
        });
      },
      "image/jpeg",
      0.85,
    );
  }

  function del() {
    if (!window.confirm("Hapus foto profil? Lingkaran akan kembali menampilkan inisial nama.")) return;
    start(async () => {
      const r = await remove(null, new FormData());
      if (!r.ok) return setError(r.error ?? "Gagal menghapus");
      toast(r.message ?? "Foto dihapus");
      (onDone ?? close)();
    });
  }

  return (
    <div className="space-y-3">
      <input ref={cam} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={gal} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      {img ? (
        <div className="flex flex-col items-center gap-3">
          <div
            className="relative touch-none select-none overflow-hidden rounded-full bg-slate-200 ring-4 ring-brand-200"
            style={{ width: VIEW, height: VIEW, cursor: "grab" }}
            onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
            onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ left: pos.x, top: pos.y, width: w, height: h }} />
          </div>
          <p className="text-xs text-slate-500">Geser foto agar wajah di tengah lingkaran</p>
          <label className="flex w-full max-w-xs items-center gap-2 text-xs text-slate-600">
            <span>Perkecil</span>
            <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1 accent-brand-600" aria-label="Perbesar foto" />
            <span>Perbesar</span>
          </label>
          <div className="flex w-full gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setImg(null)} disabled={pending}>Batal</button>
            <button type="button" className="btn-primary flex-1" onClick={submit} disabled={pending}>{pending ? "Menyimpan…" : "Simpan foto"}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Avatar name={name} src={src} size={112} />
          <div className="grid w-full grid-cols-2 gap-2 keep-cols">
            <button type="button" className="btn-primary" onClick={() => cam.current?.click()} disabled={pending}>📷 Kamera</button>
            <button type="button" className="btn-secondary" onClick={() => gal.current?.click()} disabled={pending}>🖼️ Galeri</button>
          </div>
          {src && <button type="button" className="text-xs font-medium text-red-600 hover:underline" onClick={del} disabled={pending}>Hapus foto</button>}
          <p className="text-center text-xs text-slate-500">Foto dipotong bulat dan dikecilkan otomatis. Data lokasi di foto dibuang.</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
