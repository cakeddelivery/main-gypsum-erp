"use client";
import { useEffect, useRef, useState } from "react";

/** Selebrasi layar penuh (konfeti + teks), mis. setelah laporan shift terkirim. Dipasang sekali di Shell. */
export function celebrate(text: string) {
  window.dispatchEvent(new CustomEvent("mg-celebrate", { detail: { text } }));
}

const COLORS = ["#2559b8", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#facc15", "#ec4899"];
const DURATION = 2800;

type Bit = { x: number; y: number; vx: number; vy: number; r: number; w: number; h: number; c: string; spin: number };

export function Celebrate() {
  const [text, setText] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const on = (e: Event) => {
      setLeaving(false);
      setText((e as CustomEvent<{ text: string }>).detail.text);
    };
    window.addEventListener("mg-celebrate", on);
    return () => window.removeEventListener("mg-celebrate", on);
  }, []);

  useEffect(() => {
    if (!text) return;
    const t1 = window.setTimeout(() => setLeaving(true), DURATION - 350);
    const t2 = window.setTimeout(() => setText(null), DURATION);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const c = canvas.current;
    let raf = 0;
    if (c && !reduced) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = window.innerWidth, H = window.innerHeight;
      c.width = W * dpr;
      c.height = H * dpr;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      // Dua semburan dari kiri & kanan bawah + hujan dari atas
      const bits: Bit[] = [];
      const make = (x: number, y: number, angle: number, spread: number, speed: number, n: number) => {
        for (let i = 0; i < n; i++) {
          const a = angle + (Math.random() - 0.5) * spread;
          const v = speed * (0.55 + Math.random() * 0.6);
          bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: COLORS[i % COLORS.length], spin: (Math.random() - 0.5) * 0.4 });
        }
      };
      make(0, H * 0.85, -Math.PI / 3, 0.9, 17, 90);
      make(W, H * 0.85, (-Math.PI * 2) / 3, 0.9, 17, 90);
      for (let i = 0; i < 70; i++) bits.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, r: Math.random() * Math.PI, w: 6 + Math.random() * 5, h: 8 + Math.random() * 7, c: COLORS[i % COLORS.length], spin: (Math.random() - 0.5) * 0.3 });
      const start = performance.now();
      const tick = (now: number) => {
        const t = now - start;
        ctx.clearRect(0, 0, W, H);
        ctx.globalAlpha = t > DURATION - 700 ? Math.max(0, (DURATION - t) / 700) : 1;
        for (const b of bits) {
          b.vy += 0.32;
          b.vx *= 0.99;
          b.vy *= 0.99;
          b.x += b.vx;
          b.y += b.vy;
          b.r += b.spin;
          ctx.save();
          ctx.translate(b.x, b.y);
          ctx.rotate(b.r);
          ctx.fillStyle = b.c;
          ctx.fillRect(-b.w / 2, (-b.h / 2) * Math.abs(Math.cos(b.r * 2)), b.w, b.h * Math.abs(Math.cos(b.r * 2)) + 1);
          ctx.restore();
        }
        if (t < DURATION) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      cancelAnimationFrame(raf);
    };
  }, [text]);

  if (!text) return null;
  return (
    <div className={`celebrate pointer-events-none fixed inset-0 z-[70] ${leaving ? "celebrate-out" : ""}`} role="status" aria-live="assertive">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden />
      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="celebrate-card rounded-2xl bg-white/95 px-6 py-5 text-center shadow-2xl ring-1 ring-emerald-200">
          <div className="celebrate-check mx-auto mb-2 grid h-14 w-14 place-items-center rounded-full bg-emerald-500 text-white">
            <svg viewBox="0 0 24 24" className="check-draw h-8 w-8" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          </div>
          <p className="text-lg font-bold text-slate-900">{text}</p>
        </div>
      </div>
    </div>
  );
}
