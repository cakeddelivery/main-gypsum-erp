"use client";
import { useEffect, useRef, useState } from "react";

/** Perkecil isi selebar `width` px agar muat di layar (mis. lembar A4 di HP), tanpa menggeser tata letaknya */
export function FitWidth({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [h, setH] = useState(height);
  useEffect(() => {
    const el = box.current;
    const inn = inner.current;
    if (!el || !inn) return;
    const fit = () => {
      setScale(Math.min(1, el.clientWidth / width));
      setH(inn.offsetHeight || height);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(inn);
    return () => ro.disconnect();
  }, [width, height]);
  return (
    <div ref={box} className="w-full overflow-hidden" style={{ height: scale ? h * scale : undefined }}>
      <div ref={inner} style={{ width, transform: `scale(${scale || 1})`, transformOrigin: "top left", visibility: scale ? "visible" : "hidden" }}>{children}</div>
    </div>
  );
}
