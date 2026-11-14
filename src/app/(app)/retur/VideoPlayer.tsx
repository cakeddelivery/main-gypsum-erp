"use client";
import { useState } from "react";

/** Video hanya dimuat saat diputar (stream HTTP Range); sebelum itu cukup thumbnail */
export function VideoPlayer({ src, poster, label }: { src: string; poster?: string | null; label: string }) {
  const [on, setOn] = useState(false);
  if (on) return <video src={src} poster={poster ?? undefined} controls autoPlay playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black" />;
  return (
    <button type="button" onClick={() => setOn(true)} className="relative block aspect-video w-full overflow-hidden rounded-lg bg-slate-900 text-white" aria-label={`Putar ${label}`}>
      {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />}
      <span className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-2xl">▶</span>
      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs">{label}</span>
    </button>
  );
}
