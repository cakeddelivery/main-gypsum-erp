"use client";
import { useEffect, useState } from "react";

type Tab = { key: string; label: string; count?: number };

/**
 * Tab yang berpindah langsung di HP tanpa permintaan ke server: semua isi tab sudah dikirim sekaligus
 * (dipakai untuk tab yang datanya kecil). Alamat tetap ikut berubah (?param=…) agar bisa dibagikan/dimuat ulang.
 */
export function ClientTabs({ tabs, initial, panels, param = "tab", actions }: { tabs: Tab[]; initial: string; panels: Record<string, React.ReactNode>; param?: string; actions?: Record<string, React.ReactNode> }) {
  const [cur, setCur] = useState(initial);
  // Tombol kembali/maju browser
  useEffect(() => {
    const on = () => setCur(new URLSearchParams(location.search).get(param) ?? tabs[0].key);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [param, tabs]);
  const pick = (k: string) => {
    if (k === cur) return;
    setCur(k);
    const u = new URL(location.href);
    u.searchParams.set(param, k);
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  };
  return (
    <>
      <div className="no-print -mx-1 mb-4 flex items-center gap-1 overflow-x-auto pb-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === cur}
            onClick={() => pick(t.key)}
            className={`min-h-9 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${t.key === cur ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
          >
            {t.label}
            {t.count !== undefined && <span className={`ml-1.5 rounded-full px-1.5 text-xs ${t.key === cur ? "bg-brand-800" : "bg-slate-100"}`}>{t.count}</span>}
          </button>
        ))}
        {actions?.[cur] && <div className="ml-auto shrink-0">{actions[cur]}</div>}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" hidden={t.key !== cur} className={t.key === cur ? "tab-enter" : undefined}>
          {panels[t.key]}
        </div>
      ))}
    </>
  );
}
