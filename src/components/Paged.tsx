"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Pagination (bawaan 10 baris) untuk tabel di dalamnya. Baris disembunyikan lewat atribut data-pg-hidden,
 * sehingga saat diunduh JPG atau dicetak semua baris tetap tampil (lihat globals.css).
 * Baris judul kelompok (`data-pg-group`) tidak dihitung; judul ikut tampil (diulang) di setiap halaman
 * yang memuat baris kelompoknya, sehingga kelompok yang terpotong tetap jelas.
 */
export function Paged({ children, size = 10 }: { children: React.ReactNode; size?: number }) {
  const PAGE = size;
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const pages = Math.ceil(count / PAGE);
  const cur = Math.min(page, Math.max(pages - 1, 0));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCount(el.querySelectorAll(":scope > table > tbody > tr:not([data-pg-group])").length);
    measure();
    const obs = new MutationObserver(measure);
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const rows = ref.current?.querySelectorAll<HTMLTableRowElement>(":scope > table > tbody > tr");
    if (!rows) return;
    let i = 0;
    let header: { row: HTMLTableRowElement; shown: boolean } | null = null;
    const closeHeader = () => header && header.row.toggleAttribute("data-pg-hidden", !header.shown);
    rows.forEach((r) => {
      if (r.hasAttribute("data-pg-group")) {
        closeHeader();
        header = { row: r, shown: false };
        return;
      }
      const shown = Math.floor(i++ / PAGE) === cur;
      r.toggleAttribute("data-pg-hidden", !shown);
      if (shown && header) header.shown = true;
    });
    closeHeader();
  }, [cur, count, PAGE]);

  return (
    <div ref={ref}>
      {children}
      {pages > 1 && (
        <div className="no-print sticky left-0 flex w-full max-w-[calc(100vw-2rem)] items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-sm text-slate-600">
          <span className="tabular-nums">{cur * PAGE + 1}–{Math.min(count, (cur + 1) * PAGE)} dari {count}</span>
          <span className="flex items-center gap-1">
            <button type="button" className="btn-secondary btn-sm btn-icon" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Halaman sebelumnya">‹</button>
            <span className="px-1 tabular-nums">{cur + 1}/{pages}</span>
            <button type="button" className="btn-secondary btn-sm btn-icon" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Halaman berikutnya">›</button>
          </span>
        </div>
      )}
    </div>
  );
}
