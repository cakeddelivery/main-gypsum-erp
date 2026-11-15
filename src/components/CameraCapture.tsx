"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Ukuran & kualitas foto bukti yang dikirim (dikompres di HP sebelum diunggah) */
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.7;

/** Perkecil gambar (sisi terpanjang ≤ 1600 px, JPEG 0.7). Metadata EXIF/GPS ikut hilang karena digambar ulang di canvas. */
export async function shrinkImage(src: Blob | HTMLVideoElement, max = PHOTO_MAX_SIDE, quality = PHOTO_QUALITY): Promise<Blob> {
  let w: number, h: number, draw: CanvasImageSource;
  if (src instanceof HTMLVideoElement) {
    w = src.videoWidth;
    h = src.videoHeight;
    draw = src;
  } else {
    if (!src.type.startsWith("image/")) throw new Error("File harus berupa foto");
    const img = await createImageBitmap(src).catch(() => null);
    if (!img) return src;
    w = img.width;
    h = img.height;
    draw = img;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(draw, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : src instanceof Blob ? res(src) : rej(new Error("Gagal memproses foto"))), "image/jpeg", quality));
}

const camSupported = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * Kamera DI DALAM halaman (kamera belakang + tombol jepret). Tidak membuka aplikasi kamera HP, sehingga
 * halaman tidak dimuat ulang di HP RAM kecil. Bila izin kamera ditolak / tidak didukung: pilih dari galeri / kamera HP.
 * `onCapture` menerima foto yang sudah dikompres.
 */
export function CameraCapture({ open, title, onClose, onCapture, onBeforeExternal }: { open: boolean; title: string; onClose: () => void; onCapture: (photo: Blob) => void; onBeforeExternal?: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"start" | "live" | "shot" | "error">("start");
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!camSupported()) {
      setState("error");
      setError("Kamera di dalam aplikasi tidak didukung HP/browser ini. Pakai tombol di bawah.");
      return;
    }
    setState("start");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => {});
      }
      setState("live");
    } catch (e) {
      const name = (e as { name?: string }).name;
      setState("error");
      setError(name === "NotAllowedError" ? "Izin kamera ditolak. Izinkan kamera untuk situs ini, atau pakai tombol di bawah." : "Kamera tidak bisa dibuka. Pakai tombol di bawah.");
    }
  }, []);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open) {
      if (!d.open) d.showModal();
      setShot(null);
      start();
    } else {
      stop();
      if (d.open) d.close();
    }
    return () => stop();
  }, [open, start, stop]);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const snap = async () => {
    if (!video.current || !video.current.videoWidth) return;
    try {
      const blob = await shrinkImage(video.current);
      setShot({ blob, url: URL.createObjectURL(blob) });
      setState("shot");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memotret");
    }
  };

  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      onCapture(await shrinkImage(f));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Foto tidak bisa dibaca");
    }
  };

  return (
    <dialog
      ref={dlg}
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
      onClose={(e) => e.stopPropagation()}
      className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-black p-0 text-white backdrop:bg-black"
      aria-label={title}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">📷 {title}</div>
          <button type="button" className="rounded-full bg-white/15 px-3 py-1.5 text-sm" onClick={onClose}>Tutup</button>
        </div>
        <div className="relative min-h-0 flex-1 bg-black">
          <video ref={video} playsInline muted className={`absolute inset-0 h-full w-full object-contain ${state === "live" ? "" : "invisible"}`} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {state === "shot" && shot && <img src={shot.url} alt="Hasil foto" className="absolute inset-0 h-full w-full object-contain" />}
          {state === "start" && <div className="absolute inset-0 grid place-items-center text-sm text-white/70">Membuka kamera…</div>}
          {state === "error" && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/90">{error}</div>}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; fromFile(f); }}
        />
        <div className="flex items-center justify-between gap-3 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {state === "shot" ? (
            <>
              <button type="button" className="rounded-xl bg-white/15 px-4 py-3 text-sm font-semibold" onClick={() => { setShot(null); setState("live"); }}>↺ Ulangi</button>
              <button type="button" className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-base font-bold" onClick={() => { if (shot) onCapture(shot.blob); onClose(); }}>✓ Pakai foto</button>
            </>
          ) : (
            <>
              <button type="button" className="w-24 rounded-xl bg-white/15 px-3 py-3 text-xs font-semibold" onClick={() => { onBeforeExternal?.(); file.current?.click(); }}>🖼️ Galeri</button>
              <button type="button" aria-label="Jepret" disabled={state !== "live"} onClick={snap} className="grid h-[72px] w-[72px] place-items-center rounded-full border-4 border-white disabled:opacity-40">
                <span className="h-14 w-14 rounded-full bg-white" />
              </button>
              <span className="w-24" />
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
