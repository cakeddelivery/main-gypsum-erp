"use client";
import { useState } from "react";

/** Tombol salin teks (mis. tautan undangan) ke clipboard */
export function CopyButton({ text, label = "Salin tautan", className = "btn-secondary btn-sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt("Salin tautan ini:", text);
        }
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? "✓ Tersalin" : label}
    </button>
  );
}
