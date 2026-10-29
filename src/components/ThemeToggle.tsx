"use client";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

const KEY = "mg-theme";

/** Pilihan tersimpan di perangkat; bila belum pernah memilih, ikuti setelan sistem */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.dataset.theme="dark"}catch(e){}`;

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  const toggle = () => {
    const next = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {}
    setDark(next);
  };
  const label = dark ? "Mode terang" : "Mode malam";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!dark}
      aria-label={label}
      title={label}
      onClick={toggle}
      className={withLabel ? "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100" : "rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"}
    >
      <Icon name={dark ? "sun" : "moon"} />
      {withLabel && (
        <>
          <span>Mode malam</span>
          <span className={`ml-auto inline-flex h-5 w-9 items-center rounded-full p-0.5 transition ${dark ? "bg-brand-600" : "bg-slate-300"}`}>
            <span className={`h-4 w-4 rounded-full bg-[#fff] shadow transition ${dark ? "translate-x-4" : ""}`} />
          </span>
        </>
      )}
    </button>
  );
}
