"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Kanvas tanda tangan jari/stylus (HP). Hasil: gambar PNG kecil di input tersembunyi `signature`, plus `device`. */
export function SignaturePad({ onChange }: { onChange?: (hasInk: boolean) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const out = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const strokes = useRef(0);
  const [ink, setInk] = useState(false);
  const [device, setDevice] = useState("");

  const fit = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    const g = c.getContext("2d")!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#1e3a8a";
    strokes.current = 0;
    setInk(false);
    if (out.current) out.current.value = "";
    onChange?.(false);
  }, [onChange]);

  useEffect(() => {
    fit();
    setDevice(navigator.userAgent.slice(0, 280));
  }, [fit]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    const g = ref.current!.getContext("2d")!;
    const p = last.current;
    g.beginPath();
    g.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    g.fillStyle = "#1e3a8a";
    g.fill();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const g = ref.current!.getContext("2d")!;
    const p = pos(e);
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    strokes.current++;
    const c = ref.current!;
    // Perkecil agar ringan (maks lebar 480 px), latar putih transparan → PNG
    const scale = Math.min(1, 480 / c.width);
    const t = document.createElement("canvas");
    t.width = Math.round(c.width * scale);
    t.height = Math.round(c.height * scale);
    t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
    if (out.current) out.current.value = t.toDataURL("image/png");
    setInk(true);
    onChange?.(true);
  };

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-white">
        <canvas
          ref={ref}
          aria-label="Kanvas tanda tangan: goreskan dengan jari"
          className="block h-40 w-full touch-none"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        {!ink && <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-400">Tanda tangan di sini</span>}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary btn-sm" onClick={fit}>Ulangi</button>
        <span className="text-xs text-slate-500">{ink ? "Tanda tangan siap" : "Goreskan dengan jari"}</span>
      </div>
      <input ref={out} type="hidden" name="signature" />
      <input type="hidden" name="device" value={device} />
    </div>
  );
}
